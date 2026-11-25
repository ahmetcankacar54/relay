//! The account orders the router shares with the rest of Relay: room in Pro units
//! (`shared/account-order.ts`), plan capacity (`shared/planning.ts` `planCapacity`), the
//! quota windows (`shared/quota-windows.ts`) and the continuation ranking the "balanced"
//! strategy uses (`shared/continuation-target-ranking.ts`).

use crate::js::parse_date;
use crate::types::{Account, AccountUsage, UsageStatus, UsageWindow};
use std::cmp::Ordering;

/// Room at or below this is low: one Pro window 80 % used.
pub const LOW_ROOM_UNITS: f64 = 20.0;
/// Room at or below this is as good as empty: one Pro window 95 % used.
pub const EMPTY_ROOM_UNITS: f64 = 5.0;
/// Accounts whose weeks end within this of each other count as ending together.
pub const DEADLINE_BAND_MS: i64 = 6 * 3_600_000;

/// Pro units left in a window that is `remaining_percent` empty on an account of `capacity`.
pub fn room_units(remaining_percent: f64, capacity: f64) -> f64 {
    remaining_percent * capacity
}

/// The deadline band of a week ending at `week_ends`, measured from the pool's earliest week.
pub fn week_band(week_ends: i64, earliest: i64) -> i64 {
    (week_ends - earliest).div_euclid(DEADLINE_BAND_MS)
}

/// An account's capacity in Pro windows: by its plan, else its weight (1–100).
pub fn plan_capacity(account: &Account) -> f64 {
    let planning = account.planning.as_ref();
    match planning.map(|p| p.plan.as_str()) {
        Some("pro") => 1.0,
        Some("max5") => 5.0,
        Some("max20") => 20.0,
        _ => {
            let weight = planning.and_then(|p| p.capacity_weight).unwrap_or(1.0);
            if weight.is_finite() {
                weight.clamp(1.0, 100.0)
            } else {
                1.0
            }
        }
    }
}

/// The quota windows the provider reported: the five-hour one required, the week when there.
pub fn quota_windows(usage: Option<&AccountUsage>) -> Option<Vec<&UsageWindow>> {
    let usage = usage?;
    let five = usage.five_hour.as_ref()?;
    Some(match usage.seven_day.as_ref() {
        Some(week) => vec![five, week],
        None => vec![five],
    })
}

/// How the accounts that hold enough are ordered.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum AutoSwitchStrategy {
    #[default]
    Best,
    WeeklyFirst,
    ConsumeFirst,
}

/// The used percent at which automatic switching leaves `account`: its own line (50–100),
/// else `fallback`.
pub fn switch_at_percent(account: &Account, fallback: f64) -> f64 {
    match account.switch_at_percent {
        Some(own) if own.fract() == 0.0 && (50.0..=100.0).contains(&own) => own,
        _ => fallback,
    }
}

#[derive(Clone, Debug)]
pub struct RankedTarget<'a> {
    pub account: &'a Account,
    pub usage: Option<&'a AccountUsage>,
    pub score: f64,
    pub remaining_percent: f64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct RankingContext {
    pub now: i64,
    /// Pro units per hour now.
    pub rate: Option<f64>,
    pub strategy: Option<AutoSwitchStrategy>,
}

const MIN_LEFT_PERCENT: f64 = 10.0;
const MIN_TEMPO_HOURS: f64 = 0.5;

fn remaining_quota_percent(account: &Account, usage: Option<&AccountUsage>) -> f64 {
    let Some(u) = usage else { return 0.0 };
    if u.account_id != account.id || u.status != UsageStatus::Ready || u.stale {
        return 0.0;
    }
    let Some(windows) = quota_windows(usage) else {
        return 0.0;
    };
    if windows
        .iter()
        .any(|w| !w.used_percent.is_finite() || w.used_percent < 0.0 || w.used_percent > 100.0)
    {
        return 0.0;
    }
    windows
        .iter()
        .map(|w| 100.0 - w.used_percent)
        .fold(f64::INFINITY, f64::min)
}

/// `a - b` as a comparator result: two infinities of one sign tie, as JavaScript's `NaN` does,
/// and the order stays total (Rust's sort requires it).
pub(crate) fn cmp_f64(a: f64, b: f64) -> Ordering {
    a.partial_cmp(&b).unwrap_or(Ordering::Equal)
}

