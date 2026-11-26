//! Port of `electron/core/draft-main.ts`: the main process's side of draft restore. When the
//! restorer runs, the notification it is given, and what the panel may do with a draft. Draft
//! text stays here. Its lock is DesktopLock's `restore`.
//!
//! The TS timers are threads: `every` and `later` default to a thread each, and a run the watch
//! starts runs on a thread of its own. Public calls block where the TS returns a promise.

use std::collections::{HashMap, HashSet};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::time::Duration;

use relay_i18n::{Args, Locale, translate};
use serde_json::{Value, json};

use crate::desktop::DesktopManager;
use crate::desktop_continuation::{ContinuationTimer, thread_interval};
use crate::desktop_continuation_host::{DesktopAutomation, DesktopHostError};
use crate::desktop_files::is_uuid;
use crate::desktop_watch::{
    DesktopWatch, DesktopWatchEnd, DesktopWatchHandlers, DesktopWatchState, DesktopWatcher,
};
use crate::draft_diagnostics::{DraftLog, log_draft, short_id};
use crate::draft_restorer::{
    DraftCounts, RestoreOptions, RestoreResult, RestoreStatus, RestorerDeps, draft_place,
    restore_drafts,
};
use crate::draft_vault::{DraftRecord, DraftState, DraftSummary};

/// How often pending drafts are tried again while one waits for Desktop's current account.
pub const RETRY_MS: u64 = 10_000;
/// How often Desktop's account alone is read while drafts wait only for other accounts.
pub const ACCOUNT_CHECK_MS: u64 = 60_000;
/// How long retries wait after a run in which Desktop's UI never answered.
pub const NOT_READY_BACKOFF_MS: i64 = 2 * 60_000;
/// Runs in a row that may try a pending draft and move nothing, before it is left for Copy.
pub const MAX_STALLS: u32 = 3;
/// For how long after Claude is ready on an account Relay may take the user to a draft's
/// place and back.
pub const VISIT_MS: i64 = 2 * 60_000;
/// For how long after Claude is ready on an account its drafts wait to be opened.
pub const WATCH_MS: i64 = 30 * 60_000;
/// The least time between the end of a run and one the watch starts.
pub const NUDGE_MS: i64 = 1_000;
/// With a watch on, a 10 s retry still runs once this long has passed since the last run.
pub const BACKSTOP_MS: i64 = 60_000;
/// Why a draft is left for Copy once the watch window ran out.
pub const NOT_OPENED: &str = "not-opened";
/// The stop a restore that throws is counted as.
pub const RESTORE_ERROR: &str = "error";

/// Node's `process.platform` for this build.
fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// Whether rescued drafts are re-typed into Claude: only once the user turns it on, missing
/// means off, and only on macOS. `platform` is Node's name for one; `None` is this one.
pub fn draft_retype_enabled(draft_retype: Option<bool>, platform: Option<&str>) -> bool {
    platform.unwrap_or(node_platform()) == "darwin" && draft_retype == Some(true)
}

/// The notification after a restore: counts only, never a draft's text or title.
pub fn draft_notice(
    summary: DraftCounts,
    language: Locale,
    platform: Option<&str>,
) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if summary.restored > 0 {
        parts.push(translate(
            language,
            "draftMain.draftsRestored",
            &Args::new().set("restored", summary.restored),
        ));
    }
    if summary.left > 0 {
        let id = if platform.unwrap_or(node_platform()) == "darwin" {
            "draftMain.draftsWaitingInThePanel"
        } else {
            "draftMain.draftsWaitingToCopyInSettings"
        };
        parts.push(translate(
            language,
            id,
            &Args::new().set("left", summary.left),
        ));
    }
    (!parts.is_empty()).then(|| parts.join(" · "))
}

fn same_account(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// Two reads of Desktop's account name the same account, or both none.
fn same_read(a: Option<&str>, b: Option<&str>) -> bool {
    a == b
        || matches!((a, b), (Some(a), Some(b)) if !a.is_empty() && !b.is_empty() && same_account(a, b))
}

fn pending_ids(drafts: &[DraftSummary]) -> HashSet<&str> {
    drafts
        .iter()
        .filter(|d| d.state == DraftState::Pending)
        .map(|d| d.id.as_str())
        .collect()
}

/// One run, as `tally_stalls` weighs it.
pub struct StallRun<'a> {
    pub before: &'a [DraftSummary],
    pub after: &'a [DraftSummary],
    /// The account the run read first; `None` when it read none.
    pub account: Option<&'a str>,
    pub result: &'a RestoreResult,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StallTally {
    pub counts: HashMap<String, u32>,
    pub give_up: Vec<String>,
}

