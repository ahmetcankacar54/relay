//! Port of `electron/core/window-keeper.ts`: keeps each planned account's five-hour window
//! running from its first warm-up until work ends, starting at most one window per tick.

use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::adaptive_schedule::{
    AdaptiveInput, AdaptiveNoticeKind, AdaptiveSchedule, Schedule, Search,
};
use crate::continuation_journal::{
    MAX_BYTES, PrivateJsonError, private_journal_directory, read_private_json, write_private_json,
};
use crate::shared::account_state::displayed_issue;
use crate::shared::day_plan::{
    PlanContext, day_plan, next_planned_start, plan_context, should_have_window,
};
use crate::shared::planning::{local_date, planning_identity};
use crate::shared::tempo::Tempo;
use crate::shared::types::js::{self, JsMap, date_parse, iso};
use crate::shared::types::{
    Account, AccountUsage, KeeperAccountState, KeeperAccountStatus, KeeperAdaptation, KeeperNext,
    KeeperSnapshot, PlanningSettings, ScheduledStart, UsageIssue, UsageStatus, WindowAttempt,
    WindowAttemptStatus,
};
use crate::shared::usage_statistics::UsageSample;

pub const KEEPER_TICK_MS: f64 = 60_000.0;
pub const KEEPER_COOLDOWN_MS: f64 = 15.0 * 60_000.0;
pub const KEEPER_DAILY_LIMIT: usize = 8;
const FRESH_MS: f64 = 5.0 * 60_000.0;
const NOTIFY_MS: f64 = 60.0 * 60_000.0;
/// Usage issues that pass on their own: they wait for a fresh read, never block.
const TRANSIENT_ISSUES: [UsageIssue; 2] = [UsageIssue::RateLimited, UsageIssue::Unavailable];
/// Refusals that repeat on every attempt (administrator policy, an unsupported system or CLI).
/// They stop the account until the plan changes, or for KEEPER_STOP_RETRY_MS: a policy removed
/// or a CLI installed meanwhile must not leave the plan silently off for good.
pub const KEEPER_STOP_REASONS: [&str; 4] = [
    "routine-policy-unverified",
    "routine-platform-unsupported",
    "routine-cli-unavailable",
    "routine-cli-unsupported",
];
/// How long a stopping refusal holds before the keeper tries the account again.
pub const KEEPER_STOP_RETRY_MS: f64 = 6.0 * 60.0 * 60_000.0;
/// How many attempts the log keeps.
const ATTEMPTS_KEPT: usize = 200;

#[derive(Debug, Clone, PartialEq)]
pub struct KeeperState {
    pub settings: PlanningSettings,
    pub accounts: Vec<Account>,
    pub usage: JsMap<AccountUsage>,
    /// What the plan assumes about the work pace (learned or chosen).
    pub tempo: Tempo,
    /// Another Relay operation owns Claude or a sign-in is in progress.
    pub blocked: bool,
    /// Accounts with a running Relay CLI session.
    pub busy_account_ids: Vec<String>,
    /// Raw usage samples of the last hour: today's pace.
    pub recent_samples: Vec<UsageSample>,
    /// The account Claude Desktop uses now.
    pub active_id: Option<String>,
}

/// Today's schedule changed (already throttled): what the user is told.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AdaptedNotice {
    pub kind: AdaptiveNoticeKind,
    pub schedule: Vec<ScheduledStart>,
}

/// What the keeper drives. Every call blocks; errors carry the sanitized reason the TS throws.
pub trait KeeperDeps: Send + Sync {
    fn now(&self) -> f64 {
        crate::clock::now_ms() as f64
    }
    fn state(&self) -> KeeperState;
    fn refresh(&self, account_id: &str) -> Result<(), String>;
    fn refresh_after_start(&self, account_id: &str) -> Result<AccountUsage, String>;
    /// Sends the isolated window-start message; an error is a sanitized reason.
    fn start(&self, account: &Account) -> Result<(), String>;
    fn notify(&self, _account: &Account, _reason: &str) {}
    /// Today's schedule changed (already throttled): tell the user. An error changes nothing.
    fn adapted(&self, _notice: &AdaptedNotice) -> Result<(), String> {
        Ok(())
    }
    fn changed(&self);
}

/// A keeper decision: the account's status, and whether its usage should be read first.
#[derive(Debug, Clone, PartialEq)]
pub struct Decision {
    pub status: KeeperAccountStatus,
    pub refresh: bool,
}

