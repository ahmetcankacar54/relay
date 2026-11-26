//! Port of tests/auto-capture.test.ts. Its first `readSignIn` case ("a sign-in is ready once a
//! new account is signed in and Code has a workspace") is in tests/auto_capture_sign_in.rs.

use std::sync::{Arc, Mutex};

use relay_core::auto_capture::{AUTO_CAPTURE_LIMIT_MS, AutoCapture, AutoCaptureDeps};
use relay_core::desktop::{DesktopError, DesktopResult};
use relay_core::desktop_session::SignInNotSettled;
use relay_core::shared::types::{
    Account, AccountAuth, AccountDesktop, AutoCaptureState, AutoCaptureStatus, DesktopState,
    OrgHint,
};
use relay_core::sign_in_wait::{SignInReading, read_sign_in};

const NEW: &str = "00000000-0000-4000-8000-0000000000a1";
const OLD: &str = "00000000-0000-4000-8000-0000000000b2";
const ORG: &str = "00000000-0000-4000-8000-0000000000c3";
const ORG2: &str = "00000000-0000-4000-8000-0000000000d4";

fn account(id: &str, uuid: Option<&str>) -> Account {
    let mut account = Account::new(id, format!("Acc {id}"));
    account.desktop = uuid.map(|u| AccountDesktop {
        account_uuid: u.into(),
        org_id: ORG.into(),
        saved_at: String::new(),
        ..Default::default()
    });
    account
}

fn state(pending: Option<&str>, current: Option<&str>, orgs: &[&str]) -> DesktopState {
    DesktopState {
        available: true,
        running: true,
        pending_profile_id: pending.map(str::to_string),
        current_account_uuid: current.map(str::to_string),
        organizations: orgs.iter().map(|o| o.to_string()).collect(),
        ..Default::default()
    }
}

fn hinted(org_id: &str, certain: bool) -> DesktopState {
    DesktopState {
        org_hint: Some(OrgHint {
            org_id: org_id.into(),
            certain,
        }),
        ..state(Some("p"), Some(NEW), &[ORG, ORG2])
    }
}

#[derive(Default)]
struct Recorded {
    now: f64,
    i: usize,
    captures: Vec<(String, String)>,
    changes: usize,
}

struct Deps {
    readings: Vec<DesktopState>,
    accounts: Vec<Account>,
    fail: Option<DesktopError>,
    recorded: Arc<Mutex<Recorded>>,
}

