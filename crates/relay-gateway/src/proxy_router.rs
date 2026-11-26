//! Picks the account for each request (`proxy-router.ts`): the session's own while it is
//! worth keeping, else the routing strategy's pick among the accounts not kept out.

use crate::js::{Clock, parse_date, system_clock};
use crate::proxy_session_cache::ProxySessionCache;
use crate::ranking::{
    EMPTY_ROOM_UNITS, LOW_ROOM_UNITS, RankingContext, cmp_f64, plan_capacity,
    rank_continuation_targets, room_units, week_band,
};
use crate::types::{
    Account, AccountUsage, Provider, ProxyMoveReason, ProxyPickReason, RoutingStrategy, UsageMap,
    UsageStatus, UsageWindow,
};
use std::collections::{HashMap, HashSet};
use std::fmt;

/// What the gateway knows about one request beyond its session.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PickContext {
    /// The request's model id; a limit scoped to its model applies to it.
    pub model: Option<String>,
    /// The first request of a new prompt in a main conversation.
    pub turn_start: bool,
    /// The session's cache has outlived its time.
    pub cold: bool,
    /// The main conversation's own request; `None` when not known.
    pub main: Option<bool>,
}

impl PickContext {
    pub fn model(model: &str) -> Self {
        PickContext {
            model: Some(model.to_string()),
            ..Default::default()
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RouterSelection {
    pub account: Account,
    pub session_affinity_hit: bool,
    /// Why this account: the session's own, the strategy's pick, or the only one left.
    pub reason: ProxyPickReason,
    /// Accounts a new pick left out for being close to a limit.
    pub nearly_full: Option<Vec<String>>,
    /// The session's own account, kept out by its sign-in or an outage; the session stays bound.
    pub bound_waiting: Option<String>,
    /// The session left its account on purpose, and why.
    pub moved: Option<ProxyMoveReason>,
    /// The account the session left.
    pub from: Option<String>,
}

/// Why the gateway is keeping an account out for a while.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CooldownReason {
    /// A window is used up (or the account bills extra usage); its sessions move on.
    Limit,
    /// Its sign-in was refused or cannot be read; its sessions wait for it.
    Auth,
    /// An overload or a blocked answer; its sessions wait for it.
    Transient,
}

impl CooldownReason {
    pub fn as_str(self) -> &'static str {
        match self {
            CooldownReason::Limit => "limit",
            CooldownReason::Auth => "auth",
            CooldownReason::Transient => "transient",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cooldown {
    pub until: i64,
    pub reason: CooldownReason,
}

/// Why no account could be selected.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RouterError {
    /// Every account of the provider is cooling down; `retry_after_seconds` is when the first
    /// is back. `sign_in_only`: every one is out for its sign-in, none for a limit.
    NoEligible {
        retry_after_seconds: Option<u64>,
        sign_in_only: bool,
    },
    /// Relay has no account of the requested provider (or every one was already tried).
    NoProvider { provider: Option<Provider> },
}

impl fmt::Display for RouterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RouterError::NoEligible {
                sign_in_only: true, ..
            } => f.write_str(
                "Relay cannot use the sign-in of any account in its pool for this provider; renew it in Relay",
            ),
            RouterError::NoEligible { .. } => f.write_str(
                "Every account in Relay's pool for this provider is at its limit or cooling down",
            ),
            RouterError::NoProvider {
                provider: Some(provider),
            } => write!(f, "No {} account is available in Relay", provider.as_str()),
            RouterError::NoProvider { provider: None } => {
                f.write_str("No account is available in Relay")
            }
        }
    }
}

impl std::error::Error for RouterError {}

const HOUR_MS: i64 = 3_600_000;
const WEEK_MS: i64 = 7 * 24 * HOUR_MS;

