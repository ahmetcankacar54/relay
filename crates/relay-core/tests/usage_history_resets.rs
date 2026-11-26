//! Port of tests/usage-history-resets.test.ts (`UsageHistory::last_known_resets`).

#[path = "common/p4services_usage_history.rs"]
mod helpers;

use helpers::*;
use relay_core::shared::types::{
    Account, AccountUsage, KnownReset, LastKnownResets, UsageStatus, UsageWindow,
};
use serde_json::json;
use std::fs;

const FIVE_HOUR_RESET: &str = "2026-10-13T13:00:00.000Z";
const WEEKLY_RESET: &str = "2026-10-19T08:00:00.000Z";

fn start() -> f64 {
    ms("2026-10-13T08:00:00.000Z")
}
fn fixture() -> Account {
    account("profile-a", "olive", start())
}
fn usage(checked_at: f64) -> AccountUsage {
    usage_of(
        "profile-a",
        checked_at,
        json!({ "usedPercent": 100, "resetsAt": FIVE_HOUR_RESET }),
        json!({ "usedPercent": 40, "resetsAt": WEEKLY_RESET }),
    )
}
fn known(resets_at: &str, checked_at: &str) -> Option<KnownReset> {
    Some(KnownReset {
        resets_at: resets_at.into(),
        checked_at: checked_at.into(),
    })
}

#[test]
fn an_exhausted_account_s_reset_dates_survive_cache_invalidation_and_relay_restart_without_resurrecting_quota()
 {
    let dir = directory("relay-last-resets-");
    let mut history = open_at(&dir.root, start() + MINUTE);
    let current = usage(start());
    history.record(&fixture(), &current);
    let mut invalidated = AccountUsage::new("profile-a", UsageStatus::Idle);
    let restored = open_at(&dir.root, start() + MINUTE);
    invalidated.last_known_resets = restored.last_known_resets(&fixture());
    let checked = current.checked_at.clone().unwrap();
    assert_eq!(
        invalidated.last_known_resets,
        Some(LastKnownResets {
            five_hour: known(FIVE_HOUR_RESET, &checked),
            seven_day: known(WEEKLY_RESET, &checked),
        })
    );
    assert_eq!(invalidated.five_hour, None);
    assert_eq!(invalidated.seven_day, None);
    assert_eq!(invalidated.checked_at, None);
    assert_eq!(invalidated.status, UsageStatus::Idle);
    assert!(!invalidated.stale);
    assert_eq!(lines(restored.file()).len(), 1);
}

#[test]
fn newer_missing_reset_dates_retain_each_window_s_own_last_verified_reset() {
    let dir = directory("relay-last-resets-");
    let mut history = open_at(&dir.root, start() + 10.0 * MINUTE);
    history.record(&fixture(), &usage(start()));
    let mut weekly_only = usage(start() + MINUTE);
    weekly_only.five_hour = Some(UsageWindow::new(0.0, None));
    weekly_only.seven_day.as_mut().unwrap().resets_at = Some("2026-10-20T08:00:00.000Z".into());
    history.record(&fixture(), &weekly_only);
    let mut missing_resets = usage(start() + 2.0 * MINUTE);
    missing_resets.five_hour = Some(UsageWindow::new(0.0, None));
    missing_resets.seven_day = Some(UsageWindow::new(0.0, None));
    history.record(&fixture(), &missing_resets);
    assert_eq!(
        history.last_known_resets(&fixture()),
        Some(LastKnownResets {
            five_hour: known(FIVE_HOUR_RESET, &at(start())),
            seven_day: known(
                "2026-10-20T08:00:00.000Z",
                weekly_only.checked_at.as_deref().unwrap()
            ),
        })
    );
}

