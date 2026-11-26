//! The `shared/usage-statistics` and `shared/usage-rollups` cases of
//! tests/usage-statistics.test.ts. The UsageHistory file and UsageManager cases are Electron.

use relay_core::shared::types::js::{date_parse, iso, round};
use relay_core::shared::types::{Account, AccountUsage, UsageIssue, UsageStatus, UsageWindow};
use relay_core::shared::usage_rollups::{UsageRollups, fold_samples};
use relay_core::shared::usage_statistics::{
    MAX_USAGE_GAP_MS, UsageSample, usage_identity, usage_sample,
};
use serde_json::json;

const RESET: &str = "2026-10-13T13:00:00.000Z";
const WEEK: &str = "2026-10-19T13:00:00.000Z";
const MINUTE: f64 = 60_000.0;

fn start() -> f64 {
    date_parse("2026-10-13T08:00:00.000Z")
}
fn account() -> Account {
    serde_json::from_value(json!({
        "id": "account-slot-a",
        "name": "A",
        "kind": "personal",
        "group": "personal",
        "color": "terra",
        "createdAt": iso(start()),
        "auth": {
            "loggedIn": true,
            "accountUuid": "verified-account-a",
            "orgId": "verified-org-a",
            "email": "a@example.test",
            "checkedAt": iso(start()),
        },
    }))
    .expect("account fixture")
}
fn usage_with(at: f64, used_percent: f64, resets_at: Option<&str>) -> AccountUsage {
    AccountUsage {
        checked_at: Some(iso(at)),
        five_hour: Some(UsageWindow::new(used_percent, resets_at)),
        seven_day: Some(UsageWindow::new(15.0, Some(WEEK))),
        ..AccountUsage::new(account().id, UsageStatus::Ready)
    }
}
fn usage(at: f64, used_percent: f64) -> AccountUsage {
    usage_with(at, used_percent, Some(RESET))
}
fn sample_with(at: f64, used_percent: f64, resets_at: Option<&str>) -> UsageSample {
    usage_sample(&account(), &usage_with(at, used_percent, resets_at)).expect("sample")
}
fn sample(at: f64, used_percent: f64) -> UsageSample {
    sample_with(at, used_percent, Some(RESET))
}

#[derive(Debug, PartialEq)]
struct Totals {
    observed_five_hour_points: f64,
    windows_observed: usize,
    covered_minutes: f64,
}
/// The points rule now lives in the rollups; these totals sum one identity.
fn totals(r: &UsageRollups, identity: Option<&str>) -> Totals {
    let own = usage_identity(&account()).expect("identity");
    let identity = identity.unwrap_or(&own);
    let hours: Vec<_> = r
        .hours
        .get(identity)
        .map(|h| h.values().cloned().collect())
        .unwrap_or_default();
    Totals {
        observed_five_hour_points: round(hours.iter().map(|h| h.points).sum::<f64>() * 100.0)
            / 100.0,
        windows_observed: r.windows.get(identity).map_or(0, Vec::len),
        covered_minutes: round(hours.iter().map(|h| h.covered_minutes).sum::<f64>()),
    }
}
fn stats(samples: &[UsageSample]) -> Totals {
    totals(&fold_samples(samples, start() + 60.0 * MINUTE), None)
}

#[test]
fn statistics_count_observed_increases_with_an_explicit_baseline_and_covered_minutes() {
    let s = start();
    let result = stats(&[
        sample(s, 20.0),
        sample(s + 5.0 * MINUTE, 25.2),
        sample(s + 10.0 * MINUTE, 31.3),
    ]);
    assert_eq!(result.observed_five_hour_points, 11.3);
    assert_eq!(result.windows_observed, 1);
    assert_eq!(result.covered_minutes, 10.0);
    assert_eq!(stats(&[sample(s, 80.0)]).observed_five_hour_points, 0.0);
}