fn decision(
    account_id: &str,
    state: KeeperAccountState,
    reason: Option<&str>,
    next_start_at: Option<String>,
) -> Decision {
    Decision {
        status: KeeperAccountStatus {
            account_id: account_id.to_string(),
            state,
            reason: reason.map(str::to_string),
            resets_at: None,
            next_start_at,
        },
        refresh: false,
    }
}

/// Planned accounts that still exist in Relay; deleted ones take no slot.
fn planned(state: &KeeperState) -> PlanningSettings {
    let mut settings = state.settings.clone();
    settings
        .accounts
        .retain(|a| state.accounts.iter().any(|x| x.id == a.id));
    settings
}

/// Capacities and tempo the plan is drawn with.
fn keeper_context(state: &KeeperState) -> PlanContext {
    plan_context(&state.accounts, state.tempo.clone())
}

/// The schedule as a list with ISO times, earliest first, then in plan order.
fn start_list(schedule: &Schedule, settings: &PlanningSettings) -> Vec<ScheduledStart> {
    let order = |id: &str| {
        settings
            .accounts
            .iter()
            .position(|a| a.id == id)
            .map_or(-1.0, |i| i as f64)
    };
    let mut entries: Vec<(&String, f64)> = schedule.iter().map(|(id, t)| (id, *t)).collect();
    js::sort_by(&mut entries, |(a, x), (b, y)| {
        let by_time = x - y;
        if by_time != 0.0 && !by_time.is_nan() {
            by_time
        } else {
            order(a) - order(b)
        }
    });
    entries
        .into_iter()
        .map(|(account_id, time)| ScheduledStart {
            account_id: account_id.clone(),
            start_at: iso(time),
        })
        .collect()
}

fn fresh(usage: Option<&AccountUsage>, now: f64) -> bool {
    let Some(usage) = usage else { return false };
    let checked = date_parse(usage.checked_at.as_deref().unwrap_or(""));
    usage.status == UsageStatus::Ready
        && !usage.stale
        && checked.is_finite()
        && now - checked <= FRESH_MS
}

/// What the keeper should do for one planned account right now. A closed window waits for
/// `scheduled_start` (today's adapted schedule) when given.
#[allow(clippy::too_many_arguments)]
pub fn keeper_decision(
    account: &Account,
    usage: Option<&AccountUsage>,
    settings: &PlanningSettings,
    context: &PlanContext,
    attempts: &[WindowAttempt],
    now: f64,
    busy: bool,
    stopped: Option<&str>,
    scheduled_start: Option<f64>,
) -> Decision {
    let id = account.id.as_str();
    if !settings.auto_start {
        return decision(id, KeeperAccountState::Off, None, None);
    }
    let Some(identity) = planning_identity(account) else {
        return decision(id, KeeperAccountState::Blocked, Some("identity"), None);
    };
    if let Some(stopped) = stopped.filter(|s| !s.is_empty()) {
        return decision(id, KeeperAccountState::Blocked, Some(stopped), None);
    }
    if !should_have_window(id, now, settings, context) {
        let next = next_planned_start(id, now, settings, context);
        return decision(
            id,
            KeeperAccountState::Outside,
            None,
            next.filter(|n| *n != 0.0 && !n.is_nan()).map(iso),
        );
    }
    if !fresh(usage, now) {
        // A connection that needs the user is reported, not shown as refreshing. The issue is
        // the one every surface shows, so a flag left under a rate-limit or an outage does not
        // block.
        let issue = displayed_issue(usage);
        let mut out = match issue {
            Some(issue) if !TRANSIENT_ISSUES.contains(&issue) => decision(
                id,
                KeeperAccountState::Blocked,
                Some("usage-connection"),
                None,
            ),
            _ => decision(id, KeeperAccountState::Waiting, Some("usage-stale"), None),
        };
        out.refresh = true;
        return out;
    }
    let usage = usage.expect("fresh usage exists");
    let reset = date_parse(
        usage
            .five_hour
            .as_ref()
            .and_then(|w| w.resets_at.as_deref())
            .unwrap_or(""),
    );
    if reset.is_finite() && reset > now {
        let mut out = decision(id, KeeperAccountState::Active, None, None);
        out.status.resets_at = Some(iso(reset));
        return out;
    }
    if usage.seven_day.as_ref().map_or(0.0, |w| w.used_percent) >= 100.0 {
        return decision(id, KeeperAccountState::Blocked, Some("weekly-limit"), None);
    }
    if let Some(scheduled) = scheduled_start.filter(|s| now < *s) {
        return decision(
            id,
            KeeperAccountState::Waiting,
            Some("adapted"),
            Some(iso(scheduled)),
        );
    }
    if busy {
        return decision(id, KeeperAccountState::Waiting, Some("in-use"), None);
    }
    let mine: Vec<&WindowAttempt> = attempts
        .iter()
        .filter(|a| a.identity_key == identity)
        .collect();
    let today = local_date(now, &settings.time_zone);
    if mine
        .iter()
        .filter(|a| local_date(date_parse(&a.at), &settings.time_zone) == today)
        .count()
        >= KEEPER_DAILY_LIMIT
    {
        return decision(id, KeeperAccountState::Blocked, Some("daily-limit"), None);
    }
    // A timestamp in the future (clock moved back) does not block for hours.
    let recent = mine.iter().any(|a| {
        let time = date_parse(&a.at);
        time <= now && now - time < KEEPER_COOLDOWN_MS
    });
    if recent {
        return decision(id, KeeperAccountState::Waiting, Some("cooldown"), None);
    }
    decision(id, KeeperAccountState::Due, None, None)
}