/// The model family of a model id ("claude-fable-5-2" → "fable"), as usage windows name it.
pub fn model_family(model: Option<&str>) -> Option<&'static str> {
    let lower = model?.to_lowercase();
    // The leftmost of the four names, as the regex `/(fable|opus|sonnet|haiku)/` finds it.
    ["fable", "opus", "sonnet", "haiku"]
        .into_iter()
        .filter_map(|name| lower.find(name).map(|at| (at, name)))
        .min_by_key(|(at, _)| *at)
        .map(|(_, name)| name)
}

/// How much of a window is used now: a window whose reset has passed is empty again.
pub fn used_now(window: Option<&UsageWindow>, now: i64) -> Option<f64> {
    let window = window?;
    if !window.used_percent.is_finite() {
        return None;
    }
    match window.resets_at.as_deref().and_then(parse_date) {
        Some(reset) if reset <= now => Some(0.0),
        _ => Some(window.used_percent),
    }
}

/// Every limit of the account scoped to a model family.
pub fn scoped_windows<'a>(
    usage: Option<&'a AccountUsage>,
    family: Option<&str>,
) -> Vec<&'a crate::types::ModelWindow> {
    let Some(family) = family else {
        return Vec::new();
    };
    usage
        .map(|u| {
            u.model_windows()
                .iter()
                .filter(|w| w.model.as_deref() == Some(family))
                .collect()
        })
        .unwrap_or_default()
}

fn model_used_now(window: &crate::types::ModelWindow, now: i64) -> f64 {
    let as_window = UsageWindow::new(window.used_percent, window.resets_at.clone());
    used_now(Some(&as_window), now).unwrap_or(0.0)
}

/// The used percents that bind a request of `family` now: 5-hour, week, and the model's own.
struct Used {
    five: Option<f64>,
    week: Option<f64>,
    model: Option<f64>,
}

fn used_for(usage: Option<&AccountUsage>, family: Option<&str>, now: i64) -> Used {
    let scoped: Vec<f64> = scoped_windows(usage, family)
        .into_iter()
        .map(|w| model_used_now(w, now))
        .collect();
    Used {
        five: used_now(usage.and_then(|u| u.five_hour.as_ref()), now),
        week: used_now(usage.and_then(|u| u.seven_day.as_ref()), now),
        model: (!scoped.is_empty())
            .then(|| scoped.iter().copied().fold(f64::NEG_INFINITY, f64::max)),
    }
}

/// How much of the fuller window is left, 0–100; `None` while no limit has been read.
fn remaining_percent(usage: Option<&AccountUsage>, family: Option<&str>, now: i64) -> Option<f64> {
    let used = used_for(usage, family, now);
    let fullest = [used.five, used.week, used.model]
        .into_iter()
        .flatten()
        .filter(|p| p.is_finite())
        .fold(None, |max: Option<f64>, p| {
            Some(max.map_or(p, |m| m.max(p)))
        })?;
    Some((100.0 - fullest).max(0.0))
}

/// Until when a read limit keeps the account out: a window at 100 % whose reset is ahead.
pub fn full_until(usage: Option<&AccountUsage>, now: i64, family: Option<&str>) -> i64 {
    let mut until = 0;
    let mut consider = |used: f64, resets_at: Option<&str>| {
        if used.is_nan() || used < 100.0 {
            return;
        }
        if let Some(reset) = resets_at.and_then(parse_date) {
            if reset > now {
                until = until.max(reset);
            }
        }
    };
    if let Some(u) = usage {
        for window in [u.five_hour.as_ref(), u.seven_day.as_ref()]
            .into_iter()
            .flatten()
        {
            consider(window.used_percent, window.resets_at.as_deref());
        }
    }
    for window in scoped_windows(usage, family) {
        consider(window.used_percent, window.resets_at.as_deref());
    }
    until
}

/// Past these, an account takes no new session while another has room.
pub const SOFT_STOP_FIVE_HOUR: f64 = 90.0;
pub const SOFT_STOP_WEEK: f64 = 98.0;

