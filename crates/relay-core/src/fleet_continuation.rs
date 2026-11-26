//! Port of `electron/core/fleet-continuation.ts`: when the active Desktop account runs out of
//! quota, switch Claude once and continue every conversation that stopped at the limit.
//!
//! Blocking where the TS awaits. The TS `setInterval` is a background thread
//! ([`thread_interval`]); the TS dependency object is [`FleetDeps`], a struct of shared closures,
//! so a caller swaps one the way the TS tests spread `{...deps, stops}`.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use indexmap::IndexMap;
use relay_i18n::{Args, Locale, translate};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::continuation_journal::{
    MAX_BYTES, private_journal_directory, read_private_json, write_private_json,
};
use crate::desktop::{
    AnswerGuard, BeforeQuit, CanProceed, DesktopError, DesktopResult, DesktopSwitchOptions,
    desktop_switch_refused,
};
use crate::desktop_continuation::{ContinuationTimer, DesktopContinuationContext, thread_interval};
use crate::desktop_continuation_evidence::{BackgroundCommand, BackgroundStopResult, QuotaStop};
use crate::desktop_files::js_truthy;
use crate::shared::continuation_readiness::{
    ContinuationTargetReadinessReason, continuation_target_readiness_reason,
};
use crate::shared::continuation_target_ranking::{
    ContinuationTargetCandidate, RankingContext, rank_continuation_targets,
};
use crate::shared::types::js::{JsMap, date_parse, iso, ser_num};
use crate::shared::types::{
    Account, AccountUsage, DesktopState, FleetContinuationState, FleetLast, FleetStatus,
    RelaySettings, UsageStatus, literal_enum,
};
use crate::shared::usage::SOURCE_FRESH_MS;

pub use crate::shared::usage::source_exhausted;

literal_enum!(
    /// Outcome of one conversation's continuation. "unknown" is never retried.
    FleetResult {
        Started = "started",
        Accepted = "accepted",
        Unknown = "unknown",
        Skipped = "skipped",
    }
);

literal_enum!(
    /// A conversation's result in a pending switch: a [`FleetResult`], or `sending` while its
    /// one send may be under way.
    PendingResult {
        Started = "started",
        Accepted = "accepted",
        Unknown = "unknown",
        Skipped = "skipped",
        Sending = "sending",
    }
);

impl From<FleetResult> for PendingResult {
    fn from(result: FleetResult) -> Self {
        match result {
            FleetResult::Started => PendingResult::Started,
            FleetResult::Accepted => PendingResult::Accepted,
            FleetResult::Unknown => PendingResult::Unknown,
            FleetResult::Skipped => PendingResult::Skipped,
        }
    }
}

literal_enum!(PendingStage { Switching = "switching", Continuing = "continuing" });

/// What the fleet reads of Relay's state: accounts, settings, usage and the tempo.
pub type FleetSnapshot = DesktopContinuationContext;

pub type FleetClock = Arc<dyn Fn() -> f64 + Send + Sync>;
/// `beforeSend`: run right before the send; it records that the send may be under way.
pub type BeforeSend<'a> = dyn FnMut() -> Result<(), String> + 'a;
/// The work `with_desktop_lock` runs under the lock.
pub type LockedAction<'a> = dyn FnMut() -> Result<FleetContinuationState, String> + 'a;

