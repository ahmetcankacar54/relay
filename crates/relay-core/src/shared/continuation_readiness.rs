//! Port of `shared/continuation-readiness.ts`.

use serde::{Deserialize, Serialize};

use super::continuation_target_ranking::switch_at_percent;
use super::history_policy::allowed_history_pair;
use super::quota_windows::quota_windows;
use super::types::js::date_parse;
use super::types::{
    Account, AccountUsage, DesktopHistoryTransfer, RelaySettings, UsageStatus, UsageWindow,
    literal_enum,
};

literal_enum!(ContinuationTargetReadinessReason {
    SourceNotEnrolled = "source-not-enrolled",
    IdentityNotEnrolled = "identity-not-enrolled",
    DuplicateIdentity = "duplicate-identity",
    HistoryBoundary = "history-boundary",
    QuotaNotFresh = "quota-not-fresh",
    FiveHourUnavailable = "five-hour-unavailable",
    QuotaWindowInvalid = "quota-window-invalid",
    TargetQuotaUnavailable = "target-quota-unavailable",
    TargetCooldown = "target-cooldown",
});

/// `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`
fn uuid(text: &str) -> bool {
    let parts: Vec<&str> = text.split('-').collect();
    parts.len() == 5
        && parts
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(p, n)| p.len() == n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// `/^[A-Za-z0-9._:-]{1,128}$/`
fn history_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}

fn enrolled(account: Option<&Account>) -> bool {
    let Some(account) = account else { return false };
    let (Some(desktop), Some(auth)) = (&account.desktop, &account.auth) else {
        return false;
    };
    uuid(&account.id)
        && uuid(&desktop.account_uuid)
        && uuid(&desktop.org_id)
        && auth.logged_in
        && auth.account_uuid.as_deref().map(str::to_lowercase)
            == Some(desktop.account_uuid.to_lowercase())
        && auth.org_id.as_deref().map(str::to_lowercase) == Some(desktop.org_id.to_lowercase())
}

fn valid_window(window: &UsageWindow, now: f64) -> bool {
    let used = window.used_percent;
    used.is_finite()
        && (0.0..=100.0).contains(&used)
        && ((used == 0.0 && window.resets_at.is_none())
            || window
                .resets_at
                .as_deref()
                .map(date_parse)
                .is_some_and(|at| at.is_finite() && at > now))
}

/// Read-only preparation information for a currently enrolled target. Matches the target gates in
/// `continuation_policy_reason`; it is not handoff authority. The manager additionally verifies
/// the source's exhausted quota, exact stopped turn, frozen enrollment, permission mode and
/// quiescence at execution time.
pub fn continuation_target_readiness_reason(
    source: Option<&Account>,
    target: &Account,
    usage: Option<&AccountUsage>,
    settings: &RelaySettings,
    now: f64,
) -> Option<ContinuationTargetReadinessReason> {
    use ContinuationTargetReadinessReason as R;
    if !enrolled(source) {
        return Some(R::SourceNotEnrolled);
    }
    let source = source?;
    if !enrolled(Some(target)) {
        return Some(R::IdentityNotEnrolled);
    }
    let (Some(sd), Some(td)) = (&source.desktop, &target.desktop) else {
        return Some(R::IdentityNotEnrolled);
    };
    if source.id == target.id
        || (sd.account_uuid.to_lowercase() == td.account_uuid.to_lowercase()
            && sd.org_id.to_lowercase() == td.org_id.to_lowercase())
    {
        return Some(R::DuplicateIdentity);
    }
    if settings.desktop_history_transfer == DesktopHistoryTransfer::Off
        || !settings
            .desktop_history_accounts
            .iter()
            .all(|id| history_id(id))
        || !allowed_history_pair(source, target, settings)
    {
        return Some(R::HistoryBoundary);
    }
    let checked_at = date_parse(usage.and_then(|u| u.checked_at.as_deref()).unwrap_or(""));
    let Some(usage) = usage.filter(|u| {
        u.account_id == target.id
            && u.status == UsageStatus::Ready
            && !u.stale
            && u.issue.is_none()
            && checked_at.is_finite()
            && checked_at <= now
            && now - checked_at <= 300_000.0
    }) else {
        return Some(R::QuotaNotFresh);
    };
    let Some(windows) = quota_windows(Some(usage)) else {
        return Some(R::FiveHourUnavailable);
    };
    if !windows.iter().all(|w| valid_window(w, now)) {
        return Some(R::QuotaWindowInvalid);
    }
    let line = switch_at_percent(target, 90.0);
    if windows.iter().any(|w| w.used_percent >= line) {
        return Some(R::TargetQuotaUnavailable);
    }
    if let Some(cooldown) = target.cooldown_until.as_deref().filter(|c| !c.is_empty()) {
        let until = date_parse(cooldown);
        if !until.is_finite() || until > now {
            return Some(R::TargetCooldown);
        }
    }
    None
}
