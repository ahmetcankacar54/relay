//! Port of the `UsageManager` cases of `tests/sign-in-renewal.test.ts`. Skipped (another slice:
//! `electron/core/sign-in-renewal` and `quiet-approval`, not in relay-core yet): "renewal is due
//! three days before the end…", "a failed renewal is said once per end date…", "a renewal that
//! connects tells no one", "the hidden window approves only on claude.ai…", "asked by the user, a
//! renewal runs at once…", "an account waiting for a fresh claude.ai sign-in is said once…" and
//! "a renewal that could not start for a passing reason…". "an expired sign-in for any other
//! reason…" ends with a `renewalDue` check, left out for the same reason.

#[path = "common/usage_manager.rs"]
mod helpers;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use helpers::*;
use relay_core::shared::account_state::cli_needs_reconnect;
use relay_core::shared::types::{Account, AccountKind, UsageIssue, UsageSource, UsageStatus};
use relay_core::usage::{DesktopUsageSource, UsageEndpoint, UsageManager};
use relay_core::usage_credentials::{UsageCredential, UsageError};
use relay_core::usage_refresh::SIGN_IN_ENDED;
use serde_json::{Value, json};

const DAY: i64 = 86_400_000;
const UUID: &str = "aaaaaaaa-1111-4111-8111-111111111111";
const ORG: &str = "bbbbbbbb-2222-4222-8222-222222222222";

fn start() -> i64 {
    ms("2026-11-19T05:30:00Z")
}

struct Fixture {
    _t: Temp,
    id: String,
    manager: UsageManager,
    issues: Log<(UsageIssue, Option<String>)>,
    store: Arc<relay_core::store::Store>,
}

type AppRead = Arc<dyn Fn(&Account, bool) -> Result<Value, UsageError> + Send + Sync>;

fn usage_fixture(
    cli: impl Fn() -> Result<UsageCredential, UsageError> + Send + Sync + 'static,
    app: Option<AppRead>,
) -> Fixture {
    let t = temp_store("relay-renewal-");
    let created = create(&t.store, "Vertex", AccountKind::Work, None);
    t.store
        .update(|s| {
            let mut a = auth(Some("a@example.test"), &iso_at(start()));
            a.account_uuid = Some(UUID.into());
            a.org_id = Some(ORG.into());
            s.accounts[0].auth = Some(a);
            s.accounts[0].desktop = Some(desktop(UUID, ORG, &iso_at(start())));
        })
        .unwrap();
    let issues = Log::new();
    let mut d = deps(
        move |_, _| cli(),
        |endpoint, _| {
            Ok(match endpoint {
                UsageEndpoint::Profile => json!({
                    "account": { "uuid": UUID, "email": "a@example.test" },
                    "organization": { "uuid": ORG },
                }),
                UsageEndpoint::Usage => json!({ "five_hour": {
                    "utilization": 42,
                    "resets_at": iso_at(start() + 3_600_000),
                }}),
            })
        },
        Arc::new(start),
    );
    let log = issues.clone();
    d.on_issue = Some(Arc::new(move |_, issue, detail| {
        log.push((issue, detail.map(str::to_owned)))
    }));
    d.desktop_usage = app.map(|read| DesktopUsageSource {
        usable: Arc::new(|_| true),
        read,
    });
    let manager = UsageManager::new(t.store.clone(), d);
    Fixture {
        store: t.store.clone(),
        _t: t,
        id: created.id,
        manager,
        issues,
    }
}

fn ended() -> UsageError {
    UsageError::with_detail(UsageIssue::Expired, SIGN_IN_ENDED)
}

#[test]
fn a_read_through_the_claude_code_sign_in_says_when_that_sign_in_ends() {
    let end = start() + 20 * DAY;
    let f = usage_fixture(
        move || {
            Ok(UsageCredential {
                access_token: "x".into(),
                expires_at: Some((start() + 8 * 3_600_000) as f64),
                refresh_token: Some("r".into()),
                refresh_token_expires_at: Some(end as f64),
                scopes: vec!["user:profile".into(), "user:inference".into()],
                ..UsageCredential::default()
            })
        },
        None,
    );
    let usage = f.manager.refresh(&f.id, false).unwrap();
    assert_eq!(usage.status, UsageStatus::Ready);
    assert_eq!(usage.source, Some(UsageSource::Cli));
    assert_eq!(usage.cli_sign_in_ends_at, Some(iso_at(end)));
    assert_eq!(usage.cli_sign_in_ended, None);
}

