//! Port of `shared/usage.ts`: whether a reading is fresh, last known or exhausted, and the account
//! to suggest.

pub use super::quota_windows::{max_used_percent, quota_windows};

use super::account_state::displayed_issue;
use super::continuation_target_ranking::{
    ContinuationTargetCandidate, RankingContext, rank_continuation_targets, switch_at_percent,
};
use super::history_policy::allowed_history_pair;
use super::types::js::date_parse;
use super::types::{Account, AccountUsage, RelaySettings, UsageIssue, UsageStatus, UsageWindow};

fn reset_ahead(w: Option<&UsageWindow>, now: f64) -> bool {
    match w
        .and_then(|w| w.resets_at.as_deref())
        .filter(|r| !r.is_empty())
    {
        Some(reset) => date_parse(reset) > now,
        None => true,
    }
}

/// A ready reading under 35 minutes old whose windows have not reset since.
pub fn fresh_usage(u: Option<&AccountUsage>, now: f64) -> bool {
    let Some(u) = u else { return false };
    let Some(checked) = u.checked_at.as_deref().filter(|c| !c.is_empty()) else {
        return false;
    };
    u.status == UsageStatus::Ready
        && !u.stale
        && now - date_parse(checked) < 35.0 * 60_000.0
        && reset_ahead(u.five_hour.as_ref(), now)
        && reset_ahead(u.seven_day.as_ref(), now)
}

/// A reading that may still be shown as last known once `fresh_usage` no longer accepts it: read
/// (not in the future), with a window, and kept from being fresh only by its age or a passing
/// issue (rate limited, the service down).
pub fn last_known_usage(u: Option<&AccountUsage>, now: f64) -> bool {
    let checked = date_parse(u.and_then(|u| u.checked_at.as_deref()).unwrap_or(""));
    let Some(u) = u else { return false };
    if !checked.is_finite() || checked > now + 60_000.0 {
        return false;
    }
    if u.five_hour.is_none() && u.seven_day.is_none() {
        return false;
    }
    match displayed_issue(Some(u)) {
        None => true,
        Some(issue) => matches!(issue, UsageIssue::RateLimited | UsageIssue::Unavailable),
    }
}

/// A window of a last known reading that has not reset since: its percent can only have grown.
pub fn window_holds(w: Option<&UsageWindow>, now: f64) -> bool {
    w.is_some_and(|w| w.used_percent.is_finite()) && reset_ahead(w, now)
}

/// How old a reading may be to confirm that the active account is out of quota.
pub const SOURCE_FRESH_MS: f64 = 15.0 * 60_000.0;

/// The usage service confirms the source is out of quota (any window or a model limit).
pub fn source_exhausted(usage: Option<&AccountUsage>, now: f64) -> bool {
    let checked = date_parse(usage.and_then(|u| u.checked_at.as_deref()).unwrap_or(""));
    let Some(usage) = usage else { return false };
    if usage.status != UsageStatus::Ready
        || usage.stale
        || !checked.is_finite()
        || now - checked > SOURCE_FRESH_MS
    {
        return false;
    }
    usage.other_limit_reached == Some(true)
        || [usage.five_hour.as_ref(), usage.seven_day.as_ref()]
            .into_iter()
            .flatten()
            .any(|w| w.used_percent >= 100.0 && reset_ahead(Some(w), now))
}

/// The percent left in a window.
pub fn remaining(w: Option<&UsageWindow>) -> Option<f64> {
    w.map(|w| super::types::js::max([0.0, 100.0 - w.used_percent]))
}

/// The account to suggest once the active one passes its switch line (its own, else the warning
/// threshold), ranked like automatic switching (`rate`: the tempo, Pro units per hour). A target
/// past its own line is never suggested.
pub fn suggested_account<'a>(
    active: Option<&Account>,
    accounts: &'a [Account],
    usage: &'a super::types::js::JsMap<AccountUsage>,
    settings: &RelaySettings,
    now: f64,
    rate: Option<f64>,
) -> Option<&'a Account> {
    let active = active?;
    if !settings.suggest_accounts || !fresh_usage(usage.get(&active.id), now) {
        return None;
    }
    let current = usage.get(&active.id)?;
    let line = switch_at_percent(active, f64::from(settings.usage_warning_percent));
    if !settings.usage_warnings
        || ![current.five_hour.as_ref(), current.seven_day.as_ref()]
            .into_iter()
            .flatten()
            .any(|w| w.used_percent >= line)
    {
        return None;
    }
    let warning = f64::from(settings.usage_warning_percent);
    let eligible: Vec<ContinuationTargetCandidate<'a>> = accounts
        .iter()
        .filter(|a| {
            a.id != active.id
                && allowed_history_pair(active, a, settings)
                && a.desktop.is_some()
                && a.cooldown_until
                    .as_deref()
                    .filter(|c| !c.is_empty())
                    .is_none_or(|c| date_parse(c) <= now)
                && fresh_usage(usage.get(&a.id), now)
                && max_used_percent(usage.get(&a.id)).unwrap_or(100.0)
                    < switch_at_percent(a, warning)
        })
        .map(|a| ContinuationTargetCandidate {
            account: a,
            usage: usage.get(&a.id),
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
    .into_iter()
    .next()
    .map(|r| r.account)
}
