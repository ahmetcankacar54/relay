//! Port of `electron/core/desktop-lock.ts`: Relay's Desktop lock, one Desktop operation at a
//! time across the app's threads, in the order they ask, with the cross-process file lock taken
//! by each holder.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Condvar, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::desktop_continuation::DesktopContinuationError;
use crate::process_lock::{ProcessLock, ProcessLockError};
use crate::shared::types::literal_enum;

/// Why an action the user started is refused while another Desktop operation runs.
pub const DESKTOP_HANDOFF: &str =
    "Finish the Desktop handoff before starting another Desktop operation.";

literal_enum!(
    /// How a holder names itself to Relay's other processes in the shared file lock.
    DesktopLockKind {
        DesktopTask = "desktop-task",
        DraftRetype = "draft-retype",
    }
);

/// The lock shared with Relay's other processes: every holder takes it as it begins and gives
/// it back as it ends.
pub trait DesktopFileLock: Send + Sync {
    fn acquire(&self, kind: DesktopLockKind) -> Result<(), ProcessLockError>;
    fn release(&self);
}

/// The app's wiring: `operationLock.tryAcquire(kind)` / `release()`.
impl DesktopFileLock for ProcessLock {
    fn acquire(&self, kind: DesktopLockKind) -> Result<(), ProcessLockError> {
        self.try_acquire(kind.as_str())
    }
    fn release(&self) {
        ProcessLock::release(self);
    }
}

/// What the lock itself refuses with; an action's own errors pass through as they are.
#[derive(Debug, thiserror::Error)]
pub enum DesktopLockError {
    /// [`DESKTOP_HANDOFF`]: another operation holds the lock or waits for it.
    #[error("{}", DESKTOP_HANDOFF)]
    Handoff,
    /// The file lock could not be taken: another Relay process runs a Desktop operation
    /// (`ProcessLockError::Busy`), or the lock file failed.
    #[error(transparent)]
    File(#[from] ProcessLockError),
}

impl From<DesktopLockError> for DesktopContinuationError {
    fn from(error: DesktopLockError) -> Self {
        DesktopContinuationError::new(error.to_string())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Holder {
    Operation,
    Restore,
}

#[derive(Default)]
struct LockState {
    /// The next caller's place in the queue.
    next: u64,
    /// The place now allowed to hold the lock.
    serving: u64,
    holder: Option<Holder>,
    /// Callers holding the lock or waiting for it.
    count: u32,
    /// Of those, the ones that are not a draft restore.
    others: u32,
    begun: u64,
}

/// Relay's Desktop lock: one Desktop operation at a time, in the order they ask. A draft restore
/// takes it per record, and only when it is free, so it never holds anything up for long. An
/// action the user starts during a restore record waits for that record and then runs; the
/// restore's next record finds the lock taken and stops, leaving the rest pending.
pub struct DesktopLock {
    state: Mutex<LockState>,
    turn: Condvar,
    changed: Box<dyn Fn() + Send + Sync>,
    file_lock: Option<Box<dyn DesktopFileLock>>,
}

impl Default for DesktopLock {
    fn default() -> Self {
        Self::new(Box::new(|| {}), None)
    }
}

/// Ends a hold whatever way the action ended: gives back the file lock, frees the queue's next
/// place and tells the listener.
struct Finish<'a> {
    lock: &'a DesktopLock,
    kind: Holder,
    file_held: bool,
}

impl Drop for Finish<'_> {
    fn drop(&mut self) {
        if self.file_held
            && let Some(file) = &self.lock.file_lock
        {
            file.release();
        }
        {
            let mut state = self.lock.lock_state();
            state.holder = None;
            state.count -= 1;
            if self.kind == Holder::Operation {
                state.others -= 1;
            }
            state.serving += 1;
        }
        self.lock.turn.notify_all();
        self.lock.tell();
    }
}

impl DesktopLock {
    /// `changed` is told inside the lock as each holder begins, and as it ends. `file_lock` is
    /// the lock shared with Relay's other processes.
    pub fn new(
        changed: Box<dyn Fn() + Send + Sync>,
        file_lock: Option<Box<dyn DesktopFileLock>>,
    ) -> Self {
        DesktopLock {
            state: Mutex::new(LockState::default()),
            turn: Condvar::new(),
            changed,
            file_lock,
        }
    }

