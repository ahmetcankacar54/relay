//! Rust-only tests of the terminal runner (plan Phase 4: portable-pty). The TS runner's only
//! test file, `tests/lightweight.test.ts`, is source text (how node-pty is loaded, the esbuild
//! config), so nothing of it carries over. PTY cases run on Unix.

#![cfg(unix)]

#[path = "common/p4services.rs"]
mod helpers;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use helpers::until;
use relay_core::runner::{RunInput, Runner};
use relay_core::shared::types::{RunKind, RunStatus, TerminalEvent};

fn input(cwd: &str) -> RunInput {
    RunInput {
        account_id: "acc".into(),
        title: "t".into(),
        cwd: cwd.into(),
        kind: RunKind::Session,
        session_key: None,
    }
}

fn runner() -> (Runner, Arc<Mutex<Vec<TerminalEvent>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let runner = Runner::new(
        Box::new({
            let events = events.clone();
            move |event| events.lock().unwrap().push(event)
        }),
        None,
    );
    (runner, events)
}

fn sh(script: &str) -> Vec<String> {
    vec!["-c".into(), script.into()]
}

#[test]
fn a_terminal_streams_its_output_in_order_in_a_110_by_30_xterm_and_reports_its_exit() {
    let dir = tempfile::tempdir().unwrap();
    let (runner, events) = runner();
    let env = HashMap::from([("PATH".to_owned(), "/usr/bin:/bin".to_owned())]);
    let run = runner
        .start(
            "/bin/sh",
            &sh("echo \"$TERM\"; stty size; exit 3"),
            &env,
            input(dir.path().to_str().unwrap()),
        )
        .unwrap();
    assert_eq!(run.status, RunStatus::Running);
    until(|| runner.list()[0].status == RunStatus::Exited);
    assert_eq!(runner.list()[0].exit_code, Some(3.0));
    let events = events.lock().unwrap().clone();
    let output: String = events.iter().filter_map(|e| e.data.clone()).collect();
    assert!(output.contains("xterm-256color"), "{output:?}");
    assert!(output.contains("30 110"), "{output:?}");
    let sequences: Vec<f64> = events.iter().filter_map(|e| e.sequence).collect();
    assert_eq!(
        sequences,
        (1..=sequences.len()).map(|n| n as f64).collect::<Vec<_>>()
    );
    // The exit comes last, after all the output.
    assert_eq!(events.last().unwrap().exit_code, Some(3.0));
    let buffer = runner.buffer(&run.id).unwrap();
    assert_eq!(buffer.data, output);
    assert_eq!(buffer.sequence as usize, sequences.len());
    assert_eq!(buffer.status, RunStatus::Exited);
}

#[test]
fn one_running_terminal_per_project_input_reaches_it_and_stop_ends_it() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    let (runner, events) = runner();
    let run = runner
        .start("/bin/cat", &[], &HashMap::new(), input(cwd))
        .unwrap();
    let busy = runner
        .start("/bin/cat", &[], &HashMap::new(), input(cwd))
        .unwrap_err();
    assert_eq!(
        busy.to_string(),
        "This account has a sign-in in progress or this project has a live session. Stop it on the Live tab first."
    );
    runner.write(&run.id, "hello relay\n").unwrap();
    until(|| {
        events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| e.data.as_deref())
            .collect::<String>()
            .contains("hello relay")
    });
    runner.resize(&run.id, 80, 24).unwrap();
    assert_eq!(
        runner.close(&run.id).unwrap_err().to_string(),
        "Stop the running session first."
    );
    runner.stop(&run.id).unwrap();
    assert_eq!(runner.list()[0].status, RunStatus::Exited);
    // Stopping an exited terminal is fine; closing forgets it.
    runner.stop(&run.id).unwrap();
    runner.close(&run.id).unwrap();
    assert!(runner.list().is_empty());
    assert_eq!(
        runner.buffer(&run.id).unwrap_err().to_string(),
        "Terminal not found."
    );
}

#[test]
fn twenty_terminals_at_most_exited_ones_make_room_running_ones_never_do() {
    let (runner, _) = runner();
    let dirs: Vec<_> = (0..21).map(|_| tempfile::tempdir().unwrap()).collect();
    let path = |n: usize| dirs[n].path().to_str().unwrap().to_owned();
    let mut runs = Vec::new();
    for n in 0..20 {
        runs.push(
            runner
                .start("/bin/cat", &[], &HashMap::new(), input(&path(n)))
                .unwrap(),
        );
    }
    let full = runner
        .start("/bin/cat", &[], &HashMap::new(), input(&path(20)))
        .unwrap_err();
    assert_eq!(full.to_string(), "You can open up to 20 live terminals.");
    runner.stop(&runs[0].id).unwrap();
    runner
        .start("/bin/cat", &[], &HashMap::new(), input(&path(20)))
        .unwrap();
    assert_eq!(runner.list().len(), 20);
    assert!(runner.list().iter().all(|r| r.id != runs[0].id));
    for run in runner.list() {
        runner.stop(&run.id).unwrap();
    }
}

#[test]
fn the_kept_output_is_bounded_to_the_last_512_000_characters() {
    let dir = tempfile::tempdir().unwrap();
    let (runner, _) = runner();
    let run = runner
        .start(
            "/bin/sh",
            &sh("i=0; while [ $i -lt 700 ]; do printf '%01000d' 0; i=$((i+1)); done; printf END"),
            &HashMap::new(),
            input(dir.path().to_str().unwrap()),
        )
        .unwrap();
    until(|| runner.list()[0].status == RunStatus::Exited);
    let buffer = runner.buffer(&run.id).unwrap();
    assert_eq!(buffer.data.chars().count(), 512_000);
    assert!(buffer.data.ends_with("END"));
}
