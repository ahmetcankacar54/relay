//! Port of the `SignInRenewal`, `renewalDue` and `approvalStep` cases of
//! `tests/sign-in-renewal.test.ts`. The `UsageManager` cases are in `sign_in_renewal_usage.rs`
//! (Usage's slice); the `renewalDue` check that ends "an expired sign-in for any other reason…"
//! is here as `an_expired_read_alone_is_not_the_end`.

use std::fs;
use std::sync::{Arc, Mutex};

use relay_core::fs_util::{iso_timestamp, parse_iso_ms};
use relay_core::quiet_approval::{ApprovalButton, ApprovalPage, ApprovalStep, approval_step};
use relay_core::shared::types::{
    Account, AccountAuth, AccountDesktop, AccountKind, AccountProvider, AccountUsage, UsageIssue,
    UsageStatus,
};
use relay_core::sign_in_renewal::{
    RENEW_BEFORE_MS, RENEW_RETRY_MS, RenewalDue, RenewalResult, SignInRenewal, SignInRenewalDeps,
    renewal_due,
};
use serde_json::Value;

const DAY: i64 = 86_400_000;
const UUID: &str = "aaaaaaaa-1111-4111-8111-111111111111";
const ORG: &str = "bbbbbbbb-2222-4222-8222-222222222222";

fn start() -> i64 {
    parse_iso_ms("2026-11-19T05:30:00Z").unwrap()
}

fn account(id: &str) -> Account {
    let mut account = Account::new(id, "Vertex");
    account.kind = AccountKind::Work;
    account.color = "#000".into();
    account.created_at = iso_timestamp(start());
    account.auth = Some(AccountAuth {
        logged_in: true,
        email: Some("a@example.test".into()),
        account_uuid: Some(UUID.into()),
        org_id: Some(ORG.into()),
        checked_at: iso_timestamp(start()),
        ..Default::default()
    });
    account.desktop = Some(AccountDesktop {
        account_uuid: UUID.into(),
        org_id: ORG.into(),
        saved_at: iso_timestamp(start()),
        email: None,
        rejected_at: None,
    });
    account
}

fn ends(ms: i64) -> AccountUsage {
    let mut usage = AccountUsage::new("acc-1", UsageStatus::Ready);
    usage.cli_sign_in_ends_at = Some(iso_timestamp(start() + ms));
    usage
}

fn failed(detail: &str) -> RenewalResult {
    RenewalResult::Failed {
        detail: detail.into(),
    }
}

#[test]
fn renewal_is_due_three_days_before_the_end_at_the_end_and_never_for_an_account_without_the_claude_app()
 {
    let now = start();
    assert_eq!(
        renewal_due(&account("acc-1"), Some(&ends(RENEW_BEFORE_MS + DAY)), now),
        None
    );
    assert_eq!(
        renewal_due(&account("acc-1"), Some(&ends(RENEW_BEFORE_MS - 1)), now),
        Some(RenewalDue {
            ends_at: Some(iso_timestamp(now + RENEW_BEFORE_MS - 1))
        })
    );
    let mut ended = AccountUsage::new("acc-1", UsageStatus::Ready);
    ended.cli_sign_in_ended = Some(true);
    assert_eq!(
        renewal_due(&account("acc-1"), Some(&ended), now),
        Some(RenewalDue::default())
    );
    // An "expired" read alone is not the end: only the end said by the read is.
    let mut expired = AccountUsage::new("acc-1", UsageStatus::Error);
    expired.issue = Some(UsageIssue::Expired);
    assert_eq!(renewal_due(&account("acc-1"), Some(&expired), now), None);
    // A Claude Code sign-in of another workspace than the Claude app's is never renewed from it.
    let mut other = account("acc-1");
    other.desktop.as_mut().unwrap().org_id = "cccccccc-3333-4333-8333-333333333333".into();
    assert_eq!(renewal_due(&other, Some(&ends(DAY)), now), None);
    let mut no_desktop = account("acc-1");
    no_desktop.desktop = None;
    assert_eq!(renewal_due(&no_desktop, Some(&ends(DAY)), now), None);
    let mut codex = account("acc-1");
    codex.provider = Some(AccountProvider::Codex);
    assert_eq!(renewal_due(&codex, Some(&ends(DAY)), now), None);
    let mut no_auth = account("acc-1");
    no_auth.auth = None;
    assert_eq!(renewal_due(&no_auth, Some(&ends(DAY)), now), None);
}

/// The `renewalDue` check of "an expired sign-in for any other reason is not taken for the 30-day end".
#[test]
fn an_expired_read_alone_is_not_the_end() {
    let mut usage = AccountUsage::new("acc-1", UsageStatus::Error);
    usage.issue = Some(UsageIssue::Expired);
    assert_eq!(renewal_due(&account("acc-1"), Some(&usage), start()), None);
}

