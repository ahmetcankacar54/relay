//! Port of `shared/mascot.ts`: the menu bar panda's pose for a tray snapshot.

use std::borrow::Cow;

use serde::{Deserialize, Serialize};

use super::account_state::{desktop_cli_mismatch, displayed_issue};
use super::percent::percent_used;
use super::types::js::{JsMap, date_parse};
use super::types::{
    Account, AccountUsage, DesktopState, UsageIssue, UsageStatus, WindowAttempt,
    WindowAttemptStatus, literal_enum,
};
use super::usage::{fresh_usage, max_used_percent};

literal_enum!(MascotPose {
    Alert = "alert",
    Away = "away",
    Warming = "warming",
    Sleeping = "sleeping",
    Full = "full",
    Hungry = "hungry",
    Idle = "idle",
});
literal_enum!(MascotHead { Idle = "idle", Hungry = "hungry", Sleep = "sleep", Alert = "alert" });
literal_enum!(
    /// Why the panda sleeps (`mascotRest`).
    MascotRest { Closed = "closed", Unknown = "unknown" }
);

/// The parts of the tray snapshot the panda reads (`TraySnapshot` lends them, `From<&TraySnapshot>`).
#[derive(Debug, Clone, Copy)]
pub struct MascotInput<'a> {
    pub accounts: &'a [Account],
    pub usage: &'a JsMap<AccountUsage>,
    pub desktop: Option<&'a DesktopState>,
    /// The keeper's recent window starts.
    pub attempts: Option<&'a [WindowAttempt]>,
}

/// A "started" attempt older than this was interrupted, not warming.
pub const WARMING_MS: f64 = 2.0 * 60_000.0;
/// The percent used from which the menu bar title also counts down to the five-hour reset.
pub const HUNGRY_PERCENT: f64 = 80.0;
/// A reading of the active account older than this no longer counts: the panda sleeps and the
/// title shows "—".
pub const READING_MAX_AGE_MS: f64 = 30.0 * 60_000.0;
const SIGN_IN_ISSUES: [UsageIssue; 4] = [
    UsageIssue::KeychainLocked,
    UsageIssue::RenewalRequired,
    UsageIssue::Expired,
    UsageIssue::IdentityMismatch,
];

/// The Desktop-active profile id, when set (an empty one is none, as in the TS).
fn active_id<'a>(input: &MascotInput<'a>) -> Option<&'a str> {
    input
        .desktop
        .and_then(|d| d.active_profile_id.as_deref())
        .filter(|id| !id.is_empty())
}

/// The Desktop-active account's reading while it still counts: fresh and under
/// READING_MAX_AGE_MS old. A refresh in progress keeps the reading it started from, so the menu
/// bar does not flicker while it runs.
pub fn active_reading<'a>(input: MascotInput<'a>, now: f64) -> Option<Cow<'a, AccountUsage>> {
    let u = input.usage.get(active_id(&input)?)?;
    let reading = if u.status == UsageStatus::Loading {
        Cow::Owned(AccountUsage {
            status: UsageStatus::Ready,
            ..u.clone()
        })
    } else {
        Cow::Borrowed(u)
    };
    if !fresh_usage(Some(&reading), now) {
        return None;
    }
    let age = now - date_parse(reading.checked_at.as_deref().unwrap_or(""));
    (-60_000.0..READING_MAX_AGE_MS)
        .contains(&age)
        .then_some(reading)
}

/// Why the menu bar panda sleeps, if it does: Claude is closed, or the active account's limits are
/// not known (its reading failed or is too old). Before the first reading has finished, with no
/// saved account active, and between a window's reset and the reading after it, it does not.
pub fn mascot_rest(input: MascotInput<'_>, now: f64) -> Option<MascotRest> {
    let desktop = input.desktop?;
    if !desktop.running {
        return Some(MascotRest::Closed);
    }
    let u = input.usage.get(active_id(&input)?)?;
    let checked = u.checked_at.as_deref().filter(|c| !c.is_empty());
    if checked.is_none() && matches!(u.status, UsageStatus::Idle | UsageStatus::Loading) {
        return None;
    }
    if active_reading(input, now).is_some() {
        return None;
    }
    let age = now - date_parse(checked.unwrap_or(""));
    // `!(age < max)`: an unreadable time counts as too old.
    (u.status == UsageStatus::Error || u.stale || age.is_nan() || age >= READING_MAX_AGE_MS)
        .then_some(MascotRest::Unknown)
}

/// The percent used of the active reading's five-hour window, as shown.
fn active_used(input: MascotInput<'_>, now: f64) -> Option<f64> {
    percent_used(
        active_reading(input, now)
            .as_deref()
            .and_then(|r| r.five_hour.as_ref())
            .map(|w| w.used_percent),
    )
}

/// The active account's five-hour window is used up.
pub fn active_full(input: MascotInput<'_>, now: f64) -> bool {
    active_used(input, now) == Some(100.0)
}

/// The pose for one snapshot; the first matching rule wins.
pub fn mascot_pose(input: MascotInput<'_>, now: f64) -> MascotPose {
    let desktop = input.desktop;
    let active_id = active_id(&input);
    let active = active_id.and_then(|id| input.usage.get(id));
    // The issue every surface shows: a flag left under a rate-limit or an outage is no sign-in problem.
    let issue = displayed_issue(active);
    if desktop.is_some_and(|d| {
        d.recovery_required || d.error.as_deref().is_some_and(|e| !e.is_empty()) || !d.available
    }) {
        return MascotPose::Alert;
    }
    if issue.is_some_and(|i| SIGN_IN_ISSUES.contains(&i)) {
        return MascotPose::Alert;
    }
    // A usage sign-in of another account is a sign-in problem, whatever its last read says.
    let active_account = active_id.and_then(|id| input.accounts.iter().find(|a| a.id == id));
    if active_account.is_some_and(desktop_cli_mismatch) {
        return MascotPose::Alert;
    }
    if desktop.is_some_and(|d| d.busy) {
        return MascotPose::Away;
    }
    if input.attempts.unwrap_or_default().iter().any(|a| {
        let at = date_parse(&a.at);
        a.status == WindowAttemptStatus::Started && at <= now && now - at < WARMING_MS
    }) {
        return MascotPose::Warming;
    }
    if mascot_rest(input, now).is_some() {
        return MascotPose::Sleeping;
    }
    // The active account's five-hour window is used up, or every account is known to be full.
    if active_full(input, now)
        || (!input.accounts.is_empty()
            && input.accounts.iter().all(|a| {
                let u = input.usage.get(&a.id);
                fresh_usage(u, now) && max_used_percent(u).unwrap_or(0.0) >= 100.0
            }))
    {
        return MascotPose::Full;
    }
    if active_used(input, now).is_some_and(|used| used >= HUNGRY_PERCENT) {
        return MascotPose::Hungry;
    }
    MascotPose::Idle
}

/// The panel header head. Leaving and warming show the normal head; a full window the wide eyes.
pub const fn head_for(pose: MascotPose) -> MascotHead {
    match pose {
        MascotPose::Alert => MascotHead::Alert,
        MascotPose::Sleeping => MascotHead::Sleep,
        MascotPose::Hungry | MascotPose::Full => MascotHead::Hungry,
        MascotPose::Away | MascotPose::Warming | MascotPose::Idle => MascotHead::Idle,
    }
}
