//! Port of the `UsageManager` cases of `tests/usage-statistics.test.ts`. The other cases test
//! `electron/core/usage-history` and `shared/usage-statistics`/`usage-rollups` (other slices).

#[path = "common/usage_manager.rs"]
mod helpers;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use helpers::*;
use relay_core::shared::types::{AccountKind, AccountUsage, UsageIssue, UsageStatus};
use relay_core::usage::{UsageEndpoint, UsageManager};
use relay_core::usage_credentials::UsageError;
use serde_json::json;

const MINUTE: i64 = 60_000;
const RESET: &str = "2026-10-13T13:00:00.000Z";

fn start() -> i64 {
    ms("2026-10-13T08:00:00.000Z")
}

fn signed_in(t: &Temp) -> String {
    let a = create(&t.store, "A", AccountKind::Personal, None);
    t.store
        .update(|s| s.accounts[0].auth = Some(auth(Some("a@example.test"), &iso_at(start()))))
        .unwrap();
    a.id
}

fn fixture_only() -> relay_core::usage_credentials::UsageCredential {
    credential("fixture-only", None, &["user:profile"])
}

#[test]
fn usage_manager_emits_only_successfully_identity_verified_fresh_polls_and_tolerates_recorder_failures()
 {
    let t = temp_store("relay-usage-statistics-");
    let id = signed_in(&t);
    let clock = Clock::new(start());
    let mismatch = Arc::new(AtomicBool::new(false));
    let received = Log::<AccountUsage>::new();
    let mut d = {
        let mismatch = mismatch.clone();
        deps(
            |_, _| Ok(fixture_only()),
            move |endpoint, _| {
                Ok(match endpoint {
                    UsageEndpoint::Profile => {
                        let email = if mismatch.load(Ordering::SeqCst) {
                            "wrong@example.test"
                        } else {
                            "a@example.test"
                        };
                        json!({ "account": { "email": email } })
                    }
                    UsageEndpoint::Usage => {
                        json!({ "five_hour": { "utilization": 10, "resets_at": RESET } })
                    }
                })
            },
            clock.now_fn(),
        )
    };
    let log = received.clone();
    d.on_sample = Arc::new(move |_, value| {
        log.push(value.clone());
        panic!("fixture disk failure");
    });
    let manager = UsageManager::new(t.store.clone(), d);
    assert_eq!(
        manager.refresh(&id, false).unwrap().status,
        UsageStatus::Ready
    );
    assert_eq!(received.len(), 1);
    clock.add(MINUTE);
    mismatch.store(true, Ordering::SeqCst);
    assert_eq!(
        manager.refresh(&id, false).unwrap().issue,
        Some(UsageIssue::IdentityMismatch)
    );
    assert_eq!(received.len(), 1);
}

#[test]
fn post_request_quota_verification_bypasses_only_a_successful_client_cooldown_never_429_or_failure_backoff()
 {
    let t = temp_store("relay-usage-statistics-");
    let id = signed_in(&t);
    let clock = Clock::new(start());
    let calls = Count::default();
    let issue = Arc::new(Mutex::new(None::<UsageIssue>));
    let prompts = Log::<bool>::new();
    let manager = {
        let (calls, issue, prompts, now) =
            (calls.clone(), issue.clone(), prompts.clone(), clock.clone());
        UsageManager::new(
            t.store.clone(),
            deps(
                move |_, allow_prompt| {
                    prompts.push(allow_prompt);
                    Ok(fixture_only())
                },
                move |endpoint, _| {
                    if endpoint == UsageEndpoint::Profile {
                        return Ok(json!({ "account": { "email": "a@example.test" } }));
                    }
                    let call = calls.bump();
                    if let Some(issue) = *issue.lock().unwrap() {
                        let retry = (issue == UsageIssue::RateLimited)
                            .then(|| (now.get() + 10 * MINUTE) as f64);
                        return Err(UsageError::with_retry(issue, retry, None));
                    }
                    Ok(json!({ "five_hour": {
                        "utilization": if call == 1 { 0 } else { 1 },
                        "resets_at": if call == 1 { None } else { Some(RESET) },
                    }}))
                },
                clock.now_fn(),
            ),
        )
    };
    let resets = |u: AccountUsage| u.five_hour.and_then(|w| w.resets_at);
    assert_eq!(resets(manager.refresh(&id, false).unwrap()), None);
    clock.add(1_000);
    assert_eq!(resets(manager.refresh(&id, false).unwrap()), None);
    assert_eq!(calls.get(), 1);
    let after = manager.refresh_after_request(&id).unwrap();
    assert_eq!(after.checked_at, Some(iso_at(clock.get())));
    assert_eq!(resets(after), Some(RESET.to_owned()));
    assert_eq!(calls.get(), 2);
    *issue.lock().unwrap() = Some(UsageIssue::RateLimited);
    let throttled = manager.refresh_after_request(&id).unwrap();
    assert_eq!(throttled.issue, Some(UsageIssue::RateLimited));
    assert_eq!(calls.get(), 3);
    assert_eq!(
        manager.refresh_after_request(&id).unwrap().retry_at,
        throttled.retry_at
    );
    assert_eq!(calls.get(), 3);
    manager.invalidate(&id);
    manager.refresh_after_request(&id).unwrap();
    assert_eq!(calls.get(), 3);
    clock.add(11 * MINUTE);
    *issue.lock().unwrap() = Some(UsageIssue::Unavailable);
    let failed = manager.refresh_after_request(&id).unwrap();
    assert_eq!(failed.issue, Some(UsageIssue::Unavailable));
    assert_eq!(calls.get(), 4);
    assert_eq!(
        manager.refresh_after_request(&id).unwrap().retry_at,
        failed.retry_at
    );
    assert_eq!(calls.get(), 4);
    assert!(prompts.all().iter().all(|allow_prompt| !allow_prompt));
}

#[test]
fn post_request_refresh_joins_an_in_flight_verified_read_without_issuing_another_poll() {
    let t = temp_store("relay-usage-statistics-");
    let id = signed_in(&t);
    let hold = Deferred::<()>::new();
    let calls = Count::default();
    let manager = {
        let (calls, hold) = (calls.clone(), hold.clone());
        Arc::new(UsageManager::new(
            t.store.clone(),
            deps(
                |_, _| Ok(fixture_only()),
                move |endpoint, _| {
                    if endpoint == UsageEndpoint::Profile {
                        return Ok(json!({ "account": { "email": "a@example.test" } }));
                    }
                    calls.bump();
                    hold.wait();
                    Ok(json!({ "five_hour": { "utilization": 1, "resets_at": RESET } }))
                },
                Arc::new(start),
            ),
        ))
    };
    let first = spawn_refresh(&manager, &id, false);
    until(|| calls.get() == 1);
    let second = {
        let (manager, id) = (manager.clone(), id.clone());
        std::thread::spawn(move || manager.refresh_after_request(&id).unwrap())
    };
    std::thread::sleep(Duration::from_millis(30));
    hold.resolve(());
    let first = first.join().unwrap();
    assert_eq!(second.join().unwrap(), first);
    assert_eq!(calls.get(), 1);
}
