//! Port of `tests/service-reconcile-auth.test.ts`. The CLI stand-in is a `/bin/sh` script (the
//! TS used a Node script); Windows is skipped as in the TS.

#![cfg(unix)]

#[path = "common/p4services.rs"]
mod helpers;

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use helpers::script;
use relay_core::relay_paths::Platform;
use relay_core::service::{Service, ServiceOptions};
use relay_core::shared::types::{Account, AccountAuth, AccountDesktop, AccountKind, CreateAccount};

const CLI: &str = r#"for a in "$@"; do if [ "$a" = "--version" ]; then echo '2.1.296'; exit 0; fi; done
echo status >> "$CLAUDE_CONFIG_DIR/fixture-status-calls"
printf rotated > "$CLAUDE_CONFIG_DIR/fixture-refresh-state"
cat "$CLAUDE_CONFIG_DIR/fixture-status.json""#;

struct Fixture {
    root: tempfile::TempDir,
    service: Arc<Service>,
}

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("relay-startup-auth-")
            .tempdir()
            .unwrap();
        let service = Self::open(root.path());
        let cli = script(root.path(), "fixture-cli", CLI);
        service
            .store
            .update(|s| s.executable = Some(cli.to_string_lossy().into_owned()))
            .unwrap();
        Fixture { root, service }
    }

    fn open(root: &std::path::Path) -> Arc<Service> {
        let mut options = ServiceOptions::new(root.join("Relay"));
        options.imported_root = Some(root.join("unused-imported"));
        Service::new(options).unwrap()
    }

    fn restart(&self) -> Arc<Service> {
        Self::open(self.root.path())
    }

    fn account(&self, name: &str, patch: impl FnOnce(&mut AccountAuth)) -> Account {
        let created = self
            .service
            .store
            .create(&CreateAccount {
                name: name.into(),
                kind: AccountKind::Personal,
                group: None,
                provider: None,
            })
            .unwrap();
        let mut auth = AccountAuth {
            logged_in: true,
            account_uuid: Some(uuid()),
            org_id: Some(uuid()),
            checked_at: "2026-01-01T00:00:00.000Z".into(),
            email: Some(format!("{name}@example.test")),
            ..Default::default()
        };
        patch(&mut auth);
        self.service
            .store
            .update(|s| {
                s.accounts
                    .iter_mut()
                    .find(|a| a.id == created.id)
                    .unwrap()
                    .auth = Some(auth.clone());
            })
            .unwrap();
        let profile = self.profile(&created.id);
        fs::write(profile.join("fixture-refresh-state"), "unchanged").unwrap();
        fs::write(
            profile.join("fixture-status.json"),
            serde_json::json!({
                "loggedIn": true,
                "authMethod": "claude.ai",
                "accountUuid": uuid(),
                "orgId": uuid(),
                "email": auth.email,
                "subscriptionType": "max",
            })
            .to_string(),
        )
        .unwrap();
        self.service.store.account(&created.id).unwrap()
    }

    fn profile(&self, id: &str) -> PathBuf {
        self.service.store.profile(id).unwrap()
    }

    fn side_effect(&self, id: &str) -> String {
        fs::read_to_string(self.profile(id).join("fixture-refresh-state")).unwrap()
    }

    fn calls(&self, id: &str) -> usize {
        match fs::read_to_string(self.profile(id).join("fixture-status-calls")) {
            Ok(text) => text.trim().split('\n').count(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
            Err(error) => panic!("{error}"),
        }
    }
}

