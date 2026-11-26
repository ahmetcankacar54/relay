//! Port of `tests/usage-refresh-lock.test.ts`.

mod lock_child;

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use lock_child::hold_profile;
use relay_core::profile_lock::{ProfileLockKind, acquire_profile_lock};
use relay_core::relay_paths::Platform;
use relay_core::shared::types::{AccountAuth, AccountKind, CreateAccount, UsageIssue};
use relay_core::store::{Store, StoreOptions};
use relay_core::usage_credentials::UsageCredential;
use relay_core::usage_refresh::{ProfileRelease, UsageCredentialRefresher, UsageRefreshDeps};

const NOW: i64 = 1_792_400_400_000; // 2026-10-19T09:00:00.000Z

fn old() -> UsageCredential {
    UsageCredential {
        access_token: "old".into(),
        expires_at: Some(NOW as f64 - 1.0),
        ..UsageCredential::default()
    }
}

#[test]
fn a_refresh_does_not_run_while_another_process_holds_the_account_s_profile_lock() {
    let temp = tempfile::Builder::new()
        .prefix("relay-refresh-lock-")
        .tempdir()
        .unwrap();
    let root = relay_core::fs_util::real_path(temp.path()).unwrap();
    let store = Store::open(&root, StoreOptions::default()).unwrap();
    let created = store
        .create(&CreateAccount {
            name: "A".into(),
            kind: AccountKind::Personal,
            group: None,
            provider: None,
        })
        .unwrap();
    let account_uuid = uuid::Uuid::new_v4().to_string();
    let org_id = uuid::Uuid::new_v4().to_string();
    store
        .update(|s| {
            s.accounts[0].auth = Some(AccountAuth {
                logged_in: true,
                account_uuid: Some(account_uuid),
                org_id: Some(org_id),
                checked_at: "2026-10-19T09:00:00.000Z".into(),
                email: None,
                org_name: None,
                subscription: None,
                plan: None,
                error: None,
            });
        })
        .unwrap();
    let account = store.account(&created.id).unwrap();
    let locks = root.join("profiles").join(".locks");
    let _holder = hold_profile(&locks, &account.id, "shared");
    let runs = Arc::new(AtomicUsize::new(0));
    let cli = root.join("fixture-cli").to_string_lossy().into_owned();
    let mut deps = UsageRefreshDeps::new(
        Arc::new(move || Ok(cli.clone())),
        Arc::new(|_: &Path, _| Ok(old())),
    );
    deps.platform = Some(Platform::Linux);
    let counted = runs.clone();
    deps.run = Some(Arc::new(move |_| {
        counted.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }));
    deps.now = Some(Arc::new(|| NOW));
    let lock_dir = locks.clone();
    deps.profile_lock = Some(Arc::new(move |id| {
        acquire_profile_lock(&lock_dir, id, ProfileLockKind::Exclusive)
            .map(|guard| Box::new(move || drop(guard)) as ProfileRelease)
    }));
    let refresher = UsageCredentialRefresher::new(deps);
    let error = refresher
        .refresh(
            &account,
            &store.profile(&account.id).unwrap(),
            &old(),
            true,
            false,
        )
        .unwrap_err();
    assert_eq!(error.issue, UsageIssue::Unavailable);
    // The busy lock refused it, not a missing profile (an I/O failure carries a detail).
    assert_eq!(error.detail, None);
    assert_eq!(runs.load(Ordering::SeqCst), 0);
}