#[test]
fn corrections_never_lower_the_running_baseline_and_inflate_later_increases() {
    let s = start();
    let result = stats(&[
        sample(s, 20.0),
        sample(s + 5.0 * MINUTE, 10.0),
        sample(s + 10.0 * MINUTE, 15.0),
        sample(s + 15.0 * MINUTE, 25.0),
        sample(s + 20.0 * MINUTE, 25.0),
    ]);
    assert_eq!(result.observed_five_hour_points, 5.0);
}

#[test]
fn a_reset_is_a_new_baseline_even_if_its_starting_utilization_is_higher() {
    let s = start();
    let next = Some("2026-10-13T13:10:00.000Z");
    let result = stats(&[
        sample(s, 20.0),
        sample(s + 5.0 * MINUTE, 25.0),
        sample_with(s + 10.0 * MINUTE, 50.0, next),
        sample_with(s + 15.0 * MINUTE, 53.0, next),
    ]);
    assert_eq!(result.observed_five_hour_points, 8.0);
    assert_eq!(result.windows_observed, 2);
    // Coverage spans the window change; points do not.
    assert_eq!(result.covered_minutes, 15.0);
}

#[test]
fn gaps_longer_than_35_minutes_do_not_invent_unobserved_usage() {
    let s = start();
    assert_eq!(
        stats(&[sample(s, 10.0), sample(s + MAX_USAGE_GAP_MS, 15.0)]).observed_five_hour_points,
        5.0
    );
    assert_eq!(
        stats(&[sample(s, 10.0), sample(s + MAX_USAGE_GAP_MS + 1.0, 15.0)])
            .observed_five_hour_points,
        0.0
    );
    assert_eq!(
        stats(&[
            sample(s, 10.0),
            sample(s + 40.0 * MINUTE, 50.0),
            sample(s + 45.0 * MINUTE, 53.0)
        ])
        .observed_five_hour_points,
        3.0
    );
}

#[test]
fn missing_expired_and_implausible_reset_timestamps_cannot_form_usage_deltas() {
    let s = start();
    for resets_at in [None, Some(iso(s)), Some(iso(s + 6.0 * 60.0 * MINUTE))] {
        let mut a = sample(s, 10.0);
        let mut b = sample(s + 5.0 * MINUTE, 50.0);
        a.five_hour.as_mut().unwrap().resets_at = resets_at.clone();
        b.five_hour.as_mut().unwrap().resets_at = resets_at;
        let result = stats(&[a, b]);
        assert_eq!(result.observed_five_hour_points, 0.0);
        // Polling is still observed even without a usable window.
        assert_eq!(result.covered_minutes, 5.0);
        assert_eq!(result.windows_observed, 0);
    }
}

#[test]
fn a_long_gap_does_not_count_a_rebound_twice() {
    let s = start();
    let result = stats(&[
        sample(s, 20.0),
        sample(s + 5.0 * MINUTE, 50.0),
        sample(s + 45.0 * MINUTE, 10.0),
        sample(s + 50.0 * MINUTE, 20.0),
    ]);
    assert_eq!(result.observed_five_hour_points, 30.0);
}

#[test]
fn duplicate_timestamps_and_temporarily_missing_windows_never_inflate_totals() {
    let s = start();
    let mut duplicate = sample(s, 5.0);
    duplicate.checked_at = duplicate.checked_at.replacen(".000Z", "Z", 1);
    let mut missing = sample(s + 10.0 * MINUTE, 50.0);
    missing.five_hour = None;
    let result = stats(&[
        sample(s, 20.0),
        duplicate,
        sample(s + 5.0 * MINUTE, 50.0),
        missing,
        sample(s + 15.0 * MINUTE, 10.0),
        sample(s + 20.0 * MINUTE, 20.0),
    ]);
    assert_eq!(result.observed_five_hour_points, 30.0);
    assert_eq!(result.covered_minutes, 20.0);
}