impl AutoCaptureDeps for Deps {
    fn snapshot(&self) -> DesktopResult<DesktopState> {
        let mut recorded = self.recorded.lock().unwrap();
        let reading = self.readings[recorded.i.min(self.readings.len() - 1)].clone();
        recorded.i += 1;
        Ok(reading)
    }
    fn accounts(&self) -> Vec<Account> {
        self.accounts.clone()
    }
    fn capture(&self, account_id: &str, org_id: &str) -> DesktopResult<()> {
        self.recorded
            .lock()
            .unwrap()
            .captures
            .push((account_id.into(), org_id.into()));
        match &self.fail {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }
    fn changed(&self) {
        self.recorded.lock().unwrap().changes += 1;
    }
    fn now(&self) -> f64 {
        self.recorded.lock().unwrap().now
    }
}

struct Harness {
    auto: AutoCapture,
    recorded: Arc<Mutex<Recorded>>,
}

impl Harness {
    fn captures(&self) -> Vec<(String, String)> {
        self.recorded.lock().unwrap().captures.clone()
    }
    fn advance(&self, ms: f64) {
        self.recorded.lock().unwrap().now += ms;
    }
}

fn harness(
    readings: Vec<DesktopState>,
    accounts: Option<Vec<Account>>,
    fail: Option<DesktopError>,
) -> Harness {
    let recorded = Arc::new(Mutex::new(Recorded::default()));
    let auto = AutoCapture::new(Deps {
        readings,
        accounts: accounts.unwrap_or_else(|| vec![account("p", None)]),
        fail,
        recorded: Arc::clone(&recorded),
    });
    Harness { auto, recorded }
}

fn captured(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect()
}

fn capture_state(status: AutoCaptureStatus) -> AutoCaptureState {
    AutoCaptureState {
        account_id: "p".into(),
        status,
        orgs: None,
        suggested_org: None,
        already_saved: None,
        error: None,
    }
}

#[test]
fn the_sign_in_is_saved_by_itself_at_the_first_tick_that_finds_it_ready_once() {
    let h = harness(
        vec![
            state(Some("p"), None, &[]),
            state(Some("p"), Some(NEW), &[ORG]),
        ],
        None,
        None,
    );
    h.auto.tick();
    assert_eq!(h.auto.state(), None, "nothing happens before it is armed");
    h.auto.arm("p");
    h.auto.tick();
    assert_eq!(
        h.auto.state().map(|s| s.status),
        Some(AutoCaptureStatus::Waiting)
    );
    h.auto.tick();
    assert_eq!(h.captures(), captured(&[("p", ORG)]));
    assert_eq!(
        h.auto.state(),
        Some(capture_state(AutoCaptureStatus::Saved))
    );
    h.auto.tick();
    assert_eq!(h.captures().len(), 1);
}

#[test]
fn several_workspaces_wait_for_the_users_pick_a_saved_account_signed_in_instead_is_named() {
    let h = harness(
        vec![
            state(Some("p"), Some(OLD), &[ORG]),
            state(Some("p"), Some(NEW), &[ORG, ORG2]),
        ],
        Some(vec![account("p", None), account("q", Some(OLD))]),
        None,
    );
    h.auto.arm("p");
    h.auto.tick();
    assert_eq!(
        h.auto.state(),
        Some(AutoCaptureState {
            already_saved: Some("Acc q".into()),
            ..capture_state(AutoCaptureStatus::Waiting)
        })
    );
    h.auto.tick();
    assert_eq!(
        h.auto.state(),
        Some(AutoCaptureState {
            orgs: Some(vec![ORG.into(), ORG2.into()]),
            ..capture_state(AutoCaptureStatus::ChooseOrg)
        })
    );
    assert!(
        h.auto
            .choose("p", "00000000-0000-4000-8000-0000000000ff")
            .is_err()
    );
    h.auto.choose("p", ORG2).unwrap();
    assert_eq!(h.captures(), captured(&[("p", ORG2)]));
    assert_eq!(
        h.auto.state().map(|s| s.status),
        Some(AutoCaptureStatus::Saved)
    );
}

#[test]
fn a_failed_save_a_sign_in_pending_for_another_profile_and_the_time_limit_end_the_wait() {
    let failing = harness(
        vec![state(Some("p"), Some(NEW), &[ORG])],
        None,
        Some(DesktopError::new("Claude is still running.")),
    );
    failing.auto.arm("p");
    failing.auto.tick();
    assert_eq!(
        failing.auto.state(),
        Some(AutoCaptureState {
            error: Some("Claude is still running.".into()),
            ..capture_state(AutoCaptureStatus::Failed)
        })
    );
    let other = harness(vec![state(Some("x"), None, &[])], None, None);
    other.auto.arm("p");
    other.auto.tick();
    assert_eq!(
        other.auto.state().and_then(|s| s.error).as_deref(),
        Some("other-pending")
    );
    let slow = harness(vec![state(Some("p"), None, &[])], None, None);
    slow.auto.arm("p");
    slow.advance(AUTO_CAPTURE_LIMIT_MS + 1.0);
    slow.auto.tick();
    assert_eq!(
        slow.auto.state().and_then(|s| s.error).as_deref(),
        Some("timeout")
    );
    slow.auto.disarm(Some("someone-else"));
    assert!(slow.auto.state().is_some());
    slow.auto.disarm(None);
    assert_eq!(slow.auto.state(), None);
}

#[test]
fn the_workspace_the_claude_app_is_in_is_saved_without_asking_a_mere_suggestion_waits_for_the_user()
{
    let sure = harness(vec![hinted(ORG2, true)], None, None);
    sure.auto.arm("p");
    sure.auto.tick();
    assert_eq!(sure.captures(), captured(&[("p", ORG2)]));
    assert_eq!(
        sure.auto.state().map(|s| s.status),
        Some(AutoCaptureStatus::Saved)
    );

    let unsure = harness(vec![hinted(ORG2, false)], None, None);
    unsure.auto.arm("p");
    unsure.auto.tick();
    assert_eq!(unsure.captures(), Vec::new());
    assert_eq!(
        unsure.auto.state(),
        Some(AutoCaptureState {
            orgs: Some(vec![ORG.into(), ORG2.into()]),
            suggested_org: Some(ORG2.into()),
            ..capture_state(AutoCaptureStatus::ChooseOrg)
        })
    );
    unsure.auto.choose("p", ORG2).unwrap();
    assert_eq!(unsure.captures(), captured(&[("p", ORG2)]));
    assert_eq!(
        unsure.auto.state(),
        Some(capture_state(AutoCaptureStatus::Saved))
    );
}

#[test]
fn a_sign_in_claude_has_not_written_to_its_cookie_file_yet_is_saved_at_a_later_tick_not_failed() {
    let ready = state(Some("p"), Some(NEW), &[ORG]);
    let h = harness(vec![ready], None, Some(SignInNotSettled.into()));
    h.auto.arm("p");
    h.auto.tick();
    assert_eq!(
        h.auto.state().map(|s| s.status),
        Some(AutoCaptureStatus::Waiting)
    );
    h.auto.tick();
    assert_eq!(h.captures().len(), 2);
}

fn ready(preferred: Option<&str>, suggested: Option<&str>) -> SignInReading {
    SignInReading::Ready {
        account_uuid: NEW.into(),
        orgs: vec![ORG.into(), ORG2.into()],
        preferred: preferred.map(str::to_string),
        suggested: suggested.map(str::to_string),
    }
}

fn signed_in_as(account_uuid: &str, org_id: &str) -> Vec<Account> {
    vec![Account {
        auth: Some(AccountAuth {
            logged_in: true,
            checked_at: String::new(),
            account_uuid: Some(account_uuid.into()),
            org_id: Some(org_id.into()),
            ..Default::default()
        }),
        ..account("p", None)
    }]
}

#[test]
fn with_several_workspaces_the_one_the_profiles_usage_sign_in_or_the_claude_app_names_is_preferred()
{
    let several = state(Some("p"), Some(NEW), &[ORG, ORG2]);
    let hint = |org_id: &str, certain: bool| DesktopState {
        org_hint: Some(OrgHint {
            org_id: org_id.into(),
            certain,
        }),
        ..several.clone()
    };
    let plain = [account("p", None)];
    // Nothing says which: the user chooses, with no suggestion.
    assert_eq!(read_sign_in(&several, &plain, "p"), ready(None, None));
    // The app only used ORG2 last: offered first, still the user's choice.
    assert_eq!(
        read_sign_in(&hint(ORG2, false), &plain, "p"),
        ready(None, Some(ORG2))
    );
    // The app names ORG2 for this sign-in: saved without asking.
    assert_eq!(
        read_sign_in(&hint(&ORG2.to_uppercase(), true), &plain, "p"),
        ready(Some(ORG2), Some(ORG2))
    );
    // The profile's own usage sign-in is this account in ORG2: that decides, whatever the app
    // used last.
    assert_eq!(
        read_sign_in(&hint(ORG, true), &signed_in_as(NEW, ORG2), "p"),
        ready(Some(ORG2), Some(ORG2))
    );
    // A usage sign-in of another account, or in a workspace the app does not have, decides
    // nothing.
    assert_eq!(
        read_sign_in(&several, &signed_in_as(OLD, ORG2), "p"),
        ready(None, None)
    );
}