/// Counts, per pending draft, the runs in a row that tried it and moved no draft at all. Only
/// a run that stopped with a reason counts, and not one stopped `busy`, `active`, `elsewhere`
/// or `loading`. A run that moved any draft starts every count again. A draft counted
/// `MAX_STALLS` times is given up.
pub fn tally_stalls(counts: &HashMap<String, u32>, run: StallRun<'_>) -> StallTally {
    let before = pending_ids(run.before);
    let after: Vec<&DraftSummary> = run
        .after
        .iter()
        .filter(|d| d.state == DraftState::Pending)
        .collect();
    let still: HashSet<&str> = after.iter().map(|d| d.id.as_str()).collect();
    if run.result.restored > 0 || before.iter().any(|id| !still.contains(id)) {
        return StallTally::default();
    }
    // Only drafts still pending keep a count.
    let mut next: HashMap<String, u32> = HashMap::new();
    for draft in &after {
        if let Some(&count) = counts.get(&draft.id).filter(|count| **count > 0) {
            next.insert(draft.id.clone(), count);
        }
    }
    let mut give_up = Vec::new();
    let reason = run.result.reason.as_deref();
    let (Some(reason), Some(account)) = (reason, run.account.filter(|a| !a.is_empty())) else {
        return StallTally {
            counts: next,
            give_up,
        };
    };
    if reason.is_empty() || ["busy", "active", "elsewhere", "loading"].contains(&reason) {
        return StallTally {
            counts: next,
            give_up,
        };
    }
    for draft in &after {
        if !before.contains(draft.id.as_str()) || !same_account(&draft.to, account) {
            continue;
        }
        let count = next.get(&draft.id).copied().unwrap_or(0) + 1;
        if count >= MAX_STALLS {
            next.remove(&draft.id);
            give_up.push(draft.id.clone());
        } else {
            next.insert(draft.id.clone(), count);
        }
    }
    StallTally {
        counts: next,
        give_up,
    }
}

/// Stops a timer: `clearInterval` / `clearTimeout`.
pub type Cancel = Box<dyn FnOnce() + Send>;
/// The restore to run.
pub type RestoreFn = Box<
    dyn Fn(&dyn RestorerDeps, RestoreOptions) -> Result<RestoreResult, DesktopHostError>
        + Send
        + Sync,
>;
/// Calls `fn` every `ms` until cancelled.
pub type EveryFn = Box<dyn Fn(Box<dyn Fn() + Send + Sync>, u64) -> Cancel + Send + Sync>;
/// Calls `fn` once after `ms` unless cancelled first.
pub type LaterFn = Box<dyn Fn(Box<dyn FnOnce() + Send>, u64) -> Cancel + Send + Sync>;

pub struct DraftSchedulerDeps {
    /// What each run gives `restore_drafts`.
    pub restorer: Arc<dyn RestorerDeps>,
    /// Every record's summary; an error reads as none.
    pub drafts: Box<dyn Fn() -> Result<Vec<DraftSummary>, String> + Send + Sync>,
    /// Tells the renderers that the drafts changed.
    pub changed: Box<dyn Fn() -> Result<(), String> + Send + Sync>,
    /// Whether drafts are re-typed into Claude.
    pub retype: Box<dyn Fn() -> bool + Send + Sync>,
    /// The restore to run; `restore_drafts` unless a test gives another.
    pub restore: Option<RestoreFn>,
    /// A thread interval unless a test gives another.
    pub every: Option<EveryFn>,
    /// A thread timeout unless a test gives another.
    pub later: Option<LaterFn>,
    /// Watches where the user is in Claude while drafts wait for Desktop's account.
    pub watch: Option<DesktopWatcher>,
}

impl DraftSchedulerDeps {
    /// Deps with the TS defaults for every optional member.
    pub fn new(
        restorer: Arc<dyn RestorerDeps>,
        drafts: Box<dyn Fn() -> Result<Vec<DraftSummary>, String> + Send + Sync>,
        changed: Box<dyn Fn() -> Result<(), String> + Send + Sync>,
        retype: Box<dyn Fn() -> bool + Send + Sync>,
    ) -> Self {
        DraftSchedulerDeps {
            restorer,
            drafts,
            changed,
            retype,
            restore: None,
            every: None,
            later: None,
            watch: None,
        }
    }
}

fn any_pending(drafts: &[DraftSummary]) -> bool {
    drafts.iter().any(|d| d.state == DraftState::Pending)
}

/// `setInterval` on a thread.
fn interval(tick: Box<dyn Fn() + Send + Sync>, ms: u64) -> Cancel {
    let timer: Box<dyn ContinuationTimer> = thread_interval(ms, tick);
    Box::new(move || timer.cancel())
}

/// `setTimeout` on a thread.
fn timeout(f: Box<dyn FnOnce() + Send>, ms: u64) -> Cancel {
    let state = Arc::new((Mutex::new(false), Condvar::new()));
    let shared = Arc::clone(&state);
    std::thread::spawn(move || {
        let (cancelled, wake) = &*shared;
        let guard = cancelled.lock().unwrap_or_else(|e| e.into_inner());
        let (guard, _) = wake
            .wait_timeout_while(guard, Duration::from_millis(ms), |cancelled| !*cancelled)
            .unwrap_or_else(|e| e.into_inner());
        if *guard {
            return;
        }
        drop(guard);
        f();
    });
    Box::new(move || {
        let (cancelled, wake) = &*state;
        *cancelled.lock().unwrap_or_else(|e| e.into_inner()) = true;
        wake.notify_all();
    })
}

/// A run got past Claude's readiness: it looked at Desktop's UI, whatever came of it.
fn ready_run(result: &RestoreResult) -> bool {
    result.status == RestoreStatus::Done
        || result
            .reason
            .as_deref()
            .is_some_and(|r| !["not-ready", "claude-not-running", RESTORE_ERROR].contains(&r))
}

/// The watch while one runs, and its last report.
struct Watching {
    id: u64,
    watch: Option<Box<dyn DesktopWatch>>,
    state: Option<DesktopWatchState>,
}