#[test]
fn stable_identity_isolates_organizations_accounts_while_uuid_survives_email_changes() {
    let s = start();
    let values = [sample(s, 10.0), sample(s + 5.0 * MINUTE, 20.0)];
    let rollups = fold_samples(&values, s + 10.0 * MINUTE);
    let mut altered_email = account();
    altered_email.auth.as_mut().unwrap().email = Some("new@example.test".into());
    let altered = usage_identity(&altered_email).expect("identity");
    assert_eq!(
        totals(&rollups, Some(&altered)).observed_five_hour_points,
        10.0
    );
    let changes: [fn(&mut Account); 4] = [
        |a| a.auth.as_mut().unwrap().account_uuid = Some("other-account".into()),
        |a| a.auth.as_mut().unwrap().org_id = Some("other-org".into()),
        |a| a.auth.as_mut().unwrap().org_id = None,
        |a| a.auth.as_mut().unwrap().logged_in = false,
    ];
    for change in changes {
        let mut changed = account();
        change(&mut changed);
        let identity = usage_identity(&changed);
        assert_ne!(identity, usage_identity(&account()));
        if let Some(identity) = identity {
            assert!(rollups.hours.get(&identity).is_none());
        }
    }
    let mut legacy = account();
    let auth = legacy.auth.as_mut().unwrap();
    auth.account_uuid = None;
    auth.email = Some(" A@EXAMPLE.TEST ".into());
    let mut normalized = legacy.clone();
    normalized.auth.as_mut().unwrap().email = Some("a@example.test".into());
    assert_eq!(usage_identity(&legacy), usage_identity(&normalized));
}

#[test]
fn only_fresh_ready_verified_usage_produces_normalized_metadata_samples() {
    let s = start();
    let changes: [fn(&mut AccountUsage); 6] = [
        |u| u.status = UsageStatus::Error,
        |u| u.status = UsageStatus::Loading,
        |u| u.stale = true,
        |u| u.issue = Some(UsageIssue::IdentityMismatch),
        |u| u.account_id = "other-slot".into(),
        |u| u.checked_at = Some("invalid".into()),
    ];
    for change in changes {
        let mut changed = usage(s, 10.0);
        change(&mut changed);
        assert_eq!(usage_sample(&account(), &changed), None);
    }
    let mut signed_out = account();
    signed_out.auth = None;
    assert_eq!(usage_sample(&signed_out, &usage(s, 10.0)), None);
    let mut no_org = account();
    no_org.auth.as_mut().unwrap().org_id = None;
    assert_eq!(usage_sample(&no_org, &usage(s, 10.0)), None);
    let equivalent = usage_sample(
        &account(),
        &usage_with(s, 10.0, Some("2026-10-13T16:00:00+03:00")),
    )
    .expect("sample");
    assert_eq!(
        equivalent.five_hour.and_then(|w| w.resets_at).as_deref(),
        Some(RESET)
    );
    let unusable = AccountUsage {
        five_hour: Some(UsageWindow::new(f64::NAN, None)),
        seven_day: None,
        ..usage(s, 10.0)
    };
    assert_eq!(usage_sample(&account(), &unusable), None);
}

#[test]
fn identity_replacement_does_not_inherit_the_earlier_logins_statistics() {
    // UsageHistory.record folds each usage's sample; done here with the shared functions.
    let s = start();
    let mut different = account();
    different.auth.as_mut().unwrap().account_uuid = Some("new-account".into());
    let samples = [
        sample(s, 10.0),
        sample(s + 5.0 * MINUTE, 20.0),
        usage_sample(&different, &usage(s + 10.0 * MINUTE, 90.0)).expect("sample"),
    ];
    let rollups = fold_samples(&samples, s + 10.0 * MINUTE);
    let other = usage_identity(&different).expect("identity");
    assert_eq!(
        totals(&rollups, Some(&other)).observed_five_hour_points,
        0.0
    );
    assert_eq!(totals(&rollups, None).observed_five_hour_points, 10.0);
}
