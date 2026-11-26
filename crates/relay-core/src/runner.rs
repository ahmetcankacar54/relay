//! Live terminals: the CLI in a pseudo-terminal per project, its output pushed to the app and
//! kept (bounded) for a window that opens later.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use indexmap::IndexMap;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};

use crate::auth::Utf8Stream;
use crate::profile_lock::{ProfileLockError, ProfileLockGuard};
use crate::shared::types::{Run, RunKind, RunStatus, TerminalEvent};

/// At most this many terminals are kept; exited ones go first.
pub const MAX_TERMINALS: usize = 20;
/// Output kept per terminal, in characters.
pub const SCROLLBACK: usize = 512_000;
pub const TERMINAL_NAME: &str = "xterm-256color";
pub const INITIAL_COLS: u16 = 110;
pub const INITIAL_ROWS: u16 = 30;
/// How long `stop` waits for the process to close.
pub const STOP_WAIT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct RunnerError(pub String);

impl RunnerError {
    fn new(message: &str) -> Self {
        Self(message.to_owned())
    }
}

/// What a terminal is started for: `Run` without its id and status.
#[derive(Debug, Clone, PartialEq)]
pub struct RunInput {
    pub account_id: String,
    pub title: String,
    pub cwd: String,
    pub kind: RunKind,
    pub session_key: Option<String>,
}

/// A terminal's kept output, its last sequence number and status.
#[derive(Debug, Clone, PartialEq)]
pub struct RunBuffer {
    pub data: String,
    pub sequence: u64,
    pub status: RunStatus,
}

pub type EmitTerminal = dyn Fn(TerminalEvent) + Send + Sync;
/// Takes the account's shared profile lock, held while its terminal runs.
pub type RunnerProfileLock =
    dyn Fn(&str) -> Result<ProfileLockGuard, ProfileLockError> + Send + Sync;

struct Entry {
    run: Run,
    buffer: String,
    buffer_chars: usize,
    sequence: u64,
    writer: Option<Box<dyn Write + Send>>,
    master: Option<Box<dyn MasterPty + Send>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

struct Inner {
    entries: Mutex<IndexMap<String, Entry>>,
    exited: Condvar,
    emit: Box<EmitTerminal>,
    profile_lock: Option<Box<RunnerProfileLock>>,
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, IndexMap<String, Entry>> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[derive(Clone)]
pub struct Runner(Arc<Inner>);

fn get<'a>(
    entries: &'a mut IndexMap<String, Entry>,
    id: &str,
) -> Result<&'a mut Entry, RunnerError> {
    entries
        .get_mut(id)
        .ok_or_else(|| RunnerError::new("Terminal not found."))
}

impl Runner {
    pub fn new(emit: Box<EmitTerminal>, profile_lock: Option<Box<RunnerProfileLock>>) -> Self {
        Self(Arc::new(Inner {
            entries: Mutex::new(IndexMap::new()),
            exited: Condvar::new(),
            emit,
            profile_lock,
        }))
    }

    pub fn list(&self) -> Vec<Run> {
        self.0.lock().values().map(|e| e.run.clone()).collect()
    }

    pub fn start(
        &self,
        executable: &str,
        args: &[String],
        env: &HashMap<String, String>,
        input: RunInput,
    ) -> Result<Run, RunnerError> {
        let inner = &self.0;
        let mut entries = inner.lock();
        // Keep one managed writer per project; separate accounts may still work in different projects.
        if entries
            .values()
            .any(|e| e.run.status == RunStatus::Running && e.run.cwd == input.cwd)
        {
            return Err(RunnerError::new(
                "This account has a sign-in in progress or this project has a live session. Stop it on the Live tab first.",
            ));
        }
        // Bound retained terminal memory; active runs are never evicted.
        let ids: Vec<String> = entries.keys().cloned().collect();
        for id in ids {
            if entries.len() >= MAX_TERMINALS && entries[&id].run.status == RunStatus::Exited {
                entries.shift_remove(&id);
            }
        }
        if entries.len() >= MAX_TERMINALS {
            return Err(RunnerError::new("You can open up to 20 live terminals."));
        }
        let profile = match inner
            .profile_lock
            .as_ref()
            .map(|lock| lock(&input.account_id))
        {
            None => None,
            Some(Ok(guard)) => Some(guard),
            Some(Err(ProfileLockError::Busy(_))) => {
                return Err(RunnerError::new(
                    "Another Relay process is renewing this account’s connection. Try again in a moment.",
                ));
            }
            Some(Err(error)) => return Err(RunnerError(error.to_string())),
        };
        let spawn = || -> Result<_, String> {
            let pair = native_pty_system()
                .openpty(PtySize {
                    rows: INITIAL_ROWS,
                    cols: INITIAL_COLS,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| e.to_string())?;
            let mut command = CommandBuilder::new(executable);
            command.args(args);
            command.cwd(&input.cwd);
            command.env_clear();
            for (key, value) in env {
                command.env(key, value);
            }
            command.env("TERM", TERMINAL_NAME);
            let child = pair
                .slave
                .spawn_command(command)
                .map_err(|e| e.to_string())?;
            // The terminal ends when the process (and whatever it started) closes its side.
            drop(pair.slave);
            let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
            let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
            Ok((pair.master, child, reader, writer))
        };
        // A failed start gives the profile lock back (dropped with `profile`).
        let (master, mut child, mut reader, writer) = spawn().map_err(RunnerError)?;
        let run = Run {
            id: uuid::Uuid::new_v4().to_string(),
            account_id: input.account_id,
            title: input.title,
            cwd: input.cwd,
            kind: input.kind,
            session_key: input.session_key,
            status: RunStatus::Running,
            exit_code: None,
        };
        let id = run.id.clone();
        entries.insert(
            id.clone(),
            Entry {
                run: run.clone(),
                buffer: String::new(),
                buffer_chars: 0,
                sequence: 0,
                writer: Some(writer),
                master: Some(master),
                killer: child.clone_killer(),
            },
        );
        drop(entries);
        let (done, finished) = mpsc::channel::<()>();
        let this = self.clone();
        let run_id = id.clone();
        thread::spawn(move || {
            let mut decoder = Utf8Stream::default();
            let mut chunk = [0u8; 16 * 1024];
            // EOF, or EIO once the other side is gone.
            while let Ok(n) = reader.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                let data = decoder.push(&chunk[..n]);
                if !data.is_empty() {
                    this.data(&run_id, data);
                }
            }
            let _ = done.send(());
        });
        let this = self.clone();
        thread::spawn(move || {
            let status = child.wait();
            // ConPTY keeps the output side open until the pseudo-console goes.
            #[cfg(windows)]
            if let Some(e) = this.0.lock().get_mut(&id) {
                e.master = None;
            }
            // The rest of the output first, unless something the process left holds the terminal.
            let _ = finished.recv_timeout(Duration::from_secs(2));
            drop(profile);
            let exit_code = status.map_or(1, |s| s.exit_code());
            this.exit(&id, exit_code);
        });
        Ok(run)
    }

