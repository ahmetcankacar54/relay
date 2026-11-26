//! Port of `electron/core/auto-switch.ts`: prepares the Claude app on another account once it
//! quits with the active account's quota used up.

use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use indexmap::IndexMap;
use serde_json::{Value, json};

use crate::desktop::{DesktopManager, DesktopResult, DesktopSwitchOptions};
use crate::desktop_continuation::{ContinuationTimer, thread_interval};
use crate::shared::continuation_target_ranking::{
    ContinuationTargetCandidate, RankingContext, rank_continuation_targets, switch_at_percent,
};
use crate::shared::history_policy::{allowed_history_pair, history_sources};
use crate::shared::types::js::{JsMap, Num, compare_str, date_parse, iso, number_string, round};
use crate::shared::types::{
    Account, AccountUsage, AutoSwitchMode, AutoSwitchReason, AutoSwitchState, AutoSwitchStatus,
    DesktopHistoryTransfer, DesktopState, RelaySettings, UsageStatus, UsageWindow,
};
use crate::shared::usage::quota_windows;
use crate::store::Store;

const MAX_AGE: f64 = 5.0 * 60_000.0;
const RETRY_DELAY: f64 = 10.0 * 60_000.0;
const MAX_ATTEMPTS: u32 = 3;
const EXIT_GRACE: f64 = 10_000.0;
/// How often the manager looks while started.
const TICK_MS: u64 = 30_000;

/// One exhausted window of the source, until its reset.
#[derive(Debug, Clone, PartialEq)]
pub struct Exhaustion {
    pub key: String,
    pub expires_at: f64,
}

/// What [`auto_switch_decision`] found.
#[derive(Debug, Clone, PartialEq)]
pub struct Decision {
    pub state: AutoSwitchState,
    pub exhausted: Option<Vec<Exhaustion>>,
}

/// `!!text`: present and not empty.
fn truthy(text: Option<&str>) -> bool {
    text.is_some_and(|t| !t.is_empty())
}

fn parse(text: Option<&str>) -> f64 {
    match text {
        Some(t) if !t.is_empty() => date_parse(t),
        _ => f64::NAN,
    }
}

fn identity_ready(account: &Account) -> bool {
    let (Some(desktop), Some(auth)) = (&account.desktop, &account.auth) else {
        return false;
    };
    !truthy(desktop.rejected_at.as_deref())
        && auth.logged_in
        && truthy(auth.account_uuid.as_deref())
        && truthy(auth.org_id.as_deref())
        && auth
            .account_uuid
            .as_deref()
            .unwrap_or_default()
            .to_lowercase()
            == desktop.account_uuid.to_lowercase()
        && auth.org_id.as_deref().unwrap_or_default().to_lowercase()
            == desktop.org_id.to_lowercase()
}

fn fresh(usage: Option<&AccountUsage>, now: f64) -> bool {
    let Some(usage) = usage else { return false };
    let checked_at = parse(usage.checked_at.as_deref());
    usage.status == UsageStatus::Ready
        && !usage.stale
        && usage.issue.is_none()
        && checked_at.is_finite()
        && checked_at <= now
        && now - checked_at <= MAX_AGE
}

fn valid_window(window: Option<&UsageWindow>) -> bool {
    window.is_some_and(|w| {
        w.used_percent.is_finite() && w.used_percent >= 0.0 && w.used_percent <= 100.0
    })
}

fn future_reset(window: &UsageWindow, now: f64) -> Option<f64> {
    let reset = parse(window.resets_at.as_deref());
    (reset.is_finite() && reset > now).then_some(reset)
}

/// The usage API's reset time moves by seconds between reads; an episode is one reset to the nearest 10 minutes.
const EPISODE_RESET_MS: f64 = 10.0 * 60_000.0;

