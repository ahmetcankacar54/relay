//! Port of `electron/core/desktop-watch.ts`: the desktop-automation helper's long-lived
//! `watch <quietMs> <idleMs> [pid]`, which reports where the user is in Claude, one JSON line
//! per change, while drafts wait.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::desktop_continuation_host::{
    DesktopAutomationIssue, DesktopHostError, DesktopTargetPid, is_local_session_id,
};
use crate::fs_util::safe_integer;

/// Where the user is in Claude, as the helper's `watch` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DesktopWatchState {
    pub pid: i64,
    /// The conversation on screen as its `local_` id, or `new-session` for Code's new-session
    /// screen; `None` while it is unknown or Claude is not in front.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub place: Option<String>,
    pub frontmost: bool,
    /// No key has been pressed for the watch's quiet time.
    pub quiet: bool,
    /// No input of any kind for the watch's idle time.
    pub idle: bool,
}

/// Why a watch ended: Claude quit, its 10 minutes ran out, the helper's issue, or it exited.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopWatchEnd {
    Gone,
    Expired,
    Exited,
    Issue(DesktopAutomationIssue),
}

impl DesktopWatchEnd {
    /// The literal as TS writes it.
    pub fn as_str(self) -> &'static str {
        match self {
            DesktopWatchEnd::Gone => "gone",
            DesktopWatchEnd::Expired => "expired",
            DesktopWatchEnd::Exited => "exited",
            DesktopWatchEnd::Issue(issue) => issue.as_str(),
        }
    }
}

pub trait DesktopWatchHandlers: Send + Sync {
    fn state(&self, state: DesktopWatchState);
    /// Called once, when the watch ends for any reason but `stop`.
    fn end(&self, reason: DesktopWatchEnd);
}

pub trait DesktopWatch: Send + Sync {
    /// Ends the watch; `end` is not called for it.
    fn stop(&self);
}

/// Starts a watch. An error is one the watch could not start with, as its code (`ENOTDIR`)
/// or name: never a message, which could name a path.
pub type DesktopWatcher = Arc<
    dyn Fn(Arc<dyn DesktopWatchHandlers>) -> Result<Box<dyn DesktopWatch>, String> + Send + Sync,
>;

/// Which Claude the watch looks at, asked once per watch (`DesktopTarget`, shareable).
pub type SharedDesktopTarget =
    Arc<dyn Fn() -> Result<DesktopTargetPid, DesktopHostError> + Send + Sync>;

const ISSUES: [DesktopAutomationIssue; 3] = [
    DesktopAutomationIssue::AccessibilityPermissionRequired,
    DesktopAutomationIssue::ClaudeNotRunning,
    DesktopAutomationIssue::DesktopUiUnsupported,
];
/// A line longer than this is not one the helper writes.
const MAX_LINE: usize = 4096;

/// One line of the helper's watch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchLine {
    State(DesktopWatchState),
    End(DesktopWatchEnd),
}

/// One line of the helper's watch: a state, how it ended, or `None` when it is neither.
pub fn parse_watch_line(line: &str) -> Option<WatchLine> {
    if line.encode_utf16().count() > MAX_LINE {
        return None;
    }
    let value: Value = serde_json::from_str(line).ok()?;
    let v = value.as_object()?;
    if v.get("gone") == Some(&Value::Bool(true)) {
        return Some(WatchLine::End(DesktopWatchEnd::Gone));
    }
    if v.get("expired") == Some(&Value::Bool(true)) {
        return Some(WatchLine::End(DesktopWatchEnd::Expired));
    }
    if let Some(Value::String(issue)) = v.get("issue") {
        let known = DesktopAutomationIssue::parse(issue).filter(|issue| ISSUES.contains(issue));
        return Some(WatchLine::End(DesktopWatchEnd::Issue(
            known.unwrap_or(DesktopAutomationIssue::DesktopUiUnsupported),
        )));
    }
    let pid = v.get("pid").and_then(safe_integer).filter(|pid| *pid > 0)?;
    let flag = |key: &str| v.get(key).and_then(Value::as_bool);
    let (frontmost, quiet, idle) = (flag("frontmost")?, flag("quiet")?, flag("idle")?);
    let place = match v.get("place")? {
        Value::Null => None,
        Value::String(place) if place == "new-session" || is_local_session_id(place) => {
            Some(place.clone())
        }
        _ => return None,
    };
    Some(WatchLine::State(DesktopWatchState {
        pid,
        place,
        frontmost,
        quiet,
        idle,
    }))
}

/// Where a file Relay ships inside `app.asar` really is: the build unpacks the helper next to
/// it, into `app.asar.unpacked`. A path outside an archive, or already unpacked, is returned
/// as it is.
pub fn unpacked_path(file: &str) -> String {
    const ARCHIVE: &str = "app.asar";
    let is_sep = |b: u8| b == b'/' || b == b'\\';
    let bytes = file.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        let end = i + 1 + ARCHIVE.len();
        if is_sep(b)
            && file[i + 1..].starts_with(ARCHIVE)
            && bytes.get(end).copied().is_some_and(is_sep)
        {
            return format!("{}.unpacked{}", &file[..end], &file[end..]);
        }
    }
    file.to_owned()
}

