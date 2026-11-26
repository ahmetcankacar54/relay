//! Port of `tests/draft-restorer.test.ts`: the draft restorer over a fake Desktop.
//!
//! Skipped: "the restorer never sends and waits only through its deps" (source text).

#[path = "common/fleet_drafts.rs"]
mod helpers;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

use helpers::*;
use relay_core::continuation::SessionStatus;
use relay_core::desktop_continuation_host::{
    DesktopAutomation, DesktopAutomationGuard, DesktopAutomationIssue as I,
    DesktopAutomationSnapshot, DesktopDraftGuard, DesktopHostError, DesktopSendResult,
    OpenSessionOptions, SnapshotCoverage, WriteDraftOptions,
};
use relay_core::draft_diagnostics::DraftLog;
use relay_core::draft_main::{DraftScheduler, DraftSchedulerDeps};
use relay_core::draft_restorer::{
    DraftCounts, RestoreOptions, RestoreResult, RestoreStatus, RestorerDeps, restore_drafts,
};
use relay_core::draft_vault::{DraftRecord, DraftState, DraftSummary};
use serde_json::{Value, json};

fn alias(n: u32) -> String {
    format!("{n:08}-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
}
fn target(n: u32) -> String {
    format!("local_{}", alias(n))
}
/// The conversation the user is on when the restore starts.
const HOME: &str = "local_ffffffff-ffff-4fff-8fff-ffffffffffff";
/// A conversation the user moves to by hand.
const ELSEWHERE: &str = "local_cccccccc-cccc-4ccc-8ccc-cccccccccccc";
/// Code's new-session screen, as the fake shows it and its calls name it.
const NEW: &str = "new-session";

fn record(n: u32) -> DraftRecord {
    DraftRecord {
        id: format!("draft-{n}"),
        to: ACCOUNT.into(),
        target_alias: Some(alias(n)),
        new_session: None,
        title: format!("Conversation {n}"),
        text: format!("draft {n}"),
        attachments: false,
        captured_at: EPOCH.into(),
        state: DraftState::Pending,
        reason: None,
    }
}
fn record_with(n: u32, over: impl FnOnce(&mut DraftRecord)) -> DraftRecord {
    let mut r = record(n);
    over(&mut r);
    r
}
/// The draft of a session that does not exist yet, for the new-session screen.
fn fresh(n: u32) -> DraftRecord {
    record_with(n, |r| {
        r.target_alias = None;
        r.new_session = Some(true);
        r.title = String::new();
    })
}
fn fresh_with(n: u32, over: impl FnOnce(&mut DraftRecord)) -> DraftRecord {
    let mut r = fresh(n);
    over(&mut r);
    r
}
fn issue(name: I) -> DesktopHostError {
    name.into()
}
fn sum(values: &[u64]) -> u64 {
    values.iter().sum()
}
fn res(status: RestoreStatus, restored: usize, left: usize, reason: Option<&str>) -> RestoreResult {
    RestoreResult {
        status,
        restored,
        left,
        reason: reason.map(str::to_owned),
    }
}
use RestoreStatus::{Done, Idle, Waiting};
fn copy(id: &str, reason: &str) -> (String, DraftState, Option<String>) {
    (id.into(), DraftState::NeedsCopy, Some(reason.into()))
}

/// What a hook makes of an open.
#[derive(Clone)]
enum Open {
    Go,
    Ignored,
    Fail(DesktopHostError),
}

type Hook<A, R> = Option<Arc<dyn Fn(A) -> R + Send + Sync>>;

#[derive(Default, Clone)]
struct Hooks {
    /// Runs before the nth inspect; an error is thrown from it.
    inspect: Hook<u32, Option<DesktopHostError>>,
    open: Hook<String, Open>,
    /// Runs before the nth write; an error is thrown from it before anything is typed.
    write: Hook<u32, Option<DesktopHostError>>,
    sleep: Hook<u64, ()>,
    vault: Hook<(&'static str, String), Option<DesktopHostError>>,
    /// Replaces the uptime, for the nth read of it.
    uptime: Hook<u32, Option<i64>>,
    /// Desktop's wipe marker, at the nth read of it; none without.
    wiped_at: Hook<u32, Result<Option<i64>, DesktopHostError>>,
    pending: Hook<u32, Option<DesktopHostError>>,
    busy: Hook<u32, bool>,
    yielding: Hook<(), bool>,
    // The TS tests' replaced deps.
    running: Hook<(), bool>,
    current_account: Hook<(), Result<Option<String>, DesktopHostError>>,
    with_lock: Hook<(), DesktopHostError>,
    page_booted: Hook<(), Option<bool>>,
}

/// Fields forced onto snapshots: `Some(None)` is a field set to undefined.
#[derive(Default, Clone)]
struct Patch {
    composer_present: Option<Option<bool>>,
    account_label: Option<Option<String>>,
    permission_mode: Option<Option<String>>,
}

#[derive(Clone)]
struct Activity {
    frontmost: Option<bool>,
    idle_ms: Option<i64>,
    key_idle_ms: Option<i64>,
}

#[derive(Clone, Copy, PartialEq)]
enum LogMode {
    Keep,
    Panic,
    Absent,
}

struct St {
    begin: i64,
    clock: i64,
    account: Option<String>,
    records: Vec<DraftRecord>,
    shown: Option<String>,
    pid: i64,
    held: bool,
    inspects: u32,
    writes: u32,
    locks: u32,
    pending_reads: u32,
    uptime_reads: u32,
    wipe_reads: u32,
    composers: HashMap<String, String>,
    statuses: HashMap<String, SessionStatus>,
    no_composer: HashSet<String>,
    patch: Patch,
    screen_patch: HashMap<String, Patch>,
    activity: Activity,
    calls: Vec<String>,
    open_options: Vec<Option<OpenSessionOptions>>,
    guards: Vec<DesktopDraftGuard>,
    write_options: Vec<Option<WriteDraftOptions>>,
    sleeps: Vec<u64>,
    marks: Vec<(String, DraftState, Option<String>)>,
    removed: Vec<String>,
    notes: Vec<DraftCounts>,
    outside_lock: Vec<String>,
    hooks: Hooks,
    running: bool,
    uptime: i64,
    no_uptime: bool,
    lock_busy: bool,
    log_mode: LogMode,
}

#[derive(Default)]
struct Opts {
    records: Option<Vec<DraftRecord>>,
    running: Option<bool>,
    /// Claude's uptime when the restore starts; it grows with the clock.
    uptime: Option<i64>,
    no_uptime: bool,
    lock_busy: bool,
    shown: Option<Option<String>>,
    composers: Vec<(String, String)>,
    statuses: Vec<(String, SessionStatus)>,
    no_composer: Vec<String>,
}

/// A handle on the fake Desktop, for hooks to change it.
#[derive(Clone)]
struct Desk(Arc<Mutex<St>>);

impl Desk {
    fn st(&self) -> MutexGuard<'_, St> {
        self.0.lock().unwrap()
    }
    fn now(&self) -> i64 {
        self.st().clock
    }
    fn set_shown(&self, id: Option<&str>) {
        self.st().shown = id.map(str::to_owned);
    }
    fn set_account(&self, id: Option<&str>) {
        self.st().account = id.map(str::to_owned);
    }
    fn set_pid(&self, pid: i64) {
        self.st().pid = pid;
    }
    fn shown(&self) -> Option<String> {
        self.st().shown.clone()
    }
    fn writes(&self) -> Vec<String> {
        self.st()
            .calls
            .iter()
            .filter(|c| c.starts_with("write:"))
            .cloned()
            .collect()
    }
    fn hook<T: Clone>(&self, pick: impl FnOnce(&Hooks) -> T) -> T {
        pick(&self.st().hooks)
    }
    fn touch(&self, call: String) {
        let mut st = self.st();
        if !st.held {
            st.outside_lock.push(call.clone());
        }
        st.calls.push(call);
    }
    fn view(&self) -> DesktopAutomationSnapshot {
        let st = self.st();
        let shown = st.shown.clone();
        let present = shown.as_ref().is_some_and(|s| !st.no_composer.contains(s));
        let text = shown.as_ref().and_then(|s| st.composers.get(s)).cloned();
        let has_text = text.as_deref().is_some_and(|t| !t.is_empty());
        let mut account_label = Some("Test User".to_owned());
        let mut permission_mode = Some("Auto".to_owned());
        let mut composer_present = Some(present);
        let patches = [
            Some(&st.patch),
            shown.as_ref().and_then(|s| st.screen_patch.get(s)),
        ];
        for patch in patches.into_iter().flatten() {
            if let Some(v) = &patch.account_label {
                account_label = v.clone();
            }
            if let Some(v) = &patch.permission_mode {
                permission_mode = v.clone();
            }
            if let Some(v) = patch.composer_present {
                composer_present = v;
            }
        }
        let status = shown
            .as_ref()
            .and_then(|s| st.statuses.get(s).copied())
            .unwrap_or(if present {
                SessionStatus::Stopped
            } else {
                SessionStatus::Unknown
            });
        let new_session = (shown.as_deref() == Some(NEW)).then_some(true);
        let local_session_id = shown.clone().filter(|s| s != NEW);
        let composer_empty = present && !has_text;
        let send_enabled = present && has_text;
        // The helper's fingerprint: its stable fields.
        let fingerprint = format!(
            "{}|{local_session_id:?}|{new_session:?}|{account_label:?}|{permission_mode:?}|{}|{composer_present:?}|{composer_empty}|{send_enabled}",
            st.pid,
            status.as_str()
        );
        DesktopAutomationSnapshot {
            observed_at: st.clock,
            pid: st.pid,
            local_session_id,
            new_session,
            account_label,
            permission_mode,
            status,
            quota_stopped: false,
            composer_present,
            composer_empty,
            composer_empty_as: None,
            composer_chars: None,
            screen: None,
            panes: None,
            pane_found: None,
            send_enabled,
            quota_auto_resume: None,
            visible_active_tasks: None,
            visible_waiting_tasks: None,
            visible_scheduled_tasks: None,
            context_fingerprint: fingerprint,
            coverage: SnapshotCoverage::ActiveConversationOnly,
            frontmost: st.activity.frontmost,
            idle_ms: st.activity.idle_ms,
            key_idle_ms: st.activity.key_idle_ms,
        }
    }
    /// Desktop following a link to `id`, a conversation or NEW.
    fn follow(
        &self,
        id: &str,
        options: Option<OpenSessionOptions>,
    ) -> Result<(), DesktopHostError> {
        self.touch(format!("open:{id}"));
        self.st().open_options.push(options);
        let outcome = match self.hook(|h| h.open.clone()) {
            Some(hook) => hook(id.to_owned()),
            None => Open::Go,
        };
        if let Open::Fail(error) = outcome {
            return Err(error);
        }
        let mut st = self.st();
        // As the helper, asked to, refuses before it opens anything while the user is active.
        if options.and_then(|o| o.require_idle) == Some(true)
            && !(st.activity.frontmost == Some(true) && st.activity.idle_ms.unwrap_or(0) >= 3_000)
        {
            return Err(issue(I::UserActive));
        }
        if !matches!(outcome, Open::Ignored) {
            st.shown = Some(id.to_owned());
        }
        Ok(())
    }
}

/// A fake Desktop: one composer per conversation and one for the new-session screen, the view
/// on one of them, a clock that only `sleep` moves.
struct Fake {
    desk: Desk,
    log: Arc<DraftLog>,
}

impl DesktopAutomation for Fake {
    fn inspect(&self) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        let n = {
            let mut st = self.desk.st();
            st.inspects += 1;
            st.inspects
        };
        self.desk.touch("inspect".into());
        if let Some(hook) = self.desk.hook(|h| h.inspect.clone())
            && let Some(error) = hook(n)
        {
            return Err(error);
        }
        Ok(self.desk.view())
    }
    fn open_session(
        &self,
        id: &str,
        options: Option<OpenSessionOptions>,
    ) -> Result<(), DesktopHostError> {
        self.desk.follow(id, options)
    }
    fn open_new_session(
        &self,
        options: Option<OpenSessionOptions>,
    ) -> Result<(), DesktopHostError> {
        self.desk.follow(NEW, options)
    }
    fn set_permission(
        &self,
        _: &DesktopAutomationGuard,
        _: &str,
    ) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        panic!("never sets a permission")
    }
    fn send(
        &self,
        _: &DesktopAutomationGuard,
        _: &str,
        _: &str,
    ) -> Result<DesktopSendResult, DesktopHostError> {
        panic!("never sends")
    }
    fn has_request_marker(&self, _: &str) -> Result<bool, DesktopHostError> {
        panic!("never sends")
    }
    fn write_draft(
        &self,
        guard: &DesktopDraftGuard,
        text: &str,
        options: Option<WriteDraftOptions>,
    ) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        let n = {
            let mut st = self.desk.st();
            st.writes += 1;
            st.guards.push(guard.clone());
            st.write_options.push(options);
            st.writes
        };
        let name = match guard {
            DesktopDraftGuard::NewSession(_) => NEW.to_owned(),
            DesktopDraftGuard::Session(g) => g.local_session_id.clone(),
        };
        self.desk.touch(format!("write:{name}"));
        if let Some(hook) = self.desk.hook(|h| h.write.clone())
            && let Some(error) = hook(n)
        {
            return Err(error);
        }
        // As the helper validates a guard before it types anything.
        let now = self.desk.view();
        let matches = match guard {
            DesktopDraftGuard::NewSession(g) => {
                g.pid == now.pid
                    && now.new_session == Some(true)
                    && now.local_session_id.is_none()
                    && Some(&g.account_label) == now.account_label.as_ref()
                    && g.permission_mode == now.permission_mode
                    && g.context_fingerprint == now.context_fingerprint
            }
            DesktopDraftGuard::Session(g) => {
                g.pid == now.pid
                    && Some(&g.local_session_id) == now.local_session_id.as_ref()
                    && Some(&g.account_label) == now.account_label.as_ref()
                    && Some(&g.permission_mode) == now.permission_mode.as_ref()
                    && g.context_fingerprint == now.context_fingerprint
            }
        };
        if !matches {
            return Err(issue(I::ContextChanged));
        }
        if now.status != SessionStatus::Stopped {
            return Err(issue(I::DesktopWorkActive));
        }
        if now.composer_present != Some(true) {
            return Err(issue(I::DesktopUiUnsupported));
        }
        if !now.composer_empty {
            return Err(issue(I::ComposerNotEmpty));
        }
        // As the helper refuses, before it types, while the user is active.
        let keys = options.and_then(|o| o.keys_idle_ms);
        let quiet = now.frontmost == Some(true)
            && match keys {
                Some(keys) => now.key_idle_ms.unwrap_or(0) as f64 >= keys,
                None => now.idle_ms.unwrap_or(0) >= 3_000,
            };
        if !quiet {
            return Err(issue(I::UserActive));
        }
        {
            let mut st = self.desk.st();
            let shown = st.shown.clone().unwrap();
            st.composers.insert(shown, text.to_owned());
        }
        Ok(self.desk.view())
    }
}