#[derive(Default)]
struct Inner {
    running: bool,
    /// Runs ended so far: a caller joining the one in flight waits for this to change.
    flights: u64,
    /// A switch came during the run: one more run after it.
    again: bool,
    cancel: Option<Cancel>,
    /// The armed timer's period: RETRY_MS or ACCOUNT_CHECK_MS.
    period: Option<u64>,
    /// Desktop's account as the last pass to arm the timers read it.
    account: Option<String>,
    /// Passes begun, so `start` leaves the timers to a pass begun after it read the drafts.
    passes: u64,
    /// `None` is the TS `-Infinity`.
    not_before: Option<i64>,
    stalls: HashMap<String, u32>,
    stopped: bool,
    /// The drafts `retry_accessibility` set back to pending while Relay runs.
    retried: HashSet<String>,
    /// Since when Claude has been ready on an account, as a run first found it.
    window: Option<(String, i64)>,
    /// A switch asked for the next run: Claude may still be starting.
    switched: bool,
    /// Switches so far.
    generation: u64,
    watching: Option<Watching>,
    watch_ids: u64,
    /// The places of the drafts pending for Desktop's account, as the watch looks for them.
    targets: HashSet<String>,
    /// When the last run ended; `None` is the TS `-Infinity`.
    last_run_end: Option<i64>,
    /// A report came during a run: weigh it once the run ends.
    nudged: bool,
    nudge_timer: Option<(u64, Cancel)>,
    nudge_ids: u64,
}

impl Inner {
    /// Relay may take the user elsewhere and back: Claude is not ready yet, or only just.
    fn visits(&self, now: i64) -> bool {
        self.window
            .as_ref()
            .is_none_or(|(_, since)| now < since + VISIT_MS)
    }

    /// The watch window of Desktop's account is over.
    fn expired(&self, now: i64) -> bool {
        self.window
            .as_ref()
            .is_some_and(|(_, since)| now >= since + WATCH_MS)
    }

    /// The watch's last report would start a run.
    fn go(&self, now: i64) -> bool {
        let Some(state) = self.watching.as_ref().and_then(|w| w.state.as_ref()) else {
            return false;
        };
        if !state.frontmost {
            return false;
        }
        if state
            .place
            .as_ref()
            .is_some_and(|place| !place.is_empty() && self.targets.contains(place))
            && state.quiet
        {
            return true;
        }
        state.idle && self.visits(now)
    }

    fn disarm(&mut self) {
        if let Some(cancel) = self.cancel.take() {
            cancel();
        }
        self.period = None;
    }
}

enum Begin {
    Run,
    Joined(u64),
    Stopped,
}

/// The restorer's deps for one run: the account it reads first is kept.
struct Tracked<'a> {
    inner: &'a dyn RestorerDeps,
    /// `Some(account)` once a read answered.
    first: Mutex<Option<Option<String>>>,
}

impl RestorerDeps for Tracked<'_> {
    fn automation(&self) -> &dyn DesktopAutomation {
        self.inner.automation()
    }
    fn pending(&self) -> Result<Vec<DraftRecord>, DesktopHostError> {
        self.inner.pending()
    }
    fn mark(
        &self,
        id: &str,
        state: DraftState,
        reason: Option<&str>,
    ) -> Result<(), DesktopHostError> {
        self.inner.mark(id, state, reason)
    }
    fn remove(&self, id: &str) -> Result<(), DesktopHostError> {
        self.inner.remove(id)
    }
    fn current_account(&self) -> Result<Option<String>, DesktopHostError> {
        // The restorer reads the account first and restores only that account's drafts.
        let value = self.inner.current_account()?;
        let mut first = self.first.lock().unwrap_or_else(|e| e.into_inner());
        if first.is_none() {
            *first = Some(value.clone());
        }
        Ok(value)
    }
    fn running(&self) -> Result<bool, DesktopHostError> {
        self.inner.running()
    }
    fn uptime_ms(&self) -> Result<Option<i64>, DesktopHostError> {
        self.inner.uptime_ms()
    }
    fn wiped_at(&self) -> Result<Option<i64>, DesktopHostError> {
        self.inner.wiped_at()
    }
    fn page_booted(&self) -> Result<Option<bool>, DesktopHostError> {
        self.inner.page_booted()
    }
    fn with_lock(&self, f: &mut dyn FnMut()) -> Result<bool, DesktopHostError> {
        self.inner.with_lock(f)
    }
    fn yielding(&self) -> bool {
        self.inner.yielding()
    }
    fn notify(&self, summary: DraftCounts) -> Result<(), DesktopHostError> {
        self.inner.notify(summary)
    }
    fn sleep(&self, ms: u64) -> Result<(), DesktopHostError> {
        self.inner.sleep(ms)
    }
    fn now(&self) -> i64 {
        self.inner.now()
    }
    fn log(&self) -> Option<&DraftLog> {
        self.inner.log()
    }
}

/// The scheduler's side of one watch.
struct Handlers {
    scheduler: Weak<DraftScheduler>,
    id: u64,
}

impl DesktopWatchHandlers for Handlers {
    fn state(&self, state: DesktopWatchState) {
        if let Some(scheduler) = self.scheduler.upgrade() {
            scheduler.on_state(self.id, state);
        }
    }
    fn end(&self, reason: DesktopWatchEnd) {
        if let Some(scheduler) = self.scheduler.upgrade() {
            scheduler.on_end(self.id, reason);
        }
    }
}