/// The source's windows at or past its switch line, each an episode until its reset: full (100)
/// unless the account has its own line, where automatic switching leaves it earlier.
fn exhaustion(account: &Account, usage: &AccountUsage, now: f64) -> Vec<Exhaustion> {
    let line = switch_at_percent(account, 100.0);
    let Some(desktop) = &account.desktop else {
        return Vec::new();
    };
    [
        ("fiveHour", usage.five_hour.as_ref()),
        ("sevenDay", usage.seven_day.as_ref()),
    ]
    .into_iter()
    .filter_map(|(name, window)| {
        let expires_at = future_reset(window?, now)?;
        (valid_window(window) && window?.used_percent >= line).then(|| Exhaustion {
            key: format!(
                "{}:{}:{name}:{}",
                desktop.account_uuid.to_lowercase(),
                desktop.org_id.to_lowercase(),
                number_string(round(expires_at / EPISODE_RESET_MS))
            ),
            expires_at,
        })
    })
    .collect()
}

fn usable_target(account: &Account, usage: Option<&AccountUsage>, now: f64) -> bool {
    if !identity_ready(account) || !fresh(usage, now) {
        return false;
    }
    if truthy(account.cooldown_until.as_deref()) {
        let cooldown = parse(account.cooldown_until.as_deref());
        if !cooldown.is_finite() || cooldown > now {
            return false;
        }
    }
    quota_windows(usage).is_some_and(|windows| {
        windows.iter().all(|window| {
            valid_window(Some(window))
                && window.used_percent < switch_at_percent(account, 90.0)
                && (!truthy(window.resets_at.as_deref()) || future_reset(window, now).is_some())
        })
    })
}

/// The current OS as Node's `process.platform` names it.
fn current_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// Where preparing on quit can run. It reads usage and Desktop's lifecycle and switches while
/// Claude is closed: no UI automation, so Linux has it too. Windows has no lifecycle adapter.
/// `platform` is a Node platform name; `None` means the current one.
pub fn auto_switch_supported(platform: Option<&str>) -> bool {
    let platform = platform.unwrap_or(current_platform());
    platform == "darwin" || platform == "linux"
}