#[test]
fn an_ended_claude_code_sign_in_reads_the_limits_through_the_claude_app_and_still_asks_for_a_sign_in()
 {
    let f = usage_fixture(
        || Err(ended()),
        Some(Arc::new(|_, _| {
            Ok(
                json!({ "five_hour": { "utilization": 17, "resets_at": iso_at(start() + 3_600_000) } }),
            )
        })),
    );
    let usage = f.manager.refresh(&f.id, false).unwrap();
    assert_eq!(usage.status, UsageStatus::Ready);
    assert_eq!(usage.issue, None);
    assert_eq!(usage.source, Some(UsageSource::Desktop));
    assert_eq!(usage.cli_sign_in_ended, Some(true));
    assert_eq!(usage.five_hour.as_ref().unwrap().used_percent, 17.0);
    // Logged once, with the reason, so the diagnosis log tells it from a network failure.
    assert_eq!(
        f.issues.all(),
        vec![(
            UsageIssue::Expired,
            Some(
                "refresh: sign-in reached its end date; limits read through the Claude app".into()
            )
        )]
    );
    // The account keeps asking for a new Claude Code sign-in.
    assert!(cli_needs_reconnect(
        &f.store.account(&f.id).unwrap(),
        Some(&usage)
    ));
}

#[test]
fn when_the_claude_app_cannot_answer_either_the_ended_sign_in_is_what_the_read_reports_and_it_says_the_end_came()
 {
    let f = usage_fixture(
        || Err(ended()),
        Some(Arc::new(|_, _| {
            Err(UsageError::new(UsageIssue::KeychainLocked))
        })),
    );
    let usage = f.manager.refresh(&f.id, false).unwrap();
    assert_eq!(usage.status, UsageStatus::Error);
    assert_eq!(usage.issue, Some(UsageIssue::Expired));
    assert_eq!(usage.cli_sign_in_ended, Some(true));
}

#[test]
fn an_expired_sign_in_for_any_other_reason_is_not_taken_for_the_30_day_end_no_read_through_the_app_no_end_said()
 {
    let app_reads = Count::default();
    let reads = app_reads.clone();
    let f = usage_fixture(
        || {
            Err(UsageError::with_detail(
                UsageIssue::Expired,
                "refresh: saved sign-in cannot be renewed",
            ))
        },
        Some(Arc::new(move |_, _| {
            reads.bump();
            Ok(json!({}))
        })),
    );
    let usage = f.manager.refresh(&f.id, false).unwrap();
    assert_eq!(usage.issue, Some(UsageIssue::Expired));
    assert_eq!(usage.cli_sign_in_ended, None);
    assert_eq!(app_reads.get(), 0);
}

#[test]
fn a_read_failing_for_another_reason_never_falls_back_to_the_claude_app() {
    let app_reads = Count::default();
    let reads = app_reads.clone();
    let f = usage_fixture(
        || Err(UsageError::new(UsageIssue::Unavailable)),
        Some(Arc::new(move |_, _| {
            reads.bump();
            Ok(json!({}))
        })),
    );
    assert_eq!(
        f.manager.refresh(&f.id, false).unwrap().issue,
        Some(UsageIssue::Unavailable)
    );
    assert_eq!(app_reads.get(), 0);
}

#[test]
fn asked_by_the_user_an_ended_sign_in_reads_through_the_claude_app_inside_the_failure_backoff_allowed_to_ask_the_keychain()
 {
    let prompts = Log::<bool>::new();
    let app_works = Arc::new(AtomicBool::new(false));
    let (log, works) = (prompts.clone(), app_works.clone());
    let f = usage_fixture(
        || Err(ended()),
        Some(Arc::new(move |_, allow_prompt| {
            log.push(allow_prompt);
            if !works.load(Ordering::SeqCst) {
                return Err(UsageError::new(UsageIssue::KeychainLocked));
            }
            Ok(json!({ "five_hour": { "utilization": 5 } }))
        })),
    );
    assert_eq!(
        f.manager.refresh(&f.id, false).unwrap().issue,
        Some(UsageIssue::Expired)
    );
    app_works.store(true, Ordering::SeqCst);
    // A background poll waits out the backoff.
    assert_eq!(
        f.manager.refresh(&f.id, false).unwrap().issue,
        Some(UsageIssue::Expired)
    );
    let asked = f.manager.refresh(&f.id, true).unwrap();
    assert_eq!(asked.cli_sign_in_ended, Some(true));
    assert_eq!(prompts.all(), vec![false, true]);
}