#[derive(Serialize, Deserialize)]
struct AttemptLog {
    version: u32,
    attempts: Vec<WindowAttempt>,
}

struct Stop {
    reason: String,
    at: f64,
}

struct Inner {
    attempts: Vec<WindowAttempt>,
    statuses: Vec<KeeperAccountStatus>,
    notified: HashMap<String, f64>,
    /// The snapshot the windows were last told about, as JSON.
    published: Option<String>,
    /// Identity → the refusal that stopped it and when; cleared when the plan changes.
    stopped: HashMap<String, Stop>,
    /// Today's next starts at today's pace; rebuilt after a restart.
    adaptive: AdaptiveSchedule,
}

/// Keeps each planned account's five-hour window running from its first warm-up until work
/// ends, starting at most one window per tick.
pub struct WindowKeeper {
    deps: Arc<dyn KeeperDeps>,
    file: PathBuf,
    running: AtomicBool,
    inner: Mutex<Inner>,
    timer: Mutex<Option<Sender<()>>>,
}

impl WindowKeeper {
    /// Opens the attempt log in `directory` (created private). A send that may have happened
    /// when Relay stopped is marked failed ("interrupted") and never repeated.
    pub fn new(directory: &Path, deps: Arc<dyn KeeperDeps>) -> Result<Self, PrivateJsonError> {
        Self::with_search(directory, deps, None)
    }