/// Decisions never read credentials, infer task completion or send a message.
/// The Desktop adapter remains responsible for enforcing absence before writes.
/// `platform_supported` `None` means [`auto_switch_supported`] for this OS; `rate` is Pro units
/// per hour now (the tempo), for the switch rule's threshold; `continuation_owns` says a
/// continuation or the fleet owns quota-stopped conversations.
#[allow(clippy::too_many_arguments)]
pub fn auto_switch_decision(
    settings: &RelaySettings,
    accounts: &[Account],
    desktop: &DesktopState,
    usage: &JsMap<AccountUsage>,
    now: f64,
    pending_auth: bool,
    platform_supported: Option<bool>,
    rate: Option<f64>,
    continuation_owns: bool,
) -> Decision {
    let state = |status: AutoSwitchStatus,
                 reason: AutoSwitchReason,
                 source_id: Option<&str>,
                 target_id: Option<&str>| Decision {
        state: AutoSwitchState {
            status,
            reason,
            source_id: source_id.map(str::to_string),
            target_id: target_id.map(str::to_string),
            checked_at: Some(iso(now)),
            switched_at: None,
            retry_at: None,
        },
        exhausted: None,
    };
    use AutoSwitchReason as R;
    use AutoSwitchStatus as S;
    if settings.auto_switch_mode != AutoSwitchMode::AfterExit {
        return state(S::Off, R::Disabled, None, None);
    }
    if !platform_supported.unwrap_or_else(|| auto_switch_supported(None)) {
        return state(S::Blocked, R::UnsupportedPlatform, None, None);
    }
    if !desktop.available {
        return state(S::Blocked, R::DesktopUnavailable, None, None);
    }
    if desktop.recovery_required {
        return state(S::Blocked, R::DesktopRecovery, None, None);
    }
    if desktop.busy {
        return state(S::Blocked, R::DesktopBusy, None, None);
    }
    if desktop.windows.is_some_and(|n| n != 0.0 && !n.is_nan()) {
        return state(S::Blocked, R::SeparateWindow, None, None);
    }
    if truthy(desktop.pending_profile_id.as_deref()) {
        return state(S::Blocked, R::DesktopSignIn, None, None);
    }
    if continuation_owns {
        return state(S::Blocked, R::ContinuationActive, None, None);
    }
    if pending_auth {
        return state(S::Blocked, R::BrowserSignIn, None, None);
    }
    let source = accounts
        .iter()
        .find(|account| Some(&account.id) == desktop.active_profile_id.as_ref());
    let Some((source, source_desktop)) = source.and_then(|s| s.desktop.as_ref().map(|d| (s, d)))
    else {
        return state(S::Blocked, R::UnknownActive, None, None);
    };
    if desktop
        .current_account_uuid
        .as_ref()
        .map(|u| u.to_lowercase())
        != Some(source_desktop.account_uuid.to_lowercase())
        || !desktop
            .organizations
            .iter()
            .any(|org| org.to_lowercase() == source_desktop.org_id.to_lowercase())
    {
        return state(S::Blocked, R::UnknownActive, None, None);
    }
    let source_id = Some(source.id.as_str());
    if !settings.auto_switch_accounts.contains(&source.id) {
        return state(S::Watching, R::NotSelected, source_id, None);
    }
    if !identity_ready(source) {
        return state(S::Blocked, R::SourceNotReady, source_id, None);
    }
    let current = usage.get(&source.id);
    let Some(current) = current.filter(|c| fresh(Some(c), now)) else {
        return state(S::Blocked, R::UsageNotFresh, source_id, None);
    };
    let exhausted = exhaustion(source, current, now);
    if exhausted.is_empty() {
        let full = [current.five_hour.as_ref(), current.seven_day.as_ref()]
            .into_iter()
            .any(|window| valid_window(window) && window.is_some_and(|w| w.used_percent >= 100.0));
        return if full {
            state(S::Blocked, R::UsageNotFresh, source_id, None)
        } else {
            state(S::Watching, R::QuotaAvailable, source_id, None)
        };
    }
    let same = |account: &Account| {
        account.desktop.as_ref().is_some_and(|d| {
            d.account_uuid.to_lowercase() == source_desktop.account_uuid.to_lowercase()
                && d.org_id.to_lowercase() == source_desktop.org_id.to_lowercase()
        })
    };
    let eligible: Vec<ContinuationTargetCandidate<'_>> = accounts
        .iter()
        .filter(|account| {
            settings.auto_switch_accounts.contains(&account.id)
                && allowed_history_pair(source, account, settings)
                && usable_target(account, usage.get(&account.id), now)
                && !same(account)
        })
        .map(|account| ContinuationTargetCandidate {
            account,
            usage: usage.get(&account.id),
        })
        .collect();
    // The same rule as the other automatic switches: the strategy's order among the accounts
    // with enough quota at the tempo, else capacity × remaining.
    let ranked = rank_continuation_targets(
        &eligible,
        Some(RankingContext {
            now,
            rate,
            strategy: settings.auto_switch_strategy,
        }),
    );
    let Some(target) = ranked.first().map(|r| r.account) else {
        return Decision {
            exhausted: Some(exhausted),
            ..state(S::Blocked, R::NoReadyTarget, source_id, None)
        };
    };
    let (status, reason) = if desktop.running {
        (S::Waiting, R::ClaudeRunning)
    } else {
        (S::Watching, R::QuotaExhausted)
    };
    Decision {
        exhausted: Some(exhausted),
        ..state(status, reason, source_id, Some(&target.id))
    }
}

