//! Port of `electron/core/desktop-continuation.ts`: one explicit, persisted "switch and continue"
//! handoff for the selected Claude app conversation, watched on a timer.
//!
//! Blocking where the TS awaits: the manager's operations run one at a time on the caller's
//! thread (the TS `serial` queue), and the watch timer is an injected [`ContinuationTimer`] whose
//! default is a background thread.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::continuation::{
    ContinuationCapabilities, ContinuationError, ContinuationHostKind, ContinuationIdentity,
    ContinuationRequest, ContinuationResult, ContinuationResultStatus, ContinuationState,
    ExecutionPolicy, QuiescenceCoverage, SessionStatus, continuation_policy_reason, is_clock,
    is_key, is_text, is_uuid, sha256_hex,
};
use crate::continuation_journal::{
    MAX_BYTES, PrivateJsonError, private_journal_directory, read_private_json, write_private_json,
};
use crate::shared::continuation_target_ranking::{
    ContinuationTargetCandidate, RankingContext, rank_continuation_targets,
};
use crate::shared::types::js::{JsMap, date_parse, iso, ser_num, ser_opt_num};
use crate::shared::types::{Account, AccountUsage, RelaySettings, UsageStatus, literal_enum};
use crate::shared::usage::SOURCE_FRESH_MS;