/// Runs the draft restorer after every switch, one run at a time, and every 10 s while a
/// pending draft is for Desktop's current account; while drafts wait only for other accounts,
/// Desktop's account alone every 60 s. See the TS `DraftScheduler` for the whole contract:
/// backoff, visit and watch windows, the watch's nudges, stall give-ups, accessibility
/// retries, and re-typing turned off. Runs never fail.
pub struct DraftScheduler {
    deps: DraftSchedulerDeps,
    me: Weak<DraftScheduler>,
    inner: Mutex<Inner>,
    /// Told when a run ends.
    landed: Condvar,
    /// Held by the `retry_accessibility` call in progress; the next one waits for it.
    retrying: Mutex<()>,
}

impl DraftScheduler {
    pub fn new(deps: DraftSchedulerDeps) -> Arc<DraftScheduler> {
        Arc::new_cyclic(|me| DraftScheduler {
            deps,
            me: me.clone(),
            inner: Mutex::new(Inner::default()),
            landed: Condvar::new(),
            retrying: Mutex::new(()),
        })
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn log(&self, event: &str, fields: Value) {
        if let Value::Object(fields) = fields {
            log_draft(self.deps.restorer.log(), event, Some(&fields));
        }
    }

    fn now(&self) -> i64 {
        self.deps.restorer.now()
    }

    /// A run is in flight.
    pub fn in_flight(&self) -> bool {
        self.inner().running
    }

    /// When drafts wait from before, as after Relay restarts: with re-typing off they are left
    /// for Copy now; on, the 10 s retries or the 60 s check are armed for them.
    pub fn start(&self) {
        let passes = self.inner().passes;
        let drafts = self.read();
        if !any_pending(&drafts) {
            return;
        }
        if !(self.deps.retype)() {
            return self.run(false);
        }
        let account = self.current_account();
        // A pass begun since the drafts were read armed for what it found: that stands.
        let mut inner = self.inner();
        if inner.running || inner.passes != passes {
            return;
        }
        self.schedule_locked(&mut inner, &drafts, account);
    }

    /// Draft re-typing was turned on or off: one pass now, or right after the one in flight.
    pub fn retype_changed(&self) {
        self.run(true)
    }

    /// After a switch: a run now, whatever the backoff, that waits for Claude to start. It
    /// means a new Claude: the windows open again, and the watch of the last one ends.
    pub fn after_switch(&self) {
        {
            let mut inner = self.inner();
            inner.not_before = None;
            inner.window = None;
            inner.switched = true;
            inner.generation += 1;
        }
        self.unwatch();
        self.run(true)
    }

    /// One 10 s retry: skipped while backing off, and joined to a run in flight. With a watch
    /// on, it runs only while the watch's last report would start a run, the watch window is
    /// over or the last run was `BACKSTOP_MS` ago; otherwise it reads Desktop's account alone.
    pub fn tick(&self) {
        let now = self.now();
        let checking = {
            let inner = self.inner();
            if inner.not_before.is_some_and(|not_before| now < not_before) {
                return;
            }
            inner.watching.is_some()
                && !inner.go(now)
                && !inner.expired(now)
                && inner
                    .last_run_end
                    .is_some_and(|end| now - end < BACKSTOP_MS)
        };
        if checking {
            self.check()
        } else {
            self.run(false)
        }
    }

    /// Accessibility is granted: every draft left for Copy only because it was missing goes
    /// back to pending, and the 10 s retries are armed. With `once`, a draft this already set
    /// back while Relay runs stays for Copy. Waits for the call before it. Returns how many
    /// drafts moved; never fails.
    pub fn retry_accessibility(&self, once: bool) -> usize {
        let _turn = self.retrying.lock().unwrap_or_else(|e| e.into_inner());
        let moved = self.move_back(once);
        self.log(
            "retry-accessibility",
            json!({ "moved": moved, "once": once }),
        );
        moved
    }

    fn move_back(&self, once: bool) -> usize {
        if self.inner().stopped {
            return 0;
        }
        // Re-typing off: every draft left for Copy stays there, whatever left it.
        if !(self.deps.retype)() {
            return 0;
        }
        let retried = self.inner().retried.clone();
        let waiting: Vec<DraftSummary> = self
            .read()
            .into_iter()
            .filter(|d| {
                d.state == DraftState::NeedsCopy
                    && d.reason.as_deref() == Some("accessibility")
                    && !(once && retried.contains(&d.id))
            })
            .collect();
        let mut moved = 0;
        for draft in waiting {
            // A vault that cannot be changed leaves the draft for Copy.
            if self
                .deps
                .restorer
                .mark(&draft.id, DraftState::Pending, None)
                .is_ok()
            {
                let mut inner = self.inner();
                inner.stalls.remove(&draft.id);
                inner.retried.insert(draft.id.clone());
                moved += 1;
            }
        }
        if moved == 0 {
            return 0;
        }
        // The panel reads the drafts again on its next refresh.
        let _ = (self.deps.changed)();
        // A run in flight may have read the drafts before this and turn the retries off as
        // it ends: arm them after it.
        self.wait_flight();
        let mut inner = self.inner();
        self.arm_locked(&mut inner, RETRY_MS);
        moved
    }

    /// No more runs, retries or watch; one in flight ends as it would.
    pub fn stop(&self) {
        {
            let mut inner = self.inner();
            inner.stopped = true;
            inner.disarm();
        }
        self.unwatch();
    }

    fn begin(&self, again: bool) -> Begin {
        let mut inner = self.inner();
        if inner.stopped {
            return Begin::Stopped;
        }
        if inner.running {
            if again {
                inner.again = true;
            }
            return Begin::Joined(inner.flights);
        }
        inner.running = true;
        Begin::Run
    }

    /// A run now, or the end of the one in flight (`again` asks for one more after it).
    fn run(&self, again: bool) {
        match self.begin(again) {
            Begin::Stopped => {}
            Begin::Run => self.fly(),
            Begin::Joined(flight) => {
                let mut inner = self.inner();
                while inner.flights == flight {
                    inner = self.landed.wait(inner).unwrap_or_else(|e| e.into_inner());
                }
            }
        }
    }

    /// Runs the flight `begin` or `consider_locked` began, on a thread of its own.
    fn spawn_flight(&self) {
        match self.me.upgrade() {
            Some(me) => {
                std::thread::spawn(move || me.fly());
            }
            None => self.fly(),
        }
    }

    fn wait_flight(&self) {
        let mut inner = self.inner();
        if !inner.running {
            return;
        }
        let flight = inner.flights;
        while inner.flights == flight {
            inner = self.landed.wait(inner).unwrap_or_else(|e| e.into_inner());
        }
    }

    fn fly(&self) {
        // A run never fails; should one, the next tick or switch runs again.
        let _ = catch_unwind(AssertUnwindSafe(|| {
            loop {
                self.inner().again = false;
                self.once();
                let inner = self.inner();
                if !(inner.again && !inner.stopped) {
                    break;
                }
            }
        }));
        let now = catch_unwind(AssertUnwindSafe(|| self.now())).ok();
        // What the watch said meanwhile, now that the run has changed what is pending: weighed
        // as the run ends, so no look between the two finds nothing in flight.
        let next = {
            let mut inner = self.inner();
            inner.running = false;
            inner.last_run_end = now.or(inner.last_run_end);
            inner.flights += 1;
            std::mem::take(&mut inner.nudged)
                && now.is_some_and(|now| self.consider_locked(&mut inner, now))
        };
        self.landed.notify_all();
        if next {
            self.spawn_flight();
        }
    }

    fn once(&self) {
        self.inner().passes += 1;
        let mut before = self.read();
        if !any_pending(&before) {
            self.unwatch();
            self.inner().disarm();
            return;
        }
        if !(self.deps.retype)() {
            self.unwatch();
            return self.leave_all(&before);
        }
        let restorer = &*self.deps.restorer;
        if self.inner().expired(restorer.now()) {
            before = self.expire(before);
            if !any_pending(&before) {
                self.unwatch();
                self.inner().disarm();
                return;
            }
        }
        let (launching, generation) = {
            let mut inner = self.inner();
            (std::mem::take(&mut inner.switched), inner.generation)
        };
        let started = restorer.now();
        let tracked = Tracked {
            inner: restorer,
            first: Mutex::new(None),
        };
        let options = RestoreOptions {
            visits: Some(self.inner().visits(started)),
            launching: Some(launching),
        };
        let outcome = match &self.deps.restore {
            Some(restore) => restore(&tracked, options),
            None => restore_drafts(&tracked, options),
        };
        // A failure the restorer did not expect: counted, so one that repeats is given up.
        let result = outcome.unwrap_or_else(|_| RestoreResult {
            status: RestoreStatus::Waiting,
            restored: 0,
            left: 0,
            reason: Some(RESTORE_ERROR.into()),
        });
        let first = tracked
            .first
            .into_inner()
            .unwrap_or_else(|e| e.into_inner());
        let asked = first.is_some();
        let account = first.flatten();
        let ready = {
            let mut inner = self.inner();
            if result.reason.as_deref() == Some("not-ready") {
                inner.not_before = Some(restorer.now() + NOT_READY_BACKOFF_MS);
            }
            // The windows are the account's: another account's run opens its own.
            if inner.window.as_ref().is_some_and(|(window, _)| {
                account
                    .as_deref()
                    .filter(|a| !a.is_empty())
                    .is_none_or(|account| !same_account(window, account))
            }) {
                inner.window = None;
            }
            // A run begun before a switch found the Claude that switch replaced.
            let ready = ready_run(&result) && generation == inner.generation;
            if inner.window.is_none()
                && let Some(account) = account.as_ref().filter(|a| ready && !a.is_empty())
            {
                inner.window = Some((account.clone(), started));
            }
            ready
        };
        // A run with nothing for this account changed nothing.
        let after = if result.status == RestoreStatus::Idle {
            before.clone()
        } else {
            self.read()
        };
        let tally = {
            let mut inner = self.inner();
            let tally = tally_stalls(
                &inner.stalls,
                StallRun {
                    before: &before,
                    after: &after,
                    account: account.as_deref(),
                    result: &result,
                },
            );
            inner.stalls = tally.counts.clone();
            tally
        };
        self.log(
            "stalls",
            json!({
                "giveUp": tally.give_up.len(),
                "reason": result.reason,
                "status": result.status.as_str(),
            }),
        );
        let mut given: HashSet<String> = HashSet::new();
        for id in &tally.give_up {
            // A vault that cannot be changed keeps the draft pending; the next run tries again.
            let marked = restorer
                .mark(id, DraftState::NeedsCopy, result.reason.as_deref())
                .is_ok();
            if marked {
                given.insert(id.clone());
            }
            self.log(
                "give-up",
                json!({ "id": short_id(Some(id)), "reason": result.reason, "marked": marked }),
            );
        }
        if !given.is_empty() {
            // A notification that fails changes nothing about the drafts.
            let _ = restorer.notify(DraftCounts {
                restored: 0,
                left: given.len(),
            });
        }
        if !given.is_empty() || before != after {
            // The panel reads the drafts again on its next refresh.
            let _ = (self.deps.changed)();
        }
        let left: Vec<DraftSummary> = after
            .into_iter()
            .filter(|d| !given.contains(&d.id))
            .collect();
        // The account the restorer read first; read here only when it read none.
        let current = if asked {
            account
        } else {
            self.current_account()
        };
        {
            let mut inner = self.inner();
            self.schedule_locked(&mut inner, &left, current.clone());
        }
        self.watch_for(&left, current.as_deref(), ready);
    }

    /// The watch window is over: every draft still pending for its account, while Desktop is
    /// on it, is left for Copy as `not-opened`, and the watch ends. Returns the drafts after it.
    fn expire(&self, before: Vec<DraftSummary>) -> Vec<DraftSummary> {
        let restorer = &*self.deps.restorer;
        let Some(account) = self.inner().window.as_ref().map(|(a, _)| a.clone()) else {
            return before;
        };
        if !same_read(self.current_account().as_deref(), Some(&account)) {
            return before;
        }
        self.unwatch();
        let mut left = 0;
        for draft in &before {
            if draft.state != DraftState::Pending || !same_account(&draft.to, &account) {
                continue;
            }
            // A vault that cannot be changed keeps the draft pending.
            if restorer
                .mark(&draft.id, DraftState::NeedsCopy, Some(NOT_OPENED))
                .is_ok()
            {
                self.inner().stalls.remove(&draft.id);
                left += 1;
            }
        }
        self.log("watch-over", json!({ "left": left }));
        if left == 0 {
            return before;
        }
        let _ = restorer.notify(DraftCounts { restored: 0, left });
        let _ = (self.deps.changed)();
        self.read()
    }

    /// Keeps the watch on while drafts are pending for Desktop's `account` and a run found
    /// Claude ready, with the places it looks for; ends it otherwise.
    fn watch_for(&self, drafts: &[DraftSummary], account: Option<&str>, ready: bool) {
        let Some(account) = account.filter(|a| !a.is_empty()) else {
            return self.unwatch();
        };
        if self.inner().stopped
            || self.deps.watch.is_none()
            || !drafts
                .iter()
                .any(|d| d.state == DraftState::Pending && same_account(&d.to, account))
        {
            return self.unwatch();
        }
        // Records that cannot be read: nothing to look for until the next run.
        let Ok(records) = self.deps.restorer.pending() else {
            return self.unwatch();
        };
        let places: HashSet<String> = records
            .iter()
            .filter(|r| r.state == DraftState::Pending && same_account(&r.to, account))
            .filter_map(draft_place)
            .collect();
        let start = {
            let mut inner = self.inner();
            let empty = places.is_empty();
            inner.targets = places;
            if empty {
                None
            } else {
                Some(inner.watching.is_none() && ready)
            }
        };
        match start {
            None => self.unwatch(),
            Some(true) => self.start_watch(),
            Some(false) => {}
        }
    }

    fn start_watch(&self) {
        let Some(watcher) = self.deps.watch.clone() else {
            return;
        };
        let (id, places) = {
            let mut inner = self.inner();
            if inner.stopped {
                return;
            }
            inner.watch_ids += 1;
            let id = inner.watch_ids;
            inner.watching = Some(Watching {
                id,
                watch: None,
                state: None,
            });
            (id, inner.targets.len())
        };
        self.log("watch-start", json!({ "places": places }));
        let handlers = Arc::new(Handlers {
            scheduler: self.me.clone(),
            id,
        });
        match watcher(handlers) {
            Ok(watch) => {
                let mut inner = self.inner();
                match inner.watching.as_mut() {
                    Some(current) if current.id == id => current.watch = Some(watch),
                    // Ended or replaced meanwhile.
                    _ => {
                        drop(inner);
                        watch.stop();
                    }
                }
            }
            Err(code) => {
                {
                    let mut inner = self.inner();
                    if inner.watching.as_ref().is_some_and(|w| w.id == id) {
                        inner.watching = None;
                    }
                }
                // Its code alone, such as ENOTDIR: a message could name a path.
                self.log("watch-end", json!({ "reason": "failed", "error": code }));
            }
        }
    }

    fn on_state(&self, id: u64, state: DesktopWatchState) {
        {
            let mut inner = self.inner();
            match inner.watching.as_mut() {
                Some(current) if current.id == id => current.state = Some(state),
                _ => return,
            }
        }
        self.consider();
    }

    fn on_end(&self, id: u64, reason: DesktopWatchEnd) {
        let again = {
            let mut inner = self.inner();
            if inner.watching.as_ref().is_none_or(|w| w.id != id) {
                return;
            }
            inner.watching = None;
            reason == DesktopWatchEnd::Expired && !inner.targets.is_empty()
        };
        self.log("watch-end", json!({ "reason": reason.as_str() }));
        // The helper's own 10 minutes: a new one, while drafts still wait.
        if again {
            self.start_watch();
        }
    }

    fn unwatch(&self) {
        let (timer, current) = {
            let mut inner = self.inner();
            inner.nudged = false;
            (inner.nudge_timer.take(), inner.watching.take())
        };
        if let Some((_, cancel)) = timer {
            cancel();
        }
        // A watch that cannot be stopped ends with Relay, or on its own after 10 minutes.
        if let Some(watch) = current.and_then(|current| current.watch) {
            watch.stop();
        }
    }

    /// Starts a run when the watch's last report says so, at least NUDGE_MS after the last.
    fn consider(&self) {
        let now = self.now();
        let start = self.consider_locked(&mut self.inner(), now);
        if start {
            self.spawn_flight();
        }
    }

    /// `consider` under the lock: true when a run begins now (`running` is set), for the
    /// caller to fly once the lock is released.
    fn consider_locked(&self, inner: &mut Inner, now: i64) -> bool {
        if inner.stopped || !inner.go(now) {
            return false;
        }
        if inner.running {
            inner.nudged = true;
            return false;
        }
        let wait = inner
            .last_run_end
            .map_or(i64::MIN, |end| end + NUDGE_MS - now);
        if wait <= 0 {
            inner.running = true;
            return true;
        }
        if inner.nudge_timer.is_some() {
            return false;
        }
        inner.nudge_ids += 1;
        let id = inner.nudge_ids;
        let me = self.me.clone();
        let fire: Box<dyn FnOnce() + Send> = Box::new(move || {
            if let Some(scheduler) = me.upgrade() {
                {
                    let mut inner = scheduler.inner();
                    if inner.nudge_timer.as_ref().is_some_and(|(t, _)| *t == id) {
                        inner.nudge_timer = None;
                    }
                }
                scheduler.consider();
            }
        });
        let cancel = match &self.deps.later {
            Some(later) => later(fire, wait as u64),
            None => timeout(fire, wait as u64),
        };
        inner.nudge_timer = Some((id, cancel));
        false
    }

    /// Re-typing is off: every pending draft, whatever its account, is left for Copy as
    /// `manual`. One whose mark fails stays pending, and the 10 s retries try it again.
    fn leave_all(&self, before: &[DraftSummary]) {
        let restorer = &*self.deps.restorer;
        let mut left = 0;
        let mut failed = 0;
        for draft in before {
            if draft.state != DraftState::Pending {
                continue;
            }
            if restorer
                .mark(&draft.id, DraftState::NeedsCopy, Some("manual"))
                .is_ok()
            {
                self.inner().stalls.remove(&draft.id);
                left += 1;
            } else {
                failed += 1;
            }
        }
        self.log("retype-off", json!({ "left": left, "failed": failed }));
        if left > 0 {
            let _ = restorer.notify(DraftCounts { restored: 0, left });
            let _ = (self.deps.changed)();
        }
        let mut inner = self.inner();
        if failed > 0 {
            self.arm_locked(&mut inner, RETRY_MS);
        } else {
            inner.disarm();
        }
    }

    /// Arms what the pending `drafts` need: the 10 s retries while one is for Desktop's
    /// `account`, the 60 s check while they wait only for other accounts, nothing otherwise.
    fn schedule_locked(&self, inner: &mut Inner, drafts: &[DraftSummary], account: Option<String>) {
        let pending: Vec<&DraftSummary> = drafts
            .iter()
            .filter(|d| d.state == DraftState::Pending)
            .collect();
        let mine = account
            .as_deref()
            .filter(|a| !a.is_empty())
            .is_some_and(|account| pending.iter().any(|d| same_account(&d.to, account)));
        inner.account = account;
        if pending.is_empty() {
            return inner.disarm();
        }
        self.arm_locked(inner, if mine { RETRY_MS } else { ACCOUNT_CHECK_MS });
    }

    /// The 60 s check: Desktop's account alone, and a full pass once it is another.
    fn check(&self) {
        {
            let inner = self.inner();
            if inner.running || inner.stopped {
                return;
            }
        }
        let current = self.current_account();
        if same_read(current.as_deref(), self.inner().account.as_deref()) {
            return;
        }
        self.run(false)
    }

    /// Desktop's account; `None` when it cannot be read.
    fn current_account(&self) -> Option<String> {
        self.deps.restorer.current_account().ok().flatten()
    }

    fn read(&self) -> Vec<DraftSummary> {
        (self.deps.drafts)().unwrap_or_default()
    }

    fn arm_locked(&self, inner: &mut Inner, period: u64) {
        if inner.stopped || (inner.cancel.is_some() && inner.period == Some(period)) {
            return;
        }
        inner.disarm();
        inner.period = Some(period);
        let me = self.me.clone();
        let tick: Box<dyn Fn() + Send + Sync> = Box::new(move || {
            if let Some(scheduler) = me.upgrade() {
                if period == RETRY_MS {
                    scheduler.tick();
                } else {
                    scheduler.check();
                }
            }
        });
        inner.cancel = Some(match &self.deps.every {
            Some(every) => every(tick, period),
            None => interval(tick, period),
        });
    }
}

/// Where the panel's actions read and change drafts: Desktop's manager in the app.
pub trait DraftSource: Send + Sync {
    fn pending_drafts(&self) -> Result<Vec<DraftSummary>, String>;
    fn draft_text(&self, id: &str) -> Result<Option<String>, String>;
    fn dismiss_draft(&self, id: &str) -> Result<(), String>;
}

impl DraftSource for DesktopManager {
    fn pending_drafts(&self) -> Result<Vec<DraftSummary>, String> {
        Ok(DesktopManager::pending_drafts(self))
    }
    fn draft_text(&self, id: &str) -> Result<Option<String>, String> {
        Ok(DesktopManager::draft_text(self, id))
    }
    fn dismiss_draft(&self, id: &str) -> Result<(), String> {
        DesktopManager::dismiss_draft(self, id).map_err(|e| e.to_string())
    }
}

/// The panel's view of the drafts: summaries, never text, and none when the vault cannot be
/// read.
pub fn draft_summaries(source: &dyn DraftSource) -> Vec<DraftSummary> {
    source.pending_drafts().unwrap_or_default()
}

const GONE: &str = "This draft is no longer there.";
const WAITING: &str = "This draft is still waiting to be restored.";

/// Why a panel action on a draft failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DraftActionError {
    /// The id is not a uuid (zod's `z.uuid().parse`).
    #[error("Invalid UUID")]
    InvalidId,
    #[error("{GONE}")]
    Gone,
    #[error("{WAITING}")]
    Waiting,
    /// The vault's or the clipboard's own message.
    #[error("{0}")]
    Failed(String),
}