/// Whether an account read as ready is close enough to a limit to take no new session.
pub fn nearly_full(usage: Option<&AccountUsage>, family: Option<&str>, now: i64) -> bool {
    let Some(u) = usage else { return false };
    if u.status != UsageStatus::Ready {
        return false;
    }
    let used = used_for(usage, family, now);
    used.five.unwrap_or(0.0) >= SOFT_STOP_FIVE_HOUR
        || used.week.unwrap_or(0.0) >= SOFT_STOP_WEEK
        || used.model.unwrap_or(0.0) >= SOFT_STOP_WEEK
}

/// A busy session moves to an account whose week ends at least this much sooner than its own.
pub const REBALANCE_GAP_MS: i64 = 24 * HOUR_MS;
/// A session that moved stays at least this long before it moves again for a better order.
pub const MIN_STAY_MS: i64 = 20 * 60_000;
/// Only an account with at least this many Pro units of its week left is worth moving to.
pub const REBALANCE_MIN_ROOM: f64 = 5.0;
/// A running session leaves its account only past these.
pub const EJECT_FIVE_HOUR: f64 = 95.0;
pub const EJECT_WEEK: f64 = 99.0;
/// Across the pool, at most one session moves for a better order in this long.
pub const REBALANCE_SPACING_MS: i64 = 5 * 60_000;

/// One account as the router weighs it for one request.
struct Standing<'a> {
    account: &'a Account,
    usage: Option<&'a AccountUsage>,
    /// When its week ends; a week not started ends a full week from now.
    week_ends: i64,
    /// When its running 5-hour window ends; `None` (infinity) when none runs.
    five_ends: Option<i64>,
    /// Left of its fullest window in Pro units; `None` when never read.
    room_units: Option<f64>,
    draining: bool,
    ejecting: bool,
    spent: bool,
    five_low: bool,
    specialised: bool,
}

#[derive(Default)]
pub struct RouterOptions {
    pub strategy: Option<RoutingStrategy>,
    pub session_cache: Option<ProxySessionCache>,
    pub now: Option<Clock>,
}

pub struct ProxyRouter {
    session_cache: ProxySessionCache,
    strategy: RoutingStrategy,
    now: Clock,
    /// Cooldowns the gateway itself sets after a 429/401/403, by account id.
    cooldowns: HashMap<String, Cooldown>,
    /// Cooldowns of one model on one account (`<account>:<family>`).
    model_cooldowns: HashMap<String, i64>,
    /// When a session last moved for a better order, across the pool.
    last_rebalance_at: Option<i64>,
}

impl Default for ProxyRouter {
    fn default() -> Self {
        Self::new(RouterOptions::default())
    }
}

impl ProxyRouter {
    pub fn new(options: RouterOptions) -> Self {
        let now = options.now.unwrap_or_else(system_clock);
        ProxyRouter {
            // One clock for both: the cache times moves and lifetimes the router weighs.
            session_cache: options
                .session_cache
                .unwrap_or_else(|| ProxySessionCache::with_clock(now.clone())),
            strategy: options.strategy.unwrap_or_default(),
            now,
            cooldowns: HashMap::new(),
            model_cooldowns: HashMap::new(),
            last_rebalance_at: None,
        }
    }

    pub fn with_strategy(strategy: RoutingStrategy, now: Option<Clock>) -> Self {
        Self::new(RouterOptions {
            strategy: Some(strategy),
            now,
            session_cache: None,
        })
    }

    pub fn session_cache(&self) -> &ProxySessionCache {
        &self.session_cache
    }

    pub fn session_cache_mut(&mut self) -> &mut ProxySessionCache {
        &mut self.session_cache
    }

    pub fn strategy(&self) -> RoutingStrategy {
        self.strategy
    }

    pub fn set_strategy(&mut self, strategy: RoutingStrategy) {
        self.strategy = strategy;
    }