pub type SnapshotFn = dyn Fn() -> FleetSnapshot + Send + Sync;
pub type DesktopFn = dyn Fn() -> Result<DesktopState, String> + Send + Sync;
pub type BusyFn = dyn Fn() -> bool + Send + Sync;
pub type RefreshUsageFn = dyn Fn(&str) -> Result<(), String> + Send + Sync;
pub type StopsFn = dyn Fn(&Account) -> Result<Vec<QuotaStop>, String> + Send + Sync;
pub type QuietFn = dyn Fn(&[QuotaStop]) -> Result<Option<String>, String> + Send + Sync;
pub type QuietSyncFn = dyn Fn(&[QuotaStop]) -> Option<String> + Send + Sync;
pub type UnchangedFn = dyn Fn(&QuotaStop) -> bool + Send + Sync;
pub type AutomationReadyFn = dyn Fn() -> Result<Option<String>, String> + Send + Sync;
pub type SwitchToFn = dyn Fn(&str, DesktopSwitchOptions) -> DesktopResult<()> + Send + Sync;
pub type ContinueOneFn = dyn Fn(&QuotaStop, &Account, &str, &mut BeforeSend<'_>) -> Result<FleetResult, String>
    + Send
    + Sync;
pub type WithDesktopLockFn =
    dyn Fn(&mut LockedAction<'_>) -> Result<FleetContinuationState, String> + Send + Sync;
pub type ChangedFn = dyn Fn() + Send + Sync;
pub type LogFn = dyn Fn(&str, &Map<String, Value>) + Send + Sync;
pub type QuietDetailFn = dyn Fn() -> Map<String, Value> + Send + Sync;
pub type FinishedFn = dyn Fn(&FleetLast, Option<&str>) + Send + Sync;
pub type BackgroundCommandsFn = dyn Fn() -> Vec<BackgroundCommand> + Send + Sync;
pub type StopBackgroundFn =
    dyn Fn(&HashSet<i64>) -> Result<BackgroundStopResult, String> + Send + Sync;
pub type AnswerQuitGuardFn = dyn Fn() -> Result<bool, String> + Send + Sync;

/// What the fleet needs from the app. Errors are the TS `Error.message`; optional TS members
/// are `Option`s.
#[derive(Clone)]
pub struct FleetDeps {
    pub directory: PathBuf,
    pub now: Option<FleetClock>,
    pub snapshot: Arc<SnapshotFn>,
    pub desktop: Arc<DesktopFn>,
    /// Another Relay operation (sign-in, single-conversation watch…) owns Claude now.
    pub busy: Arc<BusyFn>,
    /// Reads the account's usage from the server now, past its short success cache. Without it
    /// a stop newer than the last reading waits for the next scheduled one.
    pub refresh_usage: Option<Arc<RefreshUsageFn>>,
    pub stops: Arc<StopsFn>,
    /// Reason restarting Claude would interrupt other work, or None.
    pub quiet: Arc<QuietFn>,
    pub quiet_sync: Arc<QuietSyncFn>,
    pub unchanged: Arc<UnchangedFn>,
    /// Reason the UI automation cannot continue conversations, or None.
    pub automation_ready: Arc<AutomationReadyFn>,
    /// Fails with `DesktopError::SwitchRefused` when a guard called the switch off before Claude
    /// quit. The options are `automatic`, `can_proceed`, `before_quit` and `answer_quit_guard`:
    /// while Claude, asked to quit, still runs, it answers Claude's own question about
    /// background commands still running with "Quit anyway", once Relay has stopped them.
    pub switch_to: Arc<SwitchToFn>,
    /// Reopen, verify and send once. `before_send` must run right before the send.
    pub continue_one: Arc<ContinueOneFn>,
    pub with_desktop_lock: Arc<WithDesktopLockFn>,
    pub changed: Arc<ChangedFn>,
    /// A diagnosis log: each change of the fleet's state with what it waited on, and how each
    /// conversation's continuation ended. Fields are ids cut to 8 characters, states, reasons,
    /// counts and process names; never a conversation's text.
    pub log: Option<Arc<LogFn>>,
    /// What the last `quiet` found running, for the log: transcripts and process names.
    pub quiet_detail: Option<Arc<QuietDetailFn>>,
    /// A switch and its continuations are over: what became of them, to tell the user.
    pub finished: Option<Arc<FinishedFn>>,
    /// The commands the stopped sessions left running in the background (dev servers, builds,
    /// watchers), as the last `quiet` found them. Claude asks before it quits while one runs.
    pub background_commands: Option<Arc<BackgroundCommandsFn>>,
    /// Right before Claude quits: stops the background commands whose shells are `allowed`, and
    /// none when another one runs. What it stopped, what is left, what it did not expect.
    pub stop_background: Option<Arc<StopBackgroundFn>>,
    /// Answers Claude's quit question about background commands with "Quit anyway"; whether it
    /// did.
    pub answer_quit_guard: Option<Arc<AnswerQuitGuardFn>>,
}

/// An id for the diagnosis log: its first 8 characters, which tell two apart.
fn short(id: Option<&str>) -> Value {
    match id.filter(|id| !id.is_empty()) {
        Some(id) => json!(id.chars().take(8).collect::<String>()),
        None => Value::Null,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
    id: String,
    key: String,
    source_id: String,
    target_id: String,
    stops: Vec<QuotaStop>,
    stage: PendingStage,
    results: IndexMap<String, PendingResult>,
    #[serde(serialize_with = "ser_num")]
    started_at: f64,
}

/// `fleet-state.json`. Written with its keys in the order the TS object has them, which keeps
/// a key set to `undefined` in its place: `version`, `enabled`, `handled`, then `pending` and
/// `last` as they first appeared, and any key Relay does not know where the file had it.
#[derive(Debug, Clone)]
struct Saved {
    enabled: bool,
    /// Stops (account:conversation:turn) already handled; never handled twice.
    handled: Vec<Value>,
    pending: Option<Pending>,
    last: Option<FleetLast>,
    order: Vec<String>,
    extra: Map<String, Value>,
}

impl Saved {
    fn fresh() -> Saved {
        Saved {
            enabled: false,
            handled: Vec::new(),
            pending: None,
            last: None,
            order: vec!["version".into(), "enabled".into(), "handled".into()],
            extra: Map::new(),
        }
    }

    /// The saved state, when it is version 1 with a list of handled stops. A `pending` or
    /// `last` Relay cannot read makes the whole file unreadable.
    fn parse(value: Value) -> Option<Saved> {
        let Value::Object(map) = value else {
            return None;
        };
        if map.get("version").and_then(Value::as_f64) != Some(1.0) {
            return None;
        }
        let handled = map.get("handled")?.as_array()?.clone();
        let optional = |key: &str| map.get(key).filter(|v| !v.is_null()).cloned();
        let pending = match optional("pending") {
            Some(value) => Some(serde_json::from_value(value).ok()?),
            None => None,
        };
        let last = match optional("last") {
            Some(value) => Some(serde_json::from_value(value).ok()?),
            None => None,
        };
        let known = ["version", "enabled", "handled", "pending", "last"];
        Some(Saved {
            enabled: map.get("enabled").is_some_and(js_truthy),
            handled,
            pending,
            last,
            order: map.keys().cloned().collect(),
            extra: map
                .iter()
                .filter(|(key, _)| !known.contains(&key.as_str()))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        })
    }

    /// Assigning a key: one the object lacks goes last.
    fn touch(&mut self, key: &str) {
        if !self.order.iter().any(|k| k == key) {
            self.order.push(key.to_owned());
        }
    }

    fn set_enabled(&mut self, enabled: bool) {
        self.touch("enabled");
        self.enabled = enabled;
    }

    fn set_pending(&mut self, pending: Option<Pending>) {
        self.touch("pending");
        self.pending = pending;
    }

    fn set_last(&mut self, last: FleetLast) {
        self.touch("last");
        self.last = Some(last);
    }

    fn add_handled(&mut self, keys: impl IntoIterator<Item = String>) {
        self.touch("handled");
        self.handled.extend(keys.into_iter().map(Value::String));
    }

    fn handles(&self, key: &str) -> bool {
        self.handled.iter().any(|k| k.as_str() == Some(key))
    }

    fn to_json(&self) -> Value {
        let mut map = Map::new();
        for key in &self.order {
            let value = match key.as_str() {
                "version" => Some(json!(1)),
                "enabled" => Some(json!(self.enabled)),
                "handled" => Some(Value::Array(self.handled.clone())),
                "pending" => self.pending.as_ref().map(|p| json!(p)),
                "last" => self.last.as_ref().map(|l| json!(l)),
                other => self.extra.get(other).cloned(),
            };
            if let Some(value) = value {
                map.insert(key.clone(), value);
            }
        }
        Value::Object(map)
    }
}

fn stop_key(account: &Account, stop: &QuotaStop) -> String {
    let uuid = account
        .desktop
        .as_ref()
        .map(|d| d.account_uuid.to_lowercase())
        .unwrap_or_default();
    format!("{uuid}:{}:{}", stop.cli_session_id, stop.turn_id)
}

/// How long a quota-stop scan is reused while the source's quota state holds: a stop is seen
/// within this long of happening, before its usage is read again. The scan reads only what
/// transcripts gained since the last one.
pub const FLEET_SCAN_MS: f64 = 20_000.0;
/// The least time between two usage reads the fleet asks for, per source.
pub const FLEET_REREAD_MS: f64 = 60_000.0;
/// A background command that used CPU this recently is still working, as a build or a test run
/// is, and the switch waits for it to end. A server, which listens on a port, never ends on its
/// own; one that has been idle this long is waiting on nothing that will come.
pub const BACKGROUND_IDLE_MS: f64 = 2.0 * 60_000.0;
/// The longest the fleet waits for working background commands before it stops them too.
pub const BACKGROUND_WAIT_MS: f64 = 15.0 * 60_000.0;
/// How long after Relay stopped background commands a notification's stop counts as its own
/// doing.
const OWN_STOP_MS: f64 = 5.0 * 60_000.0;
/// How long conversations stopped at the limit wait for a switch made by hand: the user may
/// switch while the fleet still waits (for a build, or for Claude to settle) or after its own
/// switch failed, and they are continued in the account switched to.
pub const HANDOFF_MS: f64 = 60.0 * 60_000.0;
/// How often the fleet looks.
const TICK_MS: u64 = 10_000;

/// The background commands still working at `now`: not serving, and busy within
/// [`BACKGROUND_IDLE_MS`].
pub fn working_commands(commands: &[BackgroundCommand], now: f64) -> Vec<BackgroundCommand> {
    commands
        .iter()
        .filter(|command| {
            command.ports.is_empty()
                && command
                    .active_at
                    .is_some_and(|at| now - at < BACKGROUND_IDLE_MS)
        })
        .cloned()
        .collect()
}

/// Background commands for the log: each one's names, and its ports when it serves.
fn describe_commands(commands: &[BackgroundCommand]) -> String {
    let join = |items: Vec<String>, separator: &str| items.join(separator);
    let text = commands
        .iter()
        .map(|command| {
            let names = join(command.names.iter().take(3).cloned().collect(), "+");
            let names = if names.is_empty() { "sh".into() } else { names };
            if command.ports.is_empty() {
                names
            } else {
                let ports = command.ports.iter().take(3).map(i64::to_string).collect();
                format!("{names}:{}", join(ports, ","))
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    text.chars().take(160).collect()
}

/// A stop newer than the source's last usage reading, or one with no reading: it is out of
/// date.
fn stopped_since_reading(stops: &[QuotaStop], usage: Option<&AccountUsage>) -> bool {
    let checked = date_parse(usage.and_then(|u| u.checked_at.as_deref()).unwrap_or(""));
    stops
        .iter()
        .any(|stop| !checked.is_finite() || stop.stopped_at > checked)
}

literal_enum!(
    /// What a reading under 15 minutes old says about the source: out of quota ("full"), not
    /// ("room"), or there is no such reading ("unknown").
    SourceQuota { Full = "full", Room = "room", Unknown = "unknown" }
);

fn source_quota(usage: Option<&AccountUsage>, now: f64) -> SourceQuota {
    if source_exhausted(usage, now) {
        return SourceQuota::Full;
    }
    let checked = date_parse(usage.and_then(|u| u.checked_at.as_deref()).unwrap_or(""));
    let fresh = usage.is_some_and(|u| u.status == UsageStatus::Ready && !u.stale)
        && checked.is_finite()
        && checked <= now
        && now - checked <= SOURCE_FRESH_MS;
    if fresh {
        SourceQuota::Room
    } else {
        SourceQuota::Unknown
    }
}

/// Best eligible target: in the strategy's order among accounts with quota for half an hour at
/// the tempo (`rate`, Pro units per hour), else by plan capacity × smallest remaining quota.
pub fn choose_target<'a>(
    source: &Account,
    accounts: &'a [Account],
    settings: &RelaySettings,
    usage: &'a JsMap<AccountUsage>,
    now: f64,
    rate: Option<f64>,
) -> Option<&'a Account> {
    let eligible: Vec<ContinuationTargetCandidate<'a>> = accounts
        .iter()
        .filter(|account| {
            account.id != source.id
                && continuation_target_readiness_reason(
                    Some(source),
                    account,
                    usage.get(&account.id),
                    settings,
                    now,
                )
                .is_none()
        })
        .map(|account| ContinuationTargetCandidate {
            account,
            usage: usage.get(&account.id),
        })
        .collect();
    rank_continuation_targets(
        &eligible,
        Some(RankingContext {
            now,
            rate,
            strategy: settings.auto_switch_strategy,
        }),
    )
    .first()
    .map(|ranked| ranked.account)
}

/// `toLocaleUpperCase` of one character in the language's format locale.
fn upper_first(text: &str, language: Locale) -> String {
    let mut chars = text.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    let head = match (language, first) {
        (Locale::Tr, 'i') => "İ".to_owned(),
        (Locale::Tr, 'ı') => "I".to_owned(),
        _ => first.to_uppercase().collect(),
    };
    head + chars.as_str()
}

/// The notification after the fleet switched Claude to `name` at the limit: how many
/// conversations go on, and how many the user must continue or check. Counts only.
pub fn fleet_notice(
    last: &FleetLast,
    name: &str,
    language: Locale,
    reason: Option<&str>,
) -> String {
    let t = |id: &str, args: Args| translate(language, id, &args);
    let head = t(
        "fleetContinuation.limitReachedTheClaudeApp",
        Args::new().set("name", name),
    );
    if reason.is_some_and(|r| !r.is_empty()) || last.started + last.uncertain + last.skipped == 0.0
    {
        return format!(
            "{head} {}",
            t(
                "fleetContinuation.itsConversationsWereNotContinued",
                Args::new()
            )
        );
    }
    if last.started == last.conversations {
        return format!(
            "{head} {}",
            t(
                "fleetContinuation.conversationsContinueWhereTheyStopped",
                Args::new().set("started", last.started),
            )
        );
    }
    let mut parts = Vec::new();
    if last.started != 0.0 {
        parts.push(t(
            "fleetContinuation.conversationsContinue",
            Args::new().set("started", last.started),
        ));
    }
    if last.skipped != 0.0 {
        parts.push(t(
            "fleetContinuation.continueConversationsYourself",
            Args::new().set("skipped", last.skipped),
        ));
    }
    if last.uncertain != 0.0 {
        parts.push(t(
            "fleetContinuation.checkConversations",
            Args::new().set("uncertain", last.uncertain),
        ));
    }
    let text = parts
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("; ");
    format!("{head} {}.", upper_first(&text, language))
}

/// The last quota-stop scan, reused while the source and its quota state hold.
#[derive(Clone)]
struct ScanCache {
    source_id: String,
    quota: SourceQuota,
    at: f64,
    stops: Vec<QuotaStop>,
}

/// The conversations the active account left stopped at the limit, last seen at `at`.
#[derive(Clone)]
struct Awaiting {
    source_id: String,
    stops: Vec<QuotaStop>,
    at: f64,
}

struct FleetInner {
    saved: Saved,
    /// The published state, its keys in the order the TS object has them: a change of order
    /// counts as a change, as `JSON.stringify` compares.
    view: Map<String, Value>,
    scan: Option<ScanCache>,
    /// When the fleet last asked for a usage read of each account.
    rereads: HashMap<String, f64>,
    /// Since when the fleet has waited for working background commands, for which stops.
    background_wait: Option<(String, f64)>,
    /// When the fleet last stopped background commands, as a switch began.
    background_stopped_at: Option<f64>,
    awaiting: Option<Awaiting>,
}

fn lock(inner: &Mutex<FleetInner>) -> MutexGuard<'_, FleetInner> {
    inner.lock().unwrap_or_else(|e| e.into_inner())
}

fn fleet_now(deps: &FleetDeps) -> f64 {
    match &deps.now {
        Some(now) => now(),
        None => crate::clock::now_ms() as f64,
    }
}

/// The log is an aid, never a part of a switch.
fn log_event(deps: &FleetDeps, event: &str, fields: Map<String, Value>) {
    if let Some(log) = &deps.log {
        log(event, &fields);
    }
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// When the active Desktop account runs out of quota, waits until nothing else is working,
/// switches Claude to the best other account once and sends one continuation message to every
/// conversation that stopped at the limit. It stays on for later limits (A → B → A) and never
/// returns to an account that is still out of quota.
pub struct FleetContinuation {
    deps: FleetDeps,
    file: PathBuf,
    inner: Arc<Mutex<FleetInner>>,
    running: AtomicBool,
    timer: Mutex<Option<Box<dyn ContinuationTimer>>>,
}

impl FleetContinuation {
    pub fn new(deps: FleetDeps) -> Result<FleetContinuation, String> {
        private_journal_directory(&deps.directory).map_err(|e| e.to_string())?;
        let file = deps.directory.join("fleet-state.json");
        // Missing or unreadable: start off.
        let mut saved = read_private_json(&file, MAX_BYTES)
            .ok()
            .and_then(Saved::parse)
            .unwrap_or_else(Saved::fresh);
        // A send that was about to happen when Relay stopped is never repeated.
        if let Some(pending) = saved.pending.as_mut() {
            for result in pending.results.values_mut() {
                if *result == PendingResult::Sending {
                    *result = PendingResult::Unknown;
                }
            }
        }
        let mut view = Map::new();
        view.insert("enabled".into(), json!(saved.enabled));
        view.insert(
            "status".into(),
            json!(if saved.enabled {
                FleetStatus::Watching
            } else {
                FleetStatus::Off
            }),
        );
        if let Some(last) = &saved.last {
            view.insert("last".into(), json!(last));
        }
        Ok(FleetContinuation {
            deps,
            file,
            inner: Arc::new(Mutex::new(FleetInner {
                saved,
                view,
                scan: None,
                rereads: HashMap::new(),
                background_wait: None,
                background_stopped_at: None,
                awaiting: None,
            })),
            running: AtomicBool::new(false),
            timer: Mutex::new(None),
        })
    }

    fn inner(&self) -> MutexGuard<'_, FleetInner> {
        lock(&self.inner)
    }

    fn now(&self) -> f64 {
        fleet_now(&self.deps)
    }

    pub fn snapshot(&self) -> FleetContinuationState {
        let view = self.inner().view.clone();
        serde_json::from_value(Value::Object(view)).unwrap_or(FleetContinuationState {
            enabled: false,
            status: FleetStatus::Off,
            reason: None,
            source_id: None,
            target_id: None,
            stopped: None,
            checked_at: None,
            last: None,
        })
    }

    pub fn enabled(&self) -> bool {
        self.inner().saved.enabled
    }

    /// Looks every 10 s on a background thread, and once now on another.
    pub fn start(self: &Arc<Self>) {
        let mut timer = self.timer.lock().unwrap_or_else(|e| e.into_inner());
        if timer.is_some() {
            return;
        }
        let weak = Arc::downgrade(self);
        *timer = Some(thread_interval(
            TICK_MS,
            Box::new(move || {
                if let Some(fleet) = weak.upgrade() {
                    fleet.tick();
                }
            }),
        ));
        let fleet = Arc::clone(self);
        std::thread::spawn(move || {
            fleet.tick();
        });
    }

    pub fn stop(&self) {
        let timer = self.timer.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(timer) = timer {
            timer.cancel();
        }
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<FleetContinuationState, String> {
        self.inner().scan = None;
        self.save(|saved| saved.set_enabled(enabled))?;
        Ok(self.publish(
            if enabled {
                json!({ "status": "watching", "reason": "checking" })
            } else {
                json!({ "status": "off", "reason": null })
            },
            Map::new(),
        ))
    }

    fn save(&self, change: impl FnOnce(&mut Saved)) -> Result<(), String> {
        let mut next = self.inner().saved.clone();
        change(&mut next);
        let excess = next.handled.len().saturating_sub(300);
        next.handled.drain(..excess);
        write_private_json(&self.file, &next.to_json(), MAX_BYTES).map_err(|e| e.to_string())?;
        self.inner().saved = next;
        Ok(())
    }

    /// Tells the windows only when the state changed, not for a new check time alone, and logs
    /// the change with `detail`: what the fleet waited on. In `fields`, `null` is `undefined`.
    fn publish(&self, fields: Value, detail: Map<String, Value>) -> FleetContinuationState {
        let now = self.now();
        let (changed, view) = {
            let mut inner = self.inner();
            let mut previous = inner.view.clone();
            previous.shift_remove("checkedAt");
            let mut view = Map::new();
            view.insert("enabled".into(), json!(inner.saved.enabled));
            if let Some(last) = &inner.saved.last {
                view.insert("last".into(), json!(last));
            }
            view.insert("checkedAt".into(), json!(iso(now)));
            for (key, value) in object(fields) {
                if value.is_null() {
                    view.shift_remove(&key);
                } else {
                    view.insert(key, value);
                }
            }
            inner.view = view.clone();
            let mut compared = view.clone();
            compared.shift_remove("checkedAt");
            // `JSON.stringify` texts: the key order counts, unlike `Map` equality.
            let before = Value::Object(previous).to_string();
            let after = Value::Object(compared).to_string();
            (before != after, view)
        };
        if changed {
            (self.deps.changed)();
            let text = |key: &str| view.get(key).and_then(Value::as_str);
            let mut fields = Map::new();
            fields.insert(
                "status".into(),
                view.get("status").cloned().unwrap_or(Value::Null),
            );
            fields.insert(
                "reason".into(),
                view.get("reason").cloned().unwrap_or(Value::Null),
            );
            fields.insert("source".into(), short(text("sourceId")));
            fields.insert("target".into(), short(text("targetId")));
            fields.insert(
                "stopped".into(),
                view.get("stopped").cloned().unwrap_or(Value::Null),
            );
            fields.extend(detail);
            log_event(&self.deps, "state", fields);
        }
        self.snapshot()
    }

    /// Each other account and why it cannot take over now, or `ok`, for the log.
    fn target_reasons(&self, source: &Account, snapshot: &FleetSnapshot, now: f64) -> String {
        snapshot
            .accounts
            .iter()
            .filter(|account| account.id != source.id)
            .map(|account| {
                let reason = continuation_target_readiness_reason(
                    Some(source),
                    account,
                    snapshot.usage.get(&account.id),
                    &snapshot.settings,
                    now,
                );
                format!(
                    "{}:{}",
                    account.id.chars().take(8).collect::<String>(),
                    reason.map_or("ok", |r| r.as_str())
                )
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// No account can take over only because its last reading is too old: read those again
    /// now, each at most once a minute. Whether any was read.
    fn read_targets_again(&self, source: &Account, snapshot: &FleetSnapshot, now: f64) -> bool {
        let mut read = false;
        for account in &snapshot.accounts {
            if account.id != source.id
                && continuation_target_readiness_reason(
                    Some(source),
                    account,
                    snapshot.usage.get(&account.id),
                    &snapshot.settings,
                    now,
                ) == Some(ContinuationTargetReadinessReason::QuotaNotFresh)
                && self.read_again(&account.id)
            {
                read = true;
            }
        }
        read
    }

    pub fn tick(&self) -> FleetContinuationState {
        if self.running.swap(true, Ordering::SeqCst) {
            return self.snapshot();
        }
        let result = (|| {
            let pending = self.inner().saved.pending.clone();
            if let Some(pending) = pending {
                return self.resume(pending);
            }
            if !self.enabled() {
                return Ok(self.publish(json!({ "status": "off" }), Map::new()));
            }
            self.evaluate()
        })();
        let state = match result {
            Ok(state) => state,
            Err(message) => self.publish(
                json!({ "status": "attention", "reason": message }),
                Map::new(),
            ),
        };
        self.running.store(false, Ordering::SeqCst);
        state
    }

    fn unhandled(&self, source: &Account, stops: Vec<QuotaStop>) -> Vec<QuotaStop> {
        let inner = self.inner();
        stops
            .into_iter()
            .filter(|stop| !inner.saved.handles(&stop_key(source, stop)))
            .collect()
    }

    fn evaluate(&self) -> Result<FleetContinuationState, String> {
        let desktop = (self.deps.desktop)()?;
        if !desktop.available {
            return Ok(self.publish(
                json!({ "status": "waiting", "reason": "desktop-unavailable" }),
                Map::new(),
            ));
        }
        if desktop.busy
            || desktop.recovery_required
            || desktop
                .pending_profile_id
                .as_ref()
                .is_some_and(|id| !id.is_empty())
            || (self.deps.busy)()
        {
            return Ok(self.publish(
                json!({ "status": "waiting", "reason": "desktop-busy" }),
                Map::new(),
            ));
        }
        if desktop.windows.is_some_and(|w| w != 0.0 && !w.is_nan()) {
            return Ok(self.publish(
                json!({ "status": "waiting", "reason": "separate-window" }),
                Map::new(),
            ));
        }
        let snapshot = (self.deps.snapshot)();
        let Some(source) = snapshot
            .accounts
            .iter()
            .find(|a| Some(&a.id) == desktop.active_profile_id.as_ref())
            .filter(|a| a.desktop.is_some())
            .cloned()
        else {
            return Ok(self.publish(
                json!({ "status": "waiting", "reason": "source-not-enrolled" }),
                Map::new(),
            ));
        };
        let usage = &snapshot.usage;
        let now = self.now();
        let handoff = self.inner().awaiting.clone();
        if let Some(handoff) = handoff
            && handoff.source_id != source.id
        {
            self.inner().awaiting = None;
            if now - handoff.at < HANDOFF_MS
                && source_quota(usage.get(&source.id), now) != SourceQuota::Full
            {
                return self.continue_handoff(handoff, &source);
            }
        }
        let mut quota = source_quota(usage.get(&source.id), now);
        let scanned = self.quota_stops(&source, quota, now)?;
        let unhandled = self.unhandled(&source, scanned);
        let mut stops = self.without_own_stops(&source, unhandled)?;
        // A conversation that stopped at the limit after the last reading makes that reading
        // out of date: a 99 % read a minute before the stop must not hold the switch until the
        // next scheduled read. Read again now, at most once a minute.
        if quota != SourceQuota::Full
            && stopped_since_reading(&stops, usage.get(&source.id))
            && self.read_again(&source.id)
        {
            quota = source_quota((self.deps.snapshot)().usage.get(&source.id), self.now());
        }
        // While a fresh reading shows room, no conversation waits for another account.
        if quota == SourceQuota::Room {
            stops = Vec::new();
        }
        self.await_stops(&source, &stops, quota, now);
        let detail = object(json!({ "quota": quota }));
        if stops.is_empty() {
            // Name the account the fleet would pick while the active one is full, so the UI can
            // offer it. Nothing switches until a conversation stops.
            let target = if quota == SourceQuota::Full {
                choose_target(
                    &source,
                    &snapshot.accounts,
                    &snapshot.settings,
                    usage,
                    now,
                    snapshot.tempo_rate,
                )
            } else {
                None
            };
            let mut fields = object(json!({
                "status": "watching",
                "reason": "awaiting-quota-stop",
                "sourceId": source.id,
                "stopped": 0,
            }));
            if let Some(target) = target {
                fields.insert("targetId".into(), json!(target.id));
            }
            return Ok(self.publish(Value::Object(fields), detail));
        }
        let base = |extra: Value| {
            let mut fields = object(json!({ "sourceId": source.id, "stopped": stops.len() }));
            fields.extend(object(extra));
            Value::Object(fields)
        };
        if quota != SourceQuota::Full {
            return Ok(self.publish(
                base(json!({ "status": "waiting", "reason": "source-quota-unconfirmed" })),
                detail,
            ));
        }
        let mut target = choose_target(
            &source,
            &snapshot.accounts,
            &snapshot.settings,
            usage,
            now,
            snapshot.tempo_rate,
        )
        .cloned();
        // An account whose reading is only too old is read again now rather than at its turn.
        if target.is_none() && self.read_targets_again(&source, &snapshot, now) {
            let fresh = (self.deps.snapshot)();
            target = choose_target(
                &source,
                &fresh.accounts,
                &fresh.settings,
                &fresh.usage,
                self.now(),
                fresh.tempo_rate,
            )
            .cloned();
        }
        let Some(target) = target else {
            let fresh = (self.deps.snapshot)();
            let mut detail = detail;
            detail.insert(
                "targets".into(),
                json!(self.target_reasons(&source, &fresh, self.now())),
            );
            return Ok(self.publish(
                base(json!({ "status": "waiting", "reason": "no-target" })),
                detail,
            ));
        };
        if let Some(busy) = (self.deps.quiet)(&stops)? {
            let mut detail = detail;
            if let Some(quiet_detail) = &self.deps.quiet_detail {
                detail.extend(quiet_detail());
            }
            return Ok(self.publish(
                base(json!({ "targetId": target.id, "status": "waiting", "reason": busy })),
                detail,
            ));
        }
        // A build or a test a stopped session left running ends on its own: wait for it, up to
        // BACKGROUND_WAIT_MS. Servers and idle commands never do; they are stopped at the
        // switch.
        let commands = self
            .deps
            .background_commands
            .as_ref()
            .map(|commands| commands())
            .unwrap_or_default();
        let working = working_commands(&commands, self.now());
        if working.is_empty() {
            self.inner().background_wait = None;
        } else {
            let wanted = self.key(&source, &stops);
            let since = {
                let mut inner = self.inner();
                if inner.background_wait.as_ref().map(|(key, _)| key) != Some(&wanted) {
                    inner.background_wait = Some((wanted, self.now()));
                }
                inner
                    .background_wait
                    .as_ref()
                    .map_or(0.0, |(_, since)| *since)
            };
            if self.now() - since < BACKGROUND_WAIT_MS {
                let mut detail = detail;
                detail.insert("working".into(), json!(describe_commands(&working)));
                detail.insert("commands".into(), json!(describe_commands(&commands)));
                return Ok(self.publish(
                    base(json!({
                        "targetId": target.id,
                        "status": "waiting",
                        "reason": "background-work",
                    })),
                    detail,
                ));
            }
        }
        if let Some(automation) = (self.deps.automation_ready)()? {
            return Ok(self.publish(
                base(json!({ "targetId": target.id, "status": "attention", "reason": automation })),
                detail,
            ));
        }
        let lock = Arc::clone(&self.deps.with_desktop_lock);
        lock(&mut || self.switch_locked(&source, &target, &stops, quota, now))
    }

    fn key(&self, source: &Account, stops: &[QuotaStop]) -> String {
        let mut keys: Vec<String> = stops.iter().map(|stop| stop_key(source, stop)).collect();
        keys.sort();
        keys.join(",")
    }

    /// Under the Desktop lock: rescan, switch, and continue.
    fn switch_locked(
        &self,
        source: &Account,
        target: &Account,
        stops: &[QuotaStop],
        quota: SourceQuota,
        now: f64,
    ) -> Result<FleetContinuationState, String> {
        let base = |extra: Value| {
            let mut fields = object(json!({ "sourceId": source.id, "stopped": stops.len() }));
            fields.extend(object(extra));
            Value::Object(fields)
        };
        // Recheck under the lock: a new turn or task may have started meanwhile. From here on
        // only this fresh scan counts; the one above may be a minute old.
        let scanned = self.scan_stops(source, quota, self.now())?;
        let unhandled = self.unhandled(source, scanned);
        let current = self.without_own_stops(source, unhandled)?;
        if self.key(source, &current) != self.key(source, stops)
            || (self.deps.quiet)(&current)?.is_some()
        {
            return Ok(self.publish(
                base(json!({ "status": "waiting", "reason": "context-changed" })),
                Map::new(),
            ));
        }
        // The commands weighed above: the switch stops these, and no other.
        let stoppable: HashSet<i64> = self
            .deps
            .background_commands
            .as_ref()
            .map(|commands| commands())
            .unwrap_or_default()
            .iter()
            .map(|command| command.pid)
            .collect();
        let stopped = Arc::new(AtomicBool::new(false));
        let pending = Pending {
            id: uuid::Uuid::new_v4().to_string(),
            key: self.key(source, &current),
            source_id: source.id.clone(),
            target_id: target.id.clone(),
            stops: current.clone(),
            stage: PendingStage::Switching,
            results: IndexMap::new(),
            started_at: now,
        };
        self.save(|saved| saved.set_pending(Some(pending.clone())))?;
        // From here the switch continues them, or its failure hands them back below.
        self.inner().awaiting = None;
        self.publish(
            base(json!({ "targetId": target.id, "status": "switching" })),
            Map::new(),
        );
        let can_proceed: CanProceed = {
            let (deps, current) = (self.deps.clone(), current.clone());
            Arc::new(move || {
                (deps.quiet_sync)(&current).is_none()
                    && current.iter().all(|stop| (deps.unchanged)(stop))
            })
        };
        let before_quit: BeforeQuit = {
            let (deps, current) = (self.deps.clone(), current.clone());
            let (inner, stopped) = (Arc::clone(&self.inner), Arc::clone(&stopped));
            Arc::new(move || {
                let busy = (deps.quiet)(&current).map_err(DesktopError::new)?;
                if busy.is_some() || !current.iter().all(|stop| (deps.unchanged)(stop)) {
                    return Err(desktop_switch_refused("work-started"));
                }
                // Claude would ask before quitting while a background command runs: stop them.
                let Some(stop_background) = &deps.stop_background else {
                    return Ok(());
                };
                // Set first: a stopped command's notification may land while the stop runs.
                lock(&inner).background_stopped_at = Some(fleet_now(&deps));
                let result = stop_background(&stoppable).map_err(DesktopError::new)?;
                if !result.stopped.is_empty() || result.left > 0 || result.unexpected > 0 {
                    let names = result
                        .stopped
                        .join(" ")
                        .chars()
                        .take(160)
                        .collect::<String>();
                    log_event(
                        &deps,
                        "background-stopped",
                        object(json!({
                            "stopped": names,
                            "left": result.left,
                            "unexpected": result.unexpected,
                        })),
                    );
                }
                if result.unexpected > 0 || result.left > 0 {
                    return Err(desktop_switch_refused("background-left"));
                }
                stopped.store(!result.stopped.is_empty(), Ordering::SeqCst);
                Ok(())
            })
        };
        // Only after Relay stopped them: a background command Claude still counts is one of
        // those, ending. Without stopping, Claude's question stays the user's to answer.
        let answer_quit_guard: Arc<AnswerGuard> = {
            let deps = self.deps.clone();
            let stopped = Arc::clone(&stopped);
            Arc::new(move || {
                let Some(answer) = deps.answer_quit_guard.as_ref() else {
                    return Ok(false);
                };
                if !stopped.load(Ordering::SeqCst) {
                    return Ok(false);
                }
                let answered = answer().map_err(DesktopError::new)?;
                log_event(&deps, "quit-guard", object(json!({ "answered": answered })));
                Ok(answered)
            })
        };
        let switched = (self.deps.switch_to)(
            &target.id,
            DesktopSwitchOptions {
                automatic: true,
                can_proceed: Some(can_proceed),
                before_quit: Some(before_quit),
                answer_quit_guard: Some(answer_quit_guard),
                ..DesktopSwitchOptions::default()
            },
        );
        if let Err(error) = switched {
            let after = (self.deps.desktop)().ok();
            if after.and_then(|a| a.active_profile_id).as_deref() != Some(target.id.as_str()) {
                if let DesktopError::SwitchRefused(_) = error {
                    // Called off before Claude quit, often by a task notification landing in a
                    // stopped transcript: nothing restarted, so the next tick scans these again.
                    self.inner().scan = None;
                    self.save(|saved| saved.set_pending(None))?;
                    return Ok(self.publish(
                        base(json!({
                            "targetId": target.id,
                            "status": "waiting",
                            "reason": "context-changed",
                        })),
                        Map::new(),
                    ));
                }
                // Not switched, and a quit or a write may have happened. Never retry this limit
                // automatically: a persistent failure must not restart Claude again and again.
                // A switch the user then makes by hand still continues them.
                self.inner().awaiting = Some(Awaiting {
                    source_id: source.id.clone(),
                    stops: current.clone(),
                    at: self.now(),
                });
                self.save(|saved| {
                    saved.set_pending(None);
                    saved.add_handled(current.iter().map(|stop| stop_key(source, stop)));
                })?;
                return Ok(self.publish(
                    base(json!({
                        "targetId": target.id,
                        "status": "attention",
                        "reason": format!("switch-failed:{}", error.message()),
                    })),
                    Map::new(),
                ));
            }
        }
        self.continue_all(Pending {
            stage: PendingStage::Continuing,
            ..pending
        })
    }

    /// `stops` without those Relay caused itself: stopping a session's background command
    /// sends the session a notification, and out of quota that turn stops at the limit too.
    /// Such a stop, a notification's turn that began once Relay stopped commands, is no work to
    /// continue: it is marked handled and logged.
    fn without_own_stops(
        &self,
        source: &Account,
        stops: Vec<QuotaStop>,
    ) -> Result<Vec<QuotaStop>, String> {
        let Some(since) = self.inner().background_stopped_at else {
            return Ok(stops);
        };
        let (own, rest): (Vec<QuotaStop>, Vec<QuotaStop>) = stops.into_iter().partition(|stop| {
            stop.trigger == Some(crate::transcript_scan::TurnTrigger::TaskNotification)
                && stop.stopped_at >= since
                && stop.stopped_at - since < OWN_STOP_MS
        });
        if own.is_empty() {
            return Ok(rest);
        }
        self.save(|saved| saved.add_handled(own.iter().map(|stop| stop_key(source, stop))))?;
        for stop in &own {
            let id = stop
                .local_session_id
                .strip_prefix("local_")
                .unwrap_or(&stop.local_session_id);
            log_event(
                &self.deps,
                "stop-skipped",
                object(json!({
                    "conversation": short(Some(id)),
                    "why": "relay-stopped-its-command",
                })),
            );
        }
        Ok(rest)
    }

    /// Keeps what a switch by hand would continue: the source's stopped conversations, each by
    /// its latest stop, including those a failed switch left handled. Room again in the source
    /// ends the wait: they are the user's to continue there.
    fn await_stops(&self, source: &Account, stops: &[QuotaStop], quota: SourceQuota, now: f64) {
        let mut inner = self.inner();
        let kept = match &inner.awaiting {
            Some(awaiting) if awaiting.source_id == source.id => awaiting.stops.clone(),
            _ => Vec::new(),
        };
        if quota == SourceQuota::Room {
            inner.awaiting = None;
            return;
        }
        let mut latest: IndexMap<String, QuotaStop> = IndexMap::new();
        for stop in kept.into_iter().chain(stops.iter().cloned()) {
            let newer = latest
                .get(&stop.local_session_id)
                .is_none_or(|seen| stop.stopped_at >= seen.stopped_at);
            if newer {
                latest.insert(stop.local_session_id.clone(), stop);
            }
        }
        inner.awaiting = (!latest.is_empty()).then(|| Awaiting {
            source_id: source.id.clone(),
            stops: latest.into_values().collect(),
            at: now,
        });
    }

    /// The user switched by hand from an account whose conversations stopped at the limit, to
    /// `target`, which is not full: those conversations are continued there as after the
    /// fleet's own switch. Each is checked again before its send; one that moved on is skipped.
    fn continue_handoff(
        &self,
        handoff: Awaiting,
        target: &Account,
    ) -> Result<FleetContinuationState, String> {
        log_event(
            &self.deps,
            "handoff",
            object(json!({
                "source": short(Some(&handoff.source_id)),
                "target": short(Some(&target.id)),
                "stopped": handoff.stops.len(),
            })),
        );
        let mut keys: Vec<String> = handoff
            .stops
            .iter()
            .map(|stop| format!("{}:{}", stop.cli_session_id, stop.turn_id))
            .collect();
        keys.sort();
        let pending = Pending {
            id: uuid::Uuid::new_v4().to_string(),
            key: keys.join(","),
            source_id: handoff.source_id,
            target_id: target.id.clone(),
            stops: handoff.stops,
            stage: PendingStage::Continuing,
            results: IndexMap::new(),
            started_at: self.now(),
        };
        let lock = Arc::clone(&self.deps.with_desktop_lock);
        lock(&mut || self.continue_all(pending.clone()))
    }

    /// Asks for a fresh usage read of `account_id`, unless one was asked for under a minute ago.
    /// Whether it read.
    fn read_again(&self, account_id: &str) -> bool {
        let Some(refresh) = &self.deps.refresh_usage else {
            return false;
        };
        let now = self.now();
        {
            let mut inner = self.inner();
            if let Some(last) = inner.rereads.get(account_id)
                && now >= *last
                && now - last < FLEET_REREAD_MS
            {
                return false;
            }
            inner.rereads.insert(account_id.to_owned(), now);
        }
        // A failed read changes nothing: the scheduled reads go on, and the next stop or minute
        // asks again.
        refresh(account_id).is_ok()
    }

    /// The source's quota stops: the last scan while it is under [`FLEET_SCAN_MS`] old for this
    /// source and quota state.
    fn quota_stops(
        &self,
        source: &Account,
        quota: SourceQuota,
        now: f64,
    ) -> Result<Vec<QuotaStop>, String> {
        let cached = self.inner().scan.clone().filter(|last| {
            let age = now - last.at;
            last.source_id == source.id
                && last.quota == quota
                && (0.0..FLEET_SCAN_MS).contains(&age)
        });
        match cached {
            Some(last) => Ok(last.stops),
            None => self.scan_stops(source, quota, now),
        }
    }

    fn scan_stops(
        &self,
        source: &Account,
        quota: SourceQuota,
        now: f64,
    ) -> Result<Vec<QuotaStop>, String> {
        let stops = (self.deps.stops)(source)?;
        self.inner().scan = Some(ScanCache {
            source_id: source.id.clone(),
            quota,
            at: now,
            stops: stops.clone(),
        });
        Ok(stops)
    }

    fn resume(&self, mut pending: Pending) -> Result<FleetContinuationState, String> {
        let desktop = (self.deps.desktop)()?;
        let on_target = desktop.active_profile_id.as_deref() == Some(pending.target_id.as_str());
        if pending.stage == PendingStage::Switching {
            if !on_target {
                // Relay stopped before the switch finished; Desktop recovery owns files.
                self.save(|saved| saved.set_pending(None))?;
                return Ok(self.publish(
                    json!({ "status": "waiting", "reason": "switch-interrupted" }),
                    Map::new(),
                ));
            }
            pending.stage = PendingStage::Continuing;
        }
        if !on_target {
            let source = (self.deps.snapshot)()
                .accounts
                .into_iter()
                .find(|a| a.id == pending.source_id);
            return self.finish(pending, source.as_ref(), Some("account-changed"));
        }
        let lock = Arc::clone(&self.deps.with_desktop_lock);
        lock(&mut || self.continue_all(pending.clone()))
    }

    fn continue_all(&self, mut pending: Pending) -> Result<FleetContinuationState, String> {
        self.save(|saved| saved.set_pending(Some(pending.clone())))?;
        let accounts = (self.deps.snapshot)().accounts;
        let target = accounts.iter().find(|a| a.id == pending.target_id).cloned();
        let source = accounts.iter().find(|a| a.id == pending.source_id).cloned();
        let Some(target) = target else {
            return self.finish(pending, source.as_ref(), Some("target-missing"));
        };
        for index in 0..pending.stops.len() {
            let stop = pending.stops[index].clone();
            let id = stop.local_session_id.clone();
            if pending.results.contains_key(&id) {
                continue;
            }
            self.publish(
                json!({
                    "status": "continuing",
                    "sourceId": pending.source_id,
                    "targetId": pending.target_id,
                    "stopped": pending.stops.len(),
                }),
                Map::new(),
            );
            let request_id = format!("relay-{}-{index}", pending.id);
            let outcome = {
                let mut before_send = || {
                    pending.results.insert(id.clone(), PendingResult::Sending);
                    self.save(|saved| saved.set_pending(Some(pending.clone())))
                };
                (self.deps.continue_one)(&stop, &target, &request_id, &mut before_send)
            };
            let result = match outcome {
                Ok(result) => PendingResult::from(result),
                Err(_) if pending.results.get(&id) == Some(&PendingResult::Sending) => {
                    PendingResult::Unknown
                }
                Err(_) => PendingResult::Skipped,
            };
            pending.results.insert(id.clone(), result);
            self.save(|saved| saved.set_pending(Some(pending.clone())))?;
            let conversation = id.strip_prefix("local_").unwrap_or(&id);
            log_event(
                &self.deps,
                "continued",
                object(json!({ "conversation": short(Some(conversation)), "result": result })),
            );
        }
        self.finish(pending, source.as_ref(), None)
    }

    fn finish(
        &self,
        pending: Pending,
        source: Option<&Account>,
        reason: Option<&str>,
    ) -> Result<FleetContinuationState, String> {
        let results: Vec<PendingResult> = pending
            .stops
            .iter()
            .map(|stop| {
                pending
                    .results
                    .get(&stop.local_session_id)
                    .copied()
                    .unwrap_or(PendingResult::Skipped)
            })
            .collect();
        let count =
            |kinds: &[PendingResult]| results.iter().filter(|r| kinds.contains(r)).count() as f64;
        let last = FleetLast {
            at: iso(self.now()),
            source_id: pending.source_id.clone(),
            target_id: pending.target_id.clone(),
            conversations: pending.stops.len() as f64,
            started: count(&[PendingResult::Started, PendingResult::Accepted]),
            uncertain: count(&[PendingResult::Unknown, PendingResult::Sending]),
            skipped: count(&[PendingResult::Skipped]),
        };
        let handled: Vec<String> = match source {
            Some(source) if source.desktop.is_some() => pending
                .stops
                .iter()
                .map(|stop| stop_key(source, stop))
                .collect(),
            _ => Vec::new(),
        };
        self.save(|saved| {
            saved.set_pending(None);
            saved.set_last(last.clone());
            saved.add_handled(handled);
        })?;
        // A notice that fails changes nothing about the conversations.
        if let Some(finished) = &self.deps.finished {
            finished(&last, reason);
        }
        let attention = reason.is_some_and(|r| !r.is_empty()) || last.uncertain != 0.0;
        let reason = match reason {
            Some(reason) => reason,
            None if last.uncertain != 0.0 => "delivery-uncertain",
            None => "continued",
        };
        Ok(self.publish(
            json!({
                "status": if attention { "attention" } else { "watching" },
                "reason": reason,
                "sourceId": pending.target_id,
            }),
            Map::new(),
        ))
    }
}