/// Writes text to the clipboard; the error is the clipboard's message.
pub type WriteClipboard = Box<dyn Fn(&str) -> Result<(), String> + Send + Sync>;

pub struct DraftActionsDeps {
    pub drafts: Arc<dyn DraftSource>,
    pub write_clipboard: WriteClipboard,
    pub changed: Box<dyn Fn() + Send + Sync>,
    /// A diagnosis log: the draft's id cut to 8 characters and how the action ended.
    pub log: Option<Arc<DraftLog>>,
}

/// The panel's Copy and Dismiss, by record id. See [`draft_actions`].
pub struct DraftActions {
    deps: DraftActionsDeps,
}

/// The panel's Copy and Dismiss, by record id, for a draft left for copy only: one still
/// waiting to be restored, or gone, is left as it is and the call fails. Copy writes the text
/// to the clipboard here, in main, and then removes the record; neither ever returns anything.
/// Either way the renderers are told to read the drafts again.
pub fn draft_actions(deps: DraftActionsDeps) -> DraftActions {
    DraftActions { deps }
}

fn draft_id(raw: &Value) -> Result<String, DraftActionError> {
    match raw {
        Value::String(id) if is_uuid(id) => Ok(id.clone()),
        _ => Err(DraftActionError::InvalidId),
    }
}