    fn lock_state(&self) -> MutexGuard<'_, LockState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Something holds the lock, a draft restore included.
    pub fn active(&self) -> bool {
        self.lock_state().holder.is_some()
    }
    /// A draft restore holds the lock.
    pub fn restoring(&self) -> bool {
        self.lock_state().holder == Some(Holder::Restore)
    }
    /// An operation other than a draft restore holds the lock or waits for it: what the user is
    /// shown as Desktop being busy, and what refuses the user's own Desktop actions.
    pub fn busy(&self) -> bool {
        self.lock_state().others > 0
    }
    /// Callers holding the lock or waiting for it.
    pub fn callers(&self) -> u32 {
        self.lock_state().count
    }
    /// Operations other than draft restores begun so far; it only grows.
    pub fn operations(&self) -> u64 {
        self.lock_state().begun
    }

    /// Runs `action` holding the lock, once every caller before it is done.
    pub fn run<T, E: From<DesktopLockError>>(
        &self,
        action: impl FnOnce() -> Result<T, E>,
    ) -> Result<T, E> {
        let ticket = self
            .enqueue(Holder::Operation, |_| true)
            .expect("always queued");
        self.hold(ticket, Holder::Operation, action)
            .map(|done| done.expect("an operation never gives up"))
    }

    /// Runs an action the user started. It is refused while another operation holds the lock
    /// or waits for it, and then when `refuse` gives a reason; behind a draft restore it waits.
    pub fn manual<T, E: From<DesktopLockError>>(
        &self,
        action: impl FnOnce() -> Result<T, E>,
        refuse: Option<&dyn Fn() -> Option<E>>,
    ) -> Result<T, E> {
        if self.busy() {
            return Err(DesktopLockError::Handoff.into());
        }
        if let Some(refused) = refuse.and_then(|refuse| refuse()) {
            return Err(refused);
        }
        // Checked again with the place taken, as the TS does in one synchronous step.
        let Some(ticket) = self.enqueue(Holder::Operation, |state| state.others == 0) else {
            return Err(DesktopLockError::Handoff.into());
        };
        self.hold(ticket, Holder::Operation, action)
            .map(|done| done.expect("an operation never gives up"))
    }

    /// The draft restorer's `withLock`: `None` at once, without running `f`, when anything holds
    /// the lock or waits for it, or `free()` says Desktop is busy. Otherwise `f` runs holding
    /// it, and whatever `f` returns as an error comes out unchanged.
    pub fn restore<T, E: From<DesktopLockError>>(
        &self,
        f: impl FnOnce() -> Result<T, E>,
        free: impl FnOnce() -> bool,
    ) -> Result<Option<T>, E> {
        if self.callers() > 0 || !free() {
            return Ok(None);
        }
        let Some(ticket) = self.enqueue(Holder::Restore, |state| state.count == 0) else {
            return Ok(None);
        };
        self.hold(ticket, Holder::Restore, f)
    }

    /// Takes the next place in the queue when `admit` allows it, in one step under the mutex.
    fn enqueue(&self, kind: Holder, admit: impl FnOnce(&LockState) -> bool) -> Option<u64> {
        let mut state = self.lock_state();
        if !admit(&state) {
            return None;
        }
        let ticket = state.next;
        state.next += 1;
        state.count += 1;
        if kind == Holder::Operation {
            state.others += 1;
        }
        Some(ticket)
    }

    /// `None` only for a draft restore that found the file lock taken by another process.
    fn hold<T, E: From<DesktopLockError>>(
        &self,
        ticket: u64,
        kind: Holder,
        action: impl FnOnce() -> Result<T, E>,
    ) -> Result<Option<T>, E> {
        {
            let mut state = self.lock_state();
            while state.serving != ticket {
                state = self.turn.wait(state).unwrap_or_else(|e| e.into_inner());
            }
        }
        let mut finish = Finish {
            lock: self,
            kind,
            file_held: false,
        };
        if let Some(file) = &self.file_lock {
            // Named for the other process: a draft restore re-types a draft; any other holder
            // does a Desktop task (a DesktopManager operation inside it names itself no further).
            let named = if kind == Holder::Restore {
                DesktopLockKind::DraftRetype
            } else {
                DesktopLockKind::DesktopTask
            };
            match file.acquire(named) {
                Ok(()) => finish.file_held = true,
                // Another Relay process runs a Desktop operation: a draft restore gives up, as
                // it does for a busy lock, and anything else is refused.
                Err(ProcessLockError::Busy(_)) if kind == Holder::Restore => return Ok(None),
                Err(error) => return Err(DesktopLockError::File(error).into()),
            }
        }
        {
            let mut state = self.lock_state();
            state.holder = Some(kind);
            if kind == Holder::Operation {
                state.begun += 1;
            }
        }
        self.tell();
        let result = action().map(Some);
        drop(finish);
        result
    }

    fn tell(&self) {
        // A listener never changes how a Desktop operation ends.
        let _ = catch_unwind(AssertUnwindSafe(|| (self.changed)()));
    }
}
