//! Port of `tests/cli-read.test.ts`: read commands. macOS only, as the TS skips elsewhere.
#![cfg(target_os = "macos")]

mod common;
// The lock holder in its own process, shared with relay-core's lock tests (tests/lock-child.ts).
#[path = "../../relay-core/tests/lock_child/mod.rs"]
mod lock_child;

use common::{Options, cli_fixture};
use lock_child::hold_in_child;
use relay_core::desktop_files::{json_bytes, write_bytes};
use serde_json::{Value, json};

#[test]
fn list_marks_the_account_claude_desktop_is_signed_in_to_in_a_table_and_as_json() {
    let f = cli_fixture(Options::default());
    let (a, _) = f.saved("A", None);
    let (b, _) = f.saved("Work", Some("Vertex")); // Desktop is now signed in to Work
    assert_eq!(f.run(&["list"]), 0);
    let out = f.out();
    let lines: Vec<&str> = out.split('\n').collect();
    assert!(
        lines
            .iter()
            .find(|l| l.contains("Work"))
            .unwrap()
            .starts_with('*')
    );
    assert!(
        lines
            .iter()
            .find(|l| l.split_whitespace().any(|w| w == "A"))
            .unwrap()
            .starts_with(' ')
    );
    assert!(out.contains("work · Vertex"));
    f.clear();
    assert_eq!(f.run(&["list", "--json"]), 0);
    let rows: Value = serde_json::from_str(&f.out()).unwrap();
    let picked: Vec<Value> = rows
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            serde_json::json!([
                r["id"],
                r["name"],
                r["kind"],
                r["active"],
                r["desktop"]["linked"],
                r["limits"]
            ])
        })
        .collect();
    assert_eq!(
        picked,
        vec![
            serde_json::json!([a.id, "A", "personal", false, true, "not-connected"]),
            serde_json::json!([b.id, "Work", "work", true, true, "not-connected"]),
        ]
    );
    assert!(!f.out().contains("FIXTURE-SECRET"));
}

#[test]
fn list_with_no_accounts_says_how_to_add_one() {
    let f = cli_fixture(Options::default());
    assert_eq!(f.run(&["ls"]), 0);
    assert!(f.out().contains("relay add"));
}

#[test]
fn status_names_the_active_account_and_an_unknown_one_as_unsaved() {
    let f = cli_fixture(Options::default());
    f.saved("A", None);
    f.state.lock().unwrap().running = true;
    assert_eq!(f.run(&["status"]), 0);
    assert!(f.out().contains("running"));
    assert!(f.out().contains("signed in as A"));
    f.clear();
    let config = json!({
        "oauth:tokenCacheV2": "FIXTURE-SECRET-x",
        "lastKnownAccountUuid": uuid::Uuid::new_v4().to_string(),
    });
    write_bytes(&f.claude, "config.json", Some(&json_bytes(&config))).unwrap();
    assert_eq!(f.run(&["status", "--json"]), 0);
    let s: Value = serde_json::from_str(&f.out()).unwrap();
    assert_eq!(s["desktop"]["running"], true);
    assert!(s["desktop"]["account"].is_object());
    assert!(s["desktop"]["account"].get("id").is_none());
    assert_eq!(s["relay"]["vault"], "ready");
    assert_eq!(s["relay"]["appRunning"], false);
    assert_eq!(s["relay"]["historyMode"], "same-group");
    f.clear();
    f.run(&["status"]);
    assert!(f.out().contains("unsaved account"));
    assert!(!f.out().contains("FIXTURE-SECRET"));
}

#[test]
fn status_shows_a_pending_sign_in_and_a_lock_held_by_another_process() {
    let f = cli_fixture(Options::default());
    let (a, _) = f.saved("A", None);
    let pending = json!({ "profileId": a.id, "startedAt": "2026-10-19T09:00:00.000Z" });
    write_bytes(&f.vault(), "pending.json", Some(&json_bytes(&pending))).unwrap();
    let _child = hold_in_child(&f.vault().join("operation.lock"), "switch", "cli", 0);
    assert_eq!(f.run(&["status", "--json"]), 0);
    let s: Value = serde_json::from_str(&f.out()).unwrap();
    assert_eq!(
        s["desktop"]["pendingSignIn"],
        json!({ "name": "A", "since": "2026-10-19T09:00:00.000Z" })
    );
    assert_eq!(s["relay"]["lock"]["by"], "cli");
    assert_eq!(s["relay"]["lock"]["kind"], "switch");
    f.clear();
    f.run(&["status", "--lang", "tr"]);
    assert!(f.out().contains("relay add --resume"));
    assert!(f.out().contains("Başka bir relay komutu"));
}

#[test]
fn relay_app_shows_as_running_from_the_process_list() {
    let mut f = cli_fixture(Options {
        app_version: Some("0.12.0".into()),
        ..Options::default()
    });
    f.deps.process_list = std::sync::Arc::new(|| {
        Ok("  501     1 /Applications/Relay.app/Contents/MacOS/Relay\n".into())
    });
    f.run(&["status", "--json"]);
    let s: Value = serde_json::from_str(&f.out()).unwrap();
    assert_eq!(s["relay"]["appRunning"], true);
    assert_eq!(s["relay"]["appVersion"], "0.12.0");
}

#[test]
fn status_and_list_never_write_the_registry() {
    let f = cli_fixture(Options::default());
    f.saved("A", None);
    let file = f.home.join("state.json");
    let before = std::fs::metadata(&file).unwrap().modified().unwrap();
    f.run(&["status"]);
    f.run(&["list"]);
    assert_eq!(
        std::fs::metadata(&file).unwrap().modified().unwrap(),
        before
    );
}

#[test]
fn a_lock_held_for_an_app_task_is_described_in_words_not_as_a_raw_kind() {
    let f = cli_fixture(Options::default());
    f.saved("A", None);
    f.saved("B", None); // B is open in Claude, so switching to A needs the lock
    let _child = hold_in_child(&f.vault().join("operation.lock"), "draft-retype", "app", 0);
    f.run(&["status"]);
    assert!(f.out().contains("re-typing a draft"));
    f.clear();
    assert_eq!(f.run(&["switch", "A", "--yes"]), 3);
    assert!(f.err().contains("Relay.app is re-typing a draft"));
}
