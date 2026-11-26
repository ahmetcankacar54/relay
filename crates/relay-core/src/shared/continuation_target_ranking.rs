//! Port of `shared/continuation-target-ranking.ts`: how automatic switching, the suggestion and
//! the panel rank the accounts to switch to.

use super::planning::plan_capacity;
use super::quota_windows::quota_windows;
use super::types::js::{compare_str, date_parse, min, sort_by};
use super::types::{Account, AccountUsage, AutoSwitchStrategy, UsageStatus};

/// Every strategy, in the order Settings → Switching offers them; "best" is the default.
pub const AUTO_SWITCH_STRATEGIES: [AutoSwitchStrategy; 3] = [
    AutoSwitchStrategy::Best,
    AutoSwitchStrategy::WeeklyFirst,
    AutoSwitchStrategy::ConsumeFirst,
];

/// The used percent at which automatic switching leaves `account`: its own line when one is saved
/// (a whole 50–100), else `fallback`.
pub fn switch_at_percent(account: &Account, fallback: f64) -> f64 {
    match account.switch_at_percent {
        Some(own) if own.fract() == 0.0 && (50.0..=100.0).contains(&own) => own,
        _ => fallback,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ContinuationTargetCandidate<'a> {
    pub account: &'a Account,
    pub usage: Option<&'a AccountUsage>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RankedContinuationTarget<'a> {
    pub account: &'a Account,
    pub usage: Option<&'a AccountUsage>,
    /// Relative plan capacity weighted by the smaller remaining quota window.
    pub score: f64,
    pub remaining_percent: f64,
}

fn remaining_quota_percent(account: &Account, usage: Option<&AccountUsage>) -> f64 {
    let Some(u) = usage else { return 0.0 };
    if u.account_id != account.id || u.status != UsageStatus::Ready || u.stale {
        return 0.0;
    }
    let Some(windows) = quota_windows(Some(u)) else {
        return 0.0;
    };
    if windows
        .iter()
        .any(|w| !w.used_percent.is_finite() || w.used_percent < 0.0 || w.used_percent > 100.0)
    {
        return 0.0;
    }
    min(windows.iter().map(|w| 100.0 - w.used_percent))
}

/// A relative capacity heuristic, not an estimate of tokens, cost, or runtime.
pub fn continuation_target_score(account: &Account, usage: Option<&AccountUsage>) -> f64 {
    (plan_capacity(account) * remaining_quota_percent(account, usage)) / 100.0
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RankingContext {
    pub now: f64,
    /// Pro units per hour now.
    pub rate: Option<f64>,
    /// Missing means "best".
    pub strategy: Option<AutoSwitchStrategy>,
}

const MIN_LEFT_PERCENT: f64 = 10.0;
const MIN_TEMPO_HOURS: f64 = 0.5;

/// `a || b` on comparator results: `0` and `NaN` fall through.
fn or(a: f64, b: impl FnOnce() -> f64) -> f64 {
    if a != 0.0 && !a.is_nan() { a } else { b() }
}

fn by_score(left: &RankedContinuationTarget<'_>, right: &RankedContinuationTarget<'_>) -> f64 {
    or(right.score - left.score, || {
        or(right.remaining_percent - left.remaining_percent, || {
            compare_str(&left.account.id, &right.account.id)
        })
    })
}

fn finite_after(reset: f64, now: f64) -> f64 {
    if reset.is_finite() && reset > now {
        reset
    } else {
        f64::INFINITY
    }
}

/// The open five-hour window's reset; a weekly window with less left binds instead (Infinity).
fn open_reset(usage: Option<&AccountUsage>, now: f64) -> f64 {
    if let Some(windows) = quota_windows(usage)
        && let [five, weekly] = windows[..]
        && weekly.used_percent > five.used_percent
    {
        return f64::INFINITY;
    }
    finite_after(
        date_parse(
            usage
                .and_then(|u| u.five_hour.as_ref())
                .and_then(|w| w.resets_at.as_deref())
                .unwrap_or(""),
        ),
        now,
    )
}

/// The weekly period's reset, when known and ahead.
fn weekly_reset(usage: Option<&AccountUsage>, now: f64) -> f64 {
    finite_after(
        date_parse(
            usage
                .and_then(|u| u.seven_day.as_ref())
                .and_then(|w| w.resets_at.as_deref())
                .unwrap_or(""),
        ),
        now,
    )
}

fn strategy_order(
    strategy: AutoSwitchStrategy,
    left: &RankedContinuationTarget<'_>,
    right: &RankedContinuationTarget<'_>,
    now: f64,
) -> f64 {
    match strategy {
        AutoSwitchStrategy::Best => or(
            open_reset(left.usage, now) - open_reset(right.usage, now),
            || by_score(left, right),
        ),
        AutoSwitchStrategy::WeeklyFirst => or(
            weekly_reset(left.usage, now) - weekly_reset(right.usage, now),
            || by_score(left, right),
        ),
        // The most used first; the smaller capacity first among equals, so it drains.
        AutoSwitchStrategy::ConsumeFirst => {
            or(left.remaining_percent - right.remaining_percent, || {
                or(left.score - right.score, || by_score(left, right))
            })
        }
    }
}

/// An account past its own switch line: automatic switching would leave it again at once.
fn past_own_line(r: &RankedContinuationTarget<'_>) -> bool {
    r.account.switch_at_percent.is_some()
        && 100.0 - r.remaining_percent >= switch_at_percent(r.account, 100.0)
}

/// Rank policy-eligible candidates. With a context: accounts with enough quota for half an hour
/// at the current tempo (else 10% left) first, in the strategy's order, then the rest. Without
/// one, or when nobody has enough: plan capacity × remaining quota. An account past its own switch
/// line comes last in every order.
pub fn rank_continuation_targets<'a>(
    candidates: &[ContinuationTargetCandidate<'a>],
    context: Option<RankingContext>,
) -> Vec<RankedContinuationTarget<'a>> {
    let all: Vec<RankedContinuationTarget<'a>> = candidates
        .iter()
        .map(|c| {
            let remaining_percent = remaining_quota_percent(c.account, c.usage);
            RankedContinuationTarget {
                account: c.account,
                usage: c.usage,
                remaining_percent,
                score: (plan_capacity(c.account) * remaining_percent) / 100.0,
            }
        })
        .collect();
    let mut past: Vec<_> = all.iter().filter(|r| past_own_line(r)).cloned().collect();
    sort_by(&mut past, by_score);
    let mut ranked: Vec<_> = all.iter().filter(|r| !past_own_line(r)).cloned().collect();
    let Some(context) = context else {
        sort_by(&mut ranked, by_score);
        ranked.extend(past);
        return ranked;
    };
    let rate = context.rate;
    // `score` is in Pro windows, so `score × 100` is Pro units.
    let enough = |r: &RankedContinuationTarget<'_>| {
        r.remaining_percent > 0.0
            && match rate {
                Some(rate) if rate > 0.0 => r.score * 100.0 >= rate * MIN_TEMPO_HOURS,
                _ => r.remaining_percent >= MIN_LEFT_PERCENT,
            }
    };
    let passing_index: Vec<usize> = (0..ranked.len()).filter(|i| enough(&ranked[*i])).collect();
    if passing_index.is_empty() {
        sort_by(&mut ranked, by_score);
        ranked.extend(past);
        return ranked;
    }
    let strategy = context.strategy.unwrap_or(AutoSwitchStrategy::Best);
    let mut passing: Vec<_> = passing_index.iter().map(|i| ranked[*i].clone()).collect();
    sort_by(&mut passing, |l, r| {
        strategy_order(strategy, l, r, context.now)
    });
    let mut rest: Vec<_> = (0..ranked.len())
        .filter(|i| !passing_index.contains(i))
        .map(|i| ranked[i].clone())
        .collect();
    sort_by(&mut rest, by_score);
    passing.extend(rest);
    passing.extend(past);
    passing
}