    fn data(&self, id: &str, data: String) {
        let event = {
            let mut entries = self.0.lock();
            let Some(e) = entries.get_mut(id) else {
                return;
            };
            // OSC 52 clipboard writes from model/tool output are not honored: the UI's xterm
            // registers no clipboard handler, and no shell link callbacks are exposed either.
            e.buffer.push_str(&data);
            e.buffer_chars += data.chars().count();
            if e.buffer_chars > SCROLLBACK {
                let excess = e.buffer_chars - SCROLLBACK;
                let cut = e
                    .buffer
                    .char_indices()
                    .nth(excess)
                    .map_or(e.buffer.len(), |(i, _)| i);
                e.buffer.drain(..cut);
                e.buffer_chars = SCROLLBACK;
            }
            e.sequence += 1;
            TerminalEvent {
                run_id: id.to_owned(),
                data: Some(data),
                exit_code: None,
                sequence: Some(e.sequence as f64),
            }
        };
        (self.0.emit)(event);
    }

    fn exit(&self, id: &str, exit_code: u32) {
        {
            let mut entries = self.0.lock();
            if let Some(e) = entries.get_mut(id) {
                e.run.status = RunStatus::Exited;
                e.run.exit_code = Some(f64::from(exit_code));
                e.writer = None;
                e.master = None;
            }
            self.0.exited.notify_all();
        }
        (self.0.emit)(TerminalEvent {
            run_id: id.to_owned(),
            data: None,
            exit_code: Some(f64::from(exit_code)),
            sequence: None,
        });
    }

    pub fn buffer(&self, id: &str) -> Result<RunBuffer, RunnerError> {
        let mut entries = self.0.lock();
        let e = get(&mut entries, id)?;
        Ok(RunBuffer {
            data: e.buffer.clone(),
            sequence: e.sequence,
            status: e.run.status,
        })
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), RunnerError> {
        let mut entries = self.0.lock();
        let e = get(&mut entries, id)?;
        if e.run.status == RunStatus::Running
            && let Some(writer) = e.writer.as_mut()
        {
            let _ = writer
                .write_all(data.as_bytes())
                .and_then(|()| writer.flush());
        }
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), RunnerError> {
        let mut entries = self.0.lock();
        let e = get(&mut entries, id)?;
        if e.run.status == RunStatus::Running
            && let Some(master) = e.master.as_ref()
        {
            let _ = master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
        Ok(())
    }

    /// Ends the process and waits for it to close, at most `STOP_WAIT`.
    pub fn stop(&self, id: &str) -> Result<(), RunnerError> {
        let inner = &self.0;
        let mut entries = inner.lock();
        let e = get(&mut entries, id)?;
        if e.run.status == RunStatus::Exited {
            return Ok(());
        }
        let mut killer = e.killer.clone_killer();
        drop(entries);
        let _ = killer.kill();
        let entries = inner.lock();
        let (entries, _) = inner
            .exited
            .wait_timeout_while(entries, STOP_WAIT, |entries| {
                entries
                    .get(id)
                    .is_some_and(|e| e.run.status == RunStatus::Running)
            })
            .unwrap_or_else(|e| e.into_inner());
        if entries
            .get(id)
            .is_some_and(|e| e.run.status == RunStatus::Running)
        {
            return Err(RunnerError::new(
                "The process has not closed yet. The transfer did not start.",
            ));
        }
        Ok(())
    }

    pub fn close(&self, id: &str) -> Result<(), RunnerError> {
        let mut entries = self.0.lock();
        if get(&mut entries, id)?.run.status == RunStatus::Running {
            return Err(RunnerError::new("Stop the running session first."));
        }
        entries.shift_remove(id);
        Ok(())
    }
}
