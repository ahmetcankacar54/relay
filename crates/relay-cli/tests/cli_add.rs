//! Port of `tests/cli-add.test.ts`: `relay add`. The macOS-only cases skip elsewhere, as the TS.
#![cfg_attr(not(target_os = "macos"), allow(dead_code, unused_imports))]

mod common;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use common::{Fixture, Options, cli_fixture};
use relay_cli::io::Signal;
use relay_core::desktop_files::{json_bytes, read_object, write_bytes};
use relay_core::shared::types::{AccountKind, CreateAccount};
use serde_json::json;

fn identity(claude: &Path) -> Option<String> {
    read_object(claude, "config.json").unwrap().and_then(|o| {
        o.get("lastKnownAccountUuid")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
    })
}

fn pending_file(home: &Path) -> PathBuf {
    home.join("desktop-vault").join("pending.json")
}

fn until(check: impl Fn() -> bool) {
    let end = Instant::now() + Duration::from_secs(30);
    while !check() {
        assert!(Instant::now() <= end, "timed out");
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// `t.after(() => f.signal("SIGINT"))`: a failed assertion must not leave the waiting run hanging.
struct InterruptOnDrop<'a>(&'a Fixture);

impl Drop for InterruptOnDrop<'_> {
    fn drop(&mut self) {
        self.0.signal(Signal::Int);
    }
}

/// Runs `argv` on another thread while `during` runs here; the run's exit code.
fn run_while(f: &Fixture, argv: &[&str], during: impl FnOnce()) -> i32 {
    std::thread::scope(|s| {
        let done = s.spawn(|| f.run(argv));
        let _interrupt = InterruptOnDrop(f);
        during();
        done.join().unwrap()
    })
}

fn names(f: &Fixture) -> Vec<String> {
    f.store()
        .state()
        .accounts
        .iter()
        .map(|a| a.name.clone())
        .collect()
}

#[cfg(target_os = "macos")]
#[test]
fn add_saves_the_unsaved_account_signed_in_to_claude_desktop() {
    let f = cli_fixture(Options::default());
    let (account_uuid, orgs) = f.account_in_desktop(1);
    assert_eq!(f.run(&["add", "Kişisel", "--yes"]), 0);
    let accounts = f.store().state().accounts;
    let account = &accounts[0];
    assert_eq!(account.name, "Kişisel");
    assert_eq!(account.desktop.as_ref().unwrap().account_uuid, account_uuid);
    assert_eq!(account.desktop.as_ref().unwrap().org_id, orgs[0]);
    assert_eq!(f.quits(), 1);
    assert!(f.out().contains("Saved Kişisel"));
    assert!(!(f.out() + &f.err()).contains("FIXTURE-SECRET"));
}

#[cfg(target_os = "macos")]
#[test]
fn add_work_group_makes_a_work_account_in_that_group() {
    let f = cli_fixture(Options::default());
    f.account_in_desktop(1);
    assert_eq!(
        f.run(&["add", "Work", "--work", "--group", "Vertex", "--yes"]),
        0
    );
    let accounts = f.store().state().accounts;
    assert_eq!(accounts[0].kind, AccountKind::Work);
    assert_eq!(accounts[0].group, "work:Vertex");
}

#[cfg(target_os = "macos")]
#[test]
fn add_new_signs_a_new_account_in_and_waits_for_it() {
    let f = cli_fixture(Options::default());
    f.saved("A", None);
    let mut signed = None;
    let code = run_while(
        &f,
        &["add", "B", "--new", "--yes", "--poll-ms", "10"],
        || {
            until(|| pending_file(&f.home).exists());
            signed = Some(f.account_in_desktop(1));
        },
    );
    assert_eq!(code, 0);
    let accounts = f.store().state().accounts;
    let b = accounts.iter().find(|x| x.name == "B").unwrap();
    assert_eq!(b.desktop.as_ref().unwrap().account_uuid, signed.unwrap().0);
    assert!(!pending_file(&f.home).exists());
    assert!(f.out().contains("Sign in"));
}

#[cfg(target_os = "macos")]
#[test]
fn several_workspaces_no_terminal_exits_2_org_or_a_numbered_answer_picks_one() {
    let f = cli_fixture(Options::default());
    let (_, orgs) = f.account_in_desktop(2);
    assert_eq!(f.run(&["add", "W", "--yes"]), 2);
    assert_eq!(f.store().state().accounts.len(), 0);
    assert_eq!(f.run(&["add", "W", "--yes", "--org", &orgs[1]]), 0);
    assert_eq!(
        f.store().state().accounts[0]
            .desktop
            .as_ref()
            .unwrap()
            .org_id,
        orgs[1]
    );
    let g = cli_fixture(Options {
        tty: true,
        answers: vec![Some("2".into()), Some("y".into())],
        ..Options::default()
    });
    let (_, other) = g.account_in_desktop(2);
    assert_eq!(g.run(&["add", "W"]), 0);
    let out = g.out();
    // `/2\) ([0-9a-f-]{36})/`
    let at = out.find("2) ").expect("a numbered second workspace") + 3;
    let second = &out[at..at + 36];
    assert!(
        second
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-'))
    );
    assert!(other.iter().any(|o| o == second));
    assert_eq!(
        g.store().state().accounts[0]
            .desktop
            .as_ref()
            .unwrap()
            .org_id,
        second
    );
}