#[test]
fn another_login_or_organization_cannot_inherit_a_slot_s_former_reset_dates() {
    let dir = directory("relay-last-resets-");
    let mut history = open_at(&dir.root, start() + MINUTE);
    history.record(&fixture(), &usage(start()));
    for patch in [
        json!({ "accountUuid": "other-account" }),
        json!({ "orgId": "other-organization" }),
        json!({ "loggedIn": false }),
        json!({ "accountUuid": null, "orgId": null, "email": null }),
    ] {
        let changed = with_auth(&fixture(), patch);
        assert_eq!(history.last_known_resets(&changed), None);
    }
    let mut different = fixture();
    different.id = "different-profile".into();
    assert_eq!(history.last_known_resets(&different), None);
    assert_eq!(
        history.last_known_resets(&with_auth(
            &fixture(),
            json!({ "email": "renamed@example.test" })
        )),
        history.last_known_resets(&fixture())
    );
}

#[test]
fn stale_and_failed_polls_do_not_replace_persisted_verified_reset_dates() {
    let dir = directory("relay-last-resets-");
    let mut history = open_at(&dir.root, start() + 10.0 * MINUTE);
    history.record(&fixture(), &usage(start()));
    for patch in [
        json!({ "stale": true }),
        json!({ "status": "error", "issue": "identity-mismatch" }),
        json!({ "accountId": "different-profile" }),
    ] {
        let mut unverified = patched(&usage(start() + MINUTE), patch);
        unverified.five_hour.as_mut().unwrap().resets_at = Some("2026-10-13T14:00:00.000Z".into());
        history.record(&fixture(), &unverified);
    }
    assert_eq!(
        history
            .last_known_resets(&fixture())
            .and_then(|r| r.five_hour)
            .map(|r| r.resets_at)
            .as_deref(),
        Some(FIVE_HOUR_RESET)
    );
}

#[test]
fn expired_retention_and_unavailable_ledgers_cannot_supply_reset_metadata() {
    let dir = directory("relay-last-resets-");
    let clock = Clock::new(start());
    let mut history = clock.open(&dir.root);
    history.record(&fixture(), &usage(start()));
    clock.add(14.0 * 86_400_000.0 + 1.0);
    assert_eq!(history.last_known_resets(&fixture()), None);
    assert_eq!(clock.open(&dir.root).last_known_resets(&fixture()), None);
    fs::write(history.file(), "broken history").unwrap();
    assert_eq!(
        open_at(&dir.root, start()).last_known_resets(&fixture()),
        None
    );
}

#[test]
fn past_reset_metadata_stays_available_as_history_and_returned_objects_cannot_mutate_the_ledger() {
    let dir = directory("relay-last-resets-");
    let mut history = open_at(&dir.root, start() + 6.0 * 60.0 * MINUTE);
    history.record(&fixture(), &usage(start()));
    let mut dates = history.last_known_resets(&fixture()).unwrap();
    assert_eq!(
        dates.five_hour.as_ref().map(|r| r.resets_at.as_str()),
        Some(FIVE_HOUR_RESET)
    );
    dates.five_hour.as_mut().unwrap().resets_at = "2099-01-01T00:00:00.000Z".into();
    assert_eq!(
        history
            .last_known_resets(&fixture())
            .and_then(|r| r.five_hour)
            .map(|r| r.resets_at)
            .as_deref(),
        Some(FIVE_HOUR_RESET)
    );
}

#[test]
fn samples_stamped_after_the_current_time_do_not_supply_reset_metadata() {
    let dir = directory("relay-last-resets-");
    let clock = Clock::new(start() + MINUTE);
    let mut history = clock.open(&dir.root);
    history.record(&fixture(), &usage(start()));
    // The clock moves back before the recorded check.
    clock.set(start() - MINUTE);
    assert_eq!(history.last_known_resets(&fixture()), None);
    clock.set(start() + MINUTE);
    assert_eq!(
        history
            .last_known_resets(&fixture())
            .and_then(|r| r.five_hour)
            .map(|r| r.resets_at)
            .as_deref(),
        Some(FIVE_HOUR_RESET)
    );
}
