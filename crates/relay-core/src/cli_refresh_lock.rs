//! Port of `electron/core/cli-refresh-lock.ts`: Claude Code's OAuth refresh locks, folders taken
//! the way proper-lockfile takes them.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime};

use crate::clock::now_ms;
use crate::fs_util::{
    FileId, create_private_dir, create_private_dir_all, mtime_ms, real_path, set_times,
};

/// proper-lockfile's rule, which Claude Code uses: a lock not touched for this long is stale.
pub const LOCK_STALE_MS: i64 = 60_000;
/// How often a held lock is touched, as proper-lockfile does.
pub const TOUCH_INTERVAL: Duration = Duration::from_secs(5);
/// How long a wait for a held lock sleeps between looks.
const POLL: Duration = Duration::from_millis(250);

/// A lock folder was held by another process past the wait.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{} is held by another process", .file.file_name().map(|n| n.to_string_lossy()).unwrap_or_default())]
pub struct LockBusyError {
    pub file: PathBuf,
}

/// Claude Code's two OAuth refresh locks for a config folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliRefreshLockPaths {
    /// `<dir>/.oauth_refresh.lock`.
    pub current: PathBuf,
    /// `<realpath(dir)>.lock`.
    pub legacy: PathBuf,
}

/// Claude Code's two OAuth refresh locks for `config_dir`.
pub fn cli_refresh_lock_paths(config_dir: &Path) -> CliRefreshLockPaths {
    // Not there yet: the CLI names the legacy lock after the path as given then.
    let real = real_path(config_dir).unwrap_or_else(|_| config_dir.to_path_buf());
    let mut legacy = real.into_os_string();
    legacy.push(".lock");
    CliRefreshLockPaths {
        current: config_dir.join(".oauth_refresh.lock"),
        legacy: PathBuf::from(legacy),
    }
}

/// A lock folder this process made.
#[derive(Debug)]
pub struct LockDir {
    file: PathBuf,
    id: FileId,
}

impl LockDir {
    pub fn file(&self) -> &Path {
        &self.file
    }

    /// Marks it fresh, while it is still this one.
    pub fn touch(&self) {
        if FileId::of_path(&self.file).is_ok_and(|id| id == self.id) {
            let _ = set_times(&self.file, SystemTime::now());
        }
    }

    /// Removes it, while it is still this one; touched no more.
    pub fn release(self) {
        if FileId::of_path(&self.file).is_ok_and(|id| id == self.id) {
            // Gone already is fine.
            let _ = fs::remove_dir(&self.file);
        }
    }
}

/// Takes the lock folder `file` the way proper-lockfile does: mkdir, waiting up to `wait_ms` for
/// a holder that keeps touching it, and taking over one not touched for `LOCK_STALE_MS`. Only
/// the stale folder that was judged is removed (same identity and time), so a fresh lock another
/// process made meanwhile is never taken away. `now` is the clock, epoch ms.
pub fn take_lock_dir(
    file: &Path,
    wait_ms: u64,
    now: &dyn Fn() -> i64,
) -> Result<LockDir, LockBusyError> {
    let busy = || LockBusyError {
        file: file.to_path_buf(),
    };
    let deadline = now().saturating_add(i64::try_from(wait_ms).unwrap_or(i64::MAX));
    loop {
        match create_private_dir(file) {
            Ok(()) => {
                let id = FileId::of_path(file).map_err(|_| busy())?;
                return Ok(LockDir {
                    file: file.to_path_buf(),
                    id,
                });
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(busy()),
        }
        let Ok(judged) = look(file) else {
            continue;
        };
        if (now() as f64) - judged.1 > LOCK_STALE_MS as f64 {
            // Still the folder judged stale, right before it goes; taken over by another process
            // meanwhile, mkdir decides.
            if look(file).is_ok_and(|again| again == judged) {
                let _ = fs::remove_dir(file);
            }
            continue;
        }
        if now() >= deadline {
            return Err(busy());
        }
        std::thread::sleep(POLL);
    }
}

/// A folder's identity and modification time (`lstat`).
fn look(file: &Path) -> io::Result<(FileId, f64)> {
    let meta = fs::symlink_metadata(file)?;
    Ok((FileId::of_path(file)?, mtime_ms(&meta)?))
}

/// Both refresh locks held, touched every 5 s on a thread; released, in reverse order of
/// taking, on drop.
#[derive(Debug)]
pub struct CliRefreshLock {
    held: Vec<LockDir>,
    stop: Option<mpsc::Sender<()>>,
    toucher: Option<JoinHandle<Vec<LockDir>>>,
}

impl CliRefreshLock {
    /// Takes both of Claude Code's OAuth refresh locks for `config_dir`, in the CLI's own order,
    /// creating the folder (private) when it is missing.
    pub fn acquire(
        config_dir: &Path,
        wait_ms: u64,
        now: &dyn Fn() -> i64,
    ) -> Result<CliRefreshLock, CliRefreshLockError> {
        if !config_dir.exists() {
            create_private_dir_all(config_dir)?;
        }
        let paths = cli_refresh_lock_paths(config_dir);
        let mut held = Vec::new();
        for file in [&paths.current, &paths.legacy] {
            match take_lock_dir(file, wait_ms, now) {
                Ok(lock) => held.push(lock),
                Err(e) => {
                    for lock in held.into_iter().rev() {
                        lock.release();
                    }
                    return Err(e.into());
                }
            }
        }
        let (stop, stopped) = mpsc::channel::<()>();
        let toucher = std::thread::spawn(move || {
            while let Err(mpsc::RecvTimeoutError::Timeout) = stopped.recv_timeout(TOUCH_INTERVAL) {
                held.iter().for_each(LockDir::touch);
            }
            held
        });
        Ok(CliRefreshLock {
            held: Vec::new(),
            stop: Some(stop),
            toucher: Some(toucher),
        })
    }
}

impl Drop for CliRefreshLock {
    fn drop(&mut self) {
        drop(self.stop.take());
        if let Some(Ok(held)) = self.toucher.take().map(JoinHandle::join) {
            self.held = held;
        }
        while let Some(lock) = self.held.pop() {
            lock.release();
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CliRefreshLockError {
    #[error(transparent)]
    Busy(#[from] LockBusyError),
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// Holds both of Claude Code's OAuth refresh locks for `config_dir` while `action` runs, taken
/// in the CLI's own order, touched every 5 s so no CLI takes them for stale.
pub fn with_cli_refresh_lock<T>(
    config_dir: &Path,
    wait_ms: u64,
    action: impl FnOnce() -> T,
) -> Result<T, CliRefreshLockError> {
    let _lock = CliRefreshLock::acquire(config_dir, wait_ms, &now_ms)?;
    Ok(action())
}
