//! The `Service` case of `tests/provider-usage.test.ts`; the rest are in `provider_usage.rs`.

use std::fs;

use relay_core::relay_paths::Platform;
use relay_core::service::{Service, ServiceOptions};
use relay_core::shared::types::{
    AccountAuth, AccountKind, AccountPlan, AccountPlanning, CreateAccount,
};
use serde_json::json;

#[test]
fn on_macos_the_plan_is_read_at_startup_from_the_profile_file_without_the_claude_cli() {
    let root = tempfile::Builder::new()
        .prefix("relay-plan-sync-")
        .tempdir()
        .unwrap();
    let mut options = ServiceOptions::new(root.path().join("Relay"));
    options.imported_root = Some(root.path().join("imported"));
    let service = Service::new(options).unwrap();
    let missing = root.path().join("no-such-claude");
    service
        .store
        .update(|s| s.executable = Some(missing.to_string_lossy().into_owned()))
        .unwrap();
    let org_id = uuid::Uuid::new_v4().to_string();
    let create = |name: &str| {
        service
            .store
            .create(&CreateAccount {
                name: name.into(),
                kind: AccountKind::Personal,
                group: None,
                provider: None,
            })
            .unwrap()
    };
    let matching = create("Seat");
    let other = create("Other");
    service
        .store
        .update(|s| {
            for a in &mut s.accounts {
                a.auth = Some(AccountAuth {
                    logged_in: true,
                    email: Some(
                        if a.id == matching.id {
                            "seat@example.test"
                        } else {
                            "other@example.test"
                        }
                        .into(),
                    ),
                    org_id: Some(org_id.clone()),
                    checked_at: "x".into(),
                    ..Default::default()
                });
            }
            s.accounts
                .iter_mut()
                .find(|a| a.id == matching.id)
                .unwrap()
                .planning = Some(AccountPlanning {
                plan: AccountPlan::Pro,
                capacity_weight: 3.0,
            });
        })
        .unwrap();
    for id in [&matching.id, &other.id] {
        let profile = service.store.profile(id).unwrap();
        fs::create_dir_all(&profile).unwrap();
        fs::write(
            profile.join(".claude.json"),
            json!({
                "oauthAccount": {
                    "accountUuid": uuid::Uuid::new_v4().to_string(),
                    "organizationUuid": org_id,
                    // The other profile's file names someone else: its plan is not taken.
                    "emailAddress": "seat@example.test",
                    "organizationType": "claude_team",
                    "userRateLimitTier": "default_claude_max_5x",
                }
            })
            .to_string(),
        )
        .unwrap();
    }
    service.reconcile_auth(Platform::MacOs);
    let seat = service.store.account(&matching.id).unwrap();
    assert_eq!(seat.auth.unwrap().plan, Some(AccountPlan::Max5));
    assert_eq!(
        seat.planning,
        Some(AccountPlanning {
            plan: AccountPlan::Max5,
            capacity_weight: 3.0
        })
    );
    let other = service.store.account(&other.id).unwrap();
    assert_eq!(other.auth.unwrap().plan, None);
    assert_eq!(other.planning, None);
}