/// The child of one native watch, and whether the watch is over.
#[derive(Default)]
struct NativeState {
    ended: bool,
    child: Option<Child>,
    /// Held open while the helper runs: closing it ends the helper.
    stdin: Option<ChildStdin>,
}

struct NativeWatch {
    helper: PathBuf,
    quiet_ms: i64,
    idle_ms: i64,
    handlers: Arc<dyn DesktopWatchHandlers>,
    state: Mutex<NativeState>,
}

impl NativeWatch {
    fn lock(&self) -> MutexGuard<'_, NativeState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn finish(&self, reason: DesktopWatchEnd) {
        {
            let mut state = self.lock();
            if state.ended {
                return;
            }
            state.ended = true;
        }
        self.handlers.end(reason);
    }

    fn start(self: &Arc<Self>, pid: Option<i64>) {
        let mut args = vec![
            "watch".to_owned(),
            self.quiet_ms.to_string(),
            self.idle_ms.to_string(),
        ];
        args.extend(pid.map(|pid| pid.to_string()));
        let mut command = Command::new(unpacked_path(&self.helper.to_string_lossy()));
        command
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let stdout = {
            let mut state = self.lock();
            if state.ended {
                return;
            }
            match command.spawn() {
                Ok(mut child) => {
                    let stdout = child.stdout.take();
                    state.stdin = child.stdin.take();
                    state.child = Some(child);
                    stdout
                }
                Err(_) => None,
            }
        };
        let Some(stdout) = stdout else {
            self.finish(DesktopWatchEnd::Issue(
                DesktopAutomationIssue::DesktopUiUnsupported,
            ));
            return;
        };
        let watch = Arc::clone(self);
        std::thread::spawn(move || watch.read(stdout));
    }

    /// Reads the helper's lines until its output closes, then waits for it to exit: a last
    /// line, such as `gone`, says why first.
    fn read(&self, stdout: impl std::io::Read) {
        let mut reader = BufReader::new(stdout);
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            match reader.read_until(b'\n', &mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            if self.lock().ended {
                continue;
            }
            let text = String::from_utf8_lossy(&buffer);
            let line = text.strip_suffix('\n').unwrap_or(&text);
            let line = line.strip_suffix('\r').unwrap_or(line);
            match parse_watch_line(line) {
                None => {}
                Some(WatchLine::End(reason)) => self.finish(reason),
                Some(WatchLine::State(state)) => self.handlers.state(state),
            }
        }
        loop {
            {
                let mut state = self.lock();
                if state.ended {
                    return;
                }
                match state.child.as_mut().map(Child::try_wait) {
                    Some(Ok(None)) => {}
                    _ => break,
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        self.finish(DesktopWatchEnd::Exited);
    }
}

impl DesktopWatch for Arc<NativeWatch> {
    fn stop(&self) {
        let mut state = self.lock();
        state.ended = true;
        drop(state.stdin.take());
        if let Some(child) = state.child.as_mut() {
            let _ = child.kill();
            let _ = child.try_wait();
        }
    }
}

/// The helper's `watch <quietMs> <idleMs> [pid]`, as a watcher. Its stdin stays open while it
/// runs: Relay ending closes it, and the helper ends with it. Lines that do not parse are
/// skipped. With `target`, the helper watches the Claude it names.
pub fn native_desktop_watch(
    helper: impl AsRef<Path>,
    quiet_ms: i64,
    idle_ms: i64,
    target: Option<SharedDesktopTarget>,
) -> DesktopWatcher {
    let helper = helper.as_ref().to_path_buf();
    Arc::new(move |handlers| {
        let watch = Arc::new(NativeWatch {
            helper: helper.clone(),
            quiet_ms,
            idle_ms,
            handlers,
            state: Mutex::new(NativeState::default()),
        });
        match &target {
            None => watch.start(None),
            Some(target) => {
                let target = Arc::clone(target);
                let watch = Arc::clone(&watch);
                std::thread::spawn(move || {
                    let pid = target();
                    if watch.lock().ended {
                        return;
                    }
                    match pid {
                        Ok(DesktopTargetPid::Any) => watch.start(None),
                        Ok(DesktopTargetPid::Pid(pid)) => watch.start(Some(pid)),
                        Ok(DesktopTargetPid::MainNotRunning) => watch.finish(
                            DesktopWatchEnd::Issue(DesktopAutomationIssue::ClaudeNotRunning),
                        ),
                        Err(_) => watch.finish(DesktopWatchEnd::Issue(
                            DesktopAutomationIssue::DesktopUiUnsupported,
                        )),
                    }
                });
            }
        }
        Ok(Box::new(watch) as Box<dyn DesktopWatch>)
    })
}