literal_enum!(ContinuationStatus {
    Off = "off",
    Armed = "armed",
    Waiting = "waiting",
    Executing = "executing",
    Continued = "continued",
    Blocked = "blocked",
    ReconciliationRequired = "reconciliation-required",
});
literal_enum!(
    /// Automatic enrollment is frozen at arming.
    TargetSelection { Automatic = "automatic" }
);
literal_enum!(QuotaStopReason { RateLimit = "rate-limit" });
literal_enum!(
    /// Durable before taking over Desktop's timer; an uncertain cancel is never replayed.
    OwnQuotaWakeup {
        CancellationIntent = "cancellation-intent",
        CancelledVerified = "cancelled-verified",
    }
);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopQuotaStop {
    pub reason: QuotaStopReason,
    pub session_id: String,
    /// The specific ended model turn; a quota percentage alone is insufficient.
    pub turn_id: String,
    #[serde(serialize_with = "ser_num")]
    pub observed_at: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopContinuationObservation {
    pub state: ContinuationState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota_stop: Option<DesktopQuotaStop>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_reason: Option<String>,
    /// Exactly this ended turn's checked Desktop quota-reset wakeup, never other work.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub own_quota_wakeup: Option<bool>,
}

/// What the panel shows of "switch and continue" for one conversation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopContinuationSnapshot {
    pub status: ContinuationStatus,
    pub reason: String,
    pub can_arm: bool,
    pub enabled: bool,
    pub executable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_selection: Option<TargetSelection>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub allowed_target_count: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

impl DesktopContinuationSnapshot {
    fn bare(status: ContinuationStatus, reason: &str, executable: bool) -> Self {
        DesktopContinuationSnapshot {
            status,
            reason: reason.to_owned(),
            can_arm: false,
            enabled: false,
            executable,
            observation_reason: None,
            checked_at: None,
            source_id: None,
            target_id: None,
            target_selection: None,
            allowed_target_count: None,
            session_id: None,
            project_key: None,
            permission_mode: None,
            request_id: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopContinuationArm {
    pub id: String,
    #[serde(serialize_with = "ser_num")]
    pub armed_at: f64,
    pub source: ContinuationIdentity,
    pub target: ContinuationIdentity,
    /// Automatic enrollment is frozen; later added or replaced identities need new consent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_selection: Option<TargetSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_targets: Option<Vec<ContinuationIdentity>>,
    pub session_id: String,
    pub project_key: String,
    pub permission_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_policy: Option<ExecutionPolicy>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopContinuationAttempt {
    pub id: String,
    pub arm: DesktopContinuationArm,
    pub episode_key: String,
    pub transcript_revision: String,
    #[serde(serialize_with = "ser_num")]
    pub expected_context_revision: f64,
    pub turn_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub own_quota_wakeup: Option<OwnQuotaWakeup>,
}

/// One continued quota episode (`completed[]`), for deduplication.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompletedEpisode {
    pub key: String,
    #[serde(serialize_with = "ser_num")]
    pub at: f64,
}

/// `continuation-state.json`. Key order is what the TS writes produce: a fresh state is
/// `{version, completed}`, an arm is added next and a pending attempt after it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopContinuationPersistentState {
    /// Always 1.
    pub version: u8,
    pub completed: Vec<CompletedEpisode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arm: Option<DesktopContinuationArm>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<DesktopContinuationAttempt>,
}

impl Default for DesktopContinuationPersistentState {
    fn default() -> Self {
        DesktopContinuationPersistentState {
            version: 1,
            completed: Vec::new(),
            arm: None,
            pending: None,
        }
    }
}

/// An error a dependency or the manager reports. `message` is the TS `Error.message`;
/// `unchanged` is `DesktopAutomationError.unchanged` (the failure happened before anything in
/// Claude was changed), false for every other error.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct DesktopContinuationError {
    pub message: String,
    pub unchanged: bool,
}

impl DesktopContinuationError {
    pub fn new(message: impl Into<String>) -> Self {
        DesktopContinuationError {
            message: message.into(),
            unchanged: false,
        }
    }
    /// A host failure before anything in Claude was changed.
    pub fn unchanged(message: impl Into<String>) -> Self {
        DesktopContinuationError {
            message: message.into(),
            unchanged: true,
        }
    }
}

impl From<&str> for DesktopContinuationError {
    fn from(message: &str) -> Self {
        Self::new(message)
    }
}

impl From<String> for DesktopContinuationError {
    fn from(message: String) -> Self {
        Self::new(message)
    }
}

impl From<ContinuationError> for DesktopContinuationError {
    fn from(error: ContinuationError) -> Self {
        Self::new(error.0)
    }
}

pub trait DesktopContinuationPersistence: Send + Sync {
    fn load(&self) -> Result<DesktopContinuationPersistentState, DesktopContinuationError>;
    fn save(
        &self,
        state: &DesktopContinuationPersistentState,
    ) -> Result<(), DesktopContinuationError>;
}

/// What the manager reads of Relay's state (`DesktopContinuationDependencies.snapshot()`).
#[derive(Debug, Clone, PartialEq)]
pub struct DesktopContinuationContext {
    pub accounts: Vec<Account>,
    pub settings: RelaySettings,
    pub usage: JsMap<AccountUsage>,
    /// Pro units per hour now (the tempo); absent means unknown.
    pub tempo_rate: Option<f64>,
}

/// A running watch timer (`setInterval`'s handle).
pub trait ContinuationTimer: Send {
    /// `clearInterval`: no tick starts after this returns.
    fn cancel(&self);
}

struct ThreadTimer(Arc<(Mutex<bool>, Condvar)>);

impl ContinuationTimer for ThreadTimer {
    fn cancel(&self) {
        let (stopped, wake) = &*self.0;
        *stopped.lock().unwrap_or_else(|e| e.into_inner()) = true;
        wake.notify_all();
    }
}

impl Drop for ThreadTimer {
    fn drop(&mut self) {
        self.cancel();
    }
}

/// Runs `tick` every `every_ms` on a background thread until cancelled. Like an `unref`ed
/// interval, the thread never keeps the process alive.
pub fn thread_interval(
    every_ms: u64,
    tick: Box<dyn Fn() + Send + Sync>,
) -> Box<dyn ContinuationTimer> {
    let state = Arc::new((Mutex::new(false), Condvar::new()));
    let shared = Arc::clone(&state);
    std::thread::spawn(move || {
        let (stopped, wake) = &*shared;
        let every = Duration::from_millis(every_ms);
        let mut guard = stopped.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            guard = wake
                .wait_timeout_while(guard, every, |stopped| !*stopped)
                .unwrap_or_else(|e| e.into_inner())
                .0;
            if *guard {
                return;
            }
            drop(guard);
            tick();
            guard = stopped.lock().unwrap_or_else(|e| e.into_inner());
        }
    });
    Box::new(ThreadTimer(state))
}

pub type DesktopLockAction<'a> =
    dyn FnMut() -> Result<DesktopContinuationSnapshot, DesktopContinuationError> + 'a;

/// What the manager needs from the app. Optional TS members are methods with the TS defaults;
/// `supports_*` says whether the optional TS function exists.
pub trait DesktopContinuationDependencies: Send + Sync {
    fn observe(&self) -> Result<DesktopContinuationObservation, DesktopContinuationError>;
    fn capabilities(&self) -> ContinuationCapabilities;
    /// `engine.execute`.
    fn execute(
        &self,
        request: &ContinuationRequest,
    ) -> Result<ContinuationResult, DesktopContinuationError>;
    /// Whether `engine.abandonUnsent` exists.
    fn supports_abandon_unsent(&self) -> bool {
        false
    }
    /// `engine.abandonUnsent`.
    fn abandon_unsent(&self, _request_id: &str) -> Result<(), DesktopContinuationError> {
        Err("unsent-cancellation-unavailable".into())
    }
    fn snapshot(&self) -> DesktopContinuationContext;
    fn persistence(&self) -> &dyn DesktopContinuationPersistence;
    /// The same lock used by manual switching, login, recovery and history writes.
    fn with_desktop_lock(
        &self,
        action: &mut DesktopLockAction<'_>,
    ) -> Result<DesktopContinuationSnapshot, DesktopContinuationError>;
    fn pending_auth(&self) -> bool {
        false
    }
    fn changed(&self) {}
    fn now(&self) -> f64 {
        crate::clock::now_ms() as f64
    }
    /// Whether `prepareQuotaStop` exists.
    fn supports_prepare_quota_stop(&self) -> bool {
        false
    }
    /// Explicit guarded-policy takeover of the selected stopped turn's own wakeup.
    fn prepare_quota_stop(
        &self,
        _observation: &DesktopContinuationObservation,
        _request: &ContinuationRequest,
    ) -> Result<DesktopContinuationObservation, DesktopContinuationError> {
        Err("own-quota-wakeup-can-takeover".into())
    }
    /// `setInterval(tick, every_ms)`.
    fn set_interval(
        &self,
        every_ms: u64,
        tick: Box<dyn Fn() + Send + Sync>,
    ) -> Box<dyn ContinuationTimer> {
        thread_interval(every_ms, tick)
    }
}

impl<T: DesktopContinuationDependencies + ?Sized> DesktopContinuationDependencies for Arc<T> {
    fn observe(&self) -> Result<DesktopContinuationObservation, DesktopContinuationError> {
        (**self).observe()
    }
    fn capabilities(&self) -> ContinuationCapabilities {
        (**self).capabilities()
    }
    fn execute(
        &self,
        request: &ContinuationRequest,
    ) -> Result<ContinuationResult, DesktopContinuationError> {
        (**self).execute(request)
    }
    fn supports_abandon_unsent(&self) -> bool {
        (**self).supports_abandon_unsent()
    }
    fn abandon_unsent(&self, request_id: &str) -> Result<(), DesktopContinuationError> {
        (**self).abandon_unsent(request_id)
    }
    fn snapshot(&self) -> DesktopContinuationContext {
        (**self).snapshot()
    }
    fn persistence(&self) -> &dyn DesktopContinuationPersistence {
        (**self).persistence()
    }
    fn with_desktop_lock(
        &self,
        action: &mut DesktopLockAction<'_>,
    ) -> Result<DesktopContinuationSnapshot, DesktopContinuationError> {
        (**self).with_desktop_lock(action)
    }
    fn pending_auth(&self) -> bool {
        (**self).pending_auth()
    }
    fn changed(&self) {
        (**self).changed()
    }
    fn now(&self) -> f64 {
        (**self).now()
    }
    fn supports_prepare_quota_stop(&self) -> bool {
        (**self).supports_prepare_quota_stop()
    }
    fn prepare_quota_stop(
        &self,
        observation: &DesktopContinuationObservation,
        request: &ContinuationRequest,
    ) -> Result<DesktopContinuationObservation, DesktopContinuationError> {
        (**self).prepare_quota_stop(observation, request)
    }
    fn set_interval(
        &self,
        every_ms: u64,
        tick: Box<dyn Fn() + Send + Sync>,
    ) -> Box<dyn ContinuationTimer> {
        (**self).set_interval(every_ms, tick)
    }
}

const ACTIONABLE_OBSERVATION_ISSUES: [&str; 10] = [
    "accessibility-permission-required",
    "claude-not-running",
    "desktop-ui-unsupported",
    "exact-session-not-observed",
    "composer-not-empty",
    "permission-mode-mismatch",
    "context-changed",
    "desktop-work-active",
    "desktop-observation-incomplete",
    "unsupported-platform",
];

fn observation_error_reason(error: &DesktopContinuationError) -> String {
    if ACTIONABLE_OBSERVATION_ISSUES.contains(&error.message.as_str()) {
        error.message.clone()
    } else {
        "desktop-observation-unavailable".into()
    }
}

fn same_identity(a: &ContinuationIdentity, b: &ContinuationIdentity) -> bool {
    a.profile_id == b.profile_id
        && a.account_uuid.to_lowercase() == b.account_uuid.to_lowercase()
        && a.org_id.to_lowercase() == b.org_id.to_lowercase()
}

/// Same account and organization, whatever the profile.
fn same_login(a: &ContinuationIdentity, b: &ContinuationIdentity) -> bool {
    a.account_uuid.to_lowercase() == b.account_uuid.to_lowercase()
        && a.org_id.to_lowercase() == b.org_id.to_lowercase()
}

fn enrolled(account: Option<&Account>) -> bool {
    let Some(account) = account else { return false };
    let (Some(desktop), Some(auth)) = (&account.desktop, &account.auth) else {
        return false;
    };
    is_uuid(&account.id)
        && is_uuid(&desktop.account_uuid)
        && is_uuid(&desktop.org_id)
        && auth.logged_in
        && auth
            .account_uuid
            .as_ref()
            .is_some_and(|u| u.to_lowercase() == desktop.account_uuid.to_lowercase())
        && auth
            .org_id
            .as_ref()
            .is_some_and(|o| o.to_lowercase() == desktop.org_id.to_lowercase())
}

/// The identity of an enrolled account.
fn identity(account: &Account) -> ContinuationIdentity {
    let desktop = account.desktop.as_ref();
    ContinuationIdentity {
        profile_id: account.id.clone(),
        account_uuid: desktop.map_or_else(String::new, |d| d.account_uuid.to_lowercase()),
        org_id: desktop.map_or_else(String::new, |d| d.org_id.to_lowercase()),
    }
}

fn valid_identity(v: &ContinuationIdentity) -> bool {
    is_uuid(&v.profile_id) && is_uuid(&v.account_uuid) && is_uuid(&v.org_id)
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

fn valid_arm(a: &DesktopContinuationArm) -> bool {
    let automatic_ok = match a.target_selection {
        None => true,
        Some(TargetSelection::Automatic) => a.allowed_targets.as_ref().is_some_and(|targets| {
            let mut profiles: Vec<&str> = targets.iter().map(|t| t.profile_id.as_str()).collect();
            profiles.sort_unstable();
            profiles.dedup();
            let mut logins: Vec<String> = targets
                .iter()
                .map(|t| {
                    format!(
                        "{}:{}",
                        t.account_uuid.to_lowercase(),
                        t.org_id.to_lowercase()
                    )
                })
                .collect();
            logins.sort_unstable();
            logins.dedup();
            (1..=100).contains(&targets.len())
                && targets.iter().all(|target| {
                    valid_identity(target)
                        && target.profile_id != a.source.profile_id
                        && !same_login(target, &a.source)
                })
                && profiles.len() == targets.len()
                && logins.len() == targets.len()
                && targets
                    .iter()
                    .any(|target| same_identity(target, &a.target))
        }),
    };
    is_key(&a.id)
        && is_clock(a.armed_at)
        && valid_identity(&a.source)
        && valid_identity(&a.target)
        && a.source.profile_id != a.target.profile_id
        && !same_login(&a.source, &a.target)
        && is_uuid(&a.session_id)
        && is_text(&a.project_key)
        && is_text(&a.permission_mode)
        && automatic_ok
}

fn valid_persistent(v: &DesktopContinuationPersistentState) -> bool {
    if v.version != 1
        || v.arm.as_ref().is_some_and(|arm| !valid_arm(arm))
        || v.completed.len() > 100
        || !v
            .completed
            .iter()
            .all(|entry| is_hex64(&entry.key) && is_clock(entry.at))
    {
        return false;
    }
    if let Some(p) = &v.pending
        && (!is_key(&p.id)
            || !valid_arm(&p.arm)
            || !is_hex64(&p.episode_key)
            || !is_text(&p.transcript_revision)
            || !is_clock(p.expected_context_revision)
            || !is_key(&p.turn_id)
            || (p.own_quota_wakeup.is_some()
                && p.arm.execution_policy != Some(ExecutionPolicy::GuardedNativeAtMostOnce)))
    {
        return false;
    }
    true
}

/// The manager's state in `<root>/continuation-state.json`, private JSON.
pub struct FileDesktopContinuationPersistence {
    pub file: PathBuf,
}

impl FileDesktopContinuationPersistence {
    pub fn new(root: &Path) -> Result<Self, PrivateJsonError> {
        private_journal_directory(root)?;
        Ok(FileDesktopContinuationPersistence {
            file: root.join("continuation-state.json"),
        })
    }
}

impl DesktopContinuationPersistence for FileDesktopContinuationPersistence {
    fn load(&self) -> Result<DesktopContinuationPersistentState, DesktopContinuationError> {
        match read_private_json(&self.file, MAX_BYTES) {
            Err(error) if error.is_not_found() => Ok(DesktopContinuationPersistentState::default()),
            // Never silently reset an arm, unfinished send or deduplication history.
            Err(_) => Err("continuation-state-unreadable".into()),
            Ok(value) => serde_json::from_value::<DesktopContinuationPersistentState>(value)
                .ok()
                .filter(valid_persistent)
                .ok_or_else(|| "continuation-state-unreadable".into()),
        }
    }

    fn save(
        &self,
        state: &DesktopContinuationPersistentState,
    ) -> Result<(), DesktopContinuationError> {
        if !valid_persistent(state) {
            return Err("continuation-state-invalid".into());
        }
        write_private_json(&self.file, state, MAX_BYTES)
            .map_err(|error| DesktopContinuationError::new(error.to_string()))
    }
}

/// The watch looks at the conversation this often near or at the source's limit…
pub const CONTINUATION_POLL_MS: u64 = 10_000;
/// …and this often while the source has more than FAR_REMAINING_PERCENT left everywhere.
pub const CONTINUATION_FAR_POLL_MS: u64 = 30_000;
const FAR_REMAINING_PERCENT: f64 = 20.0;

/// How often the watch looks: every 30 s while a reading under 15 minutes old leaves the
/// source more than 20% on every window, else (near the limit, or no such reading) every 10 s.
pub fn continuation_poll_ms(usage: Option<&AccountUsage>, now: f64) -> u64 {
    let Some(u) = usage else {
        return CONTINUATION_POLL_MS;
    };
    let checked = date_parse(u.checked_at.as_deref().unwrap_or(""));
    let windows: Vec<_> = [u.five_hour.as_ref(), u.seven_day.as_ref()]
        .into_iter()
        .flatten()
        .collect();
    let far = u.status == UsageStatus::Ready
        && !u.stale
        && u.other_limit_reached != Some(true)
        && checked.is_finite()
        && checked <= now
        && now - checked <= SOURCE_FRESH_MS
        && !windows.is_empty()
        && windows
            .iter()
            .all(|w| 100.0 - w.used_percent > FAR_REMAINING_PERCENT);
    if far {
        CONTINUATION_FAR_POLL_MS
    } else {
        CONTINUATION_POLL_MS
    }
}

/// Reasons that resolve on their own; the monitor keeps waiting rather than blocking.
fn waiting_reason(reason: &str) -> bool {
    reason == "awaiting-quota-stop"
        || reason == "automatic-target-unavailable"
        || reason == "session-not-stopped"
        || reason.starts_with("not-quiescent:")
}

/// What `arm` takes: an account id, or `"automatic"` to freeze every distinct enrolled one.
#[derive(Debug, Clone, PartialEq)]
pub struct DesktopContinuationArmInput {
    pub target_account_id: String,
    pub execution_policy: Option<ExecutionPolicy>,
}

struct Prepared {
    observation: DesktopContinuationObservation,
    reason: Option<String>,
    attempt: Option<DesktopContinuationAttempt>,
}

#[derive(Serialize)]
struct EpisodeKey<'a> {
    source: &'a ContinuationIdentity,
    session: &'a str,
    turn: &'a str,
}

struct Inner {
    saved: DesktopContinuationPersistentState,
    view: DesktopContinuationSnapshot,
    timer: Option<Box<dyn ContinuationTimer>>,
    /// When the timer last started a poll.
    polled_at: Option<f64>,
    stopped: bool,
}

/// One explicit, persisted handoff for the selected current conversation.
pub struct DesktopContinuationManager {
    deps: Box<dyn DesktopContinuationDependencies>,
    persistence_fault: bool,
    serial: Mutex<()>,
    polling: AtomicBool,
    inner: Mutex<Inner>,
}

fn pending_reason(pending: &DesktopContinuationAttempt, otherwise: &'static str) -> &'static str {
    if pending.own_quota_wakeup == Some(OwnQuotaWakeup::CancellationIntent) {
        "own-quota-wakeup-uncertain"
    } else {
        otherwise
    }
}

impl DesktopContinuationManager {
    pub fn new(deps: impl DesktopContinuationDependencies + 'static) -> Self {
        let deps: Box<dyn DesktopContinuationDependencies> = Box::new(deps);
        let loaded = deps.persistence().load().ok().filter(valid_persistent);
        let persistence_fault = loaded.is_none();
        let manager = DesktopContinuationManager {
            deps,
            persistence_fault,
            serial: Mutex::new(()),
            polling: AtomicBool::new(false),
            inner: Mutex::new(Inner {
                saved: loaded.unwrap_or_default(),
                view: DesktopContinuationSnapshot::bare(ContinuationStatus::Off, "disabled", false),
                timer: None,
                polled_at: None,
                // Keep the account panel usable, but never reset or write the unreadable
                // optional automation state. Its possible unfinished intent remains blocked.
                stopped: persistence_fault,
            }),
        };
        let view = if persistence_fault {
            let mut view = DesktopContinuationSnapshot::bare(
                ContinuationStatus::Blocked,
                "continuation-state-unreadable",
                false,
            );
            view.observation_reason = Some("continuation-state-unreadable".into());
            view
        } else {
            let saved = manager.saved();
            if let Some(pending) = &saved.pending {
                manager.pending_fields(pending, "unfinished-attempt")
            } else if let Some(arm) = &saved.arm {
                manager.fields(
                    ContinuationStatus::Armed,
                    "awaiting-quota-stop",
                    Some(arm),
                    false,
                )
            } else {
                DesktopContinuationSnapshot::bare(
                    ContinuationStatus::Off,
                    "disabled",
                    manager.contract_reason(None, false).is_none(),
                )
            }
        };
        manager.inner().view = view;
        manager
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn serial(&self) -> MutexGuard<'_, ()> {
        self.serial.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn saved(&self) -> DesktopContinuationPersistentState {
        self.inner().saved.clone()
    }

    /// Awaited host operations may have committed an intent since tick's first check.
    fn pending_attempt(&self) -> Option<DesktopContinuationAttempt> {
        self.inner().saved.pending.clone()
    }

    fn now(&self) -> f64 {
        self.deps.now()
    }

    pub fn snapshot(&self) -> DesktopContinuationSnapshot {
        self.inner().view.clone()
    }

    /// Starts the watch: one poll now, then one every [`CONTINUATION_POLL_MS`]. The first poll
    /// runs on the caller's thread.
    pub fn start(self: &Arc<Self>) {
        if self.persistence_fault {
            return;
        }
        {
            let mut inner = self.inner();
            if inner.timer.is_some() {
                return;
            }
            inner.stopped = false;
        }
        let weak = Arc::downgrade(self);
        let timer = self.deps.set_interval(
            CONTINUATION_POLL_MS,
            Box::new(move || {
                if let Some(manager) = weak.upgrade() {
                    manager.poll();
                }
            }),
        );
        self.inner().timer = Some(timer);
        self.poll();
    }

    pub fn stop(&self) {
        let timer = {
            let mut inner = self.inner();
            inner.stopped = true;
            inner.timer.take()
        };
        if let Some(timer) = timer {
            timer.cancel();
        }
    }

    fn poll(&self) {
        if self.inner().stopped || self.polling.swap(true, Ordering::SeqCst) {
            return;
        }
        // Far from the limit only every third timer tick looks; half a tick of slack
        // keeps timer jitter from skipping one more.
        let now = self.now();
        let (arm, polled_at) = {
            let inner = self.inner();
            let arm = if inner.saved.pending.is_some() {
                None
            } else {
                inner.saved.arm.clone()
            };
            (arm, inner.polled_at)
        };
        let every = arm.map_or(CONTINUATION_POLL_MS, |arm| {
            continuation_poll_ms(self.deps.snapshot().usage.get(&arm.source.profile_id), now)
        }) as f64;
        let since = polled_at.map_or(f64::INFINITY, |at| now - at);
        if since >= 0.0 && since < every - CONTINUATION_POLL_MS as f64 / 2.0 {
            self.polling.store(false, Ordering::SeqCst);
            return;
        }
        self.inner().polled_at = Some(now);
        self.tick();
        self.polling.store(false, Ordering::SeqCst);
    }

    fn fields(
        &self,
        status: ContinuationStatus,
        reason: &str,
        arm: Option<&DesktopContinuationArm>,
        selected_target: bool,
    ) -> DesktopContinuationSnapshot {
        let (enabled, request_id) = {
            let inner = self.inner();
            (
                inner.saved.arm.is_some(),
                inner.saved.pending.as_ref().map(|p| p.id.clone()),
            )
        };
        let target_id = arm.and_then(|arm| {
            (arm.target_selection != Some(TargetSelection::Automatic)
                || selected_target
                || request_id.is_some())
            .then(|| arm.target.profile_id.clone())
        });
        DesktopContinuationSnapshot {
            status,
            reason: reason.to_owned(),
            can_arm: false,
            enabled,
            executable: self.contract_reason(None, false).is_none(),
            observation_reason: None,
            checked_at: Some(iso(self.now())),
            source_id: arm.map(|a| a.source.profile_id.clone()),
            target_id,
            target_selection: arm.and_then(|a| a.target_selection),
            allowed_target_count: arm
                .and_then(|a| a.allowed_targets.as_ref())
                .map(|t| t.len() as f64),
            session_id: arm.map(|a| a.session_id.clone()),
            project_key: arm.map(|a| a.project_key.clone()),
            permission_mode: arm.map(|a| a.permission_mode.clone()),
            request_id,
        }
    }

    fn pending_fields(
        &self,
        pending: &DesktopContinuationAttempt,
        otherwise: &'static str,
    ) -> DesktopContinuationSnapshot {
        self.fields(
            ContinuationStatus::ReconciliationRequired,
            pending_reason(pending, otherwise),
            Some(&pending.arm),
            false,
        )
    }

    fn publish(&self, value: DesktopContinuationSnapshot) -> DesktopContinuationSnapshot {
        let changed = {
            let mut inner = self.inner();
            let previous = DesktopContinuationSnapshot {
                checked_at: None,
                ..inner.view.clone()
            };
            let next = DesktopContinuationSnapshot {
                checked_at: None,
                ..value.clone()
            };
            inner.view = value;
            previous != next
        };
        if changed {
            self.deps.changed();
        }
        self.snapshot()
    }

    fn commit(
        &self,
        update: impl FnOnce(&mut DesktopContinuationPersistentState),
    ) -> Result<(), DesktopContinuationError> {
        let mut next = self.saved();
        update(&mut next);
        self.deps.persistence().save(&next)?;
        self.inner().saved = next;
        Ok(())
    }

    fn contract_reason(
        &self,
        policy: Option<ExecutionPolicy>,
        require_consent: bool,
    ) -> Option<&'static str> {
        if self.persistence_fault {
            return Some("continuation-state-unreadable");
        }
        let c = self.deps.capabilities();
        if !is_text(&c.contract_id)
            || ![
                c.exact_session,
                c.conditional_actions,
                c.delivery_lookup,
                c.checkpoint,
                c.account_switch,
                c.session_reopen,
                c.targeted_send,
                c.delivery_receipt,
            ]
            .iter()
            .all(|capability| *capability)
        {
            return Some("adapter-contract-unverified");
        }
        if c.kind == ContinuationHostKind::GuardedNative {
            if require_consent && policy != Some(ExecutionPolicy::GuardedNativeAtMostOnce) {
                return Some("guarded-native-policy-required");
            }
        } else if !c.idempotent_delivery || !c.atomic_context_guard {
            return Some("adapter-contract-unverified");
        }
        None
    }

    fn observation_reason(&self, observation: &DesktopContinuationObservation) -> Option<String> {
        if let Some(reason) = observation
            .blocked_reason
            .as_ref()
            .filter(|r| !r.is_empty())
        {
            return Some(reason.clone());
        }
        let s = &observation.state;
        let now = self.now();
        if !is_clock(s.observed_at) || s.observed_at > now || now - s.observed_at > 15_000.0 {
            return Some("observation-not-fresh".into());
        }
        if !is_clock(s.context_revision)
            || !valid_identity(&s.identity)
            || !is_uuid(&s.session.id)
            || !is_text(&s.session.project_key)
            || !is_text(&s.session.transcript_revision)
            || !is_text(&s.session.permission_mode)
        {
            return Some("exact-session-unverified".into());
        }
        let snapshot = self.deps.snapshot();
        let source = snapshot
            .accounts
            .iter()
            .find(|account| account.id == s.identity.profile_id);
        match source {
            Some(source)
                if enrolled(Some(source)) && same_identity(&identity(source), &s.identity) => {}
            _ => return Some("identity-not-enrolled".into()),
        }
        None
    }

    /// Read-only observation: never arms, changes an account or sends a message.
    pub fn inspect(&self) -> DesktopContinuationSnapshot {
        let _serial = self.serial();
        if self.persistence_fault {
            return self.snapshot();
        }
        match self.deps.observe() {
            Ok(observation) => {
                let reason = self.observation_reason(&observation);
                let saved = self.saved();
                let arm = saved
                    .arm
                    .as_ref()
                    .or(saved.pending.as_ref().map(|p| &p.arm));
                let contract = self.contract_reason(None, false);
                let mut value = self.snapshot();
                value.checked_at = Some(iso(self.now()));
                value.can_arm = reason.is_none() && saved.pending.is_none();
                value.executable = contract.is_none();
                value.enabled = saved.arm.is_some();
                value.observation_reason = reason.clone().or(contract.map(str::to_owned));
                if arm.is_none() && reason.is_none() {
                    // A fresh unarmed check prepares a new authorization context. Do not
                    // attach the previous completed badge/target to another conversation.
                    let state = observation.state;
                    value.status = ContinuationStatus::Off;
                    value.reason = "disabled".into();
                    value.source_id = Some(state.identity.profile_id);
                    value.target_id = None;
                    value.target_selection = None;
                    value.allowed_target_count = None;
                    value.session_id = Some(state.session.id);
                    value.project_key = Some(state.session.project_key);
                    value.permission_mode = Some(state.session.permission_mode);
                    value.request_id = None;
                }
                self.publish(value)
            }
            Err(error) => {
                let mut value = self.snapshot();
                value.can_arm = false;
                value.checked_at = Some(iso(self.now()));
                value.observation_reason = Some(observation_error_reason(&error));
                self.publish(value)
            }
        }
    }

    pub fn arm(
        &self,
        input: &DesktopContinuationArmInput,
    ) -> Result<DesktopContinuationSnapshot, DesktopContinuationError> {
        let _serial = self.serial();
        if self.persistence_fault {
            return Err("continuation-state-unreadable".into());
        }
        if self.pending_attempt().is_some() {
            return Err("unfinished-attempt".into());
        }
        let observation = self.deps.observe()?;
        if let Some(reason) = self.observation_reason(&observation) {
            return Err(reason.into());
        }
        if self.deps.capabilities().kind == ContinuationHostKind::GuardedNative
            && input.execution_policy != Some(ExecutionPolicy::GuardedNativeAtMostOnce)
        {
            return Err("guarded-native-policy-required".into());
        }
        let current = self.deps.snapshot();
        let observed = &observation.state.identity;
        let automatic = input.target_account_id == "automatic";
        let mut allowed_targets: Vec<ContinuationIdentity> = Vec::new();
        if automatic {
            let mut seen: Vec<String> = Vec::new();
            let mut accounts: Vec<&Account> = current.accounts.iter().collect();
            accounts.sort_by(|a, b| crate::usage::locale_compare(&a.id, &b.id));
            for account in accounts {
                if !enrolled(Some(account)) {
                    continue;
                }
                let candidate = identity(account);
                let key = format!("{}:{}", candidate.account_uuid, candidate.org_id);
                if candidate.profile_id == observed.profile_id
                    || (candidate.account_uuid == observed.account_uuid.to_lowercase()
                        && candidate.org_id == observed.org_id.to_lowercase())
                    || seen.contains(&key)
                {
                    continue;
                }
                seen.push(key);
                allowed_targets.push(candidate);
            }
            if allowed_targets.is_empty() || allowed_targets.len() > 100 {
                return Err("automatic-target-enrollment-unavailable".into());
            }
        }
        let target_id = if automatic {
            allowed_targets[0].profile_id.as_str()
        } else {
            input.target_account_id.as_str()
        };
        let target = current
            .accounts
            .iter()
            .find(|account| account.id == target_id);
        let Some(target) = target.filter(|t| enrolled(Some(t))) else {
            return Err("target-not-enrolled".into());
        };
        if same_identity(observed, &identity(target)) || same_login(observed, &identity(target)) {
            return Err("duplicate-identity".into());
        }
        let arm = DesktopContinuationArm {
            id: uuid::Uuid::new_v4().to_string(),
            armed_at: self.now(),
            source: observed.clone(),
            target: identity(target),
            target_selection: automatic.then_some(TargetSelection::Automatic),
            allowed_targets: automatic.then_some(allowed_targets),
            session_id: observation.state.session.id.to_lowercase(),
            project_key: observation.state.session.project_key.clone(),
            permission_mode: observation.state.session.permission_mode.clone(),
            execution_policy: input.execution_policy,
        };
        self.commit(|state| state.arm = Some(arm.clone()))?;
        let contract = self.contract_reason(None, false);
        Ok(self.publish(self.fields(
            if contract.is_some() {
                ContinuationStatus::Blocked
            } else {
                ContinuationStatus::Armed
            },
            contract.unwrap_or("awaiting-quota-stop"),
            Some(&arm),
            false,
        )))
    }

    pub fn disarm(&self) -> Result<DesktopContinuationSnapshot, DesktopContinuationError> {
        let _serial = self.serial();
        if self.persistence_fault {
            return Err("continuation-state-unreadable".into());
        }
        self.commit(|state| state.arm = None)?;
        let value = match self.pending_attempt() {
            Some(pending) => self.pending_fields(&pending, "unfinished-attempt"),
            None => {
                let view = self.snapshot();
                DesktopContinuationSnapshot {
                    can_arm: view.can_arm,
                    observation_reason: view.observation_reason,
                    ..DesktopContinuationSnapshot::bare(
                        ContinuationStatus::Off,
                        "disabled",
                        self.contract_reason(None, false).is_none(),
                    )
                }
            }
        };
        Ok(self.publish(value))
    }

    fn arm_reason(
        &self,
        arm: &DesktopContinuationArm,
        observation: &DesktopContinuationObservation,
    ) -> Option<&'static str> {
        let s = &observation.state;
        if !same_identity(&arm.source, &s.identity) {
            return Some("source-account-changed");
        }
        if s.session.id.to_lowercase() != arm.session_id || s.session.project_key != arm.project_key
        {
            return Some("selected-session-changed");
        }
        if s.session.permission_mode != arm.permission_mode {
            return Some("permission-mode-changed");
        }
        if arm.target_selection == Some(TargetSelection::Automatic) {
            return None;
        }
        let snapshot = self.deps.snapshot();
        let target = snapshot
            .accounts
            .iter()
            .find(|account| account.id == arm.target.profile_id);
        if !target.is_some_and(|t| enrolled(Some(t)) && same_identity(&identity(t), &arm.target)) {
            return Some("target-identity-changed");
        }
        None
    }

    fn automatic_target(
        &self,
        arm: &DesktopContinuationArm,
        observation: &DesktopContinuationObservation,
    ) -> Result<Option<DesktopContinuationArm>, DesktopContinuationError> {
        let snapshot = self.deps.snapshot();
        let mut eligible = Vec::new();
        for target in &snapshot.accounts {
            if !enrolled(Some(target)) {
                continue;
            }
            let enrolled_target = identity(target);
            if !arm.allowed_targets.as_ref().is_some_and(|allowed| {
                allowed
                    .iter()
                    .any(|allowed| same_identity(allowed, &enrolled_target))
            }) {
                continue;
            }
            let selected = DesktopContinuationArm {
                target: enrolled_target,
                ..arm.clone()
            };
            let request = self.request(&self.attempt_for(&selected, observation))?;
            if continuation_policy_reason(&request, self.now(), true).is_none() {
                eligible.push(target);
            }
        }
        let candidates: Vec<ContinuationTargetCandidate<'_>> = eligible
            .into_iter()
            .map(|account| ContinuationTargetCandidate {
                account,
                usage: snapshot.usage.get(&account.id),
            })
            .collect();
        let ranked = rank_continuation_targets(
            &candidates,
            Some(RankingContext {
                now: self.now(),
                rate: snapshot.tempo_rate,
                strategy: snapshot.settings.auto_switch_strategy,
            }),
        );
        Ok(ranked
            .first()
            .filter(|chosen| enrolled(Some(chosen.account)))
            .map(|chosen| DesktopContinuationArm {
                target: identity(chosen.account),
                ..arm.clone()
            }))
    }

    fn quota_reason(
        &self,
        observation: &DesktopContinuationObservation,
        allow_own_wakeup: bool,
    ) -> Option<String> {
        let s = &observation.state;
        let now = self.now();
        let Some(stop) = &observation.quota_stop else {
            return Some("awaiting-quota-stop".into());
        };
        if stop.session_id.to_lowercase() != s.session.id.to_lowercase()
            || !is_key(&stop.turn_id)
            || s.session.last_turn_id.as_deref() != Some(stop.turn_id.as_str())
            || !is_clock(stop.observed_at)
            || stop.observed_at > now
            || now - stop.observed_at > 15_000.0
        {
            return Some("quota-stop-unverified".into());
        }
        if s.session.status != SessionStatus::Stopped {
            return Some("session-not-stopped".into());
        }
        let q = &s.quiescence;
        let expected = match self.deps.capabilities().kind {
            ContinuationHostKind::Simulated => QuiescenceCoverage::IsolatedAll,
            ContinuationHostKind::GuardedNative => QuiescenceCoverage::GuardedLocal,
            ContinuationHostKind::VerifiedContract => QuiescenceCoverage::VerifiedAll,
        };
        if q.coverage != expected {
            return Some("coverage-unverified".into());
        }
        for (name, value) in q.counters() {
            let own_wakeup = allow_own_wakeup
                && observation.own_quota_wakeup == Some(true)
                && name == "scheduledWakeups"
                && value == 1.0;
            if !is_clock(value) || (value != 0.0 && !own_wakeup) {
                return Some(format!("not-quiescent:{name}"));
            }
        }
        None
    }

    fn attempt_for(
        &self,
        arm: &DesktopContinuationArm,
        observation: &DesktopContinuationObservation,
    ) -> DesktopContinuationAttempt {
        let turn = observation
            .quota_stop
            .as_ref()
            .map(|stop| stop.turn_id.clone())
            .unwrap_or_default();
        let key = serde_json::to_string(&EpisodeKey {
            source: &arm.source,
            session: &arm.session_id,
            turn: &turn,
        })
        .expect("an episode key serializes");
        DesktopContinuationAttempt {
            id: uuid::Uuid::new_v4().to_string(),
            arm: arm.clone(),
            episode_key: sha256_hex(&key),
            transcript_revision: observation.state.session.transcript_revision.clone(),
            expected_context_revision: observation.state.context_revision,
            turn_id: turn,
            own_quota_wakeup: None,
        }
    }

    fn own_wakeup_allowed(
        &self,
        arm: &DesktopContinuationArm,
        observation: &DesktopContinuationObservation,
    ) -> bool {
        self.deps.capabilities().kind == ContinuationHostKind::GuardedNative
            && arm.execution_policy == Some(ExecutionPolicy::GuardedNativeAtMostOnce)
            && observation.own_quota_wakeup == Some(true)
    }

    fn prepare_own_wakeup(
        &self,
        arm: &DesktopContinuationArm,
        before: DesktopContinuationObservation,
    ) -> Result<Prepared, DesktopContinuationError> {
        let reason = self.quota_reason(&before, false);
        if reason.as_deref() != Some("not-quiescent:scheduledWakeups")
            || self.deps.capabilities().kind != ContinuationHostKind::GuardedNative
            || arm.execution_policy != Some(ExecutionPolicy::GuardedNativeAtMostOnce)
            || before.own_quota_wakeup != Some(true)
            || before.state.quiescence.scheduled_wakeups != 1.0
        {
            return Ok(Prepared {
                observation: before,
                reason,
                attempt: None,
            });
        }
        fn waiting(
            observation: DesktopContinuationObservation,
            reason: &str,
        ) -> Result<Prepared, DesktopContinuationError> {
            Ok(Prepared {
                observation,
                reason: Some(reason.to_owned()),
                attempt: None,
            })
        }
        if let Some(other_work) = self.quota_reason(&before, true) {
            return waiting(before, &other_work);
        }
        let mut provisional = self.attempt_for(arm, &before);
        if self
            .saved()
            .completed
            .iter()
            .any(|episode| episode.key == provisional.episode_key)
        {
            return waiting(before, "quota-episode-already-continued");
        }
        if let Some(policy) =
            continuation_policy_reason(&self.request(&provisional)?, self.now(), true)
        {
            return waiting(before, policy);
        }
        if !self.deps.supports_prepare_quota_stop() {
            return waiting(before, "own-quota-wakeup-can-takeover");
        }
        // Cancellation itself changes Desktop. Record its exact source binding before
        // the UI mutation, so a crash or failed reread cannot silently lose its timer.
        provisional.own_quota_wakeup = Some(OwnQuotaWakeup::CancellationIntent);
        let saved_arm = self.saved().arm;
        self.commit(|state| {
            state.pending = Some(provisional.clone());
            state.arm = None;
        })?;
        let after = match self
            .request(&provisional)
            .and_then(|request| self.deps.prepare_quota_stop(&before, &request))
        {
            Ok(after) => after,
            // Nothing was clicked: withdraw the intent and keep watching.
            Err(error) if error.unchanged => {
                self.commit(|state| {
                    state.pending = None;
                    state.arm = saved_arm;
                })?;
                return waiting(before, &observation_error_reason(&error));
            }
            Err(error) => return Err(error),
        };
        let changed = self
            .observation_reason(&after)
            .or_else(|| self.arm_reason(arm, &after).map(str::to_owned))
            .or_else(|| {
                (after.state.session.transcript_revision
                    != before.state.session.transcript_revision
                    || after.quota_stop.as_ref().map(|s| &s.turn_id)
                        != before.quota_stop.as_ref().map(|s| &s.turn_id))
                .then(|| "quota-checkpoint-changed".to_owned())
            })
            .or_else(|| self.quota_reason(&after, false));
        if let Some(changed) = changed {
            return waiting(after, &changed);
        }
        let prepared = DesktopContinuationAttempt {
            expected_context_revision: after.state.context_revision,
            own_quota_wakeup: Some(OwnQuotaWakeup::CancelledVerified),
            ..provisional
        };
        self.commit(|state| state.pending = Some(prepared.clone()))?;
        Ok(Prepared {
            observation: after,
            reason: None,
            attempt: Some(prepared),
        })
    }

    fn request(
        &self,
        attempt: &DesktopContinuationAttempt,
    ) -> Result<ContinuationRequest, DesktopContinuationError> {
        let snapshot = self.deps.snapshot();
        let find = |id: &str| snapshot.accounts.iter().find(|account| account.id == id);
        let source = find(&attempt.arm.source.profile_id);
        let target = find(&attempt.arm.target.profile_id);
        let (Some(source), Some(target)) = (source, target) else {
            return Err("attempt-identity-changed".into());
        };
        if !enrolled(Some(source))
            || !same_identity(&identity(source), &attempt.arm.source)
            || !enrolled(Some(target))
            || !same_identity(&identity(target), &attempt.arm.target)
        {
            return Err("attempt-identity-changed".into());
        }
        Ok(ContinuationRequest {
            id: attempt.id.clone(),
            source: source.clone(),
            target: target.clone(),
            settings: snapshot.settings.clone(),
            usage: snapshot.usage.clone(),
            session_id: attempt.arm.session_id.clone(),
            project_key: attempt.arm.project_key.clone(),
            permission_mode: attempt.arm.permission_mode.clone(),
            transcript_revision: attempt.transcript_revision.clone(),
            expected_context_revision: attempt.expected_context_revision,
            authorized: true,
            execution_policy: attempt.arm.execution_policy,
        })
    }

    fn execute(
        &self,
        attempt: &DesktopContinuationAttempt,
        recovery: bool,
    ) -> DesktopContinuationSnapshot {
        let arm = Some(&attempt.arm);
        self.publish(self.fields(
            ContinuationStatus::Executing,
            "checkpointed-handoff",
            arm,
            false,
        ));
        let outcome = (|| -> Result<DesktopContinuationSnapshot, DesktopContinuationError> {
            let result = self.deps.execute(&self.request(attempt)?)?;
            if result.status == ContinuationResultStatus::Continued {
                let now = self.now();
                self.commit(|state| {
                    if !state
                        .completed
                        .iter()
                        .any(|episode| episode.key == attempt.episode_key)
                    {
                        state.completed.push(CompletedEpisode {
                            key: attempt.episode_key.clone(),
                            at: now,
                        });
                    }
                    let excess = state.completed.len().saturating_sub(100);
                    state.completed.drain(..excess);
                    state.arm = None;
                    state.pending = None;
                })?;
                return Ok(self.publish(self.fields(
                    ContinuationStatus::Continued,
                    &result.reason,
                    arm,
                    true,
                )));
            }
            if result.status == ContinuationResultStatus::Blocked
                && result.record.is_none()
                && !recovery
                && attempt.own_quota_wakeup.is_none()
            {
                // A preflight rejection occurred before any durable host intent. Retry
                // only after gathering a new observation; retain no stale request.
                self.commit(|state| state.pending = None)?;
                return Ok(self.publish(self.fields(
                    ContinuationStatus::Blocked,
                    &result.reason,
                    arm,
                    false,
                )));
            }
            self.commit(|state| state.arm = None)?;
            Ok(self.publish(self.fields(
                ContinuationStatus::ReconciliationRequired,
                &result.reason,
                arm,
                false,
            )))
        })();
        outcome.unwrap_or_else(|_| {
            if self.commit(|state| state.arm = None).is_err() {
                self.inner().stopped = true;
            }
            self.publish(self.fields(
                ContinuationStatus::ReconciliationRequired,
                "attempt-interrupted",
                arm,
                false,
            ))
        })
    }

    fn status_for(reason: &str) -> ContinuationStatus {
        if waiting_reason(reason) {
            ContinuationStatus::Waiting
        } else {
            ContinuationStatus::Blocked
        }
    }

    /// One look at the armed conversation; hands off when its quota stop is verified.
    pub fn tick(&self) -> DesktopContinuationSnapshot {
        let _serial = self.serial();
        let (stopped, saved) = {
            let inner = self.inner();
            (inner.stopped, inner.saved.clone())
        };
        if stopped {
            return self.snapshot();
        }
        if let Some(pending) = &saved.pending {
            return self.publish(self.pending_fields(pending, "unfinished-attempt"));
        }
        let Some(mut arm) = saved.arm else {
            return self.snapshot();
        };
        // Most polls only wait. Decide that read-only, outside the shared Desktop
        // lock, so manual switches and usage renewals are not refused meanwhile.
        if !self.deps.pending_auth() {
            let preview = match self.deps.observe() {
                Ok(preview) => preview,
                Err(error) => {
                    return self.publish(self.fields(
                        ContinuationStatus::Blocked,
                        &observation_error_reason(&error),
                        Some(&arm),
                        false,
                    ));
                }
            };
            let mut reason = self
                .observation_reason(&preview)
                .or_else(|| {
                    self.contract_reason(arm.execution_policy, true)
                        .map(str::to_owned)
                })
                .or_else(|| self.arm_reason(&arm, &preview).map(str::to_owned));
            if reason.is_none() && arm.target_selection == Some(TargetSelection::Automatic) {
                reason = self.quota_reason(&preview, self.own_wakeup_allowed(&arm, &preview));
                if reason.is_none() {
                    match self.automatic_target(&arm, &preview) {
                        Ok(Some(_)) => {}
                        Ok(None) => reason = Some("automatic-target-unavailable".into()),
                        Err(error) => {
                            return self.publish(self.fields(
                                ContinuationStatus::Blocked,
                                &observation_error_reason(&error),
                                Some(&arm),
                                false,
                            ));
                        }
                    }
                }
            }
            if let Some(reason) = reason {
                return self.publish(self.fields(
                    Self::status_for(&reason),
                    &reason,
                    Some(&arm),
                    false,
                ));
            }
        }
        let locked = {
            let mut action =
                || -> Result<_, DesktopContinuationError> { Ok(self.locked_tick(&mut arm)) };
            self.deps.with_desktop_lock(&mut action)
        };
        match locked {
            Ok(snapshot) => snapshot,
            Err(_) => match self.pending_attempt() {
                Some(pending) => self.publish(self.pending_fields(&pending, "attempt-interrupted")),
                None => self.publish(self.fields(
                    ContinuationStatus::Blocked,
                    "desktop-lock-unavailable",
                    Some(&arm),
                    false,
                )),
            },
        }
    }

    fn locked_tick(&self, arm: &mut DesktopContinuationArm) -> DesktopContinuationSnapshot {
        match self.locked_tick_steps(arm) {
            Ok(snapshot) => snapshot,
            Err(error) => match self.pending_attempt() {
                Some(pending) => {
                    let mut value = self.pending_fields(&pending, "attempt-interrupted");
                    value.observation_reason = Some(observation_error_reason(&error));
                    self.publish(value)
                }
                None => self.publish(self.fields(
                    ContinuationStatus::Blocked,
                    &observation_error_reason(&error),
                    Some(arm),
                    false,
                )),
            },
        }
    }

    fn locked_tick_steps(
        &self,
        arm: &mut DesktopContinuationArm,
    ) -> Result<DesktopContinuationSnapshot, DesktopContinuationError> {
        if self.deps.pending_auth() {
            return Ok(self.publish(self.fields(
                ContinuationStatus::Waiting,
                "browser-sign-in",
                Some(arm),
                false,
            )));
        }
        let mut observation = self.deps.observe()?;
        let mut prepared_attempt = None;
        let mut reason = self
            .observation_reason(&observation)
            .or_else(|| {
                self.contract_reason(arm.execution_policy, true)
                    .map(str::to_owned)
            })
            .or_else(|| self.arm_reason(arm, &observation).map(str::to_owned));
        if reason.is_none() && arm.target_selection == Some(TargetSelection::Automatic) {
            reason = self.quota_reason(&observation, self.own_wakeup_allowed(arm, &observation));
            if reason.is_none() {
                match self.automatic_target(arm, &observation)? {
                    Some(selected) => *arm = selected,
                    None => reason = Some("automatic-target-unavailable".into()),
                }
            }
        }
        if reason.is_none() {
            let prepared = self.prepare_own_wakeup(arm, observation)?;
            observation = prepared.observation;
            reason = prepared.reason;
            prepared_attempt = prepared.attempt;
        }
        if let Some(reason) = reason {
            if self.pending_attempt().is_some() {
                let mut value = self.fields(
                    ContinuationStatus::ReconciliationRequired,
                    "own-quota-wakeup-uncertain",
                    Some(arm),
                    false,
                );
                value.observation_reason = Some(reason);
                return Ok(self.publish(value));
            }
            return Ok(self.publish(self.fields(
                Self::status_for(&reason),
                &reason,
                Some(arm),
                false,
            )));
        }
        let attempt = prepared_attempt.unwrap_or_else(|| self.attempt_for(arm, &observation));
        if self
            .saved()
            .completed
            .iter()
            .any(|episode| episode.key == attempt.episode_key)
        {
            return Ok(self.publish(self.fields(
                ContinuationStatus::Blocked,
                "quota-episode-already-continued",
                Some(arm),
                false,
            )));
        }
        self.commit(|state| state.pending = Some(attempt.clone()))?;
        Ok(self.execute(&attempt, false))
    }

    /// An unfinished send is never automatically retried on an application restart.
    pub fn resume_pending(&self) -> Result<DesktopContinuationSnapshot, DesktopContinuationError> {
        let _serial = self.serial();
        if self.persistence_fault {
            return Err("continuation-state-unreadable".into());
        }
        let Some(pending) = self.pending_attempt() else {
            return Err("no-unfinished-attempt".into());
        };
        if pending.own_quota_wakeup == Some(OwnQuotaWakeup::CancellationIntent) {
            return Ok(self.publish(self.fields(
                ContinuationStatus::ReconciliationRequired,
                "own-quota-wakeup-uncertain",
                Some(&pending.arm),
                false,
            )));
        }
        self.deps
            .with_desktop_lock(&mut || Ok(self.execute(&pending, true)))
    }

    /// Cancel only a durable, positively unsent intent; possible sends stay blocked.
    pub fn abandon_pending(&self) -> Result<DesktopContinuationSnapshot, DesktopContinuationError> {
        let _serial = self.serial();
        if self.persistence_fault {
            return Err("continuation-state-unreadable".into());
        }
        let Some(pending) = self.pending_attempt() else {
            return Err("no-unfinished-attempt".into());
        };
        if !self.deps.supports_abandon_unsent() {
            return Err("unsent-cancellation-unavailable".into());
        }
        self.deps.with_desktop_lock(&mut || {
            self.deps.abandon_unsent(&pending.id)?;
            self.commit(|state| {
                state.arm = None;
                state.pending = None;
            })?;
            Ok(self.publish(self.fields(
                ContinuationStatus::Off,
                "user-cancelled-unsent",
                Some(&pending.arm),
                false,
            )))
        })
    }
}
