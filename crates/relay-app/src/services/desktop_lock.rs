//! One Desktop operation at a time (port of electron/main/desktop-lock.ts). The menu bar shows
//! each as it begins rather than at the next poll, and its end, for operations no caller
//! refreshes the tray after.

use std::path::PathBuf;
use std::sync::LazyLock;

use relay_core::desktop_lock::{DesktopFileLock, DesktopLock, DesktopLockError, DesktopLockKind};
use relay_core::process_lock::ProcessLockError;
use relay_core::profile_lock::any_exclusive_profile_lock;

use crate::state::STATE;

/// `operationLock?.tryAcquire(kind)` / `release()`: the lock is made at boot, after this.
struct OperationLock;

impl DesktopFileLock for OperationLock {
    fn acquire(&self, kind: DesktopLockKind) -> Result<(), ProcessLockError> {
        match STATE.operation_lock.get() {
            Some(lock) => lock.try_acquire(kind.as_str()),
            None => Ok(()),
        }
    }
    fn release(&self) {
        if let Some(lock) = STATE.operation_lock.get() {
            lock.release();
        }
    }
}

pub static DESKTOP_LOCK: LazyLock<DesktopLock> = LazyLock::new(|| {
    DesktopLock::new(
        Box::new(crate::services::tray_setup::update_tray),
        Some(Box::new(OperationLock)),
    )
});

/// Per-account profile locks, shared with the relay CLI.
pub fn profile_locks() -> PathBuf {
    STATE.paths().data_dir().join("profiles").join(".locks")
}

pub fn with_desktop_lock<T, E: From<DesktopLockError>>(
    action: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    DESKTOP_LOCK.run(action)
}

/// What a refused manual action says while an account connection refresh runs.
pub const REFRESH_RUNNING: &str = "Wait for the account connection refresh to finish.";

/// A Desktop action the user started: refused during another operation, queued behind a
/// restored draft. Errors come back as the message the window shows.
pub fn manual_desktop_lock<T, E: std::fmt::Display>(
    action: impl FnOnce() -> Result<T, E>,
) -> Result<T, String> {
    let refuse = || {
        let refreshing = STATE
            .usage_credential_refresher
            .get()
            .is_some_and(|refresher| refresher.any_active());
        let pid = i64::from(std::process::id());
        (refreshing || any_exclusive_profile_lock(&profile_locks(), Some(pid)).unwrap_or(false))
            .then(|| ManualError(REFRESH_RUNNING.into()))
    };
    DESKTOP_LOCK
        .manual(
            || action().map_err(|e| ManualError(e.to_string())),
            Some(&refuse),
        )
        .map_err(|e| e.0)
}

/// An action's error or the lock's refusal, as its message.
struct ManualError(String);

impl From<DesktopLockError> for ManualError {
    fn from(error: DesktopLockError) -> Self {
        ManualError(error.to_string())
    }
}

/// A sign-in is running: an account connection refresh, or a sign-in flow starting, waiting or
/// verifying.
pub fn pending_auth() -> bool {
    STATE
        .usage_credential_refresher
        .get()
        .is_some_and(|refresher| refresher.any_active())
        || STATE.auth_busy()
}
