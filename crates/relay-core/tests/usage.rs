//! Port of `tests/usage.test.ts`. Skipped: "legacy preferences migrate without losing accounts…"
//! (the store's settings schema, another slice) and "suggestions require fresh five-hour data…"
//! (`shared/usage` `suggestedAccount`, ported with the shared views).

#[path = "common/usage_manager.rs"]
mod helpers;

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use helpers::*;
use relay_core::relay_paths::Platform;
use relay_core::shared::types::{Account, AccountKind, UsageIssue, UsageStatus};
use relay_core::shared::usage::remaining;
use relay_core::store::Store;
use relay_core::usage::{
    ErrorBody, UsageEndpoint, UsageManager, missing_identity, network_detail, parse_usage,
    request_usage_json_at, retry_time, scope_refusal, verify_identity,
};
use relay_core::usage_credentials::{
    MISSING_RETRY_MS, UsageError, credential_service, parse_credential, read_credential,
};
use serde_json::{Value, json};

struct Fixture {
    t: Temp,
    store: Arc<Store>,
    a: Account,
}

fn fixture() -> Fixture {
    let t = temp_store("relay-usage-");
    let store = t.store.clone();
    let a = create(&store, "A", AccountKind::Personal, None);
    store
        .update(|s| s.accounts[0].auth = Some(auth(Some("a@example.test"), "2026-10-13")))
        .unwrap();
    let a = store.account(&a.id).unwrap();
    Fixture { t, store, a }
}

fn limits() -> Value {
    json!({
        "five_hour": { "utilization": 91.3, "resets_at": "2026-10-13T16:00:00Z" },
        "seven_day": { "utilization": 30, "resets_at": "2026-10-16T16:00:00Z" },
    })
}

const SECRET: &str = "fixture-secret-never-rendered";

fn cred() -> relay_core::usage_credentials::UsageCredential {
    credential(
        SECRET,
        Some(ms("2026-10-14T00:00:00Z") as f64),
        &["user:profile"],
    )
}

fn credential_json(c: &relay_core::usage_credentials::UsageCredential) -> Value {
    json!({ "claudeAiOauth": {
        "accessToken": c.access_token,
        "expiresAt": c.expires_at,
        "scopes": c.scopes,
    }})
}

fn profile() -> Value {
    json!({
        "account": { "email_address": "a@example.test", "uuid": "account-a" },
        "organization": { "uuid": "org-a" },
    })
}

/// A request that answers the profile and the limits.
fn answers(endpoint: UsageEndpoint, _: &str) -> Result<Value, UsageError> {
    Ok(match endpoint {
        UsageEndpoint::Profile => profile(),
        UsageEndpoint::Usage => limits(),
    })
}

fn noon() -> i64 {
    ms("2026-10-13T12:00:00Z")
}

#[test]
fn quota_parsing_distinguishes_unavailable_windows_full_quota_and_partial_quota() {
    let value = parse_usage(&limits()).unwrap();
    assert!((remaining(value.five_hour.as_ref()).unwrap() - 8.7).abs() < 0.0001);
    assert_eq!(remaining(value.seven_day.as_ref()), Some(70.0));
    assert_eq!(
        parse_usage(&json!({ "five_hour": { "utilization": 100 }, "seven_day": null }))
            .unwrap()
            .seven_day,
        None
    );
    let full = parse_usage(&json!({ "five_hour": { "utilization": 100 } })).unwrap();
    assert_eq!(remaining(full.five_hour.as_ref()), Some(0.0));
    let empty = parse_usage(&json!({ "five_hour": { "utilization": 0 } })).unwrap();
    assert_eq!(remaining(empty.five_hour.as_ref()), Some(100.0));
    // NaN and Infinity have no JSON form (serde_json writes them as null, which also fails here).
    for bad in [
        json!(-1),
        json!(101),
        json!(f64::NAN),
        json!(f64::INFINITY),
        json!("20"),
    ] {
        assert!(parse_usage(&json!({ "five_hour": { "utilization": bad } })).is_err());
    }
    assert!(parse_usage(&json!({ "five_hour": null, "seven_day": null })).is_err());
    assert!(
        parse_usage(&json!({ "five_hour": { "utilization": 10, "resets_at": "bad" } })).is_err()
    );
}

