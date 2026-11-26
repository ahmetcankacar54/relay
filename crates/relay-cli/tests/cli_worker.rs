//! Port of `tests/cli-worker.test.ts`: a Claude-quitting command run inside Claude Desktop goes
//! to a detached worker. The macOS-only cases skip elsewhere, as the TS.
#![cfg_attr(not(target_os = "macos"), allow(dead_code, unused_imports))]

mod common;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use common::{Fixture, Options, cli_fixture};
use relay_cli::inside_desktop::{inside_claude_desktop, last_worker_record};
use relay_cli::io::Env;
use relay_core::desktop_files::read_object;

const EXE: &str = "/Applications/Claude.app/Contents/MacOS/Claude";

#[test]
fn the_ancestry_walk_finds_claude_desktop_above_this_process_and_stops_on_loops() {
    let listing = [
        format!("  300     1 {EXE}"),
        "  400   300 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper"
            .into(),
        "  450   400 /Users/x/.local/bin/claude".into(),
        "  500   450 /bin/zsh".into(),
        "  600   500 /usr/local/bin/node".into(),
        "  700     1 /usr/sbin/sshd".into(),
        "  800   700 /bin/zsh".into(),
        "  901   902 /bin/a".into(),
        "  902   901 /bin/b".into(),
    ]
    .join("\n");
    assert!(inside_claude_desktop(&listing, 600, EXE));
    assert!(!inside_claude_desktop(&listing, 800, EXE));
    assert!(!inside_claude_desktop(&listing, 901, EXE));
    assert!(!inside_claude_desktop(&listing, 12345, EXE));
}

/// One `spawn_detached` call: the executable, its arguments and its environment.
type Spawned = Arc<Mutex<Vec<(PathBuf, Vec<String>, Env)>>>;

/// A fixture whose CLI runs under the fixture's Claude.app, with worker starts recorded.
fn inside_fixture(options: Options) -> (Fixture, Spawned) {
    let mut f = cli_fixture(options);
    let exe = f
        .base
        .join("Claude.app")
        .join("Contents")
        .join("MacOS")
        .join("Claude");
    let listing = format!(
        "  300     1 {}\n  {}   300 /usr/local/bin/node\n",
        exe.display(),
        f.io.pid
    );
    f.deps.process_list = Arc::new(move || Ok(listing.clone()));
    let spawned: Spawned = Arc::default();
    let record = spawned.clone();
    f.deps.spawn_detached = Arc::new(move |exe, args, env| {
        record
            .lock()
            .unwrap()
            .push((exe.to_path_buf(), args.to_vec(), env.clone()));
        Ok(())
    });
    (f, spawned)
}

fn operations(f: &Fixture) -> PathBuf {
    f.home.join("cli-operations")
}

fn worker_env(f: &mut Fixture) {
    f.io.env.insert("RELAY_WORKER".into(), "1".into());
    f.io.env.insert("RELAY_WORKER_DELAY_MS".into(), "0".into());
}

#[cfg(target_os = "macos")]
#[test]
fn inside_claude_desktop_switch_hands_the_work_to_a_detached_worker_and_quits_nothing_itself() {
    let (f, spawned) = inside_fixture(Options {
        tty: true,
        answers: vec![Some("y".into())],
        ..Options::default()
    });
    f.saved("A", None);
    f.saved("B", None);
    assert_eq!(f.run(&["switch", "A"]), 0);
    assert!(f.out().contains("This session will end too"));
    assert_eq!(f.quits(), 0);
    let spawned = spawned.lock().unwrap();
    assert_eq!(spawned.len(), 1);
    // The worker is this executable itself; `spawn_detached` always starts it detached with nothing attached.
    let (exe, args, env) = &spawned[0];
    assert_eq!(exe, &f.deps.self_exe);
    assert_eq!(args[0], "__worker");
    assert_eq!(env.get("RELAY_WORKER").map(String::as_str), Some("1"));
    let record = last_worker_record(&operations(&f)).unwrap();
    assert_eq!(record.id, args[1]);
    assert_eq!(record.status, "pending");
    assert_eq!(record.argv, ["switch", "A"]);
}

#[cfg(target_os = "macos")]
#[test]
fn the_worker_runs_the_switch_records_it_and_status_shows_the_result_once() {
    let (mut f, _) = inside_fixture(Options::default());
    let (a, _) = f.saved("A", None);
    f.saved("B", None);
    assert_eq!(f.run(&["switch", "A", "--yes"]), 0);
    let id = last_worker_record(&operations(&f)).unwrap().id;
    worker_env(&mut f);
    assert_eq!(f.run(&["__worker", &id]), 0);
    let config = read_object(&f.claude, "config.json").unwrap().unwrap();
    assert_eq!(
        config["lastKnownAccountUuid"],
        a.desktop.unwrap().account_uuid.as_str()
    );
    assert_eq!(last_worker_record(&operations(&f)).unwrap().status, "done");
    f.clear();
    f.run(&["status"]);
    assert!(f.out().contains("switch A: done"), "{}", f.out());
    f.clear();
    f.run(&["status"]);
    assert!(!f.out().contains("switch A: done"));
}

#[cfg(target_os = "macos")]
#[test]
fn a_failing_worker_records_the_failure_without_secrets() {
    let (mut f, _) = inside_fixture(Options::default());
    f.saved("A", None);
    f.saved("B", None);
    f.run(&["switch", "A", "--yes"]);
    let id = last_worker_record(&operations(&f)).unwrap().id;
    worker_env(&mut f);
    f.state.lock().unwrap().fail_quit =
        Some("boom sk-ant-oat01-SECRETSECRETSECRETSECRETSECRETSECRET".into());
    assert_eq!(f.run(&["__worker", &id]), 1);
    let record = last_worker_record(&operations(&f)).unwrap();
    assert_eq!(record.status, "failed");
    let error = record.error.unwrap();
    assert!(!error.contains("sk-ant-"));
    assert!(error.contains("boom"));
}

#[cfg(target_os = "macos")]
#[test]
fn an_unwritable_operations_folder_means_a_sandbox_exit_5_before_any_quit() {
    use std::os::unix::fs::PermissionsExt;
    let (f, spawned) = inside_fixture(Options::default());
    f.saved("A", None);
    f.saved("B", None);
    let dir = operations(&f);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
    let code = f.run(&["switch", "A", "--yes"]);
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(code, 5);
    assert!(f.err().contains("sandbox"));
    assert_eq!(spawned.lock().unwrap().len(), 0);
    assert_eq!(f.quits(), 0);
}