    /// [`WindowKeeper::new`] with the adaptive schedule's search replaced (tests make it fail).
    pub fn with_search(
        directory: &Path,
        deps: Arc<dyn KeeperDeps>,
        search: Option<Search>,
    ) -> Result<Self, PrivateJsonError> {
        let clock = deps.clone();
        let adaptive = AdaptiveSchedule::new(Some(Box::new(move || clock.now())), search);
        private_journal_directory(directory)?;
        let file = directory.join("attempts.json");
        let mut attempts: Vec<WindowAttempt> = Vec::new();
        // First run or unreadable log: start empty.
        if let Ok(saved) = read_private_json(&file, MAX_BYTES)
            && saved.get("version").and_then(serde_json::Value::as_f64) == Some(1.0)
            && let Some(list) = saved.get("attempts").filter(|a| a.is_array())
            && let Ok(list) = serde_json::from_value::<Vec<WindowAttempt>>(list.clone())
        {
            attempts = list;
        }
        let keeper = WindowKeeper {
            deps,
            file,
            running: AtomicBool::new(false),
            inner: Mutex::new(Inner {
                attempts,
                statuses: Vec::new(),
                notified: HashMap::new(),
                published: None,
                stopped: HashMap::new(),
                adaptive,
            }),
            timer: Mutex::new(None),
        };
        {
            let mut inner = keeper.lock();
            // A send that may have happened when Relay stopped is never repeated.
            let mut interrupted = false;
            for attempt in &mut inner.attempts {
                if attempt.status == WindowAttemptStatus::Started {
                    attempt.status = WindowAttemptStatus::Failed;
                    attempt.reason = Some("interrupted".into());
                    interrupted = true;
                }
            }
            if interrupted {
                keeper.persist(&mut inner)?;
            }
            // A stop survives restarts: the newest attempt per identity decides.
            let Inner {
                attempts, stopped, ..
            } = &mut *inner;
            for attempt in attempts.iter() {
                match attempt.reason.as_deref() {
                    Some(reason)
                        if attempt.status == WindowAttemptStatus::Failed
                            && KEEPER_STOP_REASONS.contains(&reason) =>
                    {
                        stopped.insert(
                            attempt.identity_key.clone(),
                            Stop {
                                reason: reason.to_string(),
                                at: date_parse(&attempt.at),
                            },
                        );
                    }
                    _ => {
                        stopped.remove(&attempt.identity_key);
                    }
                }
            }
        }
        Ok(keeper)
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn now(&self) -> f64 {
        self.deps.now()
    }

    fn persist(&self, inner: &mut Inner) -> Result<(), PrivateJsonError> {
        let excess = inner.attempts.len().saturating_sub(ATTEMPTS_KEPT);
        inner.attempts.drain(..excess);
        write_private_json(
            &self.file,
            &AttemptLog {
                version: 1,
                attempts: inner.attempts.clone(),
            },
            MAX_BYTES,
        )
    }

    /// Ticks now and every minute on a background thread until [`WindowKeeper::stop`] (or the
    /// keeper is dropped).
    pub fn start(self: &Arc<Self>) {
        let mut timer = self.timer.lock().unwrap_or_else(|p| p.into_inner());
        if timer.is_some() {
            return;
        }
        let (stop, stopped) = mpsc::channel::<()>();
        *timer = Some(stop);
        let keeper: Weak<Self> = Arc::downgrade(self);
        std::thread::spawn(move || {
            let every = Duration::from_millis(KEEPER_TICK_MS as u64);
            loop {
                let Some(keeper) = keeper.upgrade() else {
                    return;
                };
                // An unwritable log fails one tick; the next one tries again.
                let _ = keeper.tick();
                drop(keeper);
                match stopped.recv_timeout(every) {
                    Err(RecvTimeoutError::Timeout) => continue,
                    _ => return,
                }
            }
        });
    }

    pub fn stop(&self) {
        // Dropping the sender ends the timer thread.
        self.timer.lock().unwrap_or_else(|p| p.into_inner()).take();
    }

    /// The refusal that still stops `identity` at `now`, if any.
    fn stopped_for(inner: &Inner, identity: Option<&str>, now: f64) -> Option<String> {
        let stop = inner.stopped.get(identity.unwrap_or(""))?;
        (now - stop.at < KEEPER_STOP_RETRY_MS).then(|| stop.reason.clone())
    }

    /// The plan changed: try stopped accounts again and re-plan today, quietly.
    pub fn resume(&self) {
        let mut inner = self.lock();
        inner.stopped.clear();
        inner.adaptive.reset();
    }

    /// The newest attempts first, as in the snapshot, without building the day plan.
    pub fn recent_attempts(&self) -> Vec<WindowAttempt> {
        Self::recent(&self.lock())
    }

    fn recent(inner: &Inner) -> Vec<WindowAttempt> {
        let from = inner.attempts.len().saturating_sub(20);
        inner.attempts[from..].iter().rev().cloned().collect()
    }

    pub fn snapshot(&self) -> KeeperSnapshot {
        let state = self.deps.state();
        let inner = self.lock();
        self.snapshot_of(&state, &inner)
    }

    fn snapshot_of(&self, state: &KeeperState, inner: &Inner) -> KeeperSnapshot {
        let settings = planned(state);
        let now = self.now();
        let today = day_plan(
            &local_date(now, &settings.time_zone),
            &settings,
            &keeper_context(state),
            None,
        );
        let adaptive = inner.adaptive.current();
        let mut upcoming: Vec<KeeperNext> = inner
            .statuses
            .iter()
            .filter_map(|s| {
                // A held restart or a deferred warm-up starts at its adopted time.
                let held = match s.state {
                    KeeperAccountState::Blocked | KeeperAccountState::Off => None,
                    _ => adaptive.schedule.get(&s.account_id).copied(),
                };
                let at = match held {
                    Some(held) => Some(iso(held)),
                    None => s.next_start_at.clone().or_else(|| s.resets_at.clone()),
                };
                at.filter(|at| !at.is_empty()).map(|at| KeeperNext {
                    account_id: s.account_id.clone(),
                    at,
                })
            })
            .collect();
        js::sort_by(&mut upcoming, |a, b| date_parse(&a.at) - date_parse(&b.at));
        let adaptation =
            (adaptive.factor > 1.0 || !adaptive.schedule.is_empty()).then(|| KeeperAdaptation {
                factor: adaptive.factor,
                observed_rate: adaptive.observed_rate,
                schedule: start_list(&adaptive.schedule, &settings),
                since: adaptive.since.map(iso),
            });
        KeeperSnapshot {
            enabled: settings.auto_start,
            running: self.running.load(Ordering::SeqCst),
            accounts: inner.statuses.clone(),
            attempts: Self::recent(inner),
            planned_today: today
                .accounts
                .iter()
                .map(|a| a.windows.len())
                .sum::<usize>() as f64,
            next: upcoming.into_iter().next(),
            tempo: Some(state.tempo.clone()),
            adaptation,
        }
    }

    fn evaluate(
        &self,
        state: &KeeperState,
        inner: &Inner,
        schedule: Option<&Schedule>,
    ) -> Vec<Decision> {
        let current;
        let schedule = match schedule {
            Some(schedule) => schedule,
            None => {
                current = inner.adaptive.current().schedule;
                &current
            }
        };
        let now = self.now();
        let settings = planned(state);
        let context = keeper_context(state);
        settings
            .accounts
            .iter()
            .filter_map(|p| state.accounts.iter().find(|a| a.id == p.id))
            .map(|account| {
                keeper_decision(
                    account,
                    state.usage.get(&account.id),
                    &settings,
                    &context,
                    &inner.attempts,
                    now,
                    state.busy_account_ids.contains(&account.id),
                    Self::stopped_for(inner, planning_identity(account).as_deref(), now).as_deref(),
                    schedule.get(&account.id).copied(),
                )
            })
            .collect()
    }

    /// Today's schedule for this tick: updated from the state (the user hears about a change),
    /// kept as it is while Relay is busy, and the plan's own starts if it cannot be computed.
    /// Returns the notice to send, which the caller sends without holding the lock.
    fn adapt(&self, state: &KeeperState, inner: &mut Inner) -> (Schedule, Option<AdaptedNotice>) {
        let settings = planned(state);
        // Another operation owns Claude: usage may be minutes old and the active account
        // mid-switch, so nothing is searched or adopted now. Turning auto start or adaptation
        // off only clears the schedule, and goes ahead.
        if state.blocked && settings.auto_start && settings.adaptive != Some(false) {
            return (inner.adaptive.current().schedule, None);
        }
        // Accounts the keeper cannot start, whatever the schedule says.
        let blocked: Vec<String> = self
            .evaluate(state, inner, Some(&JsMap::new()))
            .into_iter()
            .filter(|d| {
                matches!(
                    d.status.state,
                    KeeperAccountState::Blocked | KeeperAccountState::Off
                )
            })
            .map(|d| d.status.account_id)
            .collect();
        let input = AdaptiveInput {
            settings: settings.clone(),
            accounts: state.accounts.clone(),
            usage: state.usage.clone(),
            tempo: state.tempo.clone(),
            recent_samples: state.recent_samples.clone(),
            active_id: state.active_id.clone(),
            blocked,
            now: self.now(),
        };
        // A failing re-plan never stops the keep-alive.
        let Ok(result) = catch_unwind(AssertUnwindSafe(|| inner.adaptive.update(&input))) else {
            return (JsMap::new(), None);
        };
        let notice = result.notice.as_ref().map(|notice| AdaptedNotice {
            kind: notice.kind,
            schedule: start_list(&notice.schedule, &settings),
        });
        (result.schedule, notice)
    }

    /// One keeper pass: refresh stale usage, update today's schedule, then start at most one
    /// due window. A tick already running makes this one a no-op. An error is an attempt log
    /// that could not be written.
    pub fn tick(&self) -> Result<(), PrivateJsonError> {
        if self.running.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let result = self.run_tick();
        self.running.store(false, Ordering::SeqCst);
        self.publish();
        result
    }

    fn run_tick(&self) -> Result<(), PrivateJsonError> {
        let mut state = self.deps.state();
        if state.settings.auto_start && !state.blocked {
            let stale: Vec<String> = {
                let inner = self.lock();
                self.evaluate(&state, &inner, None)
                    .into_iter()
                    .filter(|d| d.refresh)
                    .map(|d| d.status.account_id)
                    .collect()
            };
            for id in &stale {
                let _ = self.deps.refresh(id);
            }
            if !stale.is_empty() {
                state = self.deps.state();
            }
        }
        // The schedule is built from the refreshed usage, before any start.
        let (schedule, notice) = {
            let mut inner = self.lock();
            self.adapt(&state, &mut inner)
        };
        if let Some(notice) = notice {
            // Not hearing about the schedule does not undo it.
            let _ = self.deps.adapted(&notice);
        }
        let mut decisions = self.evaluate(&state, &self.lock(), Some(&schedule));
        let due = decisions
            .iter()
            .find(|d| d.status.state == KeeperAccountState::Due)
            .map(|d| d.status.account_id.clone());
        if let Some(due) = due
            && state.settings.auto_start
            && !state.blocked
        {
            let account = state
                .accounts
                .iter()
                .find(|a| a.id == due)
                .expect("a due account exists")
                .clone();
            let started = self.start_one(&account);
            state = self.deps.state();
            decisions = self.evaluate(&state, &self.lock(), Some(&schedule));
            started?;
        }
        let statuses = decisions
            .into_iter()
            .map(|d| {
                let mut status = d.status;
                // Nothing is refreshed or started while Relay is busy.
                if state.blocked
                    && (status.state == KeeperAccountState::Due
                        || status.reason.as_deref() == Some("usage-stale"))
                {
                    status.state = KeeperAccountState::Waiting;
                    status.reason = Some("relay-busy".into());
                }
                status
            })
            .collect();
        self.lock().statuses = statuses;
        Ok(())
    }

    /// Tells the windows only when the snapshot changed.
    fn publish(&self) {
        let state = self.deps.state();
        let current = {
            let inner = self.lock();
            serde_json::to_string(&self.snapshot_of(&state, &inner)).ok()
        };
        {
            let mut inner = self.lock();
            if current.is_some() && current == inner.published {
                return;
            }
            inner.published = current;
        }
        self.deps.changed();
    }

    fn start_one(&self, account: &Account) -> Result<(), PrivateJsonError> {
        let now = self.now();
        let attempt = WindowAttempt {
            id: uuid::Uuid::new_v4().to_string(),
            account_id: account.id.clone(),
            identity_key: planning_identity(account).unwrap_or_default(),
            at: iso(now),
            status: WindowAttemptStatus::Started,
            reason: None,
            reset_at: None,
        };
        let id = attempt.id.clone();
        {
            let mut inner = self.lock();
            inner.attempts.push(attempt);
            self.persist(&mut inner)?;
        }
        let outcome = self.deps.start(account).map(|()| {
            let after = self.deps.refresh_after_start(&account.id).ok();
            date_parse(
                after
                    .as_ref()
                    .and_then(|u| u.five_hour.as_ref())
                    .and_then(|w| w.resets_at.as_deref())
                    .unwrap_or(""),
            )
        });
        let mut notify: Option<String> = None;
        {
            let mut inner = self.lock();
            let now = self.now();
            let Inner {
                attempts,
                stopped,
                notified,
                ..
            } = &mut *inner;
            if let Some(attempt) = attempts.iter_mut().find(|a| a.id == id) {
                match outcome {
                    Ok(reset) if reset.is_finite() && reset > now => {
                        attempt.status = WindowAttemptStatus::Verified;
                        attempt.reset_at = Some(iso(reset));
                    }
                    Ok(_) => attempt.status = WindowAttemptStatus::SentUnverified,
                    Err(reason) => {
                        attempt.status = WindowAttemptStatus::Failed;
                        attempt.reason = Some(reason.clone());
                        if KEEPER_STOP_REASONS.contains(&reason.as_str()) {
                            stopped.insert(
                                attempt.identity_key.clone(),
                                Stop {
                                    reason: reason.clone(),
                                    at: now,
                                },
                            );
                        }
                        let last = notified
                            .get(&account.id)
                            .copied()
                            .unwrap_or(f64::NEG_INFINITY);
                        if now - last >= NOTIFY_MS {
                            notified.insert(account.id.clone(), now);
                            notify = Some(reason);
                        }
                    }
                }
            }
        }
        if let Some(reason) = notify {
            self.deps.notify(account, &reason);
        }
        let mut inner = self.lock();
        self.persist(&mut inner)
    }
}

impl Drop for WindowKeeper {
    fn drop(&mut self) {
        self.stop();
    }
}
