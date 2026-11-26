//! Port of `tests/usage-refresh.test.ts`.

#[path = "common/usage_refresh.rs"]
mod helpers;

use std::fs;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use helpers::{Fixture, NOW, failed, serial};
use relay_core::relay_paths::{Platform, home_dir};
use relay_core::shared::types::UsageIssue;
use relay_core::usage::UsageRequest;
use relay_core::usage_credentials::{UsageCredential, UsageError, parse_credential};
use relay_core::usage_refresh::{
    ProbeOutcome, USAGE_REFRESH_MAX_ATTEMPTS, USAGE_REFRESH_OFFLINE_RETRY_MS,
    USAGE_REFRESH_RETRY_MS, UsageCredentialRefresher, anthropic_unreachable,
    needs_usage_credential_refresh,
};
use serde_json::json;

const MAX_ATTEMPTS: usize = USAGE_REFRESH_MAX_ATTEMPTS as usize;

fn issue(result: Result<UsageCredential, UsageError>) -> UsageIssue {
    result.expect_err("the refresh must fail").issue
}

fn with_scopes(credential: &UsageCredential, scopes: &[&str]) -> UsageCredential {
    UsageCredential {
        scopes: scopes.iter().map(|s| s.to_string()).collect(),
        ..credential.clone()
    }
}

