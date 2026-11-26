//! Port of `electron/core/process-lock.ts`: the lock file Relay's processes share, the menu-bar
//! app and the CLI.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::clock::now_ms;
use crate::continuation_journal::read_private_json;
use crate::fs_util::{
    FileId, create_new_private, create_private_dir_all, dirname, iso_timestamp, mtime_ms,
    parse_iso_ms, safe_integer, sync_directory,
};

/// Which side holds a lock. A holder whose file cannot be read is `Unknown`; it is never written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LockBy {
    App,
    Cli,
    Unknown,
}

/// Who holds a lock: the file's JSON, keys in this order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockInfo {
    pub pid: i64,
    pub token: String,
    pub by: LockBy,
    pub kind: String,
    /// ISO 8601, `Date#toISOString`.
    pub started_at: String,
}

/// The lock is held by a live holder.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{}", busy_message(.holder.by))]
pub struct LockBusyError {
    pub holder: LockInfo,
}

// Fixed sentences, so the app can show them translated (src/messages.ts); the relay CLI
// describes the holder itself.
fn busy_message(by: LockBy) -> &'static str {
    match by {
        LockBy::App => "Relay.app is using Claude Desktop. Try again when it ends.",
        LockBy::Cli => {
            "A relay command in a terminal is using Claude Desktop. Try again when it ends."
        }
        LockBy::Unknown => "Another Relay process is using Claude Desktop. Try again when it ends.",
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ProcessLockError {
    #[error(transparent)]
    Busy(#[from] LockBusyError),
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// A point in `try_acquire` where another process may act; tests use it to stage races.
#[doc(hidden)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RacePoint {
    /// The create failed because the file exists; before the first look at it.
    CreateFailed,
    /// Right after that first look (`lstat`), before the file is read.
    Looked,
}

type StartedAt = dyn Fn(i64) -> Option<i64> + Send + Sync;

/// Seams for tests; the defaults read the system.
#[derive(Default)]
pub struct LockDeps {
    /// When `pid` started, epoch ms, or None when it cannot be read.
    pub started_at: Option<Box<StartedAt>>,
    /// The time written into a new lock, epoch ms.
    pub now: Option<Box<dyn Fn() -> i64 + Send + Sync>>,
    #[doc(hidden)]
    pub race: Option<Box<dyn Fn(RacePoint) + Send + Sync>>,
}

/// When `pid` started, epoch ms at 1 s resolution (as `ps -o lstart=` gives it), or None when no
/// such process runs or its start cannot be read.
pub fn process_started_at(pid: i64) -> Option<i64> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let pid = Pid::from_u32(u32::try_from(pid).ok()?);
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing(),
    );
    let seconds = system.process(pid)?.start_time();
    (seconds > 0).then(|| (seconds as i64).saturating_mul(1000))
}

/// Whether `pid` is gone for sure (`kill(pid, 0)` says ESRCH).
fn pid_gone(pid: i64) -> bool {
    #[cfg(unix)]
    {
        // A pid beyond pid_t makes Node's process.kill throw a type error, which is not ESRCH.
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return false;
        };
        // SAFETY: signal 0 only checks that the process exists.
        if unsafe { libc::kill(pid, 0) } == 0 {
            return false;
        }
        io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
    #[cfg(not(unix))]
    {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
        let Ok(pid) = u32::try_from(pid) else {
            return false;
        };
        let pid = Pid::from_u32(pid);
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing(),
        );
        system.process(pid).is_none()
    }
}

/// Whether the process that wrote a lock at `started_at` still holds it: its pid runs, and that
/// pid's process did not start after the lock was written (a reused pid). A running pid whose
/// start cannot be read is the holder until shown otherwise.
pub fn holder_alive(pid: i64, started_at: &str, deps: &LockDeps) -> bool {
    if pid <= 0 || pid > (1 << 53) - 1 {
        return false;
    }
    if pid_gone(pid) {
        return false;
    }
    let began = match &deps.started_at {
        Some(f) => f(pid),
        None => process_started_at(pid),
    };
    let Some(began) = began else {
        return true;
    };
    !matches!(parse_iso_ms(started_at), Some(written) if began > written)
}