impl RestorerDeps for Fake {
    fn automation(&self) -> &dyn DesktopAutomation {
        self
    }
    fn pending(&self) -> Result<Vec<DraftRecord>, DesktopHostError> {
        let n = {
            let mut st = self.desk.st();
            st.pending_reads += 1;
            st.pending_reads
        };
        if let Some(hook) = self.desk.hook(|h| h.pending.clone())
            && let Some(error) = hook(n)
        {
            return Err(error);
        }
        Ok(self.desk.st().records.clone())
    }
    fn mark(
        &self,
        id: &str,
        state: DraftState,
        reason: Option<&str>,
    ) -> Result<(), DesktopHostError> {
        if let Some(hook) = self.desk.hook(|h| h.vault.clone())
            && let Some(error) = hook(("mark", id.to_owned()))
        {
            return Err(error);
        }
        let mut st = self.desk.st();
        st.marks.push((id.into(), state, reason.map(str::to_owned)));
        for r in st.records.iter_mut().filter(|r| r.id == id) {
            r.state = state;
            if let Some(reason) = reason {
                r.reason = Some(reason.into());
            }
        }
        Ok(())
    }
    fn remove(&self, id: &str) -> Result<(), DesktopHostError> {
        if let Some(hook) = self.desk.hook(|h| h.vault.clone())
            && let Some(error) = hook(("remove", id.to_owned()))
        {
            return Err(error);
        }
        let mut st = self.desk.st();
        st.removed.push(id.into());
        st.records.retain(|r| r.id != id);
        Ok(())
    }
    fn current_account(&self) -> Result<Option<String>, DesktopHostError> {
        match self.desk.hook(|h| h.current_account.clone()) {
            Some(hook) => hook(()),
            None => Ok(self.desk.st().account.clone()),
        }
    }
    fn running(&self) -> Result<bool, DesktopHostError> {
        match self.desk.hook(|h| h.running.clone()) {
            Some(hook) => Ok(hook(())),
            None => Ok(self.desk.st().running),
        }
    }
    fn uptime_ms(&self) -> Result<Option<i64>, DesktopHostError> {
        let n = {
            let mut st = self.desk.st();
            st.uptime_reads += 1;
            st.uptime_reads
        };
        if let Some(hook) = self.desk.hook(|h| h.uptime.clone()) {
            return Ok(hook(n));
        }
        let st = self.desk.st();
        Ok((!st.no_uptime).then(|| st.uptime + (st.clock - st.begin)))
    }
    fn wiped_at(&self) -> Result<Option<i64>, DesktopHostError> {
        let Some(hook) = self.desk.hook(|h| h.wiped_at.clone()) else {
            return Ok(None);
        };
        let n = {
            let mut st = self.desk.st();
            st.wipe_reads += 1;
            st.wipe_reads
        };
        hook(n)
    }
    fn page_booted(&self) -> Result<Option<bool>, DesktopHostError> {
        Ok(self
            .desk
            .hook(|h| h.page_booted.clone())
            .and_then(|hook| hook(())))
    }
    fn with_lock(&self, f: &mut dyn FnMut()) -> Result<bool, DesktopHostError> {
        if let Some(hook) = self.desk.hook(|h| h.with_lock.clone()) {
            return Err(hook(()));
        }
        let n = {
            let mut st = self.desk.st();
            st.locks += 1;
            st.locks
        };
        let busy = self.desk.st().lock_busy
            || self
                .desk
                .hook(|h| h.busy.clone())
                .is_some_and(|hook| hook(n));
        if busy {
            return Ok(false);
        }
        self.desk.st().held = true;
        f();
        self.desk.st().held = false;
        Ok(true)
    }
    fn yielding(&self) -> bool {
        self.desk
            .hook(|h| h.yielding.clone())
            .is_some_and(|hook| hook(()))
    }
    fn notify(&self, summary: DraftCounts) -> Result<(), DesktopHostError> {
        self.desk.st().notes.push(summary);
        Ok(())
    }
    fn sleep(&self, ms: u64) -> Result<(), DesktopHostError> {
        {
            let mut st = self.desk.st();
            st.sleeps.push(ms);
            st.clock += ms as i64;
        }
        if let Some(hook) = self.desk.hook(|h| h.sleep.clone()) {
            hook(ms);
        }
        Ok(())
    }
    fn now(&self) -> i64 {
        self.desk.now()
    }
    fn log(&self) -> Option<&DraftLog> {
        match self.desk.st().log_mode {
            LogMode::Absent => None,
            _ => Some(&*self.log),
        }
    }
}

struct H {
    fake: Arc<Fake>,
    desk: Desk,
    logs: Logs,
}

fn harness(options: Opts) -> H {
    let begin = 1_000_000;
    let desk = Desk(Arc::new(Mutex::new(St {
        begin,
        clock: begin,
        account: Some(ACCOUNT.into()),
        records: options.records.unwrap_or_else(|| vec![record(1)]),
        shown: options.shown.unwrap_or_else(|| Some(HOME.into())),
        pid: 456,
        held: false,
        inspects: 0,
        writes: 0,
        locks: 0,
        pending_reads: 0,
        uptime_reads: 0,
        wipe_reads: 0,
        composers: options.composers.into_iter().collect(),
        statuses: options.statuses.into_iter().collect(),
        no_composer: options.no_composer.into_iter().collect(),
        patch: Patch::default(),
        screen_patch: HashMap::new(),
        // By default the user lets Relay act.
        activity: Activity {
            frontmost: Some(true),
            idle_ms: Some(60_000),
            key_idle_ms: Some(60_000),
        },
        calls: Vec::new(),
        open_options: Vec::new(),
        guards: Vec::new(),
        write_options: Vec::new(),
        sleeps: Vec::new(),
        marks: Vec::new(),
        removed: Vec::new(),
        notes: Vec::new(),
        outside_lock: Vec::new(),
        hooks: Hooks::default(),
        running: options.running.unwrap_or(true),
        uptime: options.uptime.unwrap_or(20_000),
        no_uptime: options.no_uptime,
        lock_busy: options.lock_busy,
        log_mode: LogMode::Keep,
    })));
    let (logs, keep) = log_sink();
    let mode = desk.clone();
    let log: Arc<DraftLog> = Arc::new(
        move |event: &str, fields: Option<&serde_json::Map<String, Value>>| {
            if mode.st().log_mode == LogMode::Panic {
                panic!("the log failed");
            }
            keep(event, fields);
        },
    );
    H {
        fake: Arc::new(Fake {
            desk: desk.clone(),
            log,
        }),
        desk,
        logs,
    }
}

fn base() -> H {
    harness(Opts::default())
}
fn with_records(records: Vec<DraftRecord>) -> H {
    harness(Opts {
        records: Some(records),
        ..Opts::default()
    })
}

impl H {
    fn restore(&self) -> RestoreResult {
        self.restore_with(RestoreOptions::default())
    }
    fn restore_with(&self, options: RestoreOptions) -> RestoreResult {
        restore_drafts(&*self.fake, options).expect("the restore never fails here")
    }
    fn st(&self) -> MutexGuard<'_, St> {
        self.desk.st()
    }
    fn set(&self, f: impl FnOnce(&mut Hooks)) {
        f(&mut self.st().hooks);
    }
    fn activity(&self, f: impl FnOnce(&mut Activity)) {
        f(&mut self.st().activity);
    }
    fn patch(&self, f: impl FnOnce(&mut Patch)) {
        f(&mut self.st().patch);
    }
    fn screen_patch(&self, screen: &str, f: impl FnOnce(&mut Patch)) {
        f(self.st().screen_patch.entry(screen.into()).or_default());
    }
    fn calls(&self) -> Vec<String> {
        self.st().calls.clone()
    }
    fn opens(&self) -> Vec<String> {
        self.calls()
            .into_iter()
            .filter(|c| c.starts_with("open:"))
            .collect()
    }
    fn writes(&self) -> Vec<String> {
        self.desk.writes()
    }
    fn sleeps(&self) -> Vec<u64> {
        self.st().sleeps.clone()
    }
    fn marks(&self) -> Vec<(String, DraftState, Option<String>)> {
        self.st().marks.clone()
    }
    fn removed(&self) -> Vec<String> {
        self.st().removed.clone()
    }
    fn notes(&self) -> Vec<DraftCounts> {
        self.st().notes.clone()
    }
    fn composer(&self, id: &str) -> Option<String> {
        self.st().composers.get(id).cloned()
    }
    fn logs(&self) -> Vec<Value> {
        self.logs.lock().unwrap().clone()
    }
    /// Desktop actions taken without the lock. Only inspecting may happen outside it.
    fn actions_outside_lock(&self) -> Vec<String> {
        self.st()
            .outside_lock
            .iter()
            .filter(|c| *c != "inspect")
            .cloned()
            .collect()
    }
    fn now(&self) -> i64 {
        self.desk.now()
    }
}

fn notes(restored: usize, left: usize) -> Vec<DraftCounts> {
    vec![DraftCounts { restored, left }]
}
fn strs(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}
fn opened(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|id| format!("open:{id}")).collect()
}
fn written(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|id| format!("write:{id}")).collect()
}

#[test]
fn idle_when_nothing_is_pending_for_this_account() {
    let h = with_records(vec![
        record_with(1, |r| r.to = OTHER.into()),
        record_with(2, |r| {
            r.state = DraftState::NeedsCopy;
            r.reason = Some("manual".into());
        }),
    ]);
    assert_eq!(h.restore(), res(Idle, 0, 0, None));
    assert!(h.calls().is_empty());
    assert!(h.notes().is_empty());
    // Without a Desktop account nothing is anyone's.
    let signed_out = base();
    signed_out.desk.set_account(None);
    assert_eq!(signed_out.restore().status, Idle);
    assert!(signed_out.calls().is_empty());
}

#[test]
fn an_account_matches_whatever_its_case() {
    let h = with_records(vec![record_with(1, |r| r.to = ACCOUNT.to_uppercase())]);
    assert_eq!(h.restore(), res(Done, 1, 0, None));
    assert_eq!(h.removed(), strs(&["draft-1"]));
}

#[test]
fn a_run_waits_until_claude_has_been_up_15_s_without_claude_or_its_uptime_it_does_not() {
    for options in [
        Opts {
            no_uptime: true,
            ..Opts::default()
        },
        Opts {
            running: Some(false),
            ..Opts::default()
        },
    ] {
        let h = harness(options);
        assert_eq!(h.restore(), res(Waiting, 0, 1, None));
        assert!(h.calls().is_empty());
        assert!(h.sleeps().is_empty());
        assert!(h.marks().is_empty());
        assert!(h.removed().is_empty());
    }
    let ready = harness(Opts {
        uptime: Some(15_000),
        ..Opts::default()
    });
    assert_eq!(ready.restore().status, Done);
    assert_eq!(ready.removed(), strs(&["draft-1"]));
    // Up 10 s: the run waits the 5 s left, touching nothing of Desktop's meanwhile, and reads
    // the uptime once for it rather than running ps every 500 ms.
    let early = harness(Opts {
        uptime: Some(10_000),
        ..Opts::default()
    });
    let start = early.now();
    let first_look: Arc<Mutex<Option<(i64, u32)>>> = Arc::default();
    let (seen, desk) = (Arc::clone(&first_look), early.desk.clone());
    early.set(|k| {
        k.inspect = Some(Arc::new(move |n| {
            if n == 1 {
                let st = desk.st();
                *seen.lock().unwrap() = Some((st.clock, st.uptime_reads));
            }
            None
        }))
    });
    assert_eq!(early.restore().restored, 1);
    assert_eq!(*first_look.lock().unwrap(), Some((start + 5_000, 1)));
    assert!(early.sleeps().iter().take(10).all(|ms| *ms == 500));
}

