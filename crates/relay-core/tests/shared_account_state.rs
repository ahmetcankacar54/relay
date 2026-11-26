//! Port of tests/account-state.test.ts.

use relay_core::shared::account_state::{
    cli_needs_reconnect, desktop_cli_mismatch, duplicate_cli_account,
};
use relay_core::shared::types::{Account, AccountUsage};
use serde_json::json;

fn account(id: &str, account_uuid: &str, org_id: &str) -> Account {
    serde_json::from_value(json!({
        "id": id,
        "name": id,
        "kind": "personal",
        "group": "personal",
        "color": "olive",
        "createdAt": "2026-10-13",
        "auth": {
            "loggedIn": true,
            "email": "a@example.test",
            "accountUuid": account_uuid,
            "orgId": org_id,
            "checkedAt": "2026-10-13",
        },
    }))
    .unwrap()
}
fn account_a(id: &str) -> Account {
    account(id, "account-a", "org-a")
}
fn usage(account_id: &str, issue: &str) -> AccountUsage {
    serde_json::from_value(
        json!({ "accountId": account_id, "status": "error", "stale": false, "issue": issue }),
    )
    .unwrap()
}

#[test]
fn expired_usage_requires_reconnect_even_when_the_last_cli_status_was_logged_in() {
    let a = account_a("a");
    assert!(cli_needs_reconnect(&a, Some(&usage(&a.id, "expired"))));
    assert!(!cli_needs_reconnect(
        &a,
        Some(&usage(&a.id, "keychain-locked"))
    ));
    assert!(!cli_needs_reconnect(&a, Some(&usage(&a.id, "unavailable"))));
}

#[test]
fn duplicate_connection_needs_both_verified_account_and_organization_identities() {
    let a = account_a("a");
    let mut b = account_a("b");
    let c = account("c", "account-a", "org-b");
    assert_eq!(
        duplicate_cli_account(&a, &[a.clone(), b.clone(), c.clone()]).map(|x| x.id.as_str()),
        Some("b")
    );
    assert!(duplicate_cli_account(&a, &[a.clone(), c]).is_none());
    b.auth.as_mut().unwrap().account_uuid = None;
    assert!(duplicate_cli_account(&a, &[a.clone(), b]).is_none());
}

#[test]
fn desktop_and_cli_identity_mismatch_stays_visible_while_reconnecting_usage() {
    let mut a = account_a("a");
    a.desktop = Some(
        serde_json::from_value(
            json!({ "accountUuid": "account-a", "orgId": "org-a", "savedAt": "2026-10-13" }),
        )
        .unwrap(),
    );
    assert!(!desktop_cli_mismatch(&a));
    a.auth.as_mut().unwrap().org_id = Some("org-b".into());
    assert!(desktop_cli_mismatch(&a));
    a.auth.as_mut().unwrap().logged_in = false;
    assert!(!desktop_cli_mismatch(&a));
}