fn valid_info(value: &Value) -> Option<LockInfo> {
    let v = value.as_object()?;
    let pid = safe_integer(v.get("pid")?)?;
    let by = match v.get("by")?.as_str()? {
        "app" => LockBy::App,
        "cli" => LockBy::Cli,
        _ => return None,
    };
    Some(LockInfo {
        pid,
        token: v.get("token")?.as_str()?.to_owned(),
        by,
        kind: v.get("kind")?.as_str()?.to_owned(),
        started_at: v.get("startedAt")?.as_str()?.to_owned(),
    })
}

fn unknown_holder(meta: Option<&fs::Metadata>) -> LockInfo {
    let at = meta
        .and_then(|m| mtime_ms(m).ok())
        .map(|ms| ms as i64)
        .unwrap_or_else(now_ms);
    LockInfo {
        pid: 0,
        token: String::new(),
        by: LockBy::Unknown,
        kind: "unknown".to_owned(),
        started_at: iso_timestamp(at),
    }
}

fn is_not_found(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::NotFound
}

#[derive(Default)]
struct Held {
    depth: u32,
    token: Option<String>,
}

/// A lock file shared by Relay's processes, the menu-bar app and the CLI. It holds the owner's
/// pid, a token, which side it is, what it does and when it began. Taking it is reentrant
/// within one instance. A lock whose holder has gone, or whose pid now belongs to a newer
/// process, is stale and is swept once, if it is still the same file.
pub struct ProcessLock {
    file: PathBuf,
    by: LockBy,
    deps: LockDeps,
    held: Mutex<Held>,
}

impl ProcessLock {
    /// A lock at `file` taken as `by`, which is `LockBy::App` or `LockBy::Cli`.
    pub fn new(file: impl Into<PathBuf>, by: LockBy) -> ProcessLock {
        ProcessLock::with_deps(file, by, LockDeps::default())
    }

    pub fn with_deps(file: impl Into<PathBuf>, by: LockBy, deps: LockDeps) -> ProcessLock {
        assert!(
            by != LockBy::Unknown,
            "a lock is taken by the app or the CLI"
        );
        ProcessLock {
            file: file.into(),
            by,
            deps,
            held: Mutex::new(Held::default()),
        }
    }

    pub fn file(&self) -> &Path {
        &self.file
    }

    fn state(&self) -> std::sync::MutexGuard<'_, Held> {
        self.held.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Whether this instance holds the lock.
    pub fn held(&self) -> bool {
        self.state().depth > 0
    }

    /// The live holder, or None when the lock is free or stale. Changes nothing.
    pub fn holder(&self) -> Option<LockInfo> {
        let info = self.read()?;
        if info.by == LockBy::Unknown || holder_alive(info.pid, &info.started_at, &self.deps) {
            Some(info)
        } else {
            None
        }
    }

    fn race(&self, point: RacePoint) {
        if let Some(f) = &self.deps.race {
            f(point);
        }
    }

