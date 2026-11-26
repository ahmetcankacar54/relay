//! The `Service.checkAuth` cases of `tests/profile-identity.test.ts`; the rest are in
//! `profile_identity.rs`. The CLI stand-in is a `/bin/sh` script (the TS used a Node script).

#[path = "common/p4services.rs"]
mod helpers;

#[cfg(unix)]
use std::fs;
use std::sync::Arc;

use relay_core::service::{Service, ServiceOptions};
use relay_core::shared::types::{AccountAuth, AccountKind, AccountProvider, CreateAccount};
#[cfg(unix)]
use serde_json::json;

fn service(root: &std::path::Path) -> Arc<Service> {
    let mut options = ServiceOptions::new(root.join("Relay"));
    options.imported_root = Some(root.join("imported"));
    Service::new(options).unwrap()
}

#[cfg(unix)]
fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[cfg(unix)]
#[test]
fn cli_status_failures_retain_known_identity_a_successful_reconnect_persists_its_new_organization()
{
    let root = tempfile::Builder::new()
        .prefix("relay-profile-identity-")
        .tempdir()
        .unwrap();
    let identity = json!({
        "accountUuid": uuid(),
        "organizationUuid": uuid(),
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
    let service = service(root.path());
    let account = service
        .store
        .create(&CreateAccount {
            name: "Fixture".into(),
            kind: AccountKind::Personal,
            group: None,
            provider: None,
        })
        .unwrap();
    let profile = service.store.profile(&account.id).unwrap();
    let cli = helpers::script(
        root.path(),
        "fixture-cli",
        r#"for a in "$@"; do if [ "$a" = "--version" ]; then echo '2.1.296'; exit 0; fi; done
cat "$CLAUDE_CONFIG_DIR/fixture-status.json""#,
    );
    service
        .store
        .update(|s| s.executable = Some(cli.to_string_lossy().into_owned()))
        .unwrap();
    fs::write(
        profile.join(".claude.json"),
        json!({ "oauthAccount": identity }).to_string(),
    )
    .unwrap();
    let status_file = profile.join("fixture-status.json");
    fs::write(&status_file, status.to_string()).unwrap();
    let connected = service.check_auth(&account.id).unwrap().auth.unwrap();
    assert_eq!(
        connected.account_uuid.as_deref(),
        identity["accountUuid"].as_str()
    );
    assert_eq!(
        connected.org_id.as_deref(),
        identity["organizationUuid"].as_str()
    );
    fs::write(&status_file, "not JSON").unwrap();
    let failed = service.check_auth(&account.id).unwrap().auth.unwrap();
    assert!(!failed.logged_in);
    assert_eq!(failed.email, connected.email);
    assert_eq!(failed.account_uuid, connected.account_uuid);
    assert!(failed.error.is_some());
    let org_id = uuid();
    let account_uuid = uuid();
    let mut moved = identity.clone();
    moved["accountUuid"] = json!(account_uuid);
    moved["organizationUuid"] = json!(org_id);
    fs::write(
        profile.join(".claude.json"),
        json!({ "oauthAccount": moved }).to_string(),
    )
    .unwrap();
    let mut new_status = status.clone();
    new_status["orgId"] = json!(org_id);
    fs::write(&status_file, new_status.to_string()).unwrap();
    let reconnected = service.check_auth(&account.id).unwrap().auth.unwrap();
    assert!(reconnected.logged_in);
    assert_eq!(
        reconnected.account_uuid.as_deref(),
        Some(account_uuid.as_str())
    );
    assert_eq!(reconnected.org_id.as_deref(), Some(org_id.as_str()));
    assert_eq!(reconnected.error, None);
    let reopened = self::service(root.path());
    assert_eq!(
        reopened
            .store
            .account(&account.id)
            .unwrap()
            .auth
            .unwrap()
            .org_id,
        Some(org_id)
    );
}

#[test]
fn a_codex_or_antigravity_account_s_sign_in_is_never_asked_of_the_claude_cli() {
    let root = tempfile::Builder::new()
        .prefix("relay-provider-auth-")
        .tempdir()
        .unwrap();
    let service = service(root.path());
    let missing = root.path().join("no-such-claude");
    service
        .store
        .update(|s| s.executable = Some(missing.to_string_lossy().into_owned()))
        .unwrap();
    for provider in [AccountProvider::Codex, AccountProvider::Antigravity] {
        let name = format!("{provider:?}").to_lowercase();
        let account = service
            .store
            .create(&CreateAccount {
                name: name.clone(),
                kind: AccountKind::Personal,
                group: None,
                provider: Some(provider),
            })
            .unwrap();
        let auth = AccountAuth {
            logged_in: true,
            checked_at: relay_core::fs_util::iso_timestamp(relay_core::clock::now_ms()),
            email: Some(format!("{name}@example.com")),
            ..Default::default()
        };
        service
            .store
            .update(|s| {
                s.accounts
                    .iter_mut()
                    .find(|a| a.id == account.id)
                    .unwrap()
                    .auth = Some(auth.clone())
            })
            .unwrap();
        let checked = service.check_auth(&account.id).unwrap();
        assert_eq!(checked.auth, Some(auth), "{name}");
    }
}