fn by_score(left: &RankedTarget, right: &RankedTarget) -> Ordering {
    cmp_f64(right.score, left.score)
        .then_with(|| cmp_f64(right.remaining_percent, left.remaining_percent))
        .then_with(|| left.account.id.cmp(&right.account.id))
}

/// The open five-hour window's reset, when its quota is lost then; `INFINITY` otherwise.
fn open_reset(usage: Option<&AccountUsage>, now: i64) -> f64 {
    if let Some(windows) = quota_windows(usage) {
        if windows.len() > 1 && windows[1].used_percent > windows[0].used_percent {
            return f64::INFINITY;
        }
    }
    reset_ahead(
        usage.and_then(|u| u.five_hour.as_ref()?.resets_at.as_deref()),
        now,
    )
}

fn reset_ahead(at: Option<&str>, now: i64) -> f64 {
    match at.and_then(parse_date) {
        Some(ms) if ms > now => ms as f64,
        _ => f64::INFINITY,
    }
}

fn weekly_reset(usage: Option<&AccountUsage>, now: i64) -> f64 {
    reset_ahead(
        usage.and_then(|u| u.seven_day.as_ref()?.resets_at.as_deref()),
        now,
    )
}

fn strategy_order(
    strategy: AutoSwitchStrategy,
    left: &RankedTarget,
    right: &RankedTarget,
    now: i64,
) -> Ordering {
    match strategy {
        // Two closed windows (both Infinity) tie and fall through to the next key.
        AutoSwitchStrategy::Best => {
            cmp_f64(open_reset(left.usage, now), open_reset(right.usage, now))
                .then_with(|| by_score(left, right))
        }
        AutoSwitchStrategy::WeeklyFirst => {
            cmp_f64(weekly_reset(left.usage, now), weekly_reset(right.usage, now))
                .then_with(|| by_score(left, right))
        }
        AutoSwitchStrategy::ConsumeFirst => cmp_f64(left.remaining_percent, right.remaining_percent)
            .then_with(|| cmp_f64(left.score, right.score))
            .then_with(|| by_score(left, right)),
    }
}

fn past_own_line(r: &RankedTarget) -> bool {
    r.account.switch_at_percent.is_some()
        && 100.0 - r.remaining_percent >= switch_at_percent(r.account, 100.0)
}

/// Ranks candidates without changing the caller's list: with a context, accounts with enough
/// for half an hour (else 10 % left) first in the strategy's order, then the rest by score; an
/// account past its own switch line last.
pub fn rank_continuation_targets<'a>(
    candidates: &[(&'a Account, Option<&'a AccountUsage>)],
    context: Option<RankingContext>,
) -> Vec<RankedTarget<'a>> {
    let all: Vec<RankedTarget<'a>> = candidates
        .iter()
        .map(|&(account, usage)| {
            let remaining_percent = remaining_quota_percent(account, usage);
            RankedTarget {
                account,
                usage,
                remaining_percent,
                score: plan_capacity(account) * remaining_percent / 100.0,
            }
        })
        .collect();
    let (mut past, mut ranked): (Vec<_>, Vec<_>) = all.into_iter().partition(past_own_line);
    past.sort_by(by_score);
    let Some(context) = context else {
        ranked.sort_by(by_score);
        ranked.extend(past);
        return ranked;
    };
    let enough = |r: &RankedTarget| {
        r.remaining_percent > 0.0
            && match context.rate {
                Some(rate) if rate > 0.0 => r.score * 100.0 >= rate * MIN_TEMPO_HOURS,
                _ => r.remaining_percent >= MIN_LEFT_PERCENT,
            }
    };
    let (mut passing, mut rest): (Vec<_>, Vec<_>) = ranked.into_iter().partition(|r| enough(r));
    if passing.is_empty() {
        rest.sort_by(by_score);
        rest.extend(past);
        return rest;
    }
    let strategy = context.strategy.unwrap_or_default();
    passing.sort_by(|a, b| strategy_order(strategy, a, b, context.now));
    rest.sort_by(by_score);
    passing.extend(rest);
    passing.extend(past);
    passing
}