    /// Takes the lock at once, or fails with `LockBusyError` naming its holder.
    pub fn try_acquire(&self, kind: &str) -> Result<(), ProcessLockError> {
        let mut held = self.state();
        if held.depth > 0 {
            held.depth += 1;
            return Ok(());
        }
        let dir = dirname(&self.file);
        create_private_dir_all(dir)?;
        let mut last: Option<LockInfo> = None;
        for _attempt in 0..2 {
            let token = uuid::Uuid::new_v4().to_string();
            match create_new_private(&self.file) {
                Ok(mut fd) => {
                    let info = LockInfo {
                        pid: i64::from(std::process::id()),
                        token: token.clone(),
                        by: self.by,
                        kind: kind.to_owned(),
                        started_at: iso_timestamp(
                            self.deps.now.as_ref().map_or_else(now_ms, |f| f()),
                        ),
                    };
                    fd.write_all(&serde_json::to_vec(&info).map_err(io::Error::other)?)?;
                    fd.sync_all()?;
                    drop(fd);
                    sync_directory(dir)?;
                    held.token = Some(token);
                    held.depth = 1;
                    return Ok(());
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e.into()),
            }
            self.race(RacePoint::CreateFailed);
            let before = match fs::symlink_metadata(&self.file) {
                Ok(meta) => meta,
                // Released between the create and this look: try to create it again.
                Err(e) if is_not_found(&e) => continue,
                Err(e) => return Err(e.into()),
            };
            let before_id = FileId::of_path(&self.file);
            self.race(RacePoint::Looked);
            last = self.read();
            // Released between the create and this read: try to create it again.
            if last.is_none() && !self.file.exists() {
                continue;
            }
            if last.is_none() {
                // Another process may be writing it this instant: look once more.
                std::thread::sleep(Duration::from_millis(20));
                last = self.read();
                if last.is_none() && !self.file.exists() {
                    continue;
                }
            }
            match &last {
                Some(info) if info.by != LockBy::Unknown => {
                    if holder_alive(info.pid, &info.started_at, &self.deps) {
                        return Err(LockBusyError {
                            holder: info.clone(),
                        }
                        .into());
                    }
                }
                _ => {
                    // Still unreadable: a writer that died mid-write long ago is stale.
                    if (now_ms() as f64) - mtime_ms(&before)? < 10_000.0 {
                        let holder = last
                            .clone()
                            .unwrap_or_else(|| unknown_holder(Some(&before)));
                        return Err(LockBusyError { holder }.into());
                    }
                }
            }
            let current = match fs::symlink_metadata(&self.file) {
                Ok(meta) => meta,
                Err(e) if is_not_found(&e) => continue,
                Err(e) => return Err(e.into()),
            };
            let same = match (&before_id, FileId::of_path(&self.file)) {
                (Ok(a), Ok(b)) => *a == b,
                _ => false,
            };
            if current.is_symlink() || !same {
                let holder = last
                    .clone()
                    .unwrap_or_else(|| unknown_holder(Some(&current)));
                return Err(LockBusyError { holder }.into());
            }
            match fs::remove_file(&self.file) {
                Err(e) if !is_not_found(&e) => return Err(e.into()),
                _ => {}
            }
            sync_directory(dir)?;
        }
        // Gone again: the caller's retry will take it.
        let final_meta = fs::symlink_metadata(&self.file).ok();
        let holder = last.unwrap_or_else(|| unknown_holder(final_meta.as_ref()));
        Err(LockBusyError { holder }.into())
    }

    /// Takes the lock, retrying every 10 ms for up to `wait`; only for very short holds.
    pub fn acquire(&self, kind: &str, wait: Duration) -> Result<(), ProcessLockError> {
        let until = Instant::now() + wait;
        loop {
            match self.try_acquire(kind) {
                Err(ProcessLockError::Busy(_)) if Instant::now() < until => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                result => return result,
            }
        }
    }

    /// Gives one level back; the file goes with the last one, and only while it is ours.
    pub fn release(&self) {
        let mut held = self.state();
        if held.depth == 0 {
            return;
        }
        held.depth -= 1;
        if held.depth > 0 {
            return;
        }
        let token = held.token.take();
        if self
            .read()
            .is_some_and(|info| Some(&info.token) == token.as_ref())
        {
            // Already gone is fine.
            let _ = fs::remove_file(&self.file);
        }
    }

    /// The holder named in the file: None when there is no file, an `Unknown` holder when it
    /// cannot be read or is not a lock.
    fn read(&self) -> Option<LockInfo> {
        match read_private_json(&self.file, 4096) {
            Ok(raw) => valid_info(&raw).or_else(|| {
                // Gone since it was read: nobody holds it.
                let meta = fs::symlink_metadata(&self.file).ok()?;
                Some(unknown_holder(Some(&meta)))
            }),
            Err(e) if e.is_not_found() => None,
            Err(_) => fs::symlink_metadata(&self.file)
                .ok()
                .map(|meta| unknown_holder(Some(&meta))),
        }
    }
}
