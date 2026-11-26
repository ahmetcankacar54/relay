//! Port of `tests/cli-run.test.ts`. macOS only, as the TS skips elsewhere.
#![cfg(target_os = "macos")]

mod common;
#[path = "../../relay-core/tests/lock_child/mod.rs"]
mod lock_child;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{Fixture, Options, cli_fixture};
use lock_child::hold_profile;
use relay_cli::io::Signal;
use relay_core::profile_lock::profile_lock_holders;
use relay_core::shared::types::{Account, AccountAuth};

fn logged_in() -> AccountAuth {
    AccountAuth {
        logged_in: true,
        checked_at: relay_core::fs_util::iso_timestamp(relay_core::clock::now_ms()),
        ..AccountAuth::default()
    }
}

fn script(path: &Path, text: &str) {
    fs::write(path, text).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

fn use_claude(f: &mut Fixture, file: &Path) {
    let file = file.to_string_lossy().into_owned();
    f.deps.claude = Arc::new(move |_| Some(file.clone()));
}

fn setup(logged: bool) -> (Fixture, Account, PathBuf, PathBuf) {
    let mut f = cli_fixture(Options {
        env: vec![
            ("ANTHROPIC_API_KEY", "sk-ant-api-should-not-pass".into()),
            ("TERM", "screen-256color".into()),
        ],
        ..Options::default()
    });
    let (a, _) = f.saved("A", None);
    if logged {
        f.store()
            .update(|s| s.accounts[0].auth = Some(logged_in()))
            .unwrap();
    }
    let log = f.base.join("run.log");
    let fake = f.base.join("fake-claude");
    let locks = f.home.join("profiles").join(".locks");
    let log_text = log.display();
    script(
        &fake,
        &format!(
            "#!/bin/sh\necho \"dir=$CLAUDE_CONFIG_DIR\" >> \"{log_text}\"\necho \"args=$*\" >> \"{log_text}\"\necho \"key=$ANTHROPIC_API_KEY\" >> \"{log_text}\"\necho \"term=$TERM colorterm=$COLORTERM\" >> \"{log_text}\"\nls \"{}/{}\" | wc -l | tr -d ' ' | sed 's/^/locks=/' >> \"{log_text}\"\nexit 7\n",
            locks.display(),
            a.id
        ),
    );
    use_claude(&mut f, &fake);
    (f, a, log, locks)
}

#[test]
fn run_starts_claude_code_with_the_account_s_profile_and_passes_its_exit_code_through() {
    let (f, a, log, locks) = setup(true);
    assert_eq!(f.run(&["run", "A", "--", "--resume", "x"]), 7);
    let out = fs::read_to_string(log).unwrap();
    assert!(out.contains(&format!(
        "dir={}",
        f.home.join("profiles").join(&a.id).display()
    )));
    assert!(out.contains("args=--resume x"));
    assert!(out.contains("key=\n"));
    assert!(out.contains("locks=1"));
    // The user's own terminal, not the app's xterm.js.
    assert!(out.contains("term=screen-256color colorterm=\n"));
    assert!(
        profile_lock_holders(&locks, &a.id, None)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn an_exclusive_holder_exits_3_and_a_disconnected_account_exits_1() {
    let (f, a, _, locks) = setup(true);
    let _child = hold_profile(&locks, &a.id, "exclusive");
    assert_eq!(f.run(&["run", "A"]), 3);
    let (g, _, _, _) = setup(false);
    assert_eq!(g.run(&["run", "A"]), 1);
    assert!(g.err().contains("relay connect"));
}

#[test]
fn sigterm_and_sighup_reach_the_child_while_it_runs_sigint_is_left_to_the_terminal() {
    let mut f = cli_fixture(Options::default());
    f.saved("A", None);
    f.store()
        .update(|s| s.accounts[0].auth = Some(logged_in()))
        .unwrap();
    let sleepy = f.base.join("sleepy");
    let ready = f.base.join("ready");
    script(
        &sleepy,
        &format!(
            "#!/bin/sh\ntrap 'exit 41' INT\ntrap 'exit 42' TERM\ntouch \"{}\"\nwhile true; do sleep 0.05; done\n",
            ready.display()
        ),
    );
    use_claude(&mut f, &sleepy);
    std::thread::scope(|scope| {
        let done = scope.spawn(|| f.run(&["run", "A"]));
        let end = Instant::now() + Duration::from_secs(5);
        while !(f.has_signal_handler() && ready.exists()) && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(10));
        }
        f.signal(Signal::Int);
        std::thread::sleep(Duration::from_millis(150));
        f.signal(Signal::Term);
        assert_eq!(done.join().unwrap(), 42);
    });
}