#[test]
fn usage_credentials_are_profile_scoped_read_only_and_never_use_a_global_fallback() {
    let f = fixture();
    let profile_dir = f.store.profile(&f.a.id).unwrap();
    assert_ne!(
        credential_service(&profile_dir),
        credential_service(&f.t.root.join("different"))
    );
    let service = credential_service(&profile_dir);
    let hash = service.strip_prefix("Claude Code-credentials-").unwrap();
    assert!(
        hash.len() == 8
            && hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    assert!(parse_credential(&json!({ "mcpOAuth": { "token": "wrong" } }).to_string()).is_err());
    let file = profile_dir.join(".credentials.json");
    std::fs::write(&file, credential_json(&cred()).to_string()).unwrap();
    let read = |dir: &Path| {
        read_credential(
            dir,
            false,
            Some(Path::new("unused")),
            Platform::Linux,
            MISSING_RETRY_MS,
        )
    };
    assert_eq!(read(&profile_dir).unwrap(), cred());
    std::fs::remove_file(&file).unwrap();
    assert_eq!(
        read(&profile_dir).unwrap_err().issue,
        UsageIssue::CredentialsMissing
    );
    #[cfg(unix)]
    {
        let foreign = f.t.root.join("foreign.json");
        std::fs::write(&foreign, credential_json(&cred()).to_string()).unwrap();
        std::os::unix::fs::symlink(&foreign, &file).unwrap();
        assert_eq!(
            read(&profile_dir).unwrap_err().issue,
            UsageIssue::CredentialsMissing
        );
    }
}

/// macOS only: the Keychain, through a shell stand-in for security.
#[cfg(unix)]
#[test]
fn macos_reads_the_cli_credential_through_the_security_tool_falls_back_to_the_cli_file_and_bounds_a_consent_wait()
 {
    use std::os::unix::fs::PermissionsExt;
    let f = fixture();
    let profile_dir = f.store.profile(&f.a.id).unwrap();
    let tool = f.t.root.join("fake-security");
    let credential = credential(
        "fixture-access",
        Some(4_102_444_800_000.0),
        &["user:profile"],
    );
    let saved = credential_json(&credential).to_string();
    let script = |body: &str| {
        std::fs::write(&tool, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
    };
    let read =
        |retry: u64| read_credential(&profile_dir, false, Some(&tool), Platform::MacOs, retry);
    script(&format!(
        "[ \"$1\" = find-generic-password ] && [ \"$2\" = -s ] && [ \"$3\" = \"{}\" ] && [ \"$4\" = -w ] || exit 9\necho '{saved}'",
        credential_service(&profile_dir)
    ));
    assert_eq!(read(MISSING_RETRY_MS).unwrap(), credential);
    let hex: String = saved.bytes().map(|b| format!("{b:02x}")).collect();
    script(&format!("echo {hex}"));
    assert_eq!(read(MISSING_RETRY_MS).unwrap(), credential);
    script("exit 44");
    assert_eq!(read(0).unwrap_err().issue, UsageIssue::CredentialsMissing);
    // The CLI rewrites its item when it renews: a read in that moment looks once more.
    let seen = f.t.root.join("security-calls");
    script(&format!(
        "n=$(cat \"{0}\" 2>/dev/null || echo 0); echo $((n+1)) > \"{0}\"\n[ \"$n\" = 0 ] && exit 44\necho '{saved}'",
        seen.display()
    ));
    assert_eq!(read(1).unwrap(), credential);
    assert_eq!(std::fs::read_to_string(&seen).unwrap().trim(), "2");
    script("exit 44");
    std::fs::write(profile_dir.join(".credentials.json"), &saved).unwrap();
    assert_eq!(read(0).unwrap(), credential);
    script("exit 51");
    assert_eq!(
        read(MISSING_RETRY_MS).unwrap_err().issue,
        UsageIssue::KeychainLocked
    );
}

fn mismatch(result: Result<(), UsageError>) {
    assert_eq!(result.unwrap_err().issue, UsageIssue::IdentityMismatch);
}

#[test]
fn profile_verification_rejects_a_wrong_account_and_wrong_desktop_organization() {
    let f = fixture();
    verify_identity(&f.a, &profile()).unwrap();
    mismatch(verify_identity(
        &f.a,
        &json!({ "account": { "email_address": "other@example.test" } }),
    ));
    mismatch(verify_identity(
        &Account {
            auth: None,
            ..f.a.clone()
        },
        &profile(),
    ));
    let a = Account {
        desktop: Some(desktop("account-a", "other-org", "")),
        ..f.a.clone()
    };
    mismatch(verify_identity(&a, &profile()));
}

#[test]
fn known_cli_account_and_organization_ids_cannot_be_bypassed_by_matching_email() {
    let f = fixture();
    let mut account = f.a.clone();
    {
        let auth = account.auth.as_mut().unwrap();
        auth.account_uuid = Some("account-a".into());
        auth.org_id = Some("org-a".into());
    }
    verify_identity(&account, &profile()).unwrap();
    let mut other = profile();
    other["account"]["uuid"] = json!("other-account");
    mismatch(verify_identity(&account, &other));
    let mut other = profile();
    other["organization"] = json!({ "uuid": "other-org" });
    mismatch(verify_identity(&account, &other));
    mismatch(verify_identity(
        &account,
        &json!({ "account": { "email_address": "a@example.test" } }),
    ));
    // A corroborated account ID survives an email change; legacy profiles still require matching email.
    let mut no_email = account.clone();
    no_email.auth.as_mut().unwrap().email = None;
    verify_identity(&no_email, &profile()).unwrap();
    let mut legacy = account.clone();
    {
        let auth = legacy.auth.as_mut().unwrap();
        auth.account_uuid = None;
        auth.email = Some("other@example.test".into());
    }
    mismatch(verify_identity(&legacy, &profile()));
    let other_desktop = Account {
        desktop: Some(desktop("other-account", "org-a", "")),
        ..account.clone()
    };
    mismatch(verify_identity(&other_desktop, &profile()));
}

/// `new Date(ms).toUTCString()`.
fn utc_string(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap()
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string()
}

#[test]
fn usage_deduplicates_requests_hides_secrets_retains_stale_data_after_429_honors_retry_after() {
    let f = fixture();
    let clock = Clock::new(noon());
    let requests = Count::default();
    let fail = Arc::new(AtomicBool::new(false));
    let prompts = Log::new();
    let gate = Deferred::<()>::new();
    let manager = {
        let now = clock.now_fn();
        let (requests, fail, clock, gate, prompts) = (
            requests.clone(),
            fail.clone(),
            clock.clone(),
            gate.clone(),
            prompts.clone(),
        );
        Arc::new(UsageManager::new(
            f.store.clone(),
            deps(
                move |_, prompt| {
                    prompts.push(prompt);
                    Ok(cred())
                },
                move |endpoint, token| {
                    requests.bump();
                    gate.wait();
                    if fail.load(Ordering::SeqCst) {
                        return Err(UsageError::with_retry(
                            UsageIssue::RateLimited,
                            Some(clock.get() as f64 + 600_000.0),
                            None,
                        ));
                    }
                    answers(endpoint, token)
                },
                now,
            ),
        ))
    };
    // Both reads ask while the first is still waiting for its answer.
    let first = spawn_refresh(&manager, &f.a.id, false);
    until(|| requests.get() == 1);
    let second = spawn_refresh(&manager, &f.a.id, false);
    std::thread::sleep(Duration::from_millis(30));
    gate.resolve(());
    let (a, b) = (first.join().unwrap(), second.join().unwrap());
    assert_eq!(a.status, UsageStatus::Ready);
    assert_eq!(a, b);
    assert_eq!(requests.get(), 2);
    assert_no_secrets(&manager.snapshot(), &[SECRET]);
    manager.refresh(&f.a.id, false).unwrap();
    assert_eq!(requests.get(), 2);
    clock.add(300_000);
    fail.store(true, Ordering::SeqCst);
    let old = manager.refresh(&f.a.id, false).unwrap();
    assert!(old.stale);
    assert_eq!(old.issue, Some(UsageIssue::RateLimited));
    assert_eq!(old.five_hour, a.five_hour);
    clock.add(60_000);
    manager.refresh(&f.a.id, true).unwrap();
    assert_eq!(requests.get(), 3);
    clock.add(600_000);
    manager.refresh(&f.a.id, false).unwrap();
    assert_eq!(requests.get(), 4);
    assert!(prompts.all().iter().all(|p| !p));
    let now = clock.get() as f64;
    assert_eq!(retry_time(Some("120"), now), now + 120_000.0);
    assert_eq!(
        retry_time(Some(&utc_string(now as i64 + 600_000)), now),
        now + 600_000.0
    );
}

#[test]
fn a_retry_after_waits_at_most_an_hour_at_least_a_minute_and_an_unreadable_one_takes_the_default() {
    let now = noon() as f64;
    assert_eq!(retry_time(Some("99999999"), now), now + 3_600_000.0);
    assert_eq!(
        retry_time(Some(&utc_string(now as i64 + 3 * 86_400_000)), now),
        now + 3_600_000.0
    );
    assert_eq!(retry_time(Some("0"), now), now + 60_000.0);
    assert_eq!(retry_time(Some(&"9".repeat(400)), now), now + 300_000.0);
    assert_eq!(retry_time(Some("soon"), now), now + 300_000.0);
    assert_eq!(retry_time(None, now), now + 300_000.0);
}

#[test]
fn an_expired_credential_does_not_get_refreshed_or_sent_wrong_identity_clears_old_quota() {
    let f = fixture();
    let clock = Clock::new(noon());
    let requests = Count::default();
    let expired = {
        let requests = requests.clone();
        UsageManager::new(
            f.store.clone(),
            deps(
                |_, _| Ok(credential(SECRET, Some(0.0), &["user:profile"])),
                move |_, _| {
                    requests.bump();
                    Ok(json!({}))
                },
                clock.now_fn(),
            ),
        )
    };
    assert_eq!(
        expired.refresh(&f.a.id, false).unwrap().issue,
        Some(UsageIssue::Expired)
    );
    assert_eq!(requests.get(), 0);
    let wrong = Arc::new(AtomicBool::new(false));
    let manager = {
        let wrong = wrong.clone();
        UsageManager::new(
            f.store.clone(),
            deps(
                |_, _| Ok(cred()),
                move |endpoint, _| {
                    Ok(match endpoint {
                        UsageEndpoint::Profile if wrong.load(Ordering::SeqCst) => json!({}),
                        UsageEndpoint::Profile => profile(),
                        UsageEndpoint::Usage => limits(),
                    })
                },
                clock.now_fn(),
            ),
        )
    };
    manager.refresh(&f.a.id, false).unwrap();
    clock.add(300_000);
    wrong.store(true, Ordering::SeqCst);
    let u = manager.refresh(&f.a.id, false).unwrap();
    assert_eq!(u.issue, Some(UsageIssue::IdentityMismatch));
    assert_eq!(u.five_hour, None);
}

#[test]
fn confirmed_reconnect_clears_obsolete_auth_permission_and_transient_waits_and_resets_failures() {
    for issue in [
        UsageIssue::Expired,
        UsageIssue::Scope,
        UsageIssue::CredentialsMissing,
        UsageIssue::KeychainLocked,
        UsageIssue::Unavailable,
    ] {
        let f = fixture();
        let clock = Clock::new(noon());
        let failing = Arc::new(AtomicBool::new(true));
        let reads = Count::default();
        let manager = {
            let (failing, reads) = (failing.clone(), reads.clone());
            UsageManager::new(
                f.store.clone(),
                deps(
                    move |_, _| {
                        reads.bump();
                        if failing.load(Ordering::SeqCst) {
                            return Err(UsageError::new(issue));
                        }
                        Ok(cred())
                    },
                    answers,
                    clock.now_fn(),
                ),
            )
        };
        let retry =
            |u: &relay_core::shared::types::AccountUsage| ms(u.retry_at.as_deref().unwrap());
        let first = manager.refresh(&f.a.id, false).unwrap();
        assert_eq!(first.issue, Some(issue), "{issue:?}");
        clock.set(retry(&first));
        let second = manager.refresh(&f.a.id, false).unwrap();
        assert_eq!(retry(&second), clock.get() + 240_000, "{issue:?}");
        manager.invalidate(&f.a.id);
        let new_failure = manager.refresh(&f.a.id, false).unwrap();
        assert_eq!(reads.get(), 3, "reconnect permits an immediate new read");
        assert_eq!(retry(&new_failure), clock.get() + 120_000, "{issue:?}");
        failing.store(false, Ordering::SeqCst);
        manager.invalidate(&f.a.id);
        assert_eq!(
            manager.refresh(&f.a.id, false).unwrap().status,
            UsageStatus::Ready
        );
        assert_eq!(reads.get(), 4);
    }
}

#[test]
fn confirmed_reconnect_preserves_a_server_retry_after_and_exposes_why_polling_waits() {
    let f = fixture();
    let clock = Clock::new(noon());
    let limited = Arc::new(AtomicBool::new(false));
    let reads = Count::default();
    let retry_at = noon() + 900_000;
    let manager = {
        let (limited, reads) = (limited.clone(), reads.clone());
        Arc::new(UsageManager::new(
            f.store.clone(),
            deps(
                move |_, _| {
                    reads.bump();
                    Ok(cred())
                },
                move |endpoint, token| {
                    if limited.load(Ordering::SeqCst) {
                        return Err(UsageError::with_retry(
                            UsageIssue::RateLimited,
                            Some(retry_at as f64),
                            None,
                        ));
                    }
                    answers(endpoint, token)
                },
                clock.now_fn(),
            ),
        ))
    };
    manager.refresh(&f.a.id, false).unwrap();
    clock.add(60_000);
    limited.store(true, Ordering::SeqCst);
    assert_eq!(
        manager.refresh(&f.a.id, false).unwrap().issue,
        Some(UsageIssue::RateLimited)
    );
    manager.invalidate(&f.a.id);
    let waiting = snap(&manager, &f.a.id);
    assert_eq!(waiting.issue, Some(UsageIssue::RateLimited));
    assert_eq!(waiting.retry_at, Some(iso_at(retry_at)));
    assert_eq!(waiting.five_hour, None, "old login's quota is removed");
    assert!(!waiting.stale);
    manager.invalidate(&f.a.id);
    manager.refresh(&f.a.id, true).unwrap();
    // `tick` starts its reads on threads: what it would start is `due`, and it is nothing.
    assert!(manager.due().is_empty());
    manager.tick();
    assert_eq!(
        reads.get(),
        2,
        "neither reconnect nor manual refresh bypasses 429"
    );
    clock.set(retry_at);
    limited.store(false, Ordering::SeqCst);
    assert_eq!(
        manager.refresh(&f.a.id, false).unwrap().status,
        UsageStatus::Ready
    );
    assert_eq!(reads.get(), 3);
}

#[test]
fn an_earlier_logins_in_flight_completion_cannot_overwrite_or_undeduplicate_its_replacement() {
    for old_fails in [false, true] {
        for old_finishes_first in [false, true] {
            let name = format!(
                "{}, old finishes {}",
                if old_fails { "failure" } else { "success" },
                if old_finishes_first { "first" } else { "last" }
            );
            let f = fixture();
            let old_usage = Deferred::<Result<Value, UsageError>>::new();
            let new_usage = Deferred::<Result<Value, UsageError>>::new();
            let old_started = Deferred::<()>::new();
            let new_started = Deferred::<()>::new();
            let reads = Count::default();
            let requests = Count::default();
            let manager = {
                let reads = reads.clone();
                let requests = requests.clone();
                let (old_usage, new_usage) = (old_usage.clone(), new_usage.clone());
                let (old_started, new_started) = (old_started.clone(), new_started.clone());
                Arc::new(UsageManager::new(
                    f.store.clone(),
                    deps(
                        move |_, _| {
                            let token = if reads.bump() == 1 {
                                "old-fixture"
                            } else {
                                "new-fixture"
                            };
                            Ok(credential(token, cred().expires_at, &["user:profile"]))
                        },
                        move |endpoint, token| {
                            requests.bump();
                            if endpoint == UsageEndpoint::Profile {
                                return Ok(profile());
                            }
                            let old = token == "old-fixture";
                            (if old { &old_started } else { &new_started }).resolve(());
                            (if old { &old_usage } else { &new_usage }).wait()
                        },
                        Arc::new(noon),
                    ),
                ))
            };
            let original = spawn_refresh(&manager, &f.a.id, false);
            old_started.wait();
            manager.invalidate(&f.a.id);
            let replacement = spawn_refresh(&manager, &f.a.id, false);
            new_started.wait();
            let finish_old = || {
                old_usage.resolve(if old_fails {
                    Err(UsageError::new(UsageIssue::Expired))
                } else {
                    Ok(limits())
                });
            };
            let finish_new =
                || new_usage.resolve(Ok(json!({ "five_hour": { "utilization": 12 } })));
            if old_finishes_first {
                finish_old();
                original.join().unwrap();
                assert_eq!(
                    snap(&manager, &f.a.id).status,
                    UsageStatus::Loading,
                    "{name}"
                );
                assert_eq!(snap(&manager, &f.a.id).five_hour, None, "{name}");
                // A read asked now joins the replacement.
                let joined = spawn_refresh(&manager, &f.a.id, false);
                std::thread::sleep(Duration::from_millis(30));
                finish_new();
                let replaced = replacement.join().unwrap();
                assert_eq!(joined.join().unwrap(), replaced, "{name}");
            } else {
                finish_new();
                replacement.join().unwrap();
                finish_old();
                original.join().unwrap();
            }
            let latest = snap(&manager, &f.a.id);
            assert_eq!(latest.status, UsageStatus::Ready, "{name}");
            assert_eq!(latest.issue, None, "{name}");
            assert_eq!(
                latest.five_hour.map(|w| w.used_percent),
                Some(12.0),
                "{name}"
            );
            assert_eq!(reads.get(), 2, "{name}");
            assert_eq!(requests.get(), 4, "{name}");
        }
    }
}

#[test]
fn old_usage_never_silently_becomes_100_after_reset_manual_polling_mode_does_not_poll() {
    let f = fixture();
    let clock = Clock::new(noon());
    let reads = Count::default();
    let manager = {
        let reads = reads.clone();
        Arc::new(UsageManager::new(
            f.store.clone(),
            deps(
                move |_, _| {
                    reads.bump();
                    Ok(cred())
                },
                answers,
                clock.now_fn(),
            ),
        ))
    };
    f.store
        .update(|s| s.settings.usage_refresh_minutes = 0)
        .unwrap();
    assert!(manager.due().is_empty());
    manager.tick();
    assert_eq!(reads.get(), 0);
    manager.refresh(&f.a.id, false).unwrap();
    clock.set(ms("2026-10-13T16:01:00Z"));
    let u = snap(&manager, &f.a.id);
    assert!(u.stale);
    assert_eq!(u.five_hour.unwrap().used_percent, 91.3);
}

#[test]
fn _50_account_polling_has_at_most_two_concurrent_readers_and_isolates_each_profile() {
    let f = fixture();
    for i in 1..50 {
        create(
            &f.store,
            &format!("Account {i}"),
            AccountKind::Personal,
            None,
        );
    }
    let first = f.a.auth.clone();
    f.store
        .update(|s| s.accounts.iter_mut().for_each(|a| a.auth = first.clone()))
        .unwrap();
    let active = Arc::new(Mutex::new((0usize, 0usize)));
    let seen = Log::new();
    let manager = {
        let (active, seen) = (active.clone(), seen.clone());
        Arc::new(UsageManager::new(
            f.store.clone(),
            deps(
                move |profile_path, _| {
                    {
                        let mut a = active.lock().unwrap();
                        a.0 += 1;
                        a.1 = a.1.max(a.0);
                    }
                    seen.push(profile_path.to_path_buf());
                    std::thread::sleep(Duration::from_millis(2));
                    active.lock().unwrap().0 -= 1;
                    Ok(cred())
                },
                answers,
                Arc::new(noon),
            ),
        ))
    };
    let ids: Vec<String> = f
        .store
        .with_state(|s| s.accounts.iter().map(|a| a.id.clone()).collect());
    let results: Vec<_> = ids
        .iter()
        .map(|id| spawn_refresh(&manager, id, false))
        .collect::<Vec<_>>()
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect();
    assert_eq!(active.lock().unwrap().1, 2);
    let mut paths = seen.all();
    paths.sort();
    paths.dedup();
    assert_eq!(paths.len(), 50);
    assert!(results.iter().all(|r| r.status == UsageStatus::Ready));
}

#[test]
fn cached_quota_disappears_immediately_when_the_profiles_identity_changes() {
    let f = fixture();
    let manager = UsageManager::new(
        f.store.clone(),
        deps(|_, _| Ok(cred()), answers, Arc::new(noon)),
    );
    manager.refresh(&f.a.id, false).unwrap();
    assert!(snap(&manager, &f.a.id).five_hour.is_some());
    f.store
        .update(|s| s.accounts[0].auth.as_mut().unwrap().email = Some("new@example.test".into()))
        .unwrap();
    assert_eq!(snap(&manager, &f.a.id).five_hour, None);
    assert_eq!(snap(&manager, &f.a.id).status, UsageStatus::Idle);
}

#[test]
fn cached_quota_disappears_when_cli_uuid_or_organization_changes_with_the_same_email() {
    for field in ["accountUuid", "orgId"] {
        let f = fixture();
        let account_uuid = "11111111-1111-4111-8111-111111111111";
        let org_id = "22222222-2222-4222-8222-222222222222";
        let changed_id = "33333333-3333-4333-8333-333333333333";
        f.store
            .update(|s| {
                let auth = s.accounts[0].auth.as_mut().unwrap();
                auth.account_uuid = Some(account_uuid.into());
                auth.org_id = Some(org_id.into());
            })
            .unwrap();
        let manager = UsageManager::new(
            f.store.clone(),
            deps(
                |_, _| Ok(cred()),
                move |endpoint, _| {
                    Ok(match endpoint {
                        UsageEndpoint::Profile => json!({
                            "account": { "email_address": "a@example.test", "uuid": account_uuid },
                            "organization": { "uuid": org_id },
                        }),
                        UsageEndpoint::Usage => limits(),
                    })
                },
                Arc::new(noon),
            ),
        );
        assert_eq!(
            manager.refresh(&f.a.id, false).unwrap().status,
            UsageStatus::Ready
        );
        f.store
            .update(|s| {
                let auth = s.accounts[0].auth.as_mut().unwrap();
                match field {
                    "accountUuid" => auth.account_uuid = Some(changed_id.into()),
                    _ => auth.org_id = Some(changed_id.into()),
                }
            })
            .unwrap();
        let current = snap(&manager, &f.a.id);
        assert_eq!(current.five_hour, None, "{field}");
        assert_eq!(current.status, UsageStatus::Idle, "{field}");
    }
}

#[test]
fn a_model_specific_weekly_window_at_its_limit_is_reported_without_becoming_a_main_window() {
    let parsed = parse_usage(&json!({
        "five_hour": { "utilization": 40, "resets_at": "2026-10-13T20:00:00Z" },
        "seven_day": { "utilization": 70, "resets_at": "2026-10-18T05:00:00Z" },
        "seven_day_opus": { "utilization": 100, "resets_at": "2026-10-18T05:00:00Z" },
        "seven_day_oauth_apps": null,
    }))
    .unwrap();
    assert_eq!(parsed.other_limit_reached, Some(true));
    assert_eq!(parsed.five_hour.unwrap().used_percent, 40.0);
    assert_eq!(
        parse_usage(&json!({
            "five_hour": { "utilization": 10 },
            "seven_day_opus": { "utilization": 20 },
        }))
        .unwrap()
        .other_limit_reached,
        None
    );
}

#[test]
fn a_verified_read_restores_identity_fields_an_older_registry_lost_never_changing_existing_ones() {
    let f = fixture();
    let account_uuid = "11111111-1111-4111-8111-111111111111";
    let org_id = "22222222-2222-4222-8222-222222222222";
    f.store
        .update(|s| {
            s.accounts[0].desktop = Some(desktop(account_uuid, org_id, "2026-10-13T00:00:00.000Z"));
        })
        .unwrap();
    let verified = json!({
        "account": { "email_address": "a@example.test", "uuid": account_uuid },
        "organization": { "uuid": org_id, "name": "Example Org" },
    });
    let manager = {
        let verified = verified.clone();
        UsageManager::new(
            f.store.clone(),
            deps(
                |_, _| Ok(cred()),
                move |endpoint, _| {
                    Ok(match endpoint {
                        UsageEndpoint::Profile => verified.clone(),
                        UsageEndpoint::Usage => limits(),
                    })
                },
                Arc::new(noon),
            ),
        )
    };
    let result = manager.refresh(&f.a.id, false).unwrap();
    assert_eq!(result.status, UsageStatus::Ready);
    let repaired = f.store.account(&f.a.id).unwrap();
    let auth = repaired.auth.clone().unwrap();
    assert_eq!(auth.account_uuid.as_deref(), Some(account_uuid));
    assert_eq!(auth.org_id.as_deref(), Some(org_id));
    assert_eq!(auth.org_name.as_deref(), Some("Example Org"));
    assert_eq!(
        repaired.desktop.as_ref().unwrap().email.as_deref(),
        Some("a@example.test")
    );
    assert_eq!(snap(&manager, &f.a.id).status, UsageStatus::Ready);
    // A response for a different organization repairs nothing.
    let mut without_org = repaired.clone();
    without_org.auth.as_mut().unwrap().org_id = None;
    let mut other = verified.clone();
    other["organization"] = json!({ "uuid": uuid::Uuid::new_v4().to_string() });
    assert_eq!(missing_identity(&without_org, &other), None);
}

/// A local server answering one request with `status`, `body` and `headers`; its base URL.
fn reply(status: u16, body: &str, headers: &[(&str, &str)]) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let mut head = format!(
        "HTTP/1.1 {status} Status\r\ncontent-length: {}\r\nconnection: close\r\n",
        body.len()
    );
    if !headers.iter().any(|(k, _)| *k == "content-type") {
        head.push_str("content-type: application/json\r\n");
    }
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    let response = format!("{head}\r\n{body}");
    std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut request = Vec::new();
        let mut buf = [0u8; 1024];
        while !request.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = socket.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            request.extend_from_slice(&buf[..n]);
        }
        socket.write_all(response.as_bytes()).unwrap();
    });
    base
}