struct Fixture {
    renewal: SignInRenewal,
    renewed: Arc<Mutex<Vec<String>>>,
    told: Arc<Mutex<Vec<Option<String>>>>,
    file: std::path::PathBuf,
    now: Arc<Mutex<i64>>,
    _dir: tempfile::TempDir,
}

impl Fixture {
    fn advance(&self, ms: i64) {
        *self.now.lock().unwrap() += ms;
    }
    fn renewed(&self) -> Vec<String> {
        self.renewed.lock().unwrap().clone()
    }
    fn told(&self) -> Vec<Option<String>> {
        self.told.lock().unwrap().clone()
    }
    fn saved(&self) -> Value {
        serde_json::from_str(&fs::read_to_string(&self.file).unwrap()).unwrap()
    }
}

fn renewal_fixture(outcomes: Vec<RenewalResult>, usage: AccountUsage) -> Fixture {
    let dir = tempfile::Builder::new()
        .prefix("relay-renewal-")
        .tempdir()
        .unwrap();
    let file = dir.path().join("sign-in-renewal.json");
    let now = Arc::new(Mutex::new(start()));
    let renewed = Arc::new(Mutex::new(Vec::new()));
    let told = Arc::new(Mutex::new(Vec::new()));
    let outcomes = Mutex::new(std::collections::VecDeque::from(outcomes));
    let renewal = SignInRenewal::new(SignInRenewalDeps {
        file: file.clone(),
        accounts: Box::new(|| vec![account("acc-1")]),
        usage: Box::new(move |_| Some(usage.clone())),
        renew: Box::new({
            let renewed = renewed.clone();
            move |a| {
                renewed.lock().unwrap().push(a.id.clone());
                Ok(outcomes
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or_else(|| failed("no more")))
            }
        }),
        notify: Box::new({
            let told = told.clone();
            move |_, ends_at| told.lock().unwrap().push(ends_at.map(str::to_owned))
        }),
        now: Some(Box::new({
            let now = now.clone();
            move || *now.lock().unwrap()
        })),
    });
    Fixture {
        renewal,
        renewed,
        told,
        file,
        now,
        _dir: dir,
    }
}

#[test]
fn a_failed_renewal_is_said_once_per_end_date_and_retried_after_six_hours() {
    let ends_at = iso_timestamp(start() + 2 * DAY);
    let mut usage = AccountUsage::new("acc-1", UsageStatus::Ready);
    usage.cli_sign_in_ends_at = Some(ends_at.clone());
    let f = renewal_fixture(
        vec![
            failed("no-approval: no approve button"),
            RenewalResult::Unavailable {
                detail: "no claude.ai session".into(),
            },
        ],
        usage,
    );
    f.renewal.tick();
    assert_eq!(f.renewed(), ["acc-1"]);
    assert_eq!(f.told(), [Some(ends_at.clone())]);
    // Within the retry delay nothing runs.
    f.advance(RENEW_RETRY_MS - 1);
    f.renewal.tick();
    assert_eq!(f.renewed().len(), 1);
    // After it, one more try; the same end date is not said again.
    f.advance(1);
    f.renewal.tick();
    assert_eq!(f.renewed().len(), 2);
    assert_eq!(f.told(), [Some(ends_at)]);
    let saved = f.saved();
    assert_eq!(saved["accounts"]["acc-1"]["result"], "unavailable");
    assert_eq!(saved["accounts"]["acc-1"]["detail"], "no claude.ai session");
}

#[test]
fn a_renewal_that_connects_tells_no_one() {
    let f = renewal_fixture(vec![RenewalResult::Connected], ends(DAY));
    f.renewal.tick();
    assert_eq!(f.renewed(), ["acc-1"]);
    assert!(f.told().is_empty());
}

#[test]
fn the_hidden_window_approves_only_on_claude_ai_only_a_whole_approve_label_and_stops_at_a_sign_in_form()
 {
    let page = |buttons: &[&str]| ApprovalPage {
        host: "claude.ai".into(),
        path: "/oauth/authorize".into(),
        login_form: false,
        buttons: buttons
            .iter()
            .map(|text| ApprovalButton {
                text: (*text).into(),
                disabled: false,
            })
            .collect(),
    };
    assert_eq!(
        approval_step(&page(&["Cancel", "Authorize"])),
        ApprovalStep::Click { index: 1 }
    );
    assert_eq!(
        approval_step(&page(&["İptal", "Yetkilendir"])),
        ApprovalStep::Click { index: 1 }
    );
    assert_eq!(
        approval_step(&page(&["Continue with Google"])),
        ApprovalStep::Wait
    );
    let mut evil = page(&["Authorize"]);
    evil.host = "evil.example".into();
    assert_eq!(approval_step(&evil), ApprovalStep::Wait);
    let mut login = page(&["Continue with email"]);
    login.login_form = true;
    assert_eq!(approval_step(&login), ApprovalStep::SignedOut);
    let mut login_path = page(&[]);
    login_path.path = "/login".into();
    assert_eq!(approval_step(&login_path), ApprovalStep::SignedOut);
    let mut disabled = page(&[]);
    disabled.buttons = vec![ApprovalButton {
        text: "Authorize".into(),
        disabled: true,
    }];
    assert_eq!(approval_step(&disabled), ApprovalStep::Wait);
}