/// How an action ended, for the log: this code's own refusals say why, anything else does not.
fn outcome(error: &DraftActionError) -> &'static str {
    match error {
        DraftActionError::Gone => GONE,
        DraftActionError::Waiting => WAITING,
        _ => "failed",
    }
}

impl DraftActions {
    fn log(&self, event: &str, fields: Value) {
        if let Value::Object(fields) = fields {
            log_draft(self.deps.log.as_deref(), event, Some(&fields));
        }
    }

    fn find(&self, id: &str) -> Result<DraftSummary, DraftActionError> {
        self.deps
            .drafts
            .pending_drafts()
            .map_err(DraftActionError::Failed)?
            .into_iter()
            .find(|d| d.id == id)
            .ok_or(DraftActionError::Gone)
    }

    /// Puts a draft's text on the clipboard. One left for copy goes once copied; one still
    /// waiting to be restored stays.
    pub fn copy(&self, raw: &Value) -> Result<(), DraftActionError> {
        let id = draft_id(raw)?;
        let result = (|| {
            let draft = self.find(&id)?;
            let text = self
                .deps
                .drafts
                .draft_text(&id)
                .map_err(DraftActionError::Failed)?
                .ok_or(DraftActionError::Gone)?;
            (self.deps.write_clipboard)(&text).map_err(DraftActionError::Failed)?;
            let left = draft.state == DraftState::NeedsCopy;
            if left {
                self.deps
                    .drafts
                    .dismiss_draft(&id)
                    .map_err(DraftActionError::Failed)?;
            }
            let mut fields = json!({ "id": short_id(Some(&id)), "ok": true });
            if !left {
                fields["kept"] = json!(true);
            }
            self.log("draft-copy", fields);
            Ok(())
        })();
        if let Err(error) = &result {
            self.log(
                "draft-copy",
                json!({ "id": short_id(Some(&id)), "ok": false, "reason": outcome(error) }),
            );
        }
        (self.deps.changed)();
        result
    }

    pub fn dismiss(&self, raw: &Value) -> Result<(), DraftActionError> {
        let id = draft_id(raw)?;
        let result = (|| {
            // Only a draft waiting to be copied by hand.
            if self.find(&id)?.state != DraftState::NeedsCopy {
                return Err(DraftActionError::Waiting);
            }
            self.deps
                .drafts
                .dismiss_draft(&id)
                .map_err(DraftActionError::Failed)?;
            self.log(
                "draft-dismiss",
                json!({ "id": short_id(Some(&id)), "ok": true }),
            );
            Ok(())
        })();
        if let Err(error) = &result {
            self.log(
                "draft-dismiss",
                json!({ "id": short_id(Some(&id)), "ok": false, "reason": outcome(error) }),
            );
        }
        (self.deps.changed)();
        result
    }
}