#[test]
fn a_403_asks_for_a_new_sign_in_only_when_anthropic_says_the_token_lacks_a_scope() {
    let issue = |base: String| {
        request_usage_json_at(&base, UsageEndpoint::Usage, "fixture-token")
            .err()
            .map(|e| (e.issue, e.detail.unwrap_or_default()))
    };
    let error = |kind: &str, message: &str| {
        json!({ "type": "error", "error": { "type": kind, "message": message } }).to_string()
    };
    assert_eq!(
        issue(reply(
            403,
            &error(
                "permission_error",
                "OAuth token does not meet scope requirement user:profile"
            ),
            &[]
        )),
        Some((UsageIssue::Scope, "usage 403 permission_error".into()))
    );
    // A gateway's page, or a refusal that names no scope, passes on its own.
    assert_eq!(
        issue(reply(
            403,
            "<html>Forbidden</html>",
            &[("content-type", "text/html")]
        )),
        Some((UsageIssue::Unavailable, "usage 403".into()))
    );
    assert_eq!(
        issue(reply(
            403,
            &error("permission_error", "Request not allowed"),
            &[]
        )),
        Some((UsageIssue::Unavailable, "usage 403 permission_error".into()))
    );
    assert_eq!(
        issue(reply(
            401,
            &error("authentication_error", "Invalid bearer token"),
            &[]
        )),
        Some((UsageIssue::Expired, "usage 401 authentication_error".into()))
    );
    assert_eq!(
        issue(reply(
            429,
            &error("rate_limit_error", "Rate limited."),
            &[("retry-after", "60")]
        )),
        Some((UsageIssue::RateLimited, "usage 429 rate_limit_error".into()))
    );
    assert!(scope_refusal(&ErrorBody {
        r#type: Some("permission_error".into()),
        message: Some("missing Scope".into()),
    }));
    assert!(!scope_refusal(&ErrorBody {
        r#type: Some("invalid_request_error".into()),
        message: Some("scope".into()),
    }));
}

#[test]
fn a_read_that_gets_no_answer_says_so_in_its_issues_detail() {
    assert_eq!(
        network_detail(Some("TypeError"), Some("ENOTFOUND")),
        "no answer: TypeError ENOTFOUND"
    );
    assert_eq!(
        network_detail(Some("TimeoutError"), None),
        "no answer: TimeoutError"
    );
}