    /// Keeps an account out of selection for `ms`. The later end wins, with its reason; a
    /// limit is never shortened by a brief outage.
    pub fn mark_unavailable(&mut self, account_id: &str, ms: i64, reason: CooldownReason) {
        let now = (self.now)();
        let until = now + ms.max(0);
        let replace = match self.cooldowns.get(account_id) {
            None => true,
            Some(current) => current.until <= now || until >= current.until,
        };
        if replace {
            self.cooldowns
                .insert(account_id.to_string(), Cooldown { until, reason });
        }
    }

    /// Keeps one model off an account for `ms`: its own limit is spent.
    pub fn mark_model_unavailable(&mut self, account_id: &str, family: &str, ms: i64) {
        let key = format!("{account_id}:{family}");
        let until = (self.now)() + ms.max(0);
        if self.model_cooldowns.get(&key).copied().unwrap_or(0) < until {
            self.model_cooldowns.insert(key, until);
        }
    }

    /// The gateway's own cooldown of an account still running, with its reason.
    pub fn cooldown_of(&mut self, account_id: &str) -> Option<Cooldown> {
        let entry = *self.cooldowns.get(account_id)?;
        if entry.until <= (self.now)() {
            self.cooldowns.remove(account_id);
            return None;
        }
        Some(entry)
    }

    /// Until when one model is kept off an account by the gateway, when it is.
    pub fn model_cooldown_of(&mut self, account_id: &str, family: Option<&str>) -> Option<i64> {
        let key = format!("{account_id}:{}", family?);
        let until = *self.model_cooldowns.get(&key)?;
        if until <= (self.now)() {
            self.model_cooldowns.remove(&key);
            return None;
        }
        Some(until)
    }

    /// Lets the account be picked again at once (a usage dashboard cleared its cooldown).
    pub fn clear_cooldown(&mut self, account_id: &str) {
        self.cooldowns.remove(account_id);
        let prefix = format!("{account_id}:");
        self.model_cooldowns
            .retain(|key, _| !key.starts_with(&prefix));
    }

    /// Until when an account is out for this request, and why.
    fn block_of(
        &mut self,
        account: &Account,
        usage: Option<&AccountUsage>,
        now: i64,
        family: Option<&str>,
    ) -> Cooldown {
        let local = self.cooldown_of(&account.id);
        let stored = account.cooldown_until.as_deref().and_then(parse_date);
        let mut block = Cooldown {
            until: stored.unwrap_or(0),
            reason: CooldownReason::Limit,
        };
        if let Some(local) = local {
            if local.until > block.until {
                block = local;
            }
        }
        let model = self.model_cooldown_of(&account.id, family).unwrap_or(0);
        if model > block.until {
            block = Cooldown {
                until: model,
                reason: CooldownReason::Limit,
            };
        }
        let full = full_until(usage, now, family);
        if full > block.until {
            block = Cooldown {
                until: full,
                reason: CooldownReason::Limit,
            };
        }
        block
    }

