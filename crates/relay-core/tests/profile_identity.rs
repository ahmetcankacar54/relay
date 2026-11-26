//! Port of `tests/profile-identity.test.ts`. Skipped: "CLI status failures retain known
//! identity…" and "a Codex or Antigravity account's sign-in is never asked of the Claude CLI"
//! (both drive electron/core/service.ts `checkAuth`, the Service port).

use std::fs;

use relay_core::profile_identity::{ProfileIdentity, auth_status, read_profile_identity};
use relay_core::shared::types::AccountAuth;
use serde_json::{Value, json};

struct Fixture {
    root: tempfile::TempDir,
    identity: Value,
    status: Value,
}

fn fixture() -> Fixture {
    let root = tempfile::Builder::new()
        .prefix("relay-profile-identity-")
        .tempdir()
        .unwrap();
    let identity = json!({
        "accountUuid": uuid::Uuid::new_v4().to_string(),
        "organizationUuid": uuid::Uuid::new_v4().to_string(),
        "emailAddress": "person@example.test",
        "organizationName": "Fixture company",
    });
    let status = json!({
        "loggedIn": true,
        "authMethod": "claude.ai",
        "email": identity["emailAddress"],
        "orgId": identity["organizationUuid"],
        "orgName": identity["organizationName"],
        "subscriptionType": "team",
    });
    Fixture {
        root,
        identity,
        status,
    }
}

fn with(value: &Value, key: &str, field: Value) -> Value {
    let mut value = value.clone();
    if field.is_null() {
        value.as_object_mut().unwrap().remove(key);
    } else {
        value[key] = field;
    }
    value
}

fn s(value: &Value) -> String {
    value.as_str().unwrap().to_string()
}

#[test]
fn isolated_profile_identity_returns_only_safe_metadata_and_never_credential_fields() {
    let f = fixture();
    let mut oauth = f.identity.clone();
    oauth["accessToken"] = json!("never-return-this");
    fs::write(
        f.root.path().join(".claude.json"),
        json!({ "oauthAccount": oauth, "secret": "never-return-this" }).to_string(),
    )
    .unwrap();
    let metadata = read_profile_identity(f.root.path()).unwrap();
    assert_eq!(
        metadata,
        ProfileIdentity {
            account_uuid: s(&f.identity["accountUuid"]),
            org_id: s(&f.identity["organizationUuid"]),
            email: s(&f.identity["emailAddress"]),
            org_name: Some(s(&f.identity["organizationName"])),
            plan: None,
        }
    );
    assert!(
        !serde_json::to_string(&metadata)
            .unwrap()
            .contains("never-return-this")
    );
    let auth = auth_status(&f.status, None, Some(&metadata), "now").unwrap();
    assert_eq!(auth.account_uuid, Some(s(&f.identity["accountUuid"])));
    assert_eq!(auth.org_id, Some(s(&f.identity["organizationUuid"])));
    assert_eq!(auth.org_name, Some(s(&f.identity["organizationName"])));
}

#[test]
fn email_alone_does_not_corroborate_a_different_organization_or_stale_metadata() {
    let f = fixture();
    let metadata = ProfileIdentity {
        account_uuid: s(&f.identity["accountUuid"]),
        org_id: s(&f.identity["organizationUuid"]),
        email: s(&f.identity["emailAddress"]),
        org_name: None,
        plan: None,
    };
    for status in [
        with(&f.status, "orgId", json!(uuid::Uuid::new_v4().to_string())),
        with(&f.status, "email", json!("other@example.test")),
        with(&f.status, "orgId", Value::Null),
    ] {
        assert_eq!(
            auth_status(&status, None, Some(&metadata), "now")
                .unwrap()
                .account_uuid,
            None
        );
    }
}

#[test]
fn profile_metadata_rejects_symlinks_oversized_files_and_malformed_identities() {
    let f = fixture();
    let file = f.root.path().join(".claude.json");
    fs::write(&file, " ".repeat(1024 * 1024 + 1)).unwrap();
    assert_eq!(read_profile_identity(f.root.path()), None);
    fs::write(
        &file,
        json!({ "oauthAccount": with(&f.identity, "accountUuid", json!("invalid")) }).to_string(),
    )
    .unwrap();
    assert_eq!(read_profile_identity(f.root.path()), None);
    fs::write(&file, "{broken").unwrap();
    assert_eq!(read_profile_identity(f.root.path()), None);
    #[cfg(unix)]
    {
        let actual = f.root.path().join("other.json");
        fs::write(&actual, json!({ "oauthAccount": f.identity }).to_string()).unwrap();
        fs::remove_file(&file).unwrap();
        std::os::unix::fs::symlink(&actual, &file).unwrap();
        assert_eq!(read_profile_identity(f.root.path()), None);
        let profile_link = f.root.path().join("profile-link");
        std::os::unix::fs::symlink(f.root.path(), &profile_link).unwrap();
        assert_eq!(read_profile_identity(&profile_link), None);
    }
}

#[test]
fn legacy_config_metadata_takes_priority_without_silently_falling_back_to_another_identity() {
    let f = fixture();
    fs::write(
        f.root.path().join(".claude.json"),
        json!({ "oauthAccount": f.identity }).to_string(),
    )
    .unwrap();
    fs::write(f.root.path().join(".config.json"), "{}").unwrap();
    assert_eq!(read_profile_identity(f.root.path()), None);
}

#[test]
fn a_logged_out_status_preserves_known_email_and_identity_while_clearing_logged_in() {
    let f = fixture();
    let previous = AccountAuth {
        logged_in: true,
        email: Some(s(&f.identity["emailAddress"])),
        account_uuid: Some(s(&f.identity["accountUuid"])),
        org_id: Some(s(&f.identity["organizationUuid"])),
        org_name: Some(s(&f.identity["organizationName"])),
        subscription: Some("max".into()),
        checked_at: "old".into(),
        ..Default::default()
    };
    let auth = auth_status(&json!({ "loggedIn": false }), Some(&previous), None, "new").unwrap();
    assert!(!auth.logged_in);
    assert_eq!(auth.email, previous.email);
    assert_eq!(auth.account_uuid, previous.account_uuid);
    assert_eq!(auth.org_id, previous.org_id);
    assert_eq!(auth.checked_at, "new");
    assert!(auth_status(&Value::Null, Some(&previous), None, "new").is_err());
}
