//! Helpers for the draft restore tests (`draft_restorer`, `draft_watch`, `draft_ipc`): ids,
//! summaries, a log that keeps every entry, gates that hold a run, and waits for threads.
#![allow(dead_code)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use relay_core::desktop_continuation_host::{
    DesktopAutomation, DesktopAutomationGuard, DesktopAutomationSnapshot, DesktopDraftGuard,
    DesktopHostError, DesktopSendResult, OpenSessionOptions, WriteDraftOptions,
};
use relay_core::draft_diagnostics::DraftLog;
use relay_core::draft_main::DraftScheduler;
use relay_core::draft_restorer::{RestoreResult, RestoreStatus};
use relay_core::draft_vault::{DraftState, DraftSummary};
use serde_json::{Map, Value};

pub const ACCOUNT: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
pub const OTHER: &str = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

/// `new Date(0).toISOString()`.
pub const EPOCH: &str = "1970-01-01T00:00:00.000Z";

/// A pending summary of `id` for ACCOUNT.
pub fn summary(id: &str) -> DraftSummary {
    DraftSummary {
        id: id.into(),
        to: ACCOUNT.into(),
        title: format!("Conversation {id}"),
        new_session: false,
        attachments: false,
        state: DraftState::Pending,
        reason: None,
        captured_at: EPOCH.into(),
    }
}

/// A summary left for copy with `reason`.
pub fn left_for(id: &str, reason: &str) -> DraftSummary {
    DraftSummary {
        state: DraftState::NeedsCopy,
        reason: Some(reason.into()),
        ..summary(id)
    }
}

pub fn result(status: RestoreStatus, restored: usize, left: usize) -> RestoreResult {
    RestoreResult {
        status,
        restored,
        left,
        reason: None,
    }
}

/// A run that stopped for `reason` with one draft left.
pub fn stopped(reason: &str) -> RestoreResult {
    RestoreResult {
        reason: Some(reason.into()),
        ..result(RestoreStatus::Waiting, 0, 1)
    }
}

pub type Logs = Arc<Mutex<Vec<Value>>>;

/// A log keeping `{ event, ...fields }`, as the TS tests push them.
pub fn log_sink() -> (Logs, Arc<DraftLog>) {
    let logs: Logs = Arc::default();
    let sink = Arc::clone(&logs);
    let log: Arc<DraftLog> = Arc::new(move |event: &str, fields: Option<&Map<String, Value>>| {
        let mut entry = Map::new();
        entry.insert("event".into(), Value::String(event.into()));
        for (key, value) in fields.into_iter().flatten() {
            entry.insert(key.clone(), value.clone());
        }
        sink.lock().unwrap().push(Value::Object(entry));
    });
    (logs, log)
}

/// Holds whoever waits on it until opened; tells whether someone waits now.
#[derive(Default)]
pub struct Gate {
    state: Mutex<(bool, bool)>,
    wake: Condvar,
}

impl Gate {
    pub fn new() -> Arc<Gate> {
        Arc::default()
    }
    pub fn wait(&self) {
        let mut state = self.state.lock().unwrap();
        state.0 = true;
        while !state.1 {
            state = self.wake.wait(state).unwrap();
        }
        state.0 = false;
    }
    pub fn open(&self) {
        let mut state = self.state.lock().unwrap();
        state.1 = true;
        state.0 = false;
        self.wake.notify_all();
    }
    pub fn blocked(&self) -> bool {
        self.state.lock().unwrap().0
    }
}

/// Waits up to 5 s for `cond`.
pub fn wait_until(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !cond() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(1));
    }
}

/// The TS `flush()` where nothing can be waited for: long enough for a thread to get going.
pub fn flush() {
    std::thread::sleep(Duration::from_millis(50));
}

/// The TS `settle()`: until no run is in flight, or the one in flight waits at a gate.
pub fn settle(scheduler: &DraftScheduler, gates: &[Arc<Gate>]) {
    wait_until("the scheduler to settle", || {
        !scheduler.in_flight() || gates.iter().any(|g| g.blocked())
    });
}

/// A flag a fake sets once.
pub fn flag() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}

pub fn is_set(flag: &AtomicBool) -> bool {
    flag.load(Ordering::SeqCst)
}

/// An automation no test of the scheduler reaches: every call fails.
pub struct Unused;

fn unused<T>() -> Result<T, DesktopHostError> {
    Err(DesktopHostError::other("unused"))
}

impl DesktopAutomation for Unused {
    fn inspect(&self) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        unused()
    }
    fn open_session(&self, _: &str, _: Option<OpenSessionOptions>) -> Result<(), DesktopHostError> {
        unused()
    }
    fn open_new_session(&self, _: Option<OpenSessionOptions>) -> Result<(), DesktopHostError> {
        unused()
    }
    fn set_permission(
        &self,
        _: &DesktopAutomationGuard,
        _: &str,
    ) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        unused()
    }
    fn send(
        &self,
        _: &DesktopAutomationGuard,
        _: &str,
        _: &str,
    ) -> Result<DesktopSendResult, DesktopHostError> {
        unused()
    }
    fn has_request_marker(&self, _: &str) -> Result<bool, DesktopHostError> {
        unused()
    }
    fn write_draft(
        &self,
        _: &DesktopDraftGuard,
        _: &str,
        _: Option<WriteDraftOptions>,
    ) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        unused()
    }
}