#[test]
fn asked_by_the_user_a_renewal_runs_at_once_whether_due_or_not_and_tells_no_one_an_allowed_keychain_lets_a_waiting_one_run_again()
 {
    let f = renewal_fixture(
        vec![
            RenewalResult::Unavailable {
                detail: "claude.ai session not readable: keychain-locked".into(),
            },
            RenewalResult::Connected,
            RenewalResult::Connected,
        ],
        ends(DAY),
    );
    f.renewal.tick();
    assert_eq!(f.renewed().len(), 1);
    assert_eq!(f.told().len(), 1);
    // Inside the retry delay, an allowed Keychain runs it again at once.
    f.renewal.retry_unavailable();
    assert_eq!(f.renewed().len(), 2);
    // Not due at all: the user's own request still runs, and says nothing.
    let now = f.renewal.renew_now(&account("acc-1"));
    assert_eq!(now, RenewalResult::Connected);
    assert_eq!(f.renewed().len(), 3);
    assert_eq!(f.told().len(), 1);
}

#[test]
fn an_account_waiting_for_a_fresh_claude_ai_sign_in_is_said_once_looked_at_again_on_every_pass_and_does_not_hold_up_the_next_account()
 {
    let dir = tempfile::tempdir().unwrap();
    let now = Arc::new(Mutex::new(start()));
    let tried = Arc::new(Mutex::new(Vec::<String>::new()));
    let told = Arc::new(Mutex::new(Vec::<String>::new()));
    let outcomes = Mutex::new(std::collections::HashMap::from([
        (
            "first".to_owned(),
            std::collections::VecDeque::from([
                RenewalResult::Waiting {
                    detail: "claude.ai sign-in is 120 h old".into(),
                },
                RenewalResult::Connected,
            ]),
        ),
        (
            "second".to_owned(),
            std::collections::VecDeque::from([RenewalResult::Connected]),
        ),
    ]));
    let renewal = SignInRenewal::new(SignInRenewalDeps {
        file: dir.path().join("sign-in-renewal.json"),
        accounts: Box::new(|| vec![account("first"), account("second")]),
        usage: Box::new(|id| {
            let days = if id == "first" { 1 } else { 2 };
            let mut usage = AccountUsage::new("x", UsageStatus::Ready);
            usage.cli_sign_in_ends_at = Some(iso_timestamp(start() + days * DAY));
            Some(usage)
        }),
        renew: Box::new({
            let tried = tried.clone();
            move |a| {
                tried.lock().unwrap().push(a.id.clone());
                Ok(outcomes
                    .lock()
                    .unwrap()
                    .get_mut(&a.id)
                    .unwrap()
                    .pop_front()
                    .unwrap())
            }
        }),
        notify: Box::new({
            let told = told.clone();
            move |a, _| told.lock().unwrap().push(a.id.clone())
        }),
        now: Some(Box::new({
            let now = now.clone();
            move || *now.lock().unwrap()
        })),
    });
    renewal.tick();
    // The first only waits, so the second is renewed in the same pass.
    assert_eq!(*tried.lock().unwrap(), ["first", "second"]);
    assert_eq!(*told.lock().unwrap(), ["first"]);
    // Fifteen minutes later, not six hours: the fresh sign-in is used.
    *now.lock().unwrap() += 15 * 60_000;
    renewal.tick();
    assert_eq!(*tried.lock().unwrap(), ["first", "second", "first"]);
    assert_eq!(*told.lock().unwrap(), ["first"]);
}

#[test]
fn a_renewal_that_could_not_start_for_a_passing_reason_tells_no_one_and_leaves_the_schedule_alone()
{
    let f = renewal_fixture(
        vec![
            RenewalResult::Busy {
                detail: "Claude app busy".into(),
            },
            RenewalResult::Connected,
        ],
        ends(DAY),
    );
    f.renewal.tick();
    assert!(f.told().is_empty());
    // The next pass, minutes later, tries for real.
    f.advance(15 * 60_000);
    f.renewal.tick();
    assert_eq!(f.renewed().len(), 2);
    assert!(f.told().is_empty());
    assert_eq!(f.saved()["accounts"]["acc-1"]["result"], "connected");
}