/// When a run first looks at Desktop's UI, from its start; `None` when it never does.
fn first_look(h: &H) -> Option<i64> {
    let start = h.now();
    let at: Arc<Mutex<Option<i64>>> = Arc::default();
    let (seen, desk) = (Arc::clone(&at), h.desk.clone());
    h.set(|k| {
        k.inspect = Some(Arc::new(move |n| {
            if n == 1 {
                *seen.lock().unwrap() = Some(desk.now() - start);
            }
            None
        }))
    });
    h.restore();
    *at.lock().unwrap()
}

fn up(ms: i64) -> H {
    harness(Opts {
        uptime: Some(ms),
        ..Opts::default()
    })
}

#[test]
fn desktops_wipe_marker_from_after_claude_started_makes_it_ready_before_15_s() {
    // Up 2 s, the wipe finished 1 s ago: at once, and the lock's own check needs no 15 s.
    let now = up(2_000);
    let wiped = now.now() - 1_000;
    now.set(|k| k.wiped_at = Some(Arc::new(move |_| Ok(Some(wiped)))));
    assert_eq!(first_look(&now), Some(0));
    assert_eq!(now.removed(), strs(&["draft-1"]));
    assert_eq!(
        now.logs()[0],
        json!({
            "event": "restore-start",
            "account": &ACCOUNT[..8],
            "records": 1,
            "all": 1,
            "ready": true,
            "wiped": true,
            "waitedMs": 0,
        })
    );
    // The marker comes 3 s in: the run goes on then.
    let later = up(1_000);
    let begun = later.now();
    let desk = later.desk.clone();
    later.set(|k| {
        k.wiped_at = Some(Arc::new(move |_| {
            Ok((desk.now() - begun >= 3_000).then_some(begun + 2_900))
        }))
    });
    assert_eq!(first_look(&later), Some(3_000));
    assert_eq!(later.removed(), strs(&["draft-1"]));
    // A marker up to 1 s before the start Relay works out still counts.
    let rounded = up(2_000);
    let early = rounded.now() - 2_000 - 1_000;
    rounded.set(|k| k.wiped_at = Some(Arc::new(move |_| Ok(Some(early)))));
    assert_eq!(first_look(&rounded), Some(0));
    // The last Claude's wipe, and a marker that cannot be read, are no marker: 15 s it is.
    let old = up(2_000);
    let before = old.now() - 2_000 - 1_001;
    old.set(|k| k.wiped_at = Some(Arc::new(move |_| Ok(Some(before)))));
    assert_eq!(first_look(&old), Some(13_000));
    let unreadable = up(2_000);
    unreadable.set(|k| k.wiped_at = Some(Arc::new(|_| Err(DesktopHostError::other("EACCES")))));
    assert_eq!(first_look(&unreadable), Some(13_000));
    assert_eq!(unreadable.removed(), strs(&["draft-1"]));
    // Up 15 s already: the marker is not read at all.
    let up15 = base();
    up15.set(|k| k.wiped_at = Some(Arc::new(|_| panic!("not read"))));
    assert_eq!(first_look(&up15), Some(0));
    assert_eq!(up15.st().wipe_reads, 0);
}

#[test]
fn right_after_a_switch_a_run_waits_up_to_10_s_for_claude_to_start() {
    // Claude starts 3 s after the switch; Desktop's wipe is done 2 s after that.
    let h = base();
    let switched = h.now();
    let starts_at = switched + 3_000;
    let (a, b, c) = (h.desk.clone(), h.desk.clone(), h.desk.clone());
    h.set(|k| {
        k.running = Some(Arc::new(move |_| a.now() >= starts_at));
        k.uptime = Some(Arc::new(move |_| Some(b.now() - starts_at)));
        k.wiped_at = Some(Arc::new(move |_| {
            Ok((c.now() >= starts_at + 2_000).then_some(starts_at + 2_000))
        }));
    });
    let at: Arc<Mutex<Option<i64>>> = Arc::default();
    let (seen, desk) = (Arc::clone(&at), h.desk.clone());
    h.set(|k| {
        k.inspect = Some(Arc::new(move |n| {
            if n == 1 {
                *seen.lock().unwrap() = Some(desk.now() - switched);
            }
            None
        }))
    });
    let launching = RestoreOptions {
        launching: Some(true),
        ..RestoreOptions::default()
    };
    assert_eq!(h.restore_with(launching).restored, 1);
    assert_eq!(*at.lock().unwrap(), Some(5_000));
    // Without `launching`, a Claude not running yet is not waited for.
    let later = harness(Opts {
        running: Some(false),
        ..Opts::default()
    });
    assert_eq!(later.restore().status, Waiting);
    assert!(later.sleeps().is_empty());
    // A Claude that never starts: 10 s, then the drafts wait for the next run.
    let never = harness(Opts {
        running: Some(false),
        ..Opts::default()
    });
    assert_eq!(never.restore_with(launching), res(Waiting, 0, 1, None));
    assert_eq!(sum(&never.sleeps()), 10_000);
    assert!(never.calls().is_empty());
}

#[test]
fn restores_one_draft_and_returns_to_the_users_conversation() {
    let h = base();
    assert_eq!(h.restore(), res(Done, 1, 0, None));
    assert_eq!(h.opens(), opened(&[&target(1), HOME]));
    assert_eq!(h.writes(), written(&[&target(1)]));
    assert_eq!(h.composer(&target(1)).as_deref(), Some("draft 1"));
    assert_eq!(h.removed(), strs(&["draft-1"]));
    assert!(h.marks().is_empty());
    assert_eq!(h.notes(), notes(1, 0));
    // The text is checked again 5 s after it was written.
    assert!(h.sleeps().contains(&5_000));
    // Only the wait for Desktop's UI inspects outside the lock; every action is under it.
    assert_eq!(h.st().outside_lock, strs(&["inspect"]));
}

#[test]
fn a_non_empty_composer_is_never_written() {
    let h = harness(Opts {
        composers: vec![(target(1), "the user is typing".into())],
        ..Opts::default()
    });
    assert_eq!(h.restore(), res(Done, 0, 1, None));
    assert!(h.writes().is_empty());
    assert_eq!(
        h.composer(&target(1)).as_deref(),
        Some("the user is typing")
    );
    assert_eq!(h.marks(), vec![copy("draft-1", "composer-not-empty")]);
    assert_eq!(h.notes(), notes(0, 1));
    // The user typing between the look and the write: the helper refuses, and once is enough.
    let raced = base();
    raced.set(|k| k.write = Some(Arc::new(|_| Some(issue(I::ComposerNotEmpty)))));
    raced.restore();
    assert_eq!(raced.writes(), written(&[&target(1)]));
    assert_eq!(raced.marks(), vec![copy("draft-1", "composer-not-empty")]);
    // A composer with text is not waited on for a guard: nothing will be typed there anyway.
    let unguarded = harness(Opts {
        shown: Some(Some(target(1))),
        composers: vec![(target(1), "the user's own words".into())],
        ..Opts::default()
    });
    unguarded.screen_patch(&target(1), |p| p.permission_mode = Some(None));
    unguarded.restore();
    assert_eq!(
        unguarded.marks(),
        vec![copy("draft-1", "composer-not-empty")]
    );
    assert!(unguarded.sleeps().is_empty());
}

#[test]
fn a_busy_conversation_is_never_written() {
    for status in [SessionStatus::Running, SessionStatus::Waiting] {
        let h = harness(Opts {
            statuses: vec![(target(1), status)],
            ..Opts::default()
        });
        assert_eq!(h.restore().left, 1);
        assert!(h.writes().is_empty());
        assert_eq!(h.marks(), vec![copy("draft-1", "busy")]);
    }
}

#[test]
fn a_conversation_shown_without_a_composer_is_never_written() {
    // "Claude finished the response" is on screen, so the helper says stopped.
    let h = harness(Opts {
        no_composer: vec![target(1)],
        statuses: vec![(target(1), SessionStatus::Stopped)],
        ..Opts::default()
    });
    assert_eq!(h.restore().left, 1);
    assert!(h.writes().is_empty());
    assert_eq!(h.marks(), vec![copy("draft-1", "no-composer")]);
    // It is given the full 30 s to show its composer.
    assert_eq!(sum(&h.sleeps()), 30_000);
    // An older helper that does not report composerPresent proves no composer either.
    let older = base();
    older.patch(|p| p.composer_present = Some(None));
    older.restore();
    assert!(older.writes().is_empty());
    assert_eq!(older.marks(), vec![copy("draft-1", "no-composer")]);
}

#[test]
fn missing_accessibility_stops_at_once() {
    let h = with_records(vec![record(1), record(2), fresh(3)]);
    h.set(|k| {
        k.inspect = Some(Arc::new(|_| {
            Some(issue(I::AccessibilityPermissionRequired))
        }))
    });
    assert_eq!(h.restore(), res(Done, 0, 3, None));
    assert_eq!(h.st().inspects, 1);
    assert!(h.sleeps().is_empty());
    assert!(h.opens().is_empty());
    assert_eq!(
        h.marks(),
        vec![
            copy("draft-1", "accessibility"),
            copy("draft-2", "accessibility"),
            copy("draft-3", "accessibility"),
        ]
    );
    assert_eq!(h.notes(), notes(0, 3));
}

#[test]
fn accessibility_lost_mid_restore_stops_at_once_and_leaves_the_rest_for_copy() {
    let h = with_records(vec![record(1), record(2), record(3)]);
    h.set(|k| {
        k.write = Some(Arc::new(|n| {
            (n == 2).then(|| issue(I::AccessibilityPermissionRequired))
        }))
    });
    assert_eq!(h.restore(), res(Done, 1, 2, None));
    assert_eq!(h.removed(), strs(&["draft-1"]));
    // Without accessibility nothing was typed: both stay retryable once access is granted.
    assert_eq!(
        h.marks(),
        vec![
            copy("draft-2", "accessibility"),
            copy("draft-3", "accessibility")
        ]
    );
    // Nothing more is tried in Desktop: no third conversation, no return.
    assert_eq!(h.calls().last(), Some(&format!("write:{}", target(2))));
}

