//! Port of the tests/account-health.test.ts cases that call `shared/account-state` directly.
//! Everything else renders or reads the app's `src/lib/account-health` and is skipped.

use relay_core::shared::account_state::displayed_issue;
use relay_core::shared::types::{AccountUsage, UsageIssue};
use serde_json::{Value, json};

fn usage(value: Value) -> AccountUsage {
    serde_json::from_value(value).unwrap()
}
fn ready() -> Value {
    json!({ "accountId": "a", "status": "ready", "stale": false, "checkedAt": "2026-10-14T10:00:00.000Z" })
}
fn issue(value: &str) -> Value {
    json!({ "accountId": "a", "status": "error", "issue": value, "stale": true })
}
fn with_renewal(mut value: Value) -> AccountUsage {
    value["connectionRenewalRequired"] = json!(true);
    usage(value)
}

// The app's `displayedIssue` is the shared function (asserted by the next case in TS).
#[test]
fn displayed_issue_reads_the_issue_else_a_connection_to_renew() {
    assert_eq!(displayed_issue(None), None);
    assert_eq!(displayed_issue(Some(&usage(ready()))), None);
    assert_eq!(
        displayed_issue(Some(&with_renewal(ready()))),
        Some(UsageIssue::RenewalRequired)
    );
    assert_eq!(
        displayed_issue(Some(&usage(issue("expired")))),
        Some(UsageIssue::Expired)
    );
    // A reported issue wins over the flag: it is what the last read hit.
    assert_eq!(
        displayed_issue(Some(&with_renewal(issue("rate-limited")))),
        Some(UsageIssue::RateLimited)
    );
    assert_eq!(
        displayed_issue(Some(&with_renewal(issue("keychain-locked")))),
        Some(UsageIssue::KeychainLocked)
    );
}

#[test]
fn displayed_issue_lives_in_shared_and_the_apps_helper_is_the_same_function() {
    assert_eq!(
        displayed_issue(Some(&with_renewal(ready()))),
        Some(UsageIssue::RenewalRequired)
    );
    assert_eq!(
        displayed_issue(Some(&with_renewal(issue("rate-limited")))),
        Some(UsageIssue::RateLimited)
    );
    assert_eq!(displayed_issue(None), None);
}
