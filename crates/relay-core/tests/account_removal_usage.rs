//! Port of the `UsageManager` case of `tests/account-removal.test.ts` ("the usage cache forgets a
//! removed account…"); the other cases are in `account_removal.rs`. The TS removes the account
//! with `removeAccount` (the account-removal slice); here it leaves the registry directly, which
//! is what the manager sees of a removal.

#[path = "common/usage_manager.rs"]
mod helpers;

use std::sync::Arc;

use helpers::*;
use relay_core::shared::types::AccountKind;
use relay_core::usage::UsageManager;
use serde_json::json;

#[test]
fn the_usage_cache_forgets_a_removed_account_and_a_read_still_running_ends_quietly() {
    let t = temp_store("relay-remove-");
    let make = |name: &str| {
        let created = create(&t.store, name, AccountKind::Personal, None);
        let (desktop_uuid, auth_uuid) = (
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
        );
        t.store
            .update(|s| {
                let a = s.accounts.iter_mut().find(|x| x.id == created.id).unwrap();
                a.desktop = Some(desktop(
                    &desktop_uuid,
                    &uuid::Uuid::new_v4().to_string(),
                    &iso_at(now()),
                ));
                let mut signed_in = auth(None, &iso_at(now()));
                signed_in.account_uuid = Some(auth_uuid.clone());
                a.auth = Some(signed_in);
            })
            .unwrap();
        std::fs::write(
            t.store
                .profile(&created.id)
                .unwrap()
                .join(".credentials.json"),
            "{}",
        )
        .unwrap();
        created.id
    };
    let a = make("A");
    let b = make("B");
    let held = Deferred::<()>::new();
    let asked = Deferred::<()>::new();
    let manager = {
        let (held, asked) = (held.clone(), asked.clone());
        Arc::new(UsageManager::new(
            t.store.clone(),
            deps(
                move |_, _| {
                    asked.resolve(());
                    held.wait();
                    Ok(credential("fixture", None, &["user:profile"]))
                },
                |_, _| Ok(json!({})),
                Arc::new(now),
            ),
        ))
    };
    let running = {
        let (manager, b) = (manager.clone(), b.clone());
        std::thread::spawn(move || manager.refresh(&b, false))
    };
    asked.wait();
    t.store
        .update(|s| s.accounts.retain(|x| x.id != b))
        .unwrap();
    manager.forget(&b);
    held.resolve(());
    // It ends without a panic; the account it read is gone, which is nobody's to report.
    running.join().expect("the read ends quietly").ok();
    assert_eq!(
        manager.snapshot().keys().cloned().collect::<Vec<_>>(),
        vec![a]
    );
}

fn now() -> i64 {
    relay_core::clock::now_ms()
}