#[test]
fn accessibility_revoked_at_the_re_check_after_a_write_leaves_that_draft_maybe_typed_so_a_grant_moves_back_only_the_rest()
 {
    let h = with_records(vec![record(1), record(2), record(3)]);
    let revoked = flag();
    let r = Arc::clone(&revoked);
    let s = Arc::clone(&revoked);
    h.set(|k| {
        k.sleep = Some(Arc::new(move |ms| {
            if ms == 5_000 {
                r.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }));
        k.inspect = Some(Arc::new(move |_| {
            is_set(&s).then(|| issue(I::AccessibilityPermissionRequired))
        }));
    });
    assert_eq!(h.restore(), res(Done, 0, 3, None));
    assert_eq!(h.writes(), written(&[&target(1)]));
    assert_eq!(
        h.marks(),
        vec![
            copy("draft-1", "maybe-typed"),
            copy("draft-2", "accessibility"),
            copy("draft-3", "accessibility"),
        ]
    );
    // Granted again: the draft that may be in its composer is never typed a second time.
    let fake = Arc::clone(&h.fake);
    let mut deps = DraftSchedulerDeps::new(
        Arc::clone(&h.fake) as Arc<dyn RestorerDeps>,
        Box::new(move || {
            Ok(fake
                .pending()
                .unwrap()
                .into_iter()
                .map(|r| DraftSummary {
                    id: r.id,
                    to: r.to,
                    title: r.title,
                    new_session: r.new_session == Some(true),
                    attachments: r.attachments,
                    state: r.state,
                    reason: r.reason,
                    captured_at: r.captured_at,
                })
                .collect())
        }),
        Box::new(|| Ok(())),
        // Re-typing on: only then does a grant move drafts back.
        Box::new(|| true),
    );
    deps.every = Some(Box::new(|_, _| Box::new(|| {})));
    let scheduler = DraftScheduler::new(deps);
    assert_eq!(scheduler.retry_accessibility(false), 2);
    assert_eq!(
        h.marks()[3..],
        [
            ("draft-2".to_owned(), DraftState::Pending, None),
            ("draft-3".to_owned(), DraftState::Pending, None),
        ]
    );
    assert_eq!(
        h.fake
            .pending()
            .unwrap()
            .iter()
            .map(|r| (r.id.clone(), r.state))
            .collect::<Vec<_>>(),
        vec![
            ("draft-1".to_owned(), DraftState::NeedsCopy),
            ("draft-2".to_owned(), DraftState::Pending),
            ("draft-3".to_owned(), DraftState::Pending),
        ]
    );
}

/// Desktop's wipe empties `screen`'s composer at every re-check, or at the first only.
fn wipe_at_recheck(h: &H, screen: String, once: bool) {
    let desk = h.desk.clone();
    let wiped = flag();
    h.set(|k| {
        k.sleep = Some(Arc::new(move |ms| {
            if ms == 5_000 && !(once && is_set(&wiped)) {
                wiped.store(true, std::sync::atomic::Ordering::SeqCst);
                desk.st().composers.remove(&screen);
            }
        }))
    });
}

#[test]
fn text_wiped_after_writing_is_written_once_more_then_left_for_copy() {
    let h = base();
    wipe_at_recheck(&h, target(1), false);
    assert_eq!(h.restore(), res(Done, 0, 1, None));
    assert_eq!(h.writes(), written(&[&target(1), &target(1)]));
    assert_eq!(h.sleeps().iter().filter(|ms| **ms == 5_000).count(), 2);
    assert_eq!(h.marks(), vec![copy("draft-1", "lost")]);
    assert!(h.removed().is_empty());
}

#[test]
fn text_wiped_once_is_written_once_more_and_kept() {
    let h = base();
    wipe_at_recheck(&h, target(1), true);
    assert_eq!(h.restore(), res(Done, 1, 0, None));
    assert_eq!(h.writes().len(), 2);
    assert_eq!(h.composer(&target(1)).as_deref(), Some("draft 1"));
    assert_eq!(h.removed(), strs(&["draft-1"]));
}

/// Runs `change` at the 5 s re-check.
fn at_recheck(h: &H, change: impl Fn(&Desk) + Send + Sync + 'static) {
    let desk = h.desk.clone();
    h.set(|k| {
        k.sleep = Some(Arc::new(move |ms| {
            if ms == 5_000 {
                change(&desk);
            }
        }))
    });
}

#[test]
fn a_re_check_that_cannot_confirm_the_text_leaves_it_for_copy_and_never_writes_again() {
    type Change = Box<dyn Fn(&Desk) + Send + Sync>;
    let cases: Vec<(&str, Change)> = vec![
        (
            "no composer, stopped",
            Box::new(|d: &Desk| {
                let mut st = d.st();
                st.composers.remove(&target(1));
                st.no_composer.insert(target(1));
                st.statuses.insert(target(1), SessionStatus::Stopped);
            }),
        ),
        (
            "no composer, unknown",
            Box::new(|d: &Desk| {
                d.st().no_composer.insert(target(1));
            }),
        ),
        (
            "running with text",
            Box::new(|d: &Desk| {
                d.st().statuses.insert(target(1), SessionStatus::Running);
            }),
        ),
        (
            "waiting with text",
            Box::new(|d: &Desk| {
                d.st().statuses.insert(target(1), SessionStatus::Waiting);
            }),
        ),
        (
            "emptied while running: perhaps sent",
            Box::new(|d: &Desk| {
                let mut st = d.st();
                st.composers.remove(&target(1));
                st.statuses.insert(target(1), SessionStatus::Running);
            }),
        ),
        (
            "another conversation",
            Box::new(|d: &Desk| d.set_shown(Some(ELSEWHERE))),
        ),
        (
            "another Claude process",
            Box::new(|d: &Desk| d.set_pid(789)),
        ),
    ];
    for (name, change) in cases {
        let h = base();
        at_recheck(&h, change);
        assert_eq!(h.restore(), res(Done, 0, 1, None), "{name}");
        assert_eq!(h.writes().len(), 1, "{name}");
        assert!(h.removed().is_empty(), "{name}");
        // It was typed, perhaps it is still there: the panel says to look before pasting.
        assert_eq!(h.marks(), vec![copy("draft-1", "maybe-typed")], "{name}");
    }
}

#[test]
fn a_re_check_inspect_that_fails_leaves_the_draft_as_maybe_typed_and_goes_on() {
    let h = with_records(vec![record(1), record(2)]);
    let fail_next = Arc::new(Mutex::new(false));
    let (a, b, desk) = (
        Arc::clone(&fail_next),
        Arc::clone(&fail_next),
        h.desk.clone(),
    );
    h.set(|k| {
        k.sleep = Some(Arc::new(move |ms| {
            if ms == 5_000 && desk.writes().len() == 1 {
                *a.lock().unwrap() = true;
            }
        }));
        k.inspect = Some(Arc::new(move |_| {
            let mut fail = b.lock().unwrap();
            if !*fail {
                return None;
            }
            *fail = false;
            Some(issue(I::DesktopUiUnsupported))
        }));
    });
    assert_eq!(h.restore(), res(Done, 1, 1, None));
    assert_eq!(h.marks(), vec![copy("draft-1", "maybe-typed")]);
    assert_eq!(h.removed(), strs(&["draft-2"]));
}

#[test]
fn context_changed_leaves_the_record_for_copy_and_continues_with_the_next() {
    // The screen still shows the conversation Relay opened: it goes on.
    let h = with_records(vec![record(1), record(2)]);
    h.set(|k| k.write = Some(Arc::new(|n| (n == 1).then(|| issue(I::ContextChanged)))));
    assert_eq!(h.restore(), res(Done, 1, 1, None));
    assert_eq!(h.writes(), written(&[&target(1), &target(2)]));
    assert_eq!(h.marks(), vec![copy("draft-1", "maybe-typed")]);
    assert_eq!(h.removed(), strs(&["draft-2"]));
    assert_eq!(h.opens(), opened(&[&target(1), &target(2), HOME]));
    assert_eq!(h.notes(), notes(1, 1));
    // The context changed because the user moved: it stops there and leaves them be.
    let moved = with_records(vec![record(1), record(2)]);
    let desk = moved.desk.clone();
    moved.set(|k| {
        k.write = Some(Arc::new(move |n| {
            if n != 1 {
                return None;
            }
            desk.set_shown(Some(ELSEWHERE));
            Some(issue(I::ContextChanged))
        }))
    });
    assert_eq!(moved.restore(), res(Waiting, 0, 2, Some("moved")));
    assert_eq!(moved.marks(), vec![copy("draft-1", "maybe-typed")]);
    assert_eq!(moved.opens(), opened(&[&target(1)]));
}

#[test]
fn a_write_that_may_have_typed_something_is_never_retried() {
    for name in [
        I::DeliveryAmbiguous,
        I::DesktopUiUnsupported,
        I::DesktopWorkActive,
    ] {
        let h = base();
        h.set(|k| k.write = Some(Arc::new(move |_| Some(issue(name)))));
        h.restore();
        assert_eq!(h.writes().len(), 1);
        assert_eq!(h.marks(), vec![copy("draft-1", "maybe-typed")]);
    }
}

#[test]
fn once_a_write_was_tried_a_draft_left_for_copy_is_maybe_typed_unless_lost_or_the_composer_was_not_empty()
 {
    for name in [
        I::ContextChanged,
        I::DeliveryAmbiguous,
        I::DesktopUiUnsupported,
        I::DesktopWorkActive,
        I::ExactSessionNotObserved,
        I::PermissionModeMismatch,
        I::DesktopObservationIncomplete,
    ] {
        let h = base();
        h.set(|k| k.write = Some(Arc::new(move |_| Some(issue(name)))));
        assert_eq!(h.restore().left, 1, "{}", name.as_str());
        assert_eq!(
            h.marks(),
            vec![copy("draft-1", "maybe-typed")],
            "{}",
            name.as_str()
        );
    }
    // The helper saw text in the composer and typed nothing: it says so.
    let full = base();
    full.set(|k| k.write = Some(Arc::new(|_| Some(issue(I::ComposerNotEmpty)))));
    full.restore();
    assert_eq!(full.marks(), vec![copy("draft-1", "composer-not-empty")]);
    // Typed twice and wiped twice: it is not there, and the panel says so.
    let wiped = base();
    wipe_at_recheck(&wiped, target(1), false);
    wiped.restore();
    assert_eq!(wiped.marks(), vec![copy("draft-1", "lost")]);
    // Before any write the reason is kept as it is.
    let busy = harness(Opts {
        statuses: vec![(target(1), SessionStatus::Running)],
        ..Opts::default()
    });
    busy.restore();
    assert_eq!(busy.marks(), vec![copy("draft-1", "busy")]);
    // Claude quitting during the re-check of a typed draft: the run stops, maybe typed.
    let quit = with_records(vec![record(1), record(2)]);
    at_recheck(&quit, |d| {
        d.st().hooks.inspect = Some(Arc::new(|_| Some(issue(I::ClaudeNotRunning))));
    });
    assert_eq!(
        quit.restore(),
        res(Waiting, 0, 2, Some("claude-not-running"))
    );
    assert_eq!(quit.marks(), vec![copy("draft-1", "maybe-typed")]);
}

/// Runs `change` when the vault removes a record.
fn at_remove(h: &H, change: impl Fn(&Desk) + Send + Sync + 'static) {
    let desk = h.desk.clone();
    h.set(|k| {
        k.vault = Some(Arc::new(move |(op, _)| {
            if op == "remove" {
                change(&desk);
            }
            None
        }))
    });
}

#[test]
fn the_user_moving_between_drafts_stops_the_restore_and_is_never_sent_back() {
    // After the first draft the user opens another conversation.
    let h = with_records(vec![record(1), record(2)]);
    at_remove(&h, |d| d.set_shown(Some(ELSEWHERE)));
    assert_eq!(h.restore(), res(Waiting, 1, 1, Some("moved")));
    assert_eq!(h.opens(), opened(&[&target(1)]));
    assert_eq!(h.notes(), notes(1, 0));
    // After the last draft: it is done, and does not take the user back.
    let last = base();
    at_remove(&last, |d| d.set_shown(Some(ELSEWHERE)));
    assert_eq!(last.restore(), res(Done, 1, 0, None));
    assert_eq!(last.opens(), opened(&[&target(1)]));
    // A look at the screen that fails counts as the user moving.
    let unseen = with_records(vec![record(1), record(2)]);
    let fail_next = Arc::new(Mutex::new(false));
    let a = Arc::clone(&fail_next);
    at_remove(&unseen, move |_| *a.lock().unwrap() = true);
    unseen.set(|k| {
        k.inspect = Some(Arc::new(move |_| {
            let mut fail = fail_next.lock().unwrap();
            if !*fail {
                return None;
            }
            *fail = false;
            Some(issue(I::DesktopUiUnsupported))
        }))
    });
    assert_eq!(unseen.restore(), res(Waiting, 1, 1, Some("moved")));
    assert_eq!(unseen.opens(), opened(&[&target(1)]));
    // The screen changing between the wait for the UI and the first lock is no move: Relay
    // brings the user back to where the first lock found them.
    let early = base();
    let desk = early.desk.clone();
    early.set(|k| {
        k.inspect = Some(Arc::new(move |n| {
            if n == 2 {
                desk.set_shown(Some(ELSEWHERE));
            }
            None
        }))
    });
    assert_eq!(early.restore(), res(Done, 1, 0, None));
    assert_eq!(early.opens(), opened(&[&target(1), ELSEWHERE]));
}

#[test]
fn the_conditions_are_read_again_under_each_lock() {
    type Change = Box<dyn Fn(&Desk) + Send + Sync>;
    let changes: Vec<(&str, Change)> = vec![
        (
            "the account",
            Box::new(|d: &Desk| d.set_account(Some(OTHER))),
        ),
        ("Claude's pid", Box::new(|d: &Desk| d.set_pid(789))),
        (
            "Claude's uptime",
            Box::new(|d: &Desk| d.st().hooks.uptime = Some(Arc::new(|_| Some(3_000)))),
        ),
    ];
    for (name, change) in changes {
        let h = with_records(vec![record(1), record(2)]);
        at_remove(&h, change);
        assert_eq!(h.restore(), res(Waiting, 1, 1, Some("changed")), "{name}");
        assert_eq!(h.opens(), opened(&[&target(1)]), "{name}");
    }
    // A switch relaunched Claude between the first look and the first lock.
    let relaunched = base();
    relaunched.set(|k| k.uptime = Some(Arc::new(|n| Some(if n == 1 { 20_000 } else { 3_000 }))));
    assert_eq!(relaunched.restore(), res(Waiting, 0, 1, Some("changed")));
    assert!(relaunched.opens().is_empty());
}

#[test]
fn a_failed_read_before_or_under_the_lock_leaves_the_drafts_pending() {
    let h = base();
    h.set(|k| {
        k.pending = Some(Arc::new(|_| {
            Some(DesktopHostError::other("vault unreadable"))
        }))
    });
    assert_eq!(h.restore().status, Waiting);
    assert!(h.calls().is_empty());
    assert!(h.marks().is_empty());
    // The account read under the second lock fails.
    let later = with_records(vec![record(1), record(2)]);
    let reads = Arc::new(Mutex::new(0));
    later.set(|k| {
        k.current_account = Some(Arc::new(move |_| {
            let mut reads = reads.lock().unwrap();
            *reads += 1;
            if *reads > 2 {
                return Err(DesktopHostError::other("config unreadable"));
            }
            Ok(Some(ACCOUNT.into()))
        }))
    });
    assert_eq!(later.restore(), res(Waiting, 1, 1, Some("changed")));
    assert_eq!(later.opens(), opened(&[&target(1)]));
}

#[test]
fn a_busy_desktop_with_lock_gives_undefined_does_nothing() {
    let h = harness(Opts {
        lock_busy: true,
        ..Opts::default()
    });
    assert_eq!(h.restore(), res(Waiting, 0, 1, Some("busy")));
    // It may have looked at the screen; it took no action in Desktop or the vault.
    assert!(h.opens().is_empty());
    assert!(h.writes().is_empty());
    assert!(h.marks().is_empty());
    assert!(h.removed().is_empty());
    assert!(h.notes().is_empty());
    // A switch takes the lock after the first draft: the rest stay pending.
    let switching = with_records(vec![record(1), record(2), record(3)]);
    switching.set(|k| k.busy = Some(Arc::new(|n| n == 2)));
    assert_eq!(switching.restore(), res(Waiting, 1, 2, Some("busy")));
    assert_eq!(switching.opens(), opened(&[&target(1)]));
    assert!(switching.marks().is_empty());
    assert_eq!(switching.notes(), notes(1, 0));
}

#[test]
fn the_whole_restore_stops_after_5_minutes() {
    // No conversation ever shows, so each draft takes its full 30 s.
    let h = with_records((1..=12).map(record).collect());
    h.set(|k| k.open = Some(Arc::new(|_| Open::Ignored)));
    assert_eq!(h.restore(), res(Waiting, 0, 12, Some("budget")));
    assert_eq!(h.marks().len(), 10);
    assert!(
        h.marks()
            .iter()
            .all(|(_, _, reason)| reason.as_deref() == Some("exact-session-not-observed"))
    );
    assert_eq!(sum(&h.sleeps()), 300_000);
}

#[test]
fn a_target_shown_without_a_guard_stops_the_restore_and_leaves_the_rest_as_unsupported() {
    let h = with_records(vec![record(1), record(2), record(3)]);
    h.patch(|p| p.account_label = Some(None));
    assert_eq!(h.restore(), res(Done, 0, 3, None));
    assert!(h.writes().is_empty());
    assert_eq!(h.opens(), opened(&[&target(1)]));
    assert_eq!(
        h.marks(),
        vec![
            copy("draft-1", "unsupported"),
            copy("draft-2", "unsupported"),
            copy("draft-3", "unsupported"),
        ]
    );
}

#[test]
fn drafts_too_long_with_a_nul_or_without_a_valid_alias_go_straight_to_copy() {
    let h = with_records(vec![
        fresh_with(3, |r| r.text = "x".repeat(16_385)),
        record_with(4, |r| r.text = "x".repeat(16_385)),
        record_with(6, |r| r.target_alias = Some("../not-a-uuid".into())),
        record_with(5, |r| r.text = "y".repeat(16_384)),
        fresh_with(7, |r| r.text = "a\0b".into()),
    ]);
    assert_eq!(h.restore(), res(Done, 1, 4, None));
    assert_eq!(
        h.marks(),
        vec![
            copy("draft-3", "manual"),
            copy("draft-4", "manual"),
            copy("draft-6", "manual"),
            copy("draft-7", "manual"),
        ]
    );
    // Only the draft that fits is typed; the limit is inclusive.
    assert_eq!(h.writes(), written(&[&target(5)]));
    assert_eq!(h.opens(), opened(&[&target(5), HOME]));
    // Nothing to open, nothing to return from.
    let alone = with_records(vec![fresh_with(3, |r| r.text = "x".repeat(16_385))]);
    alone.restore();
    assert!(alone.opens().is_empty());
    assert_eq!(alone.marks(), vec![copy("draft-3", "manual")]);
}

#[test]
fn the_new_session_draft_is_typed_into_the_new_session_screen_and_the_user_is_taken_back() {
    let h = with_records(vec![fresh(3)]);
    assert_eq!(h.restore(), res(Done, 1, 0, None));
    assert_eq!(h.opens(), opened(&[NEW, HOME]));
    assert_eq!(h.writes(), written(&[NEW]));
    assert_eq!(h.composer(NEW).as_deref(), Some("draft 3"));
    assert_eq!(h.removed(), strs(&["draft-3"]));
    assert!(h.marks().is_empty());
    assert_eq!(h.notes(), notes(1, 0));
    // It is read again 5 s later, as a conversation's is.
    assert!(h.sleeps().contains(&5_000));
    // Every link asks the helper to check the user right before it opens.
    let idle = Some(OpenSessionOptions {
        require_idle: Some(true),
    });
    assert_eq!(h.st().open_options, vec![idle, idle]);
    // Only the wait for Desktop's UI inspects outside the lock.
    assert_eq!(h.st().outside_lock, strs(&["inspect"]));
    // Its guard names the screen, never a conversation.
    match &h.st().guards[0] {
        DesktopDraftGuard::NewSession(guard) => assert!(guard.new_session),
        other => panic!("not the new-session screen: {other:?}"),
    }
}

#[test]
fn a_new_session_draft_goes_in_with_the_conversations_drafts_one_screen_after_another() {
    let h = with_records(vec![record(1), fresh(3), record(2)]);
    assert_eq!(h.restore(), res(Done, 3, 0, None));
    assert_eq!(h.opens(), opened(&[&target(1), NEW, &target(2), HOME]));
    assert_eq!(h.writes(), written(&[&target(1), NEW, &target(2)]));
    assert_eq!(h.removed(), strs(&["draft-1", "draft-3", "draft-2"]));
}

#[test]
fn on_the_new_session_screen_already_the_draft_is_typed_where_the_user_is() {
    let h = harness(Opts {
        records: Some(vec![fresh(3)]),
        shown: Some(Some(NEW.into())),
        ..Opts::default()
    });
    assert_eq!(h.restore(), res(Done, 1, 0, None));
    assert!(h.opens().is_empty());
    assert_eq!(h.writes(), written(&[NEW]));
    // A user who started there is taken back there after a conversation's draft.
    let back = harness(Opts {
        records: Some(vec![record(1)]),
        shown: Some(Some(NEW.into())),
        ..Opts::default()
    });
    assert_eq!(back.restore().restored, 1);
    assert_eq!(back.opens(), opened(&[&target(1), NEW]));
    assert_eq!(back.desk.shown().as_deref(), Some(NEW));
}

#[test]
fn a_new_session_composer_with_the_users_own_text_is_never_written() {
    for shown in [HOME, NEW] {
        let h = harness(Opts {
            records: Some(vec![fresh(3)]),
            shown: Some(Some(shown.into())),
            composers: vec![(NEW.into(), "a session the user is starting".into())],
            ..Opts::default()
        });
        assert_eq!(h.restore(), res(Done, 0, 1, None));
        assert!(h.writes().is_empty());
        assert_eq!(
            h.composer(NEW).as_deref(),
            Some("a session the user is starting")
        );
        assert_eq!(h.marks(), vec![copy("draft-3", "composer-not-empty")]);
    }
}

#[test]
fn the_new_session_screen_needs_no_permission_mode_but_its_account() {
    // The mode may not be read there: the guard is built without it.
    let modeless = with_records(vec![fresh(3)]);
    modeless.screen_patch(NEW, |p| p.permission_mode = Some(None));
    assert_eq!(modeless.restore().restored, 1);
    let guard = serde_json::to_value(&modeless.st().guards[0]).unwrap();
    let mut keys: Vec<&String> = guard.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(
        keys,
        ["accountLabel", "contextFingerprint", "newSession", "pid"]
    );
    // Without its account no guard can be built: only that draft is left for copy, after the
    // 30 s it is given to show one, and the conversations' drafts go on.
    let h = with_records(vec![fresh(3), record(1)]);
    h.screen_patch(NEW, |p| p.account_label = Some(None));
    assert_eq!(h.restore(), res(Done, 1, 1, None));
    assert_eq!(h.marks(), vec![copy("draft-3", "unsupported")]);
    assert_eq!(h.writes(), written(&[&target(1)]));
    assert_eq!(h.opens(), opened(&[NEW, &target(1), HOME]));
    let sleeps = h.sleeps();
    let recheck = sleeps.iter().position(|ms| *ms == 5_000).unwrap();
    assert_eq!(sum(&sleeps[..recheck]), 30_000);
}

#[test]
fn a_new_session_screen_that_never_shows_is_left_for_copy_after_30_s_with_the_link_sent_every_5_s()
{
    let h = with_records(vec![fresh(3), record(1)]);
    h.set(|k| {
        k.open = Some(Arc::new(
            |id| if id == NEW { Open::Ignored } else { Open::Go },
        ))
    });
    assert_eq!(h.restore(), res(Done, 1, 1, None));
    assert_eq!(
        h.marks(),
        vec![copy("draft-3", "exact-session-not-observed")]
    );
    assert_eq!(
        h.opens()
            .iter()
            .filter(|c| **c == format!("open:{NEW}"))
            .count(),
        6
    );
    assert_eq!(h.writes(), written(&[&target(1)]));
}

#[test]
fn text_wiped_from_the_new_session_composer_is_written_once_more_a_screen_that_changed_is_maybe_typed()
 {
    let h = with_records(vec![fresh(3)]);
    wipe_at_recheck(&h, NEW.into(), true);
    assert_eq!(h.restore().restored, 1);
    assert_eq!(h.writes(), written(&[NEW, NEW]));
    assert_eq!(h.composer(NEW).as_deref(), Some("draft 3"));
    // Wiped twice: not there, and the panel says so.
    let lost = with_records(vec![fresh(3)]);
    wipe_at_recheck(&lost, NEW.into(), false);
    lost.restore();
    assert_eq!(lost.marks(), vec![copy("draft-3", "lost")]);
    // A conversation on screen at the re-check: typed, perhaps still there; never again.
    let moved = with_records(vec![fresh(3)]);
    at_recheck(&moved, |d| d.set_shown(Some(ELSEWHERE)));
    moved.restore();
    assert_eq!(moved.writes().len(), 1);
    assert_eq!(moved.marks(), vec![copy("draft-3", "maybe-typed")]);
    // The guard lost at the re-check, then the composer emptied: typed once, maybe there.
    let unguarded = with_records(vec![fresh(3)]);
    at_recheck(&unguarded, |d| {
        let mut st = d.st();
        st.composers.remove(NEW);
        st.screen_patch.entry(NEW.into()).or_default().account_label = Some(None);
    });
    unguarded.restore();
    assert_eq!(unguarded.writes().len(), 1);
    assert_eq!(unguarded.marks(), vec![copy("draft-3", "maybe-typed")]);
}

#[test]
fn the_user_active_leaves_the_new_session_draft_pending_and_the_helper_refusing_its_link_opens_nothing()
 {
    let h = with_records(vec![fresh(3)]);
    h.activity(|a| a.idle_ms = Some(1_000));
    assert_eq!(h.restore(), res(Waiting, 0, 1, Some("active")));
    assert!(h.opens().is_empty());
    assert!(h.marks().is_empty());
    // The user starts typing between Relay's look and the helper's own, just before it opens.
    let racing = with_records(vec![fresh(3)]);
    racing.set(|k| {
        k.open = Some(Arc::new(|id| {
            if id == NEW {
                Open::Fail(issue(I::UserActive))
            } else {
                Open::Go
            }
        }))
    });
    assert_eq!(racing.restore(), res(Waiting, 0, 1, Some("active")));
    assert_eq!(racing.opens(), opened(&[NEW]));
    assert_eq!(racing.desk.shown().as_deref(), Some(HOME));
    assert!(racing.writes().is_empty());
    assert!(racing.marks().is_empty());
    // A write refused because the user is active: still pending, nothing typed.
    let typing = with_records(vec![fresh(3)]);
    typing.set(|k| k.write = Some(Arc::new(|_| Some(issue(I::UserActive)))));
    assert_eq!(typing.restore().reason.as_deref(), Some("active"));
    assert_eq!(typing.composer(NEW), None);
    assert!(typing.marks().is_empty());
}

/// From the `n`th 500 ms sleep on, `change` runs once.
fn at_nap(h: &H, n: u32, change: impl Fn(&Desk) + Send + Sync + 'static) {
    let desk = h.desk.clone();
    let slept = Arc::new(Mutex::new(0));
    h.set(|k| {
        k.sleep = Some(Arc::new(move |ms| {
            if ms != 500 {
                return;
            }
            let mut slept = slept.lock().unwrap();
            *slept += 1;
            if *slept == n {
                change(&desk);
            }
        }))
    });
}

#[test]
fn the_user_going_to_the_new_session_screen_while_a_conversation_loads_has_moved_and_is_left_there()
{
    // The link is sent, and before Desktop follows it the user opens the new-session screen.
    let h = with_records(vec![record(1), record(2)]);
    let desk = h.desk.clone();
    h.set(|k| {
        k.open = Some(Arc::new(move |id| {
            if id != target(1) {
                return Open::Go;
            }
            desk.set_shown(Some(NEW));
            Open::Ignored
        }))
    });
    assert_eq!(h.restore(), res(Waiting, 0, 2, Some("moved")));
    // No second link, nothing typed, and no return.
    assert_eq!(h.opens(), opened(&[&target(1)]));
    assert!(h.writes().is_empty());
    assert!(h.marks().is_empty());
    assert_eq!(h.desk.shown().as_deref(), Some(NEW));
    // The user goes there 4 s into a slow load: the 5 s re-send never comes.
    let late = base();
    late.set(|k| k.open = Some(Arc::new(|_| Open::Ignored)));
    at_nap(&late, 8, |d| d.set_shown(Some(NEW)));
    assert_eq!(late.restore().reason.as_deref(), Some("moved"));
    assert_eq!(late.opens(), opened(&[&target(1)]));
    // And from the new-session screen's wait to a conversation, the same.
    let away = with_records(vec![fresh(3)]);
    let desk = away.desk.clone();
    away.set(|k| {
        k.open = Some(Arc::new(move |id| {
            if id != NEW {
                return Open::Go;
            }
            desk.set_shown(Some(ELSEWHERE));
            Open::Ignored
        }))
    });
    assert_eq!(away.restore().reason.as_deref(), Some("moved"));
    assert_eq!(away.opens(), opened(&[NEW]));
    assert_eq!(away.desk.shown().as_deref(), Some(ELSEWHERE));
    // Between drafts, too: after the first, the user opens the new-session screen.
    let between = with_records(vec![record(1), record(2)]);
    at_remove(&between, |d| d.set_shown(Some(NEW)));
    assert_eq!(between.restore(), res(Waiting, 1, 1, Some("moved")));
    assert_eq!(between.opens(), opened(&[&target(1)]));
}

#[test]
fn a_ui_that_is_not_ready_in_60_s_leaves_every_draft_pending() {
    let h = base();
    h.set(|k| k.inspect = Some(Arc::new(|_| Some(issue(I::DesktopUiUnsupported)))));
    assert_eq!(h.restore(), res(Waiting, 0, 1, Some("not-ready")));
    assert!(h.sleeps().iter().all(|ms| *ms == 500));
    assert_eq!(sum(&h.sleeps()), 60_000);
    // The wait holds no lock and takes no action.
    assert!(h.actions_outside_lock().is_empty());
    assert!(h.opens().is_empty());
    assert!(h.marks().is_empty());
    assert!(h.notes().is_empty());
}

#[test]
fn a_conversation_that_never_shows_is_left_for_copy_after_30_s() {
    let h = with_records(vec![record(1), record(2)]);
    h.set(|k| {
        k.open = Some(Arc::new(|id| {
            if id == target(1) {
                Open::Ignored
            } else {
                Open::Go
            }
        }))
    });
    assert_eq!(h.restore(), res(Done, 1, 1, None));
    assert_eq!(
        h.marks(),
        vec![copy("draft-1", "exact-session-not-observed")]
    );
    // The link is sent again every 5 s, for up to 30 s.
    assert_eq!(
        h.opens()
            .iter()
            .filter(|c| **c == format!("open:{}", target(1)))
            .count(),
        6
    );
    let sleeps = h.sleeps();
    let recheck = sleeps.iter().position(|ms| *ms == 5_000).unwrap();
    assert_eq!(sum(&sleeps[..recheck]), 30_000);
    assert_eq!(h.writes(), written(&[&target(2)]));
}

#[test]
fn an_open_that_fails_without_halting_is_sent_again() {
    let h = base();
    let opens = Arc::new(Mutex::new(0));
    h.set(|k| {
        k.open = Some(Arc::new(move |_| {
            let mut opens = opens.lock().unwrap();
            *opens += 1;
            if *opens == 1 {
                Open::Fail(issue(I::DesktopUiUnsupported))
            } else {
                Open::Go
            }
        }))
    });
    assert_eq!(h.restore().restored, 1);
    assert_eq!(h.opens()[..2], opened(&[&target(1), &target(1)]));
    // One that always fails is left for copy once the 30 s are over.
    let never = base();
    never.set(|k| {
        k.open = Some(Arc::new(|id| {
            if id == target(1) {
                Open::Fail(issue(I::DesktopUiUnsupported))
            } else {
                Open::Go
            }
        }))
    });
    never.restore();
    assert_eq!(
        never.marks(),
        vec![copy("draft-1", "exact-session-not-observed")]
    );
    assert!(never.writes().is_empty());
}

#[test]
fn claude_quitting_mid_restore_stops_and_the_rest_stay_pending() {
    let h = with_records(vec![record(1), record(2), record(3)]);
    h.set(|k| {
        k.open = Some(Arc::new(|id| {
            if id == target(2) {
                Open::Fail(issue(I::ClaudeNotRunning))
            } else {
                Open::Go
            }
        }))
    });
    assert_eq!(h.restore(), res(Waiting, 1, 2, Some("claude-not-running")));
    assert_eq!(h.removed(), strs(&["draft-1"]));
    assert!(h.marks().is_empty());
    assert_eq!(h.calls().last(), Some(&format!("open:{}", target(2))));
    // What was restored is still told.
    assert_eq!(h.notes(), notes(1, 0));
}

#[test]
fn claude_quitting_during_a_write_leaves_that_draft_for_copy_never_for_a_blind_retry() {
    let h = with_records(vec![record(1), record(2)]);
    h.set(|k| k.write = Some(Arc::new(|_| Some(issue(I::ClaudeNotRunning)))));
    assert_eq!(h.restore(), res(Waiting, 0, 2, Some("claude-not-running")));
    assert_eq!(h.marks(), vec![copy("draft-1", "maybe-typed")]);
    assert_eq!(h.calls().last(), Some(&format!("write:{}", target(1))));
}

#[test]
fn a_vault_that_fails_to_mark_or_remove_does_not_stop_the_other_drafts() {
    let h = harness(Opts {
        records: Some(vec![record(1), record(2), record(3)]),
        composers: vec![(target(1), "user text".into())],
        ..Opts::default()
    });
    h.set(|k| {
        k.vault = Some(Arc::new(|(op, id)| {
            ((op == "mark" && id == "draft-1") || (op == "remove" && id == "draft-2"))
                .then(|| DesktopHostError::other("vault unreadable"))
        }))
    });
    assert_eq!(h.restore(), res(Done, 2, 1, None));
    assert_eq!(h.writes(), written(&[&target(2), &target(3)]));
    assert_eq!(h.removed(), strs(&["draft-3"]));
    // The draft the vault would not mark is not in the panel, so it is not told as left there.
    assert_eq!(h.notes(), notes(2, 0));
}

#[test]
fn the_return_point_is_used_only_when_it_was_seen_and_differs_from_the_last_conversation() {
    // Where the user is cannot be told: Relay takes them to the drafts all the same, and they
    // stay at the last one.
    let unseen = harness(Opts {
        shown: Some(None),
        records: Some(vec![record(1), fresh(2)]),
        ..Opts::default()
    });
    assert_eq!(unseen.restore().restored, 2);
    assert_eq!(unseen.opens(), opened(&[&target(1), NEW]));
    assert_eq!(unseen.writes(), written(&[&target(1), NEW]));
    // Without visits, as once the first two minutes are over, it waits for the user instead.
    let later = harness(Opts {
        shown: Some(None),
        records: Some(vec![record(1), fresh(2)]),
        ..Opts::default()
    });
    let no_visits = RestoreOptions {
        visits: Some(false),
        ..RestoreOptions::default()
    };
    assert_eq!(
        later.restore_with(no_visits),
        res(Waiting, 0, 2, Some("elsewhere"))
    );
    assert!(later.opens().is_empty());
    assert!(later.writes().is_empty());
    assert!(later.marks().is_empty());
    assert!(later.notes().is_empty());
    // The user was already on the draft's conversation: nothing is opened at all.
    let same = harness(Opts {
        shown: Some(Some(target(1))),
        ..Opts::default()
    });
    assert_eq!(same.restore().restored, 1);
    assert!(same.opens().is_empty());
    // A failed return is ignored.
    let failed = base();
    failed.set(|k| {
        k.open = Some(Arc::new(|id| {
            if id == HOME {
                Open::Fail(issue(I::DesktopUiUnsupported))
            } else {
                Open::Go
            }
        }))
    });
    assert_eq!(failed.restore(), res(Done, 1, 0, None));
    // Desktop busy at the return: the drafts are done, the user stays where they are.
    let busy = base();
    busy.set(|k| k.busy = Some(Arc::new(|n| n == 2)));
    assert_eq!(busy.restore(), res(Done, 1, 0, None));
    assert_eq!(busy.opens(), opened(&[&target(1)]));
}

#[test]
fn the_user_moving_before_the_target_shows_stops_the_restore_and_is_never_taken_back() {
    // The link is sent, and before Desktop follows it the user opens C.
    let h = with_records(vec![record(1), record(2)]);
    let desk = h.desk.clone();
    h.set(|k| {
        k.open = Some(Arc::new(move |id| {
            if id != target(1) {
                return Open::Go;
            }
            desk.set_shown(Some(ELSEWHERE));
            Open::Ignored
        }))
    });
    assert_eq!(h.restore(), res(Waiting, 0, 2, Some("moved")));
    // No second link, nothing typed, and no return to where the user was.
    assert_eq!(h.opens(), opened(&[&target(1)]));
    assert!(h.writes().is_empty());
    assert!(h.marks().is_empty());
    assert_eq!(h.desk.shown().as_deref(), Some(ELSEWHERE));
    // The user moves 4 s into a slow load: the 5 s re-send never comes.
    let late = base();
    late.set(|k| k.open = Some(Arc::new(|_| Open::Ignored)));
    at_nap(&late, 8, |d| d.set_shown(Some(ELSEWHERE)));
    assert_eq!(late.restore().reason.as_deref(), Some("moved"));
    assert_eq!(late.opens(), opened(&[&target(1)]));
    assert!(late.writes().is_empty());
    assert!(late.marks().is_empty());
}

#[test]
fn a_target_already_on_screen_is_not_opened() {
    let h = harness(Opts {
        shown: Some(Some(target(1))),
        ..Opts::default()
    });
    assert_eq!(h.restore(), res(Done, 1, 0, None));
    assert!(h.opens().is_empty());
    assert_eq!(h.writes(), written(&[&target(1)]));
}

#[test]
fn a_draft_whose_place_is_on_screen_is_typed_there_with_1_s_of_quiet_keys_whatever_the_mouse_does()
{
    for shown in [target(1), NEW.to_owned()] {
        let records = if shown == NEW {
            vec![fresh(1)]
        } else {
            vec![record(1)]
        };
        let h = harness(Opts {
            shown: Some(Some(shown.clone())),
            records: Some(records),
            ..Opts::default()
        });
        // The mouse is in use; no key has been pressed for 1 s.
        h.activity(|a| {
            a.idle_ms = Some(0);
            a.key_idle_ms = Some(1_000);
        });
        assert_eq!(h.restore(), res(Done, 1, 0, None));
        assert!(h.opens().is_empty(), "{shown}");
        assert_eq!(h.writes(), written(&[&shown]), "{shown}");
        assert_eq!(h.removed(), strs(&["draft-1"]), "{shown}");
    }
    // Every write asks the helper to check, right before it types, that no key came for 1 s.
    let visit = with_records(vec![record(1), record(2)]);
    assert_eq!(visit.restore().restored, 2);
    let quiet = Some(WriteDraftOptions {
        keys_idle_ms: Some(1_000.0),
    });
    assert_eq!(visit.st().write_options, vec![quiet, quiet]);
    // A key between the look and the write: the helper refuses, and the draft waits.
    let late = harness(Opts {
        shown: Some(Some(target(1))),
        ..Opts::default()
    });
    let desk = late.desk.clone();
    late.set(|k| {
        k.write = Some(Arc::new(move |_| {
            desk.st().activity.key_idle_ms = Some(50);
            None
        }))
    });
    assert_eq!(late.restore(), res(Waiting, 0, 1, Some("active")));
    assert_eq!(late.composer(&target(1)), None);
    assert!(late.marks().is_empty());
}

#[test]
fn the_draft_of_the_place_on_screen_goes_first_and_the_user_is_brought_back_there() {
    let h = harness(Opts {
        records: Some(vec![record(1), record(2), record(3)]),
        shown: Some(Some(target(2))),
        ..Opts::default()
    });
    assert_eq!(h.restore(), res(Done, 3, 0, None));
    assert_eq!(h.writes(), written(&[&target(2), &target(1), &target(3)]));
    assert_eq!(h.opens(), opened(&[&target(1), &target(3), &target(2)]));
    assert_eq!(h.desk.shown(), Some(target(2)));
}

#[test]
fn without_visits_only_the_draft_on_screen_is_typed_and_the_rest_wait_as_elsewhere() {
    let no_visits = RestoreOptions {
        visits: Some(false),
        ..RestoreOptions::default()
    };
    let h = harness(Opts {
        records: Some(vec![record(1), record(2), fresh(3)]),
        shown: Some(Some(target(2))),
        ..Opts::default()
    });
    assert_eq!(
        h.restore_with(no_visits),
        res(Waiting, 1, 2, Some("elsewhere"))
    );
    assert!(h.opens().is_empty());
    assert_eq!(h.writes(), written(&[&target(2)]));
    assert!(h.marks().is_empty());
    assert_eq!(h.notes(), notes(1, 0));
    assert_eq!(
        h.logs()
            .into_iter()
            .filter(|e| e["event"] == "skip")
            .collect::<Vec<_>>(),
        vec![
            json!({ "event": "skip", "id": "draft-1", "visits": false, "returnKnown": true, "screen": null }),
            json!({ "event": "skip", "id": "draft-3", "visits": false, "returnKnown": true, "screen": null }),
        ]
    );
    // Nothing on screen of theirs: nothing is opened, typed or told.
    let none = base();
    assert_eq!(
        none.restore_with(no_visits),
        res(Waiting, 0, 1, Some("elsewhere"))
    );
    assert!(none.calls().iter().all(|c| c == "inspect"));
    assert!(none.notes().is_empty());
    // An idle user changes nothing about it.
    let idle = base();
    idle.activity(|a| a.idle_ms = Some(600_000));
    assert_eq!(
        idle.restore_with(no_visits).reason.as_deref(),
        Some("elsewhere")
    );
    assert!(idle.opens().is_empty());
}

#[test]
fn while_the_screen_shows_where_the_user_was_or_is_loading_the_link_is_sent_again_every_5_s() {
    let h = base();
    let start = h.now();
    let sent: Arc<Mutex<Vec<i64>>> = Arc::default();
    let (log, desk) = (Arc::clone(&sent), h.desk.clone());
    h.set(|k| {
        k.open = Some(Arc::new(move |id| {
            if id != target(1) {
                return Open::Go;
            }
            let mut sent = log.lock().unwrap();
            sent.push(desk.now() - start);
            // Desktop follows the third link. After the second the screen is loading.
            if sent.len() == 2 {
                desk.set_shown(None);
            }
            if sent.len() < 3 {
                Open::Ignored
            } else {
                Open::Go
            }
        }))
    });
    assert_eq!(h.restore(), res(Done, 1, 0, None));
    assert_eq!(*sent.lock().unwrap(), vec![0, 5_000, 10_000]);
    assert_eq!(h.writes(), written(&[&target(1)]));
}

#[test]
fn claude_not_in_front_or_the_user_active_leaves_every_draft_pending_and_opens_nothing() {
    type Change = fn(&mut Activity);
    // Taking the user to the first draft's conversation needs 3 s without any input.
    let away: Vec<(&str, Change)> = vec![
        ("Claude is not frontmost", |a| a.frontmost = Some(false)),
        ("the user was active 1 s ago", |a| a.idle_ms = Some(1_000)),
        ("no frontmost field", |a| a.frontmost = None),
        ("no idleMs field", |a| a.idle_ms = None),
        ("neither field", |a| {
            a.frontmost = None;
            a.idle_ms = None;
        }),
    ];
    // With the first draft's conversation already on screen: Claude in front, no key for 1 s.
    let here: Vec<(&str, Change)> = vec![
        ("Claude is not frontmost", |a| a.frontmost = Some(false)),
        ("a key was pressed 999 ms ago", |a| {
            a.key_idle_ms = Some(999)
        }),
        ("no frontmost field", |a| a.frontmost = None),
        (
            "a helper that tells no keys apart, and input 1 s ago",
            |a| {
                a.key_idle_ms = None;
                a.idle_ms = Some(1_000);
            },
        ),
        ("no field", |a| {
            a.frontmost = None;
            a.idle_ms = None;
            a.key_idle_ms = None;
        }),
    ];
    for (shown, cases) in [(HOME.to_owned(), away), (target(1), here)] {
        for (name, change) in cases {
            let h = harness(Opts {
                records: Some(vec![record(1), record(2)]),
                shown: Some(Some(shown.clone())),
                ..Opts::default()
            });
            h.activity(change);
            assert_eq!(h.restore(), res(Waiting, 0, 2, Some("active")), "{name}");
            assert!(h.opens().is_empty(), "{name}");
            assert!(h.writes().is_empty(), "{name}");
            assert!(h.marks().is_empty(), "{name}");
            assert!(h.notes().is_empty(), "{name}");
        }
    }
    // 3 s without input is enough.
    let idle = base();
    idle.activity(|a| a.idle_ms = Some(3_000));
    assert_eq!(idle.restore().restored, 1);
    // The user turning active between drafts stops the run before the next open.
    let between = with_records(vec![record(1), record(2)]);
    at_remove(&between, |d| d.st().activity.idle_ms = Some(0));
    assert_eq!(between.restore(), res(Waiting, 1, 1, Some("active")));
    assert_eq!(between.opens(), opened(&[&target(1)]));
    // And before the return: the drafts are done, and the user stays where they are.
    let end = base();
    at_remove(&end, |d| d.st().activity.frontmost = Some(false));
    assert_eq!(end.restore(), res(Done, 1, 0, None));
    assert_eq!(end.opens(), opened(&[&target(1)]));
}

#[test]
fn the_user_turning_active_while_the_target_loads_stops_the_run_before_the_link_is_sent_again() {
    let changes: [fn(&Desk); 2] = [
        |d| d.st().activity.idle_ms = Some(200),
        |d| d.st().activity.frontmost = Some(false),
    ];
    for change in changes {
        let h = base();
        h.set(|k| k.open = Some(Arc::new(|_| Open::Ignored)));
        at_nap(&h, 6, change);
        assert_eq!(h.restore(), res(Waiting, 0, 1, Some("active")));
        assert_eq!(h.opens(), opened(&[&target(1)]));
        assert!(h.writes().is_empty());
        assert!(h.marks().is_empty());
    }
}

#[test]
fn a_write_refused_because_the_user_is_active_leaves_the_draft_pending_never_for_copy() {
    let h = with_records(vec![record(1), record(2)]);
    h.set(|k| k.write = Some(Arc::new(|_| Some(issue(I::UserActive)))));
    assert_eq!(h.restore(), res(Waiting, 0, 2, Some("active")));
    assert_eq!(h.writes(), written(&[&target(1)]));
    assert!(h.marks().is_empty());
    assert!(h.removed().is_empty());
    assert!(h.notes().is_empty());
    // The user starts typing as the target shows: the helper's own fresh look refuses.
    let typing = base();
    let desk = typing.desk.clone();
    typing.set(|k| {
        k.inspect = Some(Arc::new(move |_| {
            if desk.shown() == Some(target(1)) {
                let mut st = desk.st();
                st.activity.idle_ms = Some(100);
                st.activity.key_idle_ms = Some(100);
            }
            None
        }))
    });
    assert_eq!(typing.restore(), res(Waiting, 0, 1, Some("active")));
    assert_eq!(typing.composer(&target(1)), None);
    assert!(typing.marks().is_empty());
    assert_eq!(typing.opens(), opened(&[&target(1)]));
}

#[test]
fn a_target_is_waited_for_until_a_guard_can_be_built_from_it() {
    let h = base();
    // Desktop shows the conversation and its composer before its permission mode.
    h.patch(|p| p.permission_mode = Some(None));
    at_nap(&h, 3, |d| d.st().patch.permission_mode = None);
    assert_eq!(h.restore(), res(Done, 1, 0, None));
    assert_eq!(h.writes(), written(&[&target(1)]));
    assert!(h.marks().is_empty());
    // Waiting on the target itself sends no new link.
    assert_eq!(h.opens(), opened(&[&target(1), HOME]));
}

#[test]
fn a_desktop_operation_waiting_for_the_lock_stops_the_restore_before_relay_opens_again_or_types() {
    // It asks while Relay waits for the target to show.
    let h = with_records(vec![record(1), record(2)]);
    h.set(|k| k.open = Some(Arc::new(|_| Open::Ignored)));
    let waiter = flag();
    let slept = Arc::new(Mutex::new(0));
    let (w, s) = (Arc::clone(&waiter), Arc::clone(&slept));
    h.set(|k| {
        k.sleep = Some(Arc::new(move |ms| {
            let mut slept = s.lock().unwrap();
            if ms == 500 {
                *slept += 1;
                if *slept == 2 {
                    w.store(true, std::sync::atomic::Ordering::SeqCst);
                }
            }
        }));
        k.yielding = Some(Arc::new(move |_| is_set(&waiter)));
    });
    assert_eq!(h.restore(), res(Waiting, 0, 2, Some("busy")));
    assert_eq!(h.opens(), opened(&[&target(1)]));
    assert!(h.writes().is_empty());
    assert!(h.marks().is_empty());
    assert_eq!(*slept.lock().unwrap(), 2);
    // It asks as the target shows, just before the first write.
    let late = base();
    let asked = flag();
    let (a, desk) = (Arc::clone(&asked), late.desk.clone());
    late.set(|k| {
        k.inspect = Some(Arc::new(move |_| {
            if desk.shown() == Some(target(1)) {
                a.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            None
        }));
        k.yielding = Some(Arc::new(move |_| is_set(&asked)));
    });
    assert_eq!(late.restore(), res(Waiting, 0, 1, Some("busy")));
    assert!(late.writes().is_empty());
    assert!(late.marks().is_empty());
    assert_eq!(late.composer(&target(1)), None);
    // During the 5 s re-check it does not hold back the one rewrite a wipe needs.
    let rewrite = base();
    let wiped = flag();
    let (w, desk) = (Arc::clone(&wiped), rewrite.desk.clone());
    rewrite.set(|k| {
        k.sleep = Some(Arc::new(move |ms| {
            if ms == 5_000 && !is_set(&w) {
                w.store(true, std::sync::atomic::Ordering::SeqCst);
                desk.st().composers.remove(&target(1));
            }
        }));
        k.yielding = Some(Arc::new(move |_| is_set(&wiped)));
    });
    assert_eq!(rewrite.restore().restored, 1);
    assert_eq!(rewrite.writes().len(), 2);
}

#[test]
fn every_link_the_restorer_sends_asks_the_helper_to_check_the_user_right_before_opening() {
    let h = with_records(vec![record(1), record(2)]);
    // The first link does not take, so it is sent again; then the user is taken back.
    let first = Arc::new(Mutex::new(true));
    h.set(|k| {
        k.open = Some(Arc::new(move |id| {
            let mut first = first.lock().unwrap();
            if id != target(1) || !*first {
                return Open::Go;
            }
            *first = false;
            Open::Ignored
        }))
    });
    assert_eq!(h.restore().restored, 2);
    assert_eq!(
        h.opens(),
        opened(&[&target(1), &target(1), &target(2), HOME])
    );
    let idle = Some(OpenSessionOptions {
        require_idle: Some(true),
    });
    let links = h.opens().len();
    assert_eq!(h.st().open_options, vec![idle; links]);
}

#[test]
fn the_helper_refusing_a_link_because_the_user_is_active_stops_the_run_with_nothing_typed() {
    let h = with_records(vec![record(1), record(2)]);
    h.set(|k| k.open = Some(Arc::new(|_| Open::Fail(issue(I::UserActive)))));
    assert_eq!(h.restore(), res(Waiting, 0, 2, Some("active")));
    assert_eq!(h.opens(), opened(&[&target(1)]));
    assert!(h.writes().is_empty());
    assert!(h.marks().is_empty());
    assert!(h.notes().is_empty());
    // The user starts typing between Relay's look and the helper's own, just before it opens.
    let racing = base();
    let desk = racing.desk.clone();
    racing.set(|k| {
        k.open = Some(Arc::new(move |_| {
            desk.st().activity.idle_ms = Some(50);
            Open::Go
        }))
    });
    assert_eq!(racing.restore().reason.as_deref(), Some("active"));
    assert_eq!(racing.desk.shown().as_deref(), Some(HOME));
    assert!(racing.writes().is_empty());
    assert!(racing.marks().is_empty());
    // At the return the drafts are done: a refusal leaves the user where they are.
    let back = base();
    back.set(|k| {
        k.open = Some(Arc::new(|id| {
            if id == HOME {
                Open::Fail(issue(I::UserActive))
            } else {
                Open::Go
            }
        }))
    });
    assert_eq!(back.restore(), res(Done, 1, 0, None));
}

#[test]
fn once_the_target_has_appeared_any_other_conversation_means_the_user_moved_and_no_link_is_sent_again()
 {
    // The target shows before it can be guarded; the user goes back to where they were.
    let h = base();
    h.patch(|p| p.permission_mode = Some(None));
    at_nap(&h, 2, |d| d.set_shown(Some(HOME)));
    assert_eq!(h.restore(), res(Waiting, 0, 1, Some("moved")));
    assert_eq!(h.opens(), opened(&[&target(1)]));
    assert!(h.writes().is_empty());
    assert!(h.marks().is_empty());
    assert_eq!(h.desk.shown().as_deref(), Some(HOME));
    // The screen loads again after the target appeared: Relay waits, and never sends it again.
    let reloading = base();
    reloading.patch(|p| p.permission_mode = Some(None));
    at_nap(&reloading, 2, |d| d.set_shown(None));
    reloading.restore();
    assert_eq!(reloading.opens(), opened(&[&target(1)]));
    assert_eq!(
        reloading.marks(),
        vec![copy("draft-1", "exact-session-not-observed")]
    );
}

// --- The diagnosis log: what the restorer says, and never a draft's text -------------

/// Drafts whose words no id, state or reason could contain by chance.
const SECRET: &str = "quartz zebra marmalade ONE";
const SECRET_NEW: &str = "lantern pickle walrus TWO";

fn names(logs: &[Value]) -> Vec<String> {
    logs.iter()
        .map(|e| e["event"].as_str().unwrap().to_owned())
        .collect()
}
fn entry(logs: &[Value], event: &str) -> Value {
    let found: Vec<&Value> = logs.iter().filter(|e| e["event"] == event).collect();
    assert_eq!(found.len(), 1, "exactly one {event}");
    found[0].clone()
}
/// Every value of every logged event holds neither a draft's text nor a word of it.
fn assert_no_text(logs: &[Value]) {
    let words: Vec<&str> = SECRET
        .split(' ')
        .chain(SECRET_NEW.split(' '))
        .filter(|w| w.len() >= 5)
        .collect();
    assert!(!logs.is_empty());
    for logged in logs {
        for (key, value) in logged.as_object().unwrap() {
            assert_ne!(key.to_lowercase(), "text");
            let shown = match value {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            for secret in [SECRET, SECRET_NEW] {
                assert!(!shown.contains(secret), "{key}: {shown}");
            }
            for word in &words {
                assert!(!shown.contains(word), "{key}: {shown}");
            }
            // Only plain values: a nested one could hold anything.
            assert!(!value.is_object() && !value.is_array(), "{key}");
        }
    }
    let all = serde_json::to_string(logs).unwrap();
    assert!(!all.contains(SECRET));
    assert!(!all.contains(SECRET_NEW));
}
fn secret(n: u32) -> DraftRecord {
    record_with(n, |r| r.text = SECRET.into())
}

#[test]
fn a_restored_draft_logs_each_step_of_its_run_and_no_text() {
    let h = with_records(vec![
        secret(1),
        fresh_with(2, |r| r.text = SECRET_NEW.into()),
    ]);
    assert_eq!(h.restore().restored, 2);
    let logs = h.logs();
    assert_eq!(
        names(&logs),
        strs(&[
            "restore-start",
            "record-start",
            "shown",
            "write",
            "recheck",
            "restored",
            "record-start",
            "shown",
            "write",
            "recheck",
            "restored",
            "restore-end",
        ])
    );
    assert_eq!(
        logs[0],
        json!({
            "event": "restore-start",
            "account": &ACCOUNT[..8],
            "records": 2,
            "all": 2,
            "ready": true,
            "wiped": false,
            "waitedMs": 0,
        })
    );
    assert_eq!(
        logs[1],
        json!({ "event": "record-start", "id": "draft-1", "target": "00000001", "newSession": false })
    );
    assert_eq!(
        logs[2],
        json!({
            "event": "shown",
            "id": "draft-1",
            "matched": true,
            "status": "stopped",
            "composerPresent": true,
            "composerEmpty": true,
            // The helper's reason, count and page shape; this fake's snapshots carry none.
            "composerEmptyAs": null,
            "composerChars": null,
            "screen": null,
            "panes": null,
            "paneFound": null,
            "accountLabel": true,
            "permissionMode": "Auto",
            "frontmost": true,
            "idleMs": 60_000,
            "guardable": true,
            "sessionMatches": true,
        })
    );
    assert_eq!(
        logs[3],
        json!({ "event": "write", "id": "draft-1", "ok": true, "attempt": 1 })
    );
    assert_eq!(
        logs[4],
        json!({
            "event": "recheck",
            "id": "draft-1",
            "composerPresent": true,
            "composerEmpty": false,
            "status": "stopped",
            "pidSame": true,
            "sessionMatches": true,
        })
    );
    assert_eq!(
        logs[5],
        json!({ "event": "restored", "id": "draft-1", "removed": true })
    );
    // The new-session draft has no alias to name, and is on its own screen.
    assert_eq!(
        logs[6],
        json!({ "event": "record-start", "id": "draft-2", "target": null, "newSession": true })
    );
    assert_eq!(logs[7]["sessionMatches"], true);
    assert_eq!(
        logs.last().unwrap(),
        &json!({ "event": "restore-end", "status": "done", "restored": 2, "left": 0, "reason": null })
    );
    assert_no_text(&logs);
}

#[test]
fn a_write_the_helper_refuses_logs_the_issue_the_leave_and_the_end_and_no_text() {
    let h = with_records(vec![secret(1)]);
    h.set(|k| k.write = Some(Arc::new(|_| Some(issue(I::DeliveryAmbiguous)))));
    assert_eq!(h.restore().left, 1);
    let logs = h.logs();
    assert_eq!(
        names(&logs),
        strs(&[
            "restore-start",
            "record-start",
            "shown",
            "write",
            "leave",
            "restore-end"
        ])
    );
    assert_eq!(
        logs[3],
        json!({ "event": "write", "id": "draft-1", "ok": false, "attempt": 1, "issue": "delivery-ambiguous" })
    );
    assert_eq!(
        logs[4],
        json!({ "event": "leave", "id": "draft-1", "reason": "maybe-typed", "marked": true })
    );
    assert_eq!(
        logs[5],
        json!({ "event": "restore-end", "status": "done", "restored": 0, "left": 1, "reason": null })
    );
    assert_no_text(&logs);
}

#[test]
fn a_text_wiped_after_writing_logs_both_writes_and_both_re_checks() {
    let h = with_records(vec![secret(1)]);
    wipe_at_recheck(&h, target(1), false);
    h.restore();
    let logs = h.logs();
    assert_eq!(
        logs.iter()
            .filter(|e| e["event"] == "write" || e["event"] == "recheck")
            .map(|e| (
                e["event"].clone(),
                if e["event"] == "write" {
                    e["attempt"].clone()
                } else {
                    e["composerEmpty"].clone()
                }
            ))
            .collect::<Vec<_>>(),
        vec![
            (json!("write"), json!(1)),
            (json!("recheck"), json!(true)),
            (json!("write"), json!(2)),
            (json!("recheck"), json!(true)),
        ]
    );
    assert_eq!(
        entry(&logs, "leave"),
        json!({ "event": "leave", "id": "draft-1", "reason": "lost", "marked": true })
    );
    assert_no_text(&logs);
}

#[test]
fn a_conversation_that_never_shows_logs_the_timeout_with_the_last_view() {
    let h = with_records(vec![secret(1)]);
    h.set(|k| k.open = Some(Arc::new(|_| Open::Ignored)));
    h.restore();
    let logs = h.logs();
    assert_eq!(
        entry(&logs, "shown-timeout"),
        json!({
            "event": "shown-timeout",
            "id": "draft-1",
            "sessionMatches": false,
            "seen": &HOME[6..14],
            "status": "stopped",
            "composerPresent": true,
        })
    );
    assert!(!logs.iter().any(|e| e["event"] == "shown"));
    assert_eq!(
        entry(&logs, "leave")["reason"],
        "exact-session-not-observed"
    );
    assert_no_text(&logs);
}

#[test]
fn a_stop_logs_what_leaves_and_why() {
    // The user moves to another conversation after the first draft.
    let moved = with_records(vec![
        secret(1),
        record_with(2, |r| r.text = SECRET_NEW.into()),
    ]);
    at_remove(&moved, |d| d.set_shown(Some(ELSEWHERE)));
    moved.restore();
    let logs = moved.logs();
    assert_eq!(
        entry(&logs, "stop"),
        json!({ "event": "stop", "leaves": "pending", "reason": "moved", "wrote": false, "phase": "records" })
    );
    assert_eq!(
        logs.last().unwrap(),
        &json!({ "event": "restore-end", "status": "waiting", "restored": 1, "left": 1, "reason": "moved" })
    );
    assert_no_text(&logs);
    // Accessibility lost: every draft is left for copy.
    let blind = with_records(vec![
        secret(1),
        record_with(2, |r| r.text = SECRET_NEW.into()),
    ]);
    blind.set(|k| {
        k.write = Some(Arc::new(|_| {
            Some(issue(I::AccessibilityPermissionRequired))
        }))
    });
    blind.restore();
    let logs = blind.logs();
    assert_eq!(
        entry(&logs, "stop"),
        json!({ "event": "stop", "leaves": "copy", "reason": "accessibility", "wrote": false, "phase": "records" })
    );
    assert_eq!(
        logs.iter()
            .filter(|e| e["event"] == "leave")
            .map(|e| (e["id"].clone(), e["reason"].clone()))
            .collect::<Vec<_>>(),
        vec![
            (json!("draft-1"), json!("accessibility")),
            (json!("draft-2"), json!("accessibility")),
        ]
    );
    assert_eq!(
        entry(&logs, "write")["issue"],
        "accessibility-permission-required"
    );
    assert_no_text(&logs);
}

#[test]
fn a_re_check_that_cannot_look_is_logged_without_a_view() {
    let h = with_records(vec![secret(1)]);
    at_recheck(&h, |d| {
        d.st().hooks.inspect = Some(Arc::new(|_| Some(issue(I::DesktopUiUnsupported))));
    });
    h.restore();
    let logs = h.logs();
    assert_eq!(
        entry(&logs, "recheck"),
        json!({ "event": "recheck", "id": "draft-1", "inspected": false, "issue": "desktop-ui-unsupported" })
    );
    assert_eq!(entry(&logs, "leave")["reason"], "maybe-typed");
    assert_no_text(&logs);
}

#[test]
fn a_run_that_finds_claude_not_ready_logs_it_and_one_with_nothing_to_restore_logs_why() {
    let early = harness(Opts {
        running: Some(false),
        records: Some(vec![secret(1)]),
        ..Opts::default()
    });
    early.restore();
    assert_eq!(
        early.logs(),
        vec![
            json!({ "event": "restore-start", "account": &ACCOUNT[..8], "records": 1, "all": 1, "ready": false }),
            json!({ "event": "restore-end", "status": "waiting", "restored": 0, "left": 1, "reason": null }),
        ]
    );
    // Pending drafts of another account: Desktop is not on theirs.
    let other = with_records(vec![record_with(1, |r| {
        r.to = OTHER.into();
        r.text = SECRET.into();
    })]);
    other.restore();
    assert_eq!(
        other.logs(),
        vec![
            json!({ "event": "restore-start", "account": &ACCOUNT[..8], "records": 0, "all": 1, "ready": null }),
            json!({ "event": "restore-end", "status": "idle", "restored": 0, "left": 0, "reason": null }),
        ]
    );
    // No Desktop account at all.
    let signed_out = with_records(vec![secret(1)]);
    signed_out.desk.set_account(None);
    signed_out.restore();
    assert_eq!(
        signed_out.logs()[0],
        json!({ "event": "restore-start", "account": null, "records": 0, "all": null, "ready": null })
    );
    let mut all = early.logs();
    all.extend(other.logs());
    all.extend(signed_out.logs());
    assert_no_text(&all);
    // The account is logged by its short id only.
    let mut both = early.logs();
    both.extend(other.logs());
    let text = serde_json::to_string(&both).unwrap();
    assert!(!text.contains(ACCOUNT) && !text.contains(OTHER));
}

#[test]
fn a_restore_that_throws_logs_its_end_with_the_errors_name_never_its_message() {
    let h = with_records(vec![secret(1)]);
    h.set(|k| {
        k.with_lock = Some(Arc::new(|_| {
            DesktopHostError::other(format!("the lock failed on {SECRET}"))
        }))
    });
    let error = restore_drafts(&*h.fake, RestoreOptions::default()).unwrap_err();
    assert!(error.to_string().contains("the lock failed"));
    assert_eq!(
        h.logs().last().unwrap(),
        &json!({ "event": "restore-end", "status": "threw", "error": "Error" })
    );
    assert_no_text(&h.logs());
}

#[test]
fn a_log_that_throws_never_disturbs_a_restore() {
    let h = with_records(vec![secret(1)]);
    h.st().log_mode = LogMode::Panic;
    assert_eq!(h.restore(), res(Done, 1, 0, None));
    assert_eq!(h.removed(), strs(&["draft-1"]));
    // And a restorer without a log is the one every other test runs.
    let bare = base();
    bare.st().log_mode = LogMode::Absent;
    assert_eq!(bare.restore().restored, 1);
}

#[test]
fn nothing_is_opened_or_typed_while_claudes_page_has_not_booted() {
    let h = harness(Opts {
        shown: Some(None),
        ..Opts::default()
    });
    h.set(|k| k.page_booted = Some(Arc::new(|_| Some(false))));
    assert_eq!(h.restore(), res(Waiting, 0, 1, Some("loading")));
    assert!(h.calls().is_empty());
    assert!(h.marks().is_empty());
    assert!(h.logs().iter().any(|l| l["event"] == "page-loading"));
    // Booted, or a log that cannot tell: the run goes on as before.
    for booted in [Some(true), None] {
        let next = harness(Opts {
            shown: Some(None),
            ..Opts::default()
        });
        next.set(|k| k.page_booted = Some(Arc::new(move |_| booted)));
        assert_eq!(next.restore().restored, 1);
    }
}

#[test]
fn a_conversation_that_shows_without_its_composer_yet_keeps_its_draft_pending() {
    let h = harness(Opts {
        shown: Some(None),
        ..Opts::default()
    });
    // Its URL is on screen, but its content never loads while the run waits.
    h.st().no_composer.insert(target(1));
    assert_eq!(h.restore(), res(Waiting, 0, 1, Some("loading")));
    assert!(h.marks().is_empty());
    assert!(h.writes().is_empty());
}