#[test]
fn refresh_token_parser_retains_bounded_main_process_refresh_fields_and_excludes_malformed_values()
{
    let now = NOW as f64;
    let value = parse_credential(
        &json!({
            "claudeAiOauth": {
                "accessToken": "fixture",
                "scopes": ["user:profile"],
                "refreshToken": "refresh",
                "refreshTokenExpiresAt": NOW,
                "clientId": "client",
                "secret": "do-not-return",
            }
        })
        .to_string(),
    )
    .unwrap();
    assert_eq!(value.refresh_token.as_deref(), Some("refresh"));
    assert_eq!(value.client_id.as_deref(), Some("client"));
    assert_eq!(value.refresh_token_expires_at, Some(now));
    // "secret" cannot be returned: UsageCredential has no field for it.
    for refresh_token in [json!("bad\nvalue"), json!("x".repeat(16_385)), json!(123)] {
        let parsed = parse_credential(
            &json!({
                "claudeAiOauth": {
                    "accessToken": "fixture",
                    "scopes": ["user:profile"],
                    "refreshToken": refresh_token,
                }
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(parsed.refresh_token, None);
    }
    assert!(
        parse_credential(
            &json!({ "claudeAiOauth": { "accessToken": "bad\0value", "scopes": ["user:profile"] } })
                .to_string()
        )
        .is_err()
    );
    assert!(
        parse_credential(
            r#"{"claudeAiOauth":{"accessToken":"fixture","expiresAt":1e999,"scopes":[]}}"#
        )
        .is_err()
    );
}

#[test]
fn credential_refresh_runs_five_minutes_before_expiry_and_does_not_invent_expiry_for_unknown_tokens()
 {
    let now = NOW as f64;
    let token = |expires_at: Option<f64>| UsageCredential {
        access_token: "x".into(),
        expires_at,
        ..UsageCredential::default()
    };
    assert!(needs_usage_credential_refresh(
        &token(Some(now + 300_000.0)),
        now
    ));
    assert!(!needs_usage_credential_refresh(
        &token(Some(now + 300_001.0)),
        now
    ));
    assert!(!needs_usage_credential_refresh(&token(None), now));
}

#[test]
fn supported_refresh_exchanges_once_in_an_isolated_hidden_auth_command_preserves_scopes_and_verifies_server_identity()
 {
    let _serial = serial();
    let f = Fixture::new();
    assert_eq!(f.refresh(&f.old).unwrap(), f.replacement);
    let calls = f.calls();
    assert_eq!(calls.len(), 1);
    let c = &calls[0];
    assert_eq!(
        c.args,
        [
            "--safe-mode",
            "--settings",
            r#"{"disableAllHooks":true}"#,
            "auth",
            "login",
            "--claudeai",
        ]
    );
    assert_eq!(c.cwd, f.profile);
    let env = |key: &str| c.env.get(key).map(String::as_str);
    assert_eq!(env("CLAUDE_CONFIG_DIR"), f.profile.to_str());
    assert_eq!(
        env("CLAUDE_CODE_OAUTH_REFRESH_TOKEN"),
        f.old.refresh_token.as_deref()
    );
    assert_eq!(
        env("CLAUDE_CODE_OAUTH_SCOPES"),
        Some(f.old.scopes.join(" ").as_str())
    );
    assert_eq!(
        env("CLAUDE_CODE_OAUTH_TOKEN"),
        Some(f.old.access_token.as_str())
    );
    assert_eq!(
        env("CLAUDE_CODE_OAUTH_CLIENT_ID"),
        f.old.client_id.as_deref()
    );
    for key in [
        "ANTHROPIC_API_KEY",
        "CLAUDECODE",
        "ELECTRON_RUN_AS_NODE",
        "NODE_OPTIONS",
    ] {
        assert_eq!(env(key), None, "{key}");
    }
    assert_eq!(f.requests(), ["profile"]);
    assert!(!f.refresher.any_active());
    assert_eq!(f.entries(), Vec::<String>::new());
}

#[test]
fn simultaneous_refreshes_and_separate_refresher_instances_share_one_profile_exchange() {
    let _serial = serial();
    let f = Fixture::new();
    let (release, wait) = mpsc::channel::<()>();
    let wait = Mutex::new(wait);
    let replacement = f.replacement.clone();
    f.run(move |s| {
        let _ = wait.lock().unwrap().recv();
        s.save(&replacement);
        Ok(())
    });
    let first = std::thread::spawn({
        let (refresher, account, profile, old) = (
            f.refresher.clone(),
            f.account.clone(),
            f.profile.clone(),
            f.old.clone(),
        );
        move || refresher.refresh(&account, &profile, &old, false, false)
    });
    let other = UsageCredentialRefresher::new(f.deps.clone());
    // The TS refresh registers before it returns its promise; here the first thread must start.
    let deadline = Instant::now() + Duration::from_secs(10);
    while !f.refresher.any_active() {
        assert!(Instant::now() < deadline, "the first refresh never started");
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(f.refresher.any_active());
    assert!(other.is_refreshing(&f.account.id));
    assert!(other.is_refreshing(f.profile.to_str().unwrap()));
    let second = std::thread::spawn({
        let (other, account, profile, old) = (
            other.clone(),
            f.account.clone(),
            f.profile.clone(),
            f.old.clone(),
        );
        move || other.refresh(&account, &profile, &old, false, false)
    });
    let foreign = f.account_with(|a| a.org_id = Some(uuid::Uuid::new_v4().to_string()));
    assert_eq!(
        issue(other.refresh(&foreign, &f.profile, &f.old, false, false)),
        UsageIssue::IdentityMismatch
    );
    // Let the second refresh reach the shared one before the exchange ends.
    std::thread::sleep(Duration::from_millis(100));
    release.send(()).unwrap();
    let first = first.join().unwrap();
    let second = second.join().unwrap();
    assert_eq!(first, Ok(f.replacement.clone()));
    // `first === second`: the same answer.
    assert_eq!(first, second);
    assert_eq!(f.calls().len(), 1);
}

#[test]
fn timeout_or_uncertain_rotation_persists_a_nonsecret_barrier_across_app_restart_and_never_exchanges_the_same_pair_twice()
 {
    let _serial = serial();
    let f = Fixture::new();
    f.run(|_| {
        Err(UsageError::with_detail(
            UsageIssue::Expired,
            "timeout fixture-secret-must-not-propagate",
        ))
    });
    assert_eq!(issue(f.refresh(&f.old)), UsageIssue::Expired);
    let journal = fs::read_to_string(f.journal()).unwrap();
    assert!(!journal.contains("fixture-old-access"));
    assert!(!journal.contains("fixture-old-refresh"));
    let restarted = UsageCredentialRefresher::new(f.deps.clone());
    assert_eq!(
        issue(restarted.refresh(&f.account, &f.profile, &f.old, false, false)),
        UsageIssue::Expired
    );
    assert_eq!(f.calls().len(), 1);
    f.save(&f.replacement);
    assert_eq!(
        restarted
            .refresh(&f.account, &f.profile, &f.replacement, false, false)
            .unwrap(),
        f.replacement
    );
    assert_eq!(f.calls().len(), 1);
    assert_eq!(f.entries(), Vec::<String>::new());
}

#[test]
fn a_command_error_after_saved_replacement_is_reconciled_without_a_second_exchange() {
    let _serial = serial();
    let f = Fixture::new();
    let replacement = f.replacement.clone();
    f.run(move |s| {
        s.save(&replacement);
        Err(failed())
    });
    assert_eq!(f.refresh(&f.old).unwrap(), f.replacement);
    assert_eq!(f.calls().len(), 1);
}

#[test]
fn successful_cli_exit_without_persisted_replacement_never_becomes_fresh_usage() {
    let _serial = serial();
    let f = Fixture::new();
    f.run(|_| Ok(()));
    assert_eq!(issue(f.refresh(&f.old)), UsageIssue::Expired);
    assert_eq!(f.requests(), Vec::<String>::new());
    assert_eq!(issue(f.refresh(&f.old)), UsageIssue::Expired);
    assert_eq!(f.calls().len(), 1);
}

#[test]
fn saved_credentials_from_a_different_account_or_organization_fail_identity_verification_and_retain_the_attempt()
 {
    let _serial = serial();
    for kind in ["account", "organization"] {
        let f = Fixture::new();
        let auth = f.account.auth.clone().unwrap();
        let other = uuid::Uuid::new_v4().to_string();
        f.server(json!({
            "account": {
                "uuid": if kind == "account" { Some(other.clone()) } else { auth.account_uuid.clone() },
                "email_address": auth.email,
            },
            "organization": {
                "uuid": if kind == "organization" { Some(other) } else { auth.org_id.clone() },
            },
        }));
        assert_eq!(issue(f.refresh(&f.old)), UsageIssue::IdentityMismatch);
        assert!(fs::metadata(f.journal()).is_ok());
        assert_eq!(f.calls().len(), 1);
    }
}

#[test]
fn existing_official_refresh_lock_denied_profile_guard_and_inference_less_credentials_block_before_any_exchange()
 {
    let _serial = serial();
    let f = Fixture::new();
    let lock = f.profile.join(".oauth_refresh.lock");
    fs::create_dir(&lock).unwrap();
    assert_eq!(issue(f.refresh(&f.old)), UsageIssue::Unavailable);
    assert!(fs::metadata(&lock).unwrap().is_dir());
    assert_eq!(f.calls().len(), 0);
    fs::remove_dir(&lock).unwrap();
    f.allow(false);
    assert_eq!(issue(f.refresh(&f.old)), UsageIssue::Unavailable);
    assert_eq!(f.calls().len(), 0);
    f.allow(true);
    f.save(&with_scopes(&f.old, &["user:profile"]));
    assert_eq!(
        issue(f.refresh(&with_scopes(&f.old, &["user:profile"]))),
        UsageIssue::Expired
    );
    assert_eq!(f.calls().len(), 0);
}

#[test]
fn missing_expired_refresh_token_and_unknown_enrolled_identity_require_browser_reconnection() {
    let _serial = serial();
    for missing in [true, false] {
        let f = Fixture::new();
        let credential = if missing {
            UsageCredential {
                refresh_token: None,
                ..f.old.clone()
            }
        } else {
            UsageCredential {
                refresh_token_expires_at: Some(NOW as f64 - 1.0),
                ..f.old.clone()
            }
        };
        f.save(&credential);
        assert_eq!(issue(f.refresh(&credential)), UsageIssue::Expired);
        assert_eq!(f.calls().len(), 0);
    }
    let f = Fixture::new();
    let unknown = f.account_with(|a| a.account_uuid = None);
    assert_eq!(
        issue(
            f.refresher
                .refresh(&unknown, &f.profile, &f.old, false, false)
        ),
        UsageIssue::IdentityMismatch
    );
    assert_eq!(f.calls().len(), 0);
}

#[test]
fn server_401_can_force_refresh_before_local_expiry_while_an_already_replaced_fresh_pair_skips_exchange()
 {
    let _serial = serial();
    let f = Fixture::new();
    let still_valid = UsageCredential {
        expires_at: Some(NOW as f64 + 3_600_000.0),
        ..f.old.clone()
    };
    f.save(&still_valid);
    assert_eq!(
        f.refresher
            .refresh(&f.account, &f.profile, &still_valid, true, false)
            .unwrap(),
        f.replacement
    );
    assert_eq!(f.calls().len(), 1);
    let g = Fixture::new();
    g.save(&g.replacement);
    assert_eq!(g.refresh(&g.old).unwrap(), g.replacement);
    assert_eq!(g.calls().len(), 0);
}

#[test]
fn dropped_credential_scopes_or_corrupt_uncertainty_journal_cannot_silently_restart_rotation() {
    let _serial = serial();
    let f = Fixture::new();
    let narrowed = with_scopes(&f.replacement, &["user:profile"]);
    let saved = narrowed.clone();
    f.run(move |s| {
        s.save(&saved);
        Ok(())
    });
    assert_eq!(issue(f.refresh(&f.old)), UsageIssue::Scope);
    assert!(fs::metadata(f.journal()).is_ok());
    assert_eq!(issue(f.refresh(&narrowed)), UsageIssue::Scope);
    assert_eq!(f.calls().len(), 1);
    let g = Fixture::new();
    fs::write(g.journal(), "{broken").unwrap();
    assert_eq!(issue(g.refresh(&g.old)), UsageIssue::Expired);
    assert_eq!(g.calls().len(), 0);
}

#[cfg(unix)]
#[test]
fn symlinked_profiles_global_default_profile_and_symlinked_journals_are_refused() {
    use std::os::unix::fs::symlink;
    let _serial = serial();
    let f = Fixture::new();
    let alias = f.profile.join("alias");
    symlink(&f.profile, &alias).unwrap();
    let refresh = |profile: &std::path::Path| {
        f.refresher
            .refresh(&f.account, profile, &f.old, false, false)
    };
    assert_eq!(issue(refresh(&alias)), UsageIssue::CredentialsMissing);
    assert_eq!(
        issue(refresh(std::path::Path::new("relative-profile"))),
        UsageIssue::CredentialsMissing
    );
    assert_eq!(
        issue(refresh(&home_dir().join(".claude"))),
        UsageIssue::CredentialsMissing
    );
    fs::write(f.profile.join("other"), "{}").unwrap();
    symlink(f.profile.join("other"), f.journal()).unwrap();
    assert_eq!(issue(f.refresh(&f.old)), UsageIssue::Expired);
    assert_eq!(f.calls().len(), 0);
}

#[test]
fn lost_official_lock_ownership_preserves_the_rotation_barrier_and_never_removes_the_replacement_lock()
 {
    let _serial = serial();
    let f = Fixture::new();
    let vendor_lock = f.profile.join(".oauth_refresh.lock");
    let (replacement, lock, moved) = (
        f.replacement.clone(),
        vendor_lock.clone(),
        f.profile.join("old-vendor-lock"),
    );
    f.run(move |s| {
        s.save(&replacement);
        fs::rename(&lock, &moved).unwrap();
        fs::create_dir(&lock).unwrap();
        Ok(())
    });
    assert_eq!(issue(f.refresh(&f.old)), UsageIssue::Expired);
    assert!(fs::metadata(&vendor_lock).unwrap().is_dir());
    assert!(fs::metadata(f.journal()).is_ok());
    assert_eq!(f.calls().len(), 1);
}

#[test]
fn a_credential_replaced_by_another_process_before_acquiring_the_vendor_lock_is_re_read_and_never_rotated_again()
 {
    let _serial = serial();
    let f = Fixture::new();
    let checks = Arc::new(AtomicUsize::new(0));
    let (shared, replacement) = (f.shared.clone(), f.replacement.clone());
    let mut deps = f.deps.clone();
    deps.can_proceed = Some(Arc::new(move |_, _| {
        if checks.fetch_add(1, Ordering::SeqCst) + 1 == 3 {
            shared.save(&replacement);
        }
        true
    }));
    let refresher = UsageCredentialRefresher::new(deps);
    assert_eq!(
        refresher
            .refresh(&f.account, &f.profile, &f.old, false, false)
            .unwrap(),
        f.replacement
    );
    assert_eq!(f.calls().len(), 0);
    assert_eq!(f.requests(), ["profile"]);
}

#[test]
fn a_concurrent_replacement_cannot_drop_requested_scopes_before_the_vendor_lock_is_acquired() {
    let _serial = serial();
    let f = Fixture::new();
    let checks = Arc::new(AtomicUsize::new(0));
    let (shared, narrowed) = (
        f.shared.clone(),
        with_scopes(&f.replacement, &["user:profile"]),
    );
    let mut deps = f.deps.clone();
    deps.can_proceed = Some(Arc::new(move |_, _| {
        if checks.fetch_add(1, Ordering::SeqCst) + 1 == 3 {
            shared.save(&narrowed);
        }
        true
    }));
    assert_eq!(
        issue(
            UsageCredentialRefresher::new(deps)
                .refresh(&f.account, &f.profile, &f.old, false, false)
        ),
        UsageIssue::Scope
    );
    assert_eq!(f.calls().len(), 0);
    assert_eq!(f.requests(), Vec::<String>::new());
}

#[test]
fn a_saved_replacement_whose_identity_proof_failed_transiently_reconciles_while_fresh_without_another_exchange()
 {
    let _serial = serial();
    let f = Fixture::new();
    let proof_fails = Arc::new(AtomicBool::new(true));
    let inner = f.deps.request.clone().unwrap();
    let fails = proof_fails.clone();
    let request: UsageRequest = Arc::new(move |endpoint, token: &str| {
        if fails.load(Ordering::SeqCst) {
            return Err(UsageError::with_detail(
                UsageIssue::Unavailable,
                "temporary network failure",
            ));
        }
        inner(endpoint, token)
    });
    let mut deps = f.deps.clone();
    deps.request = Some(request);
    let refresher = UsageCredentialRefresher::new(deps);
    let error = refresher
        .refresh(&f.account, &f.profile, &f.old, false, false)
        .unwrap_err();
    assert_eq!(error.detail.as_deref(), Some("temporary network failure"));
    assert!(refresher.has_pending(&f.profile));
    proof_fails.store(false, Ordering::SeqCst);
    assert_eq!(
        refresher
            .refresh(&f.account, &f.profile, &f.replacement, false, false)
            .unwrap(),
        f.replacement
    );
    assert!(!refresher.has_pending(&f.profile));
    assert_eq!(f.calls().len(), 1);
}

#[test]
fn macos_background_renewal_runs_one_isolated_exchange_like_other_platforms() {
    let _serial = serial();
    let f = Fixture::new();
    let mut deps = f.deps.clone();
    deps.platform = Some(Platform::MacOs);
    let refresher = UsageCredentialRefresher::new(deps);
    assert_eq!(
        refresher
            .refresh(&f.account, &f.profile, &f.old, false, false)
            .unwrap(),
        f.replacement
    );
    assert_eq!(f.calls().len(), 1);
    assert!(!refresher.has_pending(&f.profile));
}

#[test]
fn an_unconfirmed_exchange_is_retried_after_a_delay_or_on_request_then_requires_reconnecting() {
    let _serial = serial();
    let f = Fixture::new();
    let clock = Arc::new(AtomicI64::new(NOW));
    let mut deps = f.deps.clone();
    let read = clock.clone();
    deps.now = Some(Arc::new(move || read.load(Ordering::SeqCst)));
    let refresher = UsageCredentialRefresher::new(deps);
    let refresh =
        |interactive: bool| refresher.refresh(&f.account, &f.profile, &f.old, false, interactive);
    f.run(|_| Err(failed()));
    assert_eq!(issue(refresh(false)), UsageIssue::Expired);
    assert_eq!(f.calls().len(), 1);
    assert!(refresher.has_pending(&f.profile));
    // The unchanged pair is not exchanged again in the background right away.
    assert_eq!(issue(refresh(false)), UsageIssue::Expired);
    assert_eq!(f.calls().len(), 1);
    // An explicit renewal may retry immediately.
    assert_eq!(issue(refresh(true)), UsageIssue::Expired);
    assert_eq!(f.calls().len(), 2);
    // After the delay, a background read retries once more and then stops.
    clock.fetch_add(USAGE_REFRESH_RETRY_MS as i64, Ordering::SeqCst);
    assert_eq!(issue(refresh(false)), UsageIssue::Expired);
    assert_eq!(f.calls().len(), MAX_ATTEMPTS);
    clock.fetch_add(USAGE_REFRESH_RETRY_MS as i64, Ordering::SeqCst);
    assert_eq!(issue(refresh(true)), UsageIssue::Expired);
    assert_eq!(f.calls().len(), MAX_ATTEMPTS);
    // A browser reconnect saves a new pair, which reconciles the barrier.
    let reconnected = UsageCredential {
        expires_at: Some(clock.load(Ordering::SeqCst) as f64 + 3_600_000.0),
        ..f.replacement.clone()
    };
    f.save(&reconnected);
    assert_eq!(refresh(false).unwrap(), reconnected);
    assert!(!refresher.has_pending(&f.profile));
}

#[test]
fn macos_background_pending_reconciliation_verifies_an_already_saved_replacement_without_interactive_permission_or_exchange()
 {
    let _serial = serial();
    let f = Fixture::new();
    let mut deps = f.deps.clone();
    deps.platform = Some(Platform::MacOs);
    let refresher = UsageCredentialRefresher::new(deps);
    f.run(|_| Err(failed()));
    assert_eq!(
        issue(refresher.refresh(&f.account, &f.profile, &f.old, false, true)),
        UsageIssue::Expired
    );
    assert!(refresher.has_pending(&f.profile));
    f.save(&f.replacement);
    assert_eq!(
        refresher
            .refresh(&f.account, &f.profile, &f.replacement, false, false)
            .unwrap(),
        f.replacement
    );
    assert_eq!(f.calls().len(), 1);
    assert!(!refresher.has_pending(&f.profile));
    assert_eq!(f.requests(), ["profile"]);
}

#[test]
fn a_renewal_that_falls_on_a_dropped_network_waits_two_minutes_counts_nothing_and_asks_for_no_sign_in()
 {
    let _serial = serial();
    let f = Fixture::new();
    let clock = Arc::new(AtomicI64::new(NOW));
    let offline = Arc::new(AtomicBool::new(true));
    let mut deps = f.deps.clone();
    let read = clock.clone();
    deps.now = Some(Arc::new(move || read.load(Ordering::SeqCst)));
    let unreachable = offline.clone();
    deps.unreachable = Some(Arc::new(move || unreachable.load(Ordering::SeqCst)));
    let refresher = UsageCredentialRefresher::new(deps);
    let refresh = || refresher.refresh(&f.account, &f.profile, &f.old, false, false);
    let offline_ms = USAGE_REFRESH_OFFLINE_RETRY_MS as i64;
    f.run(|_| Err(failed()));
    // No answer from Anthropic: transient, retried soon.
    let error = refresh().unwrap_err();
    assert_eq!(error.issue, UsageIssue::Unavailable);
    assert_eq!(
        error.retry_at,
        Some(clock.load(Ordering::SeqCst) as f64 + USAGE_REFRESH_OFFLINE_RETRY_MS)
    );
    assert_eq!(error.detail.as_deref(), Some("refresh: no network"));
    assert_eq!(f.calls().len(), 1);
    // Within the two minutes a background read neither exchanges nor asks for a sign-in.
    clock.fetch_add(offline_ms - 1, Ordering::SeqCst);
    assert_eq!(issue(refresh()), UsageIssue::Unavailable);
    assert_eq!(f.calls().len(), 1);
    // Many offline tries never use up the attempts a real refusal gets.
    for _ in 0..MAX_ATTEMPTS + 1 {
        clock.fetch_add(offline_ms, Ordering::SeqCst);
        assert_eq!(issue(refresh()), UsageIssue::Unavailable);
    }
    assert_eq!(f.calls().len(), MAX_ATTEMPTS + 2);
    // Back online, the next exchange renews the sign-in.
    offline.store(false, Ordering::SeqCst);
    clock.fetch_add(offline_ms, Ordering::SeqCst);
    let renewed = UsageCredential {
        expires_at: Some(clock.load(Ordering::SeqCst) as f64 + 3_600_000.0),
        ..f.replacement.clone()
    };
    let saved = renewed.clone();
    f.run(move |s| {
        s.save(&saved);
        Ok(())
    });
    assert_eq!(refresh().unwrap(), renewed);
    assert!(!refresher.has_pending(&f.profile));
}

#[test]
fn a_renewal_anthropic_answered_but_saved_nothing_for_still_counts_and_waits_half_an_hour() {
    let _serial = serial();
    let f = Fixture::new();
    let mut deps = f.deps.clone();
    deps.unreachable = Some(Arc::new(|| false));
    let refresher = UsageCredentialRefresher::new(deps);
    let refresh = || refresher.refresh(&f.account, &f.profile, &f.old, false, false);
    f.run(|_| Err(failed()));
    let error = refresh().unwrap_err();
    assert_eq!(error.issue, UsageIssue::Expired);
    assert_eq!(
        error.detail.as_deref(),
        Some("refresh: no new sign-in saved")
    );
    assert_eq!(issue(refresh()), UsageIssue::Expired);
    assert_eq!(f.calls().len(), 1);
}

#[test]
fn anthropic_is_unreachable_only_when_a_request_gets_no_answer_at_all() {
    // A 404 and a 403 are answers.
    assert!(!anthropic_unreachable(&|| ProbeOutcome::Answered));
    // fetch's TypeError: no network.
    assert!(anthropic_unreachable(&|| ProbeOutcome::Network));
    // A TimeoutError.
    assert!(anthropic_unreachable(&|| ProbeOutcome::Timeout));
    // Any other failure.
    assert!(!anthropic_unreachable(&|| ProbeOutcome::Other));
}
