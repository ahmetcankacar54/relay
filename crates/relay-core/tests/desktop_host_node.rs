//! Port of tests/desktop-host-node.test.ts.

use std::fs;

use relay_core::desktop_host_node::{claude_executable, wait_for_quit};

#[test]
fn claude_executable_finds_the_first_claude_app_whose_executable_exists() {
    let dir = tempfile::Builder::new()
        .prefix("relay-claude-app-")
        .tempdir()
        .unwrap();
    let app = |name: &str| {
        let bundle = dir.path().join(name).join("Claude.app");
        fs::create_dir_all(bundle.join("Contents").join("MacOS")).unwrap();
        fs::write(bundle.join("Contents").join("MacOS").join("Claude"), "").unwrap();
        bundle
    };
    let first = app("one");
    let second = app("two");
    let missing = dir.path().join("none").join("Claude.app");
    assert_eq!(
        claude_executable(&[missing.clone(), first.clone(), second]),
        Some(first.join("Contents").join("MacOS").join("Claude"))
    );
    assert_eq!(claude_executable(&[missing]), None);
    assert_eq!(claude_executable(&["relative/Claude.app".into()]), None);
}

/// Runs `wait_for_quit` on a fake clock: Claude closes after `closes_at` ms (never when None),
/// and its log shows the quit cleanup from `quitting_at` ms on (never when None).
fn quit_after(closes_at: Option<u64>, quitting_at: Option<u64>) -> (bool, u64, u32) {
    use std::cell::Cell;
    let now = Cell::new(0u64);
    let answers = Cell::new(0u32);
    let closed = wait_for_quit(
        &mut || Ok(closes_at.is_some_and(|at| now.get() >= at)),
        &mut || quitting_at.is_some_and(|at| now.get() >= at),
        &mut || answers.set(answers.get() + 1),
        &|ms| now.set(now.get() + ms),
    )
    .unwrap();
    (closed, now.get(), answers.get())
}

#[test]
fn a_quit_claude_does_not_start_on_is_given_up_after_10_s_answering_its_question_twice() {
    assert_eq!(quit_after(None, None), (false, 10_000, 2));
    assert_eq!(quit_after(Some(3_000), None), (true, 3_000, 1));
}

#[test]
fn a_claude_that_is_cleaning_up_to_quit_is_waited_for_as_long_as_its_slowest_cleanup() {
    // 75 s of cleanup, as Claude took when its telemetry flush hung: the switch goes on.
    assert!(quit_after(Some(75_000), Some(500)).0);
    // Never past QUIT_CLEANUP_MS.
    assert_eq!(
        quit_after(None, Some(500)),
        (false, relay_core::desktop_host_node::QUIT_CLEANUP_MS, 2)
    );
}