#[test]
fn startup_preserves_enrolled_identities_without_launching_a_status_command_that_rotates_credentials()
 {
    let f = Fixture::new();
    let cli_only = f.account("cli-only", |_| {});
    let desktop = f.account("desktop", |_| {});
    f.service
        .store
        .update(|s| {
            let auth = desktop.auth.clone().unwrap();
            s.accounts
                .iter_mut()
                .find(|a| a.id == desktop.id)
                .unwrap()
                .desktop = Some(AccountDesktop {
                account_uuid: auth.account_uuid.unwrap(),
                org_id: auth.org_id.unwrap(),
                saved_at: "2026-01-01T00:00:00.000Z".into(),
                email: None,
                rejected_at: None,
            });
        })
        .unwrap();
    let before: Vec<_> = f
        .service
        .store
        .state()
        .accounts
        .into_iter()
        .map(|a| a.auth)
        .collect();
    let restarted = f.restart();
    restarted.reconcile_auth(Platform::current());
    let after: Vec<_> = restarted
        .store
        .state()
        .accounts
        .into_iter()
        .map(|a| a.auth)
        .collect();
    assert_eq!(after, before);
    for a in [&cli_only, &desktop] {
        assert_eq!(f.calls(&a.id), 0);
        assert_eq!(f.side_effect(&a.id), "unchanged");
    }
    // A manual recheck still asks the official CLI and observes its new identity.
    let rechecked = restarted.check_auth(&cli_only.id).unwrap();
    assert_eq!(f.calls(&cli_only.id), 1);
    assert_eq!(f.side_effect(&cli_only.id), "rotated");
    let (now, then) = (rechecked.auth.unwrap(), cli_only.auth.unwrap());
    assert_ne!(now.account_uuid, then.account_uuid);
    assert_ne!(now.checked_at, then.checked_at);
    assert_eq!(f.calls(&desktop.id), 0);
}

#[test]
fn non_macos_startup_reconciles_missing_logged_out_incomplete_failed_and_desktop_mismatched_identities()
 {
    let f = Fixture::new();
    let unknown = f.account("unknown", |_| {});
    f.service
        .store
        .update(|s| {
            s.accounts
                .iter_mut()
                .find(|a| a.id == unknown.id)
                .unwrap()
                .auth = None
        })
        .unwrap();
    let accounts = vec![
        unknown,
        f.account("logged-out", |a| a.logged_in = false),
        f.account("missing-account", |a| a.account_uuid = None),
        f.account("missing-org", |a| a.org_id = None),
        f.account("failed", |a| {
            a.error = Some("Previous verification failed.".into())
        }),
        f.account("different-desktop-account", |_| {}),
        f.account("different-desktop-org", |_| {}),
    ];
    f.service
        .store
        .update(|s| {
            for a in &accounts[accounts.len() - 2..] {
                let auth = a.auth.clone().unwrap();
                s.accounts
                    .iter_mut()
                    .find(|c| c.id == a.id)
                    .unwrap()
                    .desktop = Some(AccountDesktop {
                    account_uuid: if a.name.ends_with("account") {
                        uuid()
                    } else {
                        auth.account_uuid.unwrap()
                    },
                    org_id: if a.name.ends_with("org") {
                        uuid()
                    } else {
                        auth.org_id.unwrap()
                    },
                    saved_at: "2026-01-01T00:00:00.000Z".into(),
                    email: None,
                    rejected_at: None,
                });
            }
        })
        .unwrap();
    let restarted = f.restart();
    restarted.reconcile_auth(Platform::Linux);
    for a in &accounts {
        assert_eq!(f.calls(&a.id), 1, "{}", a.name);
        assert_eq!(f.side_effect(&a.id), "rotated", "{}", a.name);
        let auth = restarted.store.account(&a.id).unwrap().auth.unwrap();
        assert!(auth.logged_in, "{}", a.name);
        assert_eq!(auth.error, None, "{}", a.name);
    }
}

#[test]
fn macos_startup_never_launches_interactive_status_checks_for_unverified_profiles() {
    let f = Fixture::new();
    let accounts = [
        f.account("missing-identity", |a| a.account_uuid = None),
        f.account("signed-out", |a| a.logged_in = false),
        f.account("failed", |a| {
            a.error = Some("Needs explicit verification".into())
        }),
    ];
    let before = f.service.store.state().accounts;
    let restarted = f.restart();
    restarted.reconcile_auth(Platform::MacOs);
    for account in &accounts {
        assert_eq!(f.calls(&account.id), 0);
        assert_eq!(f.side_effect(&account.id), "unchanged");
    }
    assert_eq!(restarted.store.state().accounts, before);
}