    /// How the router sees one account for a request of `family`.
    fn standing<'a>(
        &self,
        account: &'a Account,
        usage: Option<&'a AccountUsage>,
        now: i64,
        family: Option<&str>,
    ) -> Standing<'a> {
        let at = |window: Option<&UsageWindow>| {
            window
                .and_then(|w| w.resets_at.as_deref())
                .and_then(parse_date)
                .filter(|ms| *ms > now)
        };
        let ready = usage.is_some_and(|u| u.status == UsageStatus::Ready);
        let used = used_for(usage, family, now);
        let (five, week, model) = (
            used.five.unwrap_or(0.0),
            used.week.unwrap_or(0.0),
            used.model.unwrap_or(0.0),
        );
        let spent = five >= 100.0 || week >= 100.0 || model >= 100.0;
        let capacity = plan_capacity(account);
        let room = if ready {
            remaining_percent(usage, family, now)
        } else {
            None
        };
        Standing {
            account,
            usage,
            week_ends: (if ready {
                at(usage.and_then(|u| u.seven_day.as_ref()))
            } else {
                None
            })
            .unwrap_or(now + WEEK_MS),
            five_ends: if ready {
                at(usage.and_then(|u| u.five_hour.as_ref()))
            } else {
                None
            },
            room_units: room.map(|r| room_units(r, capacity)),
            draining: nearly_full(usage, family, now) || (ready && spent),
            ejecting: ready
                && (spent || five >= EJECT_FIVE_HOUR || week >= EJECT_WEEK || model >= EJECT_WEEK),
            spent: ready && spent,
            five_low: ready && room_units(100.0 - five, capacity) <= LOW_ROOM_UNITS,
            specialised: ready
                && usage.is_some_and(|u| {
                    u.model_windows().iter().any(|w| {
                        w.model.as_deref().is_some_and(|m| !m.is_empty())
                            && w.model.as_deref() != family
                            && w.used_percent >= 100.0
                            && w.resets_at
                                .as_deref()
                                .filter(|r| !r.is_empty())
                                .is_none_or(|r| parse_date(r).is_some_and(|ms| ms > now))
                    })
                }),
        }
    }

    /// The order "soonest reset" means: the week ending first first; weeks within a band tie
    /// and the 5-hour window ending first decides; unknown room after known, nearly empty last.
    fn by_soonest_reset(a: &Standing, b: &Standing, earliest: i64) -> std::cmp::Ordering {
        let tier = |s: &Standing| match s.room_units {
            None => 2,
            Some(room) if room <= EMPTY_ROOM_UNITS => 3,
            Some(_) if s.five_low => 1,
            Some(_) => 0,
        };
        let five = |s: &Standing| s.five_ends.map_or(f64::INFINITY, |v| v as f64);
        tier(a)
            .cmp(&tier(b))
            .then_with(|| week_band(a.week_ends, earliest).cmp(&week_band(b.week_ends, earliest)))
            .then_with(|| b.specialised.cmp(&a.specialised))
            .then_with(|| cmp_f64(five(a), five(b)))
            .then_with(|| cmp_f64(b.room_units.unwrap_or(0.0), a.room_units.unwrap_or(0.0)))
    }

    /// The strategy's pick among `pool` (never empty), as an index into it.
    fn pick(&self, pool: &[&Standing], now: i64) -> usize {
        match self.strategy {
            RoutingStrategy::StrictPriority => pool
                .iter()
                // An account whose limits were never read counts as usable: it is tried.
                .position(|s| s.room_units.is_none_or(|room| room > EMPTY_ROOM_UNITS))
                .unwrap_or(0),
            RoutingStrategy::Balanced => {
                let candidates: Vec<(&Account, Option<&AccountUsage>)> =
                    pool.iter().map(|s| (s.account, s.usage)).collect();
                let ranked = rank_continuation_targets(
                    &candidates,
                    Some(RankingContext {
                        now,
                        ..Default::default()
                    }),
                );
                ranked
                    .first()
                    .and_then(|top| pool.iter().position(|s| s.account.id == top.account.id))
                    .unwrap_or(0)
            }
            RoutingStrategy::SoonestReset => {
                // Stable: equal accounts keep the pool's order.
                let earliest = pool.iter().map(|s| s.week_ends).min().unwrap_or(0);
                let mut order: Vec<usize> = (0..pool.len()).collect();
                order.sort_by(|&i, &j| Self::by_soonest_reset(pool[i], pool[j], earliest));
                order[0]
            }
        }
    }

    /// The pool a new pick chooses from: accounts with room first, then everything eligible.
    fn new_pick_pool<'s, 'a>(
        &self,
        eligible: &'s [Standing<'a>],
        avoid: Option<&str>,
    ) -> (Vec<&'s Standing<'a>>, Vec<String>) {
        let mut pool: Vec<&Standing> = eligible.iter().collect();
        let mut left_out = Vec::new();
        if self.strategy != RoutingStrategy::StrictPriority {
            let roomy: Vec<&Standing> = pool.iter().copied().filter(|s| !s.draining).collect();
            if !roomy.is_empty() {
                left_out = pool
                    .iter()
                    .filter(|s| s.draining)
                    .map(|s| s.account.id.clone())
                    .collect();
                pool = roomy;
            }
        }
        if let Some(avoid) = avoid {
            let others: Vec<&Standing> = pool
                .iter()
                .copied()
                .filter(|s| s.account.id != avoid)
                .collect();
            if !others.is_empty() {
                pool = others;
            }
        }
        (pool, left_out)
    }

    /// Whether a session healthy on its account should still leave it for `best`, and why.
    fn move_reason(
        &self,
        bound: &Standing,
        best: &Standing,
        context: &PickContext,
        moved_at: Option<i64>,
        now: i64,
    ) -> Option<ProxyMoveReason> {
        if best.account.id == bound.account.id {
            return None;
        }
        if context.cold {
            return Some(ProxyMoveReason::Cold);
        }
        if !context.turn_start {
            return None;
        }
        if bound.ejecting && !best.draining {
            return Some(ProxyMoveReason::Drain);
        }
        let spaced = self
            .last_rebalance_at
            .is_none_or(|last| now - last >= REBALANCE_SPACING_MS);
        if self.strategy == RoutingStrategy::SoonestReset
            && !best.draining
            && !best.five_low
            && best.room_units.unwrap_or(0.0) >= REBALANCE_MIN_ROOM
            && best.week_ends + REBALANCE_GAP_MS <= bound.week_ends
            && moved_at.is_none_or(|at| now - at >= MIN_STAY_MS)
            // One at a time across the pool: a herd of sessions moving together would fill the
            // target's 5-hour window at once and move straight back.
            && spaced
        {
            return Some(ProxyMoveReason::Rebalance);
        }
        None
    }

    /// Selects the account for one request: only the requested provider's accounts, minus
    /// those in `exclude` and those out for this request's model. A session keeps its account
    /// unless `move_reason` says it is worth leaving; otherwise the strategy picks.
    #[allow(clippy::too_many_arguments)]
    pub fn select_account(
        &mut self,
        session_key: Option<&str>,
        accounts: &[Account],
        usage_map: &UsageMap,
        target_provider: Option<Provider>,
        exclude: &HashSet<String>,
        avoid: Option<&str>,
        context: &PickContext,
    ) -> Result<RouterSelection, RouterError> {
        let now = (self.now)();
        let family = model_family(context.model.as_deref());
        let of_provider: Vec<&Account> = accounts
            .iter()
            .filter(|a| {
                !exclude.contains(&a.id) && target_provider.is_none_or(|p| a.provider() == p)
            })
            .collect();
        if of_provider.is_empty() {
            return Err(RouterError::NoProvider {
                provider: target_provider,
            });
        }

        let blocks: Vec<Cooldown> = of_provider
            .iter()
            .map(|acc| self.block_of(acc, usage_map.get(&acc.id), now, family))
            .collect();
        let eligible: Vec<Standing> = of_provider
            .iter()
            .zip(&blocks)
            .filter(|(_, block)| block.until <= now)
            .map(|(acc, _)| self.standing(acc, usage_map.get(&acc.id), now, family))
            .collect();
        if eligible.is_empty() {
            let soonest = blocks.iter().map(|b| b.until).min().unwrap_or(now);
            let seconds = ((soonest - now) as f64 / 1000.0).ceil().max(1.0) as u64;
            return Err(RouterError::NoEligible {
                retry_after_seconds: Some(seconds),
                sign_in_only: blocks.iter().all(|b| b.reason == CooldownReason::Auth),
            });
        }

        // The account the session is on, while a sign-in problem or an outage keeps it out:
        // the request is served elsewhere, but the session stays bound.
        let bound_id = session_key.and_then(|key| self.session_cache.peek(key));
        let bound_waits = match bound_id.as_deref() {
            Some(id) => self
                .cooldown_of(id)
                .is_some_and(|c| c.reason != CooldownReason::Limit),
            None => false,
        };
        let (pool, left_out) = self.new_pick_pool(&eligible, avoid);
        let best = pool[self.pick(&pool, now)];

        let mut moved = None;
        let mut keep_binding = false;
        if let (Some(key), Some(bound_id)) = (session_key, bound_id.as_deref()) {
            let bound = eligible.iter().find(|s| s.account.id == bound_id);
            match bound {
                Some(bound) if !(bound.spent && best.account.id != bound.account.id) => {
                    moved = self.move_reason(
                        bound,
                        best,
                        context,
                        self.session_cache.moved_at(key),
                        now,
                    );
                    if moved.is_none() {
                        self.session_cache.get(key);
                        return Ok(RouterSelection {
                            account: bound.account.clone(),
                            session_affinity_hit: true,
                            reason: ProxyPickReason::Bound,
                            nearly_full: None,
                            bound_waiting: None,
                            moved: None,
                            from: None,
                        });
                    }
                }
                _ if !bound_waits => {
                    // Its account is out for a limit: it moves on, unless only this model is
                    // out and the request is not the main conversation's.
                    if context.main == Some(false)
                        && self.only_this_model(&of_provider, usage_map, bound_id, family, now)
                    {
                        keep_binding = true;
                    } else {
                        moved = Some(ProxyMoveReason::Limit);
                    }
                }
                _ => {}
            }
        }

        if moved == Some(ProxyMoveReason::Rebalance) {
            self.last_rebalance_at = Some(now);
        }
        let best_account = best.account.clone();
        if let Some(key) = session_key {
            if !bound_waits && !keep_binding {
                self.session_cache.set(key, &best_account.id);
            }
        }

        let reason = if pool.len() == 1 {
            ProxyPickReason::Only
        } else {
            match self.strategy {
                RoutingStrategy::StrictPriority => ProxyPickReason::Priority,
                RoutingStrategy::SoonestReset => ProxyPickReason::SoonestReset,
                RoutingStrategy::Balanced => ProxyPickReason::Balanced,
            }
        };
        let moved_from = match (moved, bound_id.as_deref()) {
            (Some(reason), Some(from)) if from != best_account.id => {
                Some((reason, from.to_string()))
            }
            _ => None,
        };
        Ok(RouterSelection {
            session_affinity_hit: false,
            reason,
            nearly_full: (!left_out.is_empty()).then_some(left_out),
            bound_waiting: if bound_waits { bound_id.clone() } else { None },
            moved: moved_from.as_ref().map(|(r, _)| *r),
            from: moved_from.map(|(_, from)| from),
            account: best_account,
        })
    }

    /// Whether the session's account is out only for this request's model while it still
    /// serves the session's other models.
    fn only_this_model(
        &mut self,
        of_provider: &[&Account],
        usage_map: &UsageMap,
        id: &str,
        family: Option<&str>,
        now: i64,
    ) -> bool {
        let Some(acc) = of_provider.iter().find(|a| a.id == id) else {
            return false;
        };
        if family.is_none() {
            return false;
        }
        let usage = usage_map.get(id);
        let general_spent = self.standing(acc, usage, now, None).spent;
        self.block_of(acc, usage, now, None).until <= now && !general_spent
    }

    /// The account a new session of `provider` (and `model`) would get now; nothing is bound.
    pub fn preview(
        &mut self,
        accounts: &[Account],
        usage_map: &UsageMap,
        provider: Provider,
        model: Option<&str>,
    ) -> Option<RouterSelection> {
        let context = PickContext {
            model: model.map(str::to_string),
            ..Default::default()
        };
        self.select_account(
            None,
            accounts,
            usage_map,
            Some(provider),
            &HashSet::new(),
            None,
            &context,
        )
        .ok()
    }
}