#[cfg(target_os = "macos")]
#[test]
fn ctrl_c_while_waiting_keeps_the_sign_in_pending_cancel_restores_the_previous_one() {
    let f = cli_fixture(Options::default());
    let (a, _) = f.saved("A", None);
    // The wait listens for Ctrl+C from the line it prints; before it, the operation's own shield does.
    let code = run_while(
        &f,
        &["add", "C", "--new", "--yes", "--poll-ms", "20"],
        || {
            until(|| f.out().contains("open the Code tab once; waiting"));
            f.signal(Signal::Int);
        },
    );
    assert_eq!(code, 1);
    assert!(pending_file(&f.home).exists());
    let all = f.out() + &f.err();
    assert!(all.contains("relay add --resume"));
    assert!(all.contains("relay add --cancel"));
    f.clear();
    assert_eq!(f.run(&["add", "--cancel", "--yes"]), 0);
    assert!(!pending_file(&f.home).exists());
    assert_eq!(identity(&f.claude), Some(a.desktop.unwrap().account_uuid));
    assert_eq!(names(&f), ["A"]);
}

#[cfg(target_os = "macos")]
#[test]
fn resume_finishes_a_pending_sign_in() {
    let f = cli_fixture(Options::default());
    f.saved("A", None);
    let first = run_while(
        &f,
        &["add", "C", "--new", "--yes", "--poll-ms", "20"],
        || {
            until(|| f.out().contains("open the Code tab once; waiting"));
            f.signal(Signal::Int);
        },
    );
    assert_eq!(first, 1);
    let (account_uuid, _) = f.account_in_desktop(1);
    assert_eq!(f.run(&["add", "--resume", "--yes", "--poll-ms", "10"]), 0);
    let accounts = f.store().state().accounts;
    let c = accounts.iter().find(|x| x.name == "C").unwrap();
    assert_eq!(c.desktop.as_ref().unwrap().account_uuid, account_uuid);
}

#[cfg(target_os = "macos")]
#[test]
fn a_duplicate_name_exits_2_and_an_unlinked_account_of_that_name_is_linked_instead() {
    let f = cli_fixture(Options::default());
    f.saved("A", None);
    assert_eq!(f.run(&["add", "a", "--new", "--yes"]), 2);
    let bare = f
        .store()
        .create(&CreateAccount {
            name: "Bare".into(),
            kind: AccountKind::Personal,
            group: None,
            provider: None,
        })
        .unwrap();
    let (account_uuid, _) = f.account_in_desktop(1);
    assert_eq!(f.run(&["add", "bare", "--yes"]), 0);
    let linked = f.store().account(&bare.id).unwrap();
    assert_eq!(linked.desktop.unwrap().account_uuid, account_uuid);
    assert_eq!(f.store().state().accounts.len(), 2);
}

#[cfg(target_os = "macos")]
#[test]
fn add_new_stops_waiting_when_the_sign_in_is_finished_or_cancelled_elsewhere() {
    let f = cli_fixture(Options::default());
    f.saved("A", None);
    let code = run_while(
        &f,
        &["add", "C", "--new", "--yes", "--poll-ms", "10"],
        || {
            until(|| pending_file(&f.home).exists());
            std::fs::remove_file(pending_file(&f.home)).unwrap();
        },
    );
    assert_eq!(code, 1);
    assert!((f.out() + &f.err()).contains("no longer pending"));
}

#[cfg(target_os = "macos")]
#[test]
fn a_worker_gives_up_waiting_for_a_sign_in_after_its_time_limit() {
    let f = cli_fixture(Options {
        env: vec![
            ("RELAY_WORKER", "1".into()),
            ("RELAY_SIGNIN_LIMIT_MS", "60".into()),
        ],
        ..Options::default()
    });
    f.saved("A", None);
    assert_eq!(f.run(&["add", "C", "--new", "--yes", "--poll-ms", "10"]), 1);
    assert!((f.out() + &f.err()).contains("relay add --resume"));
    assert!(pending_file(&f.home).exists());
}

#[cfg(target_os = "macos")]
#[test]
fn signing_back_in_with_an_account_that_is_already_saved_says_so_while_waiting() {
    let f = cli_fixture(Options::default());
    let (a, _) = f.saved("A", None);
    let code = run_while(
        &f,
        &["add", "C", "--new", "--yes", "--poll-ms", "10"],
        || {
            until(|| f.out().contains("open the Code tab once; waiting"));
            let config = json!({ "oauth:tokenCacheV2": "FIXTURE-SECRET-again", "lastKnownAccountUuid": a.desktop.as_ref().unwrap().account_uuid });
            write_bytes(&f.claude, "config.json", Some(&json_bytes(&config))).unwrap();
            until(|| f.out().contains("already saved"));
            assert!(f.out().contains("signed in as A, which is already saved"));
            f.signal(Signal::Int);
        },
    );
    assert_eq!(code, 1);
}

#[test]
fn add_refuses_a_provider_other_than_claude_before_touching_claude_or_the_account_list() {
    let f = cli_fixture(Options::default());
    for provider in ["codex", "antigravity", "antigravty", "gemini"] {
        assert_eq!(
            f.run(&["add", "X", "--provider", provider, "--yes"]),
            2,
            "{provider}"
        );
        let err = f.err();
        assert!(
            err.contains("only adds Claude accounts") || err.contains("yalnızca Claude"),
            "{err}"
        );
        f.clear();
    }
    assert_eq!(f.store().state().accounts.len(), 0);
}
