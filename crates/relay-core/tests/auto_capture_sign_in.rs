//! The `readSignIn` case of `tests/auto-capture.test.ts`; the AutoCapture cases belong to the
//! auto-capture port.

use relay_core::shared::types::{Account, AccountDesktop, DesktopState};
use relay_core::sign_in_wait::read_sign_in;
use serde_json::json;

const NEW: &str = "00000000-0000-4000-8000-0000000000a1";
const OLD: &str = "00000000-0000-4000-8000-0000000000b2";
const ORG: &str = "00000000-0000-4000-8000-0000000000c3";

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

#[test]
fn a_sign_in_is_ready_once_a_new_account_is_signed_in_and_code_has_a_workspace() {
    let accounts = [account("p", None), account("q", Some(OLD))];
    let read = |s: DesktopState, id: &str| read_sign_in(&s, &accounts, id);
    assert_eq!(
        serde_json::to_value(read(state(Some("p"), None, &[]), "p")).unwrap(),
        json!({ "kind": "waiting" })
    );
    assert_eq!(
        serde_json::to_value(read(state(Some("p"), Some(NEW), &[]), "p")).unwrap(),
        json!({ "kind": "waiting" })
    );
    assert_eq!(
        serde_json::to_value(read(state(Some("p"), Some(NEW), &[ORG]), "p")).unwrap(),
        json!({ "kind": "ready", "accountUuid": NEW, "orgs": [ORG] })
    );
    // The first account: open in Claude and never saved, with no pending sign-in.
    assert_eq!(read(state(None, Some(NEW), &[ORG]), "p").kind(), "ready");
    assert_eq!(
        read(state(Some("p"), Some(OLD), &[ORG]), "p").kind(),
        "saved-elsewhere"
    );
    assert_eq!(
        read(state(Some("q"), None, &[]), "p").kind(),
        "other-pending"
    );
    // A renewed sign-in of the profile's own account is saved again; without a pending one it is done.
    assert_eq!(
        read(state(Some("q"), Some(OLD), &[ORG]), "q").kind(),
        "ready"
    );
    assert_eq!(read(state(None, Some(OLD), &[ORG]), "q").kind(), "done");
}