/// What the manager needs of Desktop (TS `Pick<DesktopManager, "snapshot" | "switchTo">`).
pub trait AutoSwitchDesktop: Send + Sync {
    fn snapshot(&self) -> DesktopResult<DesktopState>;
    fn switch_to(&self, profile_id: &str, options: DesktopSwitchOptions) -> DesktopResult<()>;
}

impl AutoSwitchDesktop for DesktopManager {
    fn snapshot(&self) -> DesktopResult<DesktopState> {
        DesktopManager::snapshot(self)
    }
    fn switch_to(&self, profile_id: &str, options: DesktopSwitchOptions) -> DesktopResult<()> {
        DesktopManager::switch_to(self, profile_id, options)
    }
}

impl<T: AutoSwitchDesktop + ?Sized> AutoSwitchDesktop for Arc<T> {
    fn snapshot(&self) -> DesktopResult<DesktopState> {
        (**self).snapshot()
    }
    fn switch_to(&self, profile_id: &str, options: DesktopSwitchOptions) -> DesktopResult<()> {
        (**self).switch_to(profile_id, options)
    }
}

/// The usage readings now (TS `usage.snapshot()`).
pub type UsageSnapshot = Arc<dyn Fn() -> JsMap<AccountUsage> + Send + Sync>;
/// A switch to run under the Desktop write lock.
pub type DesktopLockAction<'a> = dyn FnMut() -> DesktopResult<()> + 'a;
/// `withDesktopLock(action)`: runs `action` holding the Desktop write lock.
pub type WithDesktopLock =
    Arc<dyn Fn(&mut DesktopLockAction<'_>) -> DesktopResult<()> + Send + Sync>;
/// Told the profile the Claude app was prepared on.
pub type Switched = Arc<dyn Fn(&str) + Send + Sync>;

/// The manager's optional dependencies; a missing one acts as the TS default.
#[derive(Clone, Default)]
pub struct AutoSwitchDependencies {
    /// The wall clock by default.
    pub now: Option<Arc<dyn Fn() -> f64 + Send + Sync>>,
    pub pending_auth: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    /// Continue at quota owns the stopped conversations; preparing waits for it.
    pub continuation_owns: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    pub changed: Option<Arc<dyn Fn() + Send + Sync>>,
    /// [`auto_switch_supported`] for this OS by default.
    pub platform_supported: Option<bool>,
    pub with_desktop_lock: Option<WithDesktopLock>,
    /// Pro units per hour now (the tempo); `None` when unknown.
    pub tempo_rate: Option<Arc<dyn Fn() -> Option<f64> + Send + Sync>>,
    /// The Claude app was prepared on the target: the remote notifications post it. Never fails back.
    pub switched: Option<Switched>,
}

#[derive(Debug, Clone, Copy)]
struct Failure {
    expires_at: f64,
    attempts: u32,
    retry_at: f64,
}

struct Inner {
    state: AutoSwitchState,
    timer: Option<Box<dyn ContinuationTimer>>,
    completed: IndexMap<String, f64>,
    failures: HashMap<String, Failure>,
    last_success: Option<AutoSwitchState>,
    closed_since: Option<f64>,
}

fn bare(
    status: AutoSwitchStatus,
    reason: AutoSwitchReason,
    checked_at: Option<String>,
) -> AutoSwitchState {
    AutoSwitchState {
        status,
        reason,
        source_id: None,
        target_id: None,
        checked_at,
        switched_at: None,
        retry_at: None,
    }
}

/// Watches the active account and prepares Desktop on another one after Claude quits with the
/// quota used up, once per exhaustion episode.
pub struct AutoSwitchManager {
    store: Arc<Store>,
    desktop: Arc<dyn AutoSwitchDesktop>,
    usage: UsageSnapshot,
    dependencies: AutoSwitchDependencies,
    platform_supported: bool,
    evaluating: AtomicBool,
    stopped: AtomicBool,
    inner: Mutex<Inner>,
    this: Weak<AutoSwitchManager>,
}

impl AutoSwitchManager {
    pub fn new(
        store: Arc<Store>,
        desktop: Arc<dyn AutoSwitchDesktop>,
        usage: UsageSnapshot,
        dependencies: AutoSwitchDependencies,
    ) -> Arc<AutoSwitchManager> {
        let platform_supported = dependencies
            .platform_supported
            .unwrap_or_else(|| auto_switch_supported(None));
        let completed = store.with_state(|state| {
            state
                .auto_switch_completed
                .iter()
                .map(|(key, value)| (key.clone(), value.0))
                .collect()
        });
        let manager = Arc::new_cyclic(|this| AutoSwitchManager {
            store,
            desktop,
            usage,
            dependencies,
            platform_supported,
            evaluating: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            inner: Mutex::new(Inner {
                state: bare(AutoSwitchStatus::Off, AutoSwitchReason::Disabled, None),
                timer: None,
                completed,
                failures: HashMap::new(),
                last_success: None,
                closed_since: None,
            }),
            this: this.clone(),
        });
        manager.prune(manager.now());
        manager
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn now(&self) -> f64 {
        match &self.dependencies.now {
            Some(now) => now(),
            None => crate::clock::now_ms() as f64,
        }
    }

    fn stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    pub fn snapshot(&self) -> AutoSwitchState {
        self.inner().state.clone()
    }

    /// Looks now (on the caller's thread), then every 30 seconds on a background thread.
    pub fn start(self: &Arc<Self>) {
        {
            let mut inner = self.inner();
            if inner.timer.is_some() {
                return;
            }
            self.stopped.store(false, Ordering::SeqCst);
            let weak = Arc::downgrade(self);
            inner.timer = Some(thread_interval(
                TICK_MS,
                Box::new(move || {
                    if let Some(manager) = weak.upgrade() {
                        manager.tick();
                    }
                }),
            ));
        }
        self.tick();
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        let timer = self.inner().timer.take();
        if let Some(timer) = timer {
            timer.cancel();
        }
    }

    fn publish(&self, state: AutoSwitchState) {
        let without_checked_at = |s: &AutoSwitchState| AutoSwitchState {
            checked_at: None,
            ..s.clone()
        };
        let changed = {
            let mut inner = self.inner();
            let changed = without_checked_at(&inner.state) != without_checked_at(&state);
            inner.state = state;
            changed
        };
        if changed && let Some(changed) = &self.dependencies.changed {
            changed();
        }
    }

    fn decide(&self, desktop: &DesktopState) -> Decision {
        let usage = (self.usage)();
        let now = self.now();
        let pending_auth = self.dependencies.pending_auth.as_ref().is_some_and(|f| f());
        let rate = self.dependencies.tempo_rate.as_ref().and_then(|f| f());
        let continuation_owns = self
            .dependencies
            .continuation_owns
            .as_ref()
            .is_some_and(|f| f());
        self.store.with_state(|state| {
            auto_switch_decision(
                &state.settings,
                &state.accounts,
                desktop,
                &usage,
                now,
                pending_auth,
                Some(self.platform_supported),
                rate,
                continuation_owns,
            )
        })
    }

    fn prune(&self, now: f64) {
        let mut inner = self.inner();
        inner.completed.retain(|_, expires_at| *expires_at > now);
        inner.failures.retain(|_, failure| failure.expires_at > now);
    }

    fn episode_state(&self, decision: &Decision) -> Option<AutoSwitchState> {
        let exhausted = decision.exhausted.as_deref().unwrap_or_default();
        let failure = {
            let inner = self.inner();
            if exhausted
                .iter()
                .any(|episode| inner.completed.contains_key(&episode.key))
            {
                return Some(AutoSwitchState {
                    status: AutoSwitchStatus::Blocked,
                    reason: AutoSwitchReason::AlreadySwitched,
                    ..decision.state.clone()
                });
            }
            exhausted
                .iter()
                .filter_map(|episode| inner.failures.get(&episode.key).copied())
                .reduce(|best, next| {
                    let by_attempts = next.attempts.cmp(&best.attempts);
                    if by_attempts.is_gt() || (by_attempts.is_eq() && next.retry_at > best.retry_at)
                    {
                        next
                    } else {
                        best
                    }
                })
        };
        let failure = failure?;
        let spent = failure.attempts >= MAX_ATTEMPTS;
        (spent || failure.retry_at > self.now()).then(|| AutoSwitchState {
            status: AutoSwitchStatus::Blocked,
            reason: if spent {
                AutoSwitchReason::SwitchFailed
            } else {
                AutoSwitchReason::RetryBackoff
            },
            retry_at: (!spent).then(|| iso(failure.retry_at)),
            ..decision.state.clone()
        })
    }

    fn disabled(&self) -> AutoSwitchState {
        bare(
            AutoSwitchStatus::Off,
            AutoSwitchReason::Disabled,
            Some(iso(self.now())),
        )
    }

    fn after_exit(&self) -> bool {
        self.store
            .with_state(|state| state.settings.auto_switch_mode == AutoSwitchMode::AfterExit)
    }

    /// One look; never overlaps itself and never fails.
    pub fn tick(&self) {
        if self.stopped() || self.evaluating.swap(true, Ordering::SeqCst) {
            return;
        }
        if self.evaluate().is_err() {
            // A failed snapshot is not proof that the application has exited.
            self.inner().closed_since = None;
            self.publish(bare(
                AutoSwitchStatus::Blocked,
                AutoSwitchReason::DesktopUnavailable,
                Some(iso(self.now())),
            ));
        }
        self.evaluating.store(false, Ordering::SeqCst);
    }

    /// The accounts' identities `sourceId` and `targetId` are bound to.
    fn selected_identity(&self, source_id: &str, target_id: &str) -> Value {
        self.store.with_state(|state| {
            Value::Array(
                [source_id, target_id]
                    .iter()
                    .map(|id| {
                        let account = state.accounts.iter().find(|a| a.id == *id);
                        let desktop = account.and_then(|a| a.desktop.as_ref());
                        let auth = account.and_then(|a| a.auth.as_ref());
                        json!([
                            desktop.map(|d| &d.account_uuid),
                            desktop.map(|d| &d.org_id),
                            auth.and_then(|a| a.account_uuid.as_ref()),
                            auth.and_then(|a| a.org_id.as_ref()),
                            auth.map(|a| a.logged_in),
                        ])
                    })
                    .collect(),
            )
        })
    }

    /// The Desktop transaction can import history from accounts that are not automatic-switch
    /// candidates. Bind the entire planned sharing boundary, including every source identity,
    /// rather than only the A → B endpoints.
    fn planned_history_scope(&self, target_id: &str) -> Value {
        self.store.with_state(|state| {
            let (settings, accounts) = (&state.settings, &state.accounts);
            let target = accounts.iter().find(|account| account.id == target_id);
            let scope = |account: &Account| {
                json!([
                    account.id,
                    account.group,
                    account.desktop.as_ref().map(|d| &d.account_uuid),
                    account.desktop.as_ref().map(|d| &d.org_id),
                    account.auth.as_ref().and_then(|a| a.account_uuid.as_ref()),
                    account.auth.as_ref().and_then(|a| a.org_id.as_ref()),
                ])
            };
            let selected = |ids: &[String]| -> Vec<String> {
                ids.iter()
                    .filter(|id| accounts.iter().any(|account| &account.id == *id))
                    .cloned()
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect()
            };
            let sources: Vec<Value> = match target {
                Some(target) => {
                    let mut sources = history_sources(target, accounts, settings);
                    sources.sort_by(|a, b| compare_str(&a.id, &b.id).total_cmp(&0.0));
                    sources.into_iter().map(scope).collect()
                }
                None => Vec::new(),
            };
            json!({
                "autoMode": settings.auto_switch_mode,
                "autoAccounts": selected(&settings.auto_switch_accounts),
                "historyMode": settings.desktop_history_transfer,
                "historyGrant": if settings.desktop_history_transfer == DesktopHistoryTransfer::Selected {
                    selected(&settings.desktop_history_accounts)
                } else {
                    Vec::new()
                },
                "target": target.map(scope),
                "sources": sources,
            })
        })
    }

    fn evaluate(&self) -> DesktopResult<()> {
        use AutoSwitchReason as R;
        use AutoSwitchStatus as S;
        self.prune(self.now());
        if !self.after_exit() {
            {
                let mut inner = self.inner();
                inner.last_success = None;
                inner.closed_since = None;
            }
            self.publish(self.disabled());
            return Ok(());
        }
        let desktop = self.desktop.snapshot()?;
        if self.stopped() {
            return Ok(());
        }
        if desktop.running || !desktop.available {
            self.inner().closed_since = None;
        } else {
            let now = self.now();
            self.inner().closed_since.get_or_insert(now);
        }
        let decision = self.decide(&desktop);
        if let Some(episode_state) = self.episode_state(&decision) {
            self.publish(episode_state);
            return Ok(());
        }
        let last_success = self.inner().last_success.clone();
        if let Some(last_success) = last_success
            && decision.state.reason == R::QuotaAvailable
            && decision.state.source_id == last_success.target_id
        {
            self.publish(AutoSwitchState {
                checked_at: decision.state.checked_at.clone(),
                ..last_success
            });
            return Ok(());
        }
        self.publish(decision.state.clone());
        let (Some(source_id), Some(target_id)) = (
            decision.state.source_id.clone(),
            decision.state.target_id.clone(),
        ) else {
            return Ok(());
        };
        if decision.state.reason != R::QuotaExhausted {
            return Ok(());
        }
        let closed_since = self.inner().closed_since;
        if closed_since.is_none_or(|since| self.now() - since < EXIT_GRACE) {
            self.publish(AutoSwitchState {
                status: S::Waiting,
                reason: R::ExitSettling,
                ..decision.state
            });
            return Ok(());
        }
        // Re-read mutable state after the Desktop snapshot. Nothing separates the final consent
        // check from acquiring Desktop's write lock.
        let episodes = decision.exhausted.clone().unwrap_or_default();
        let rechecked_desktop = self.desktop.snapshot()?;
        if self.stopped() {
            return Ok(());
        }
        if rechecked_desktop.running || !rechecked_desktop.available {
            self.inner().closed_since = None;
        }
        let decision = self.decide(&rechecked_desktop);
        if decision.state.source_id.as_deref() != Some(&source_id)
            || decision.state.target_id.as_deref() != Some(&target_id)
            || decision.state.reason != R::QuotaExhausted
            || decision.exhausted.as_ref() != Some(&episodes)
        {
            self.publish(decision.state);
            return Ok(());
        }
        let identity_at_dispatch = self.selected_identity(&source_id, &target_id);
        let history_scope_at_dispatch = self.planned_history_scope(&target_id);
        let weak = self.this.clone();
        let (allowed_source, allowed_target, allowed_episodes) =
            (source_id.clone(), target_id.clone(), episodes.clone());
        let allowed = move || {
            let Some(manager) = weak.upgrade() else {
                return false;
            };
            let source = manager.store.with_state(|state| {
                state
                    .accounts
                    .iter()
                    .find(|account| account.id == allowed_source)
                    .and_then(|account| account.desktop.clone())
            });
            let recheck = manager.decide(&DesktopState {
                available: true,
                running: false,
                busy: false,
                recovery_required: false,
                active_profile_id: Some(allowed_source.clone()),
                current_account_uuid: source.as_ref().map(|d| d.account_uuid.clone()),
                organizations: vec![source.map(|d| d.org_id).unwrap_or_default()],
                error_revision: 0.0,
                ..DesktopState::default()
            });
            !manager.stopped()
                && recheck.state.reason == R::QuotaExhausted
                && recheck.state.source_id.as_deref() == Some(&allowed_source)
                && recheck.state.target_id.as_deref() == Some(&allowed_target)
                && recheck.exhausted.as_ref() == Some(&allowed_episodes)
                && manager.selected_identity(&allowed_source, &allowed_target)
                    == identity_at_dispatch
                && manager.planned_history_scope(&allowed_target) == history_scope_at_dispatch
                && manager.episode_state(&recheck).is_none()
        };
        self.publish(AutoSwitchState {
            status: S::Switching,
            ..decision.state.clone()
        });
        let options = DesktopSwitchOptions {
            automatic: true,
            closed_only: true,
            expected_active_profile_id: Some(source_id.clone()),
            can_proceed: Some(Arc::new(allowed)),
            ..DesktopSwitchOptions::default()
        };
        let mut switch_account = || self.desktop.switch_to(&target_id, options.clone());
        let switched = match &self.dependencies.with_desktop_lock {
            Some(with_lock) => with_lock(&mut switch_account),
            None => switch_account(),
        };
        if switched.is_ok() {
            self.completed(&decision, &episodes, &target_id);
        } else {
            self.failed(&decision, &episodes);
        }
        Ok(())
    }

    fn completed(&self, decision: &Decision, episodes: &[Exhaustion], target_id: &str) {
        {
            let mut inner = self.inner();
            for episode in episodes {
                inner
                    .completed
                    .insert(episode.key.clone(), episode.expires_at);
                inner.failures.remove(&episode.key);
            }
        }
        self.prune(self.now());
        let completed = {
            let inner = self.inner();
            let mut entries: Vec<(&String, &f64)> = inner.completed.iter().collect();
            entries.sort_by(|(_, a), (_, b)| b.total_cmp(a));
            let mut completed = JsMap::new();
            for (key, expires_at) in entries.into_iter().take(100) {
                completed.insert(key.clone(), Num(*expires_at));
            }
            completed
        };
        // Desktop has already prepared the account. A registry failure must not turn that
        // completed operation into a retryable Desktop failure.
        let ledger_saved = self
            .store
            .update(|state| state.auto_switch_completed = completed)
            .is_ok();
        let success = AutoSwitchState {
            status: AutoSwitchStatus::Switched,
            reason: if ledger_saved {
                AutoSwitchReason::Prepared
            } else {
                AutoSwitchReason::LedgerUnavailable
            },
            switched_at: Some(iso(self.now())),
            ..decision.state.clone()
        };
        self.inner().last_success = Some(success.clone());
        self.publish(success);
        if let Some(switched) = &self.dependencies.switched {
            switched(target_id);
        }
    }

    fn failed(&self, decision: &Decision, episodes: &[Exhaustion]) {
        if self.stopped() {
            return;
        }
        if !self.after_exit() {
            self.publish(self.disabled());
            return;
        }
        let retry_at = self.now() + RETRY_DELAY;
        let attempts = {
            let mut inner = self.inner();
            let attempts = 1 + episodes
                .iter()
                .filter_map(|episode| inner.failures.get(&episode.key).map(|f| f.attempts))
                .max()
                .unwrap_or(0);
            for episode in episodes {
                inner.failures.insert(
                    episode.key.clone(),
                    Failure {
                        expires_at: episode.expires_at,
                        attempts,
                        retry_at,
                    },
                );
            }
            attempts
        };
        self.publish(AutoSwitchState {
            status: AutoSwitchStatus::Blocked,
            reason: AutoSwitchReason::SwitchFailed,
            retry_at: (attempts < MAX_ATTEMPTS).then(|| iso(retry_at)),
            ..decision.state.clone()
        });
    }
}
