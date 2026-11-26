//! Port of tests/desktop-launch.test.ts.

use std::cell::Cell;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::sync::Arc;

use relay_core::desktop_launch::{
    ClaudeLogFiles, LaunchProgress, PageOutcome, PageWaitDeps, START_MS, launch_progress,
    log_since, mark_log, page_booted, wait_for_page, watch_claude_launch,
};
use relay_core::desktop_processes::ProcessError;

fn started(at: &str) -> String {
    format!("{at} [info] Starting app {{\n  appVersion: '3.6556.2',\n}}\n")
}
fn loaded(at: &str) -> String {
    format!("{at} [info] Loaded https://claude.ai (web commit 292b68a8, desktop commit 20c019a1)\n")
}
fn other(at: &str) -> String {
    format!("{at} [info] [growthbook] loaded 455 features (0 changed)\n")
}

fn log_dir() -> (tempfile::TempDir, ClaudeLogFiles) {
    let dir = tempfile::Builder::new()
        .prefix("relay-claude-log-")
        .tempdir()
        .unwrap();
    let files = ClaudeLogFiles {
        current: dir.path().join("main.log"),
        rotated: dir.path().join("main1.log"),
    };
    (dir, files)
}

fn append(path: &std::path::Path, text: &str) {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap()
        .write_all(text.as_bytes())
        .unwrap();
}

#[test]
fn the_last_start_in_the_log_decides_and_only_a_page_report_after_it_counts() {
    assert_eq!(launch_progress(""), LaunchProgress::None);
    assert_eq!(launch_progress(&other("10:00:01")), LaunchProgress::None);
    assert_eq!(
        launch_progress(&(started("09:59:19") + &other("09:59:20"))),
        LaunchProgress::Started
    );
    assert_eq!(
        launch_progress(&(started("10:00:29") + &loaded("10:00:31"))),
        LaunchProgress::Loaded
    );
    assert_eq!(
        launch_progress(&(started("09:00:00") + &loaded("09:00:02") + &started("09:59:19"))),
        LaunchProgress::Started
    );
    assert_eq!(
        launch_progress(
            &(started("1") + "x [info] Loaded https://staging.claude.ai (web commit abc)\n")
        ),
        LaunchProgress::Loaded
    );
    assert_eq!(
        launch_progress(&(started("1") + "x [info] Loaded https://claude.ai\n")),
        LaunchProgress::Started
    );
}

#[test]
fn a_log_is_marked_only_when_its_recent_part_shows_the_page_report_relay_reads() {
    let (_dir, files) = log_dir();
    assert_eq!(mark_log(&files), None, "no log");
    fs::write(&files.current, started("1") + &other("2")).unwrap();
    assert_eq!(mark_log(&files), None, "a log without a page report");
    append(&files.current, &loaded("3"));
    let text = started("1") + &other("2") + &loaded("3");
    assert_eq!(mark_log(&files), Some(text.len() as u64));
}

#[test]
fn a_log_rotated_just_before_the_mark_is_read_on_into_the_file_it_went_to() {
    let (_dir, files) = log_dir();
    fs::write(&files.rotated, started("1") + &loaded("2")).unwrap();
    fs::write(&files.current, other("3")).unwrap();
    assert_eq!(mark_log(&files), Some(other("3").len() as u64));
}

#[test]
fn what_was_logged_since_the_mark_also_across_a_rotation() {
    let (_dir, files) = log_dir();
    let before = started("1") + &loaded("2");
    fs::write(&files.current, &before).unwrap();
    let offset = mark_log(&files).unwrap();
    assert_eq!(log_since(&files, offset).unwrap(), "");
    append(&files.current, &started("3"));
    assert_eq!(log_since(&files, offset).unwrap(), started("3"));
    fs::write(&files.rotated, before + &started("3") + &other("4")).unwrap();
    fs::write(&files.current, loaded("5")).unwrap();
    assert_eq!(
        log_since(&files, offset).unwrap(),
        started("3") + &other("4") + &loaded("5")
    );
}

/// A clock that moves only when the watch sleeps, and a log written on a schedule.
struct World {
    schedule: Vec<(i64, String)>,
    running: Box<dyn Fn(i64) -> Result<bool, ProcessError>>,
    now: Cell<i64>,
    checks: Cell<u32>,
    unreadable: bool,
}

fn world(schedule: Vec<(i64, String)>) -> World {
    World {
        schedule,
        running: Box::new(|_| Ok(true)),
        now: Cell::new(0),
        checks: Cell::new(0),
        unreadable: false,
    }
}

impl PageWaitDeps for World {
    fn read(&self) -> io::Result<String> {
        if self.unreadable {
            return Err(io::Error::other("EACCES"));
        }
        Ok(self
            .schedule
            .iter()
            .filter(|(at, _)| *at <= self.now.get())
            .map(|(_, text)| text.as_str())
            .collect())
    }
    fn running(&self) -> Result<bool, ProcessError> {
        self.checks.set(self.checks.get() + 1);
        (self.running)(self.now.get())
    }
    fn sleep(&self, ms: u64) {
        self.now.set(self.now.get() + ms as i64);
    }
    fn now(&self) -> i64 {
        self.now.get()
    }
}

#[test]
fn a_page_that_reports_its_build_ends_the_wait_at_once() {
    let w = world(vec![(1_000, started("a")), (4_000, loaded("b"))]);
    assert_eq!(wait_for_page(&w, 30_000), PageOutcome::Loaded);
    assert_eq!(w.now.get(), 4_000);
}

#[test]
fn a_claude_whose_page_never_reports_its_build_is_stalled_at_the_deadline() {
    let w = world(vec![(1_000, started("a"))]);
    assert_eq!(wait_for_page(&w, 30_000), PageOutcome::Stalled);
    assert_eq!(w.now.get(), 30_000);
    assert!(w.checks.get() <= 7, "{} checks", w.checks.get());
}

#[test]
fn a_claude_quit_while_its_page_is_stuck_is_left_closed() {
    let mut w = world(vec![(1_000, started("a"))]);
    w.running = Box::new(|now| Ok(now < 7_000));
    assert_eq!(wait_for_page(&w, 30_000), PageOutcome::Closed);
    assert!(w.now.get() < 30_000);
}

#[test]
fn a_claude_that_exits_before_it_logs_its_start_refused_the_launch() {
    let mut w = world(vec![]);
    w.running = Box::new(|now| Ok(now < 700));
    assert_eq!(wait_for_page(&w, 30_000), PageOutcome::Refused);
    assert!(w.now.get() < START_MS);
}

#[test]
fn whether_the_running_claudes_page_booted_from_the_end_of_its_log() {
    let dir = tempfile::Builder::new()
        .prefix("relay-page-booted-")
        .tempdir()
        .unwrap();
    let files = ClaudeLogFiles {
        current: dir.path().join("main.log"),
        rotated: dir.path().join("main1.log"),
    };
    assert_eq!(page_booted(&files), None);
    fs::write(
        &files.current,
        started("a") + &loaded("b") + &started("c") + &other("d"),
    )
    .unwrap();
    assert_eq!(page_booted(&files), Some(false));
    append(&files.current, &loaded("e"));
    assert_eq!(page_booted(&files), Some(true));
    fs::write(&files.current, other("f")).unwrap();
    assert_eq!(page_booted(&files), None);
}

#[test]
fn no_start_in_the_log_means_the_watch_cannot_tell_and_it_stops_early() {
    let w = world(vec![(0, other("a"))]);
    assert_eq!(wait_for_page(&w, 30_000), PageOutcome::Unknown);
    assert_eq!(w.now.get(), START_MS);
}

#[test]
fn a_process_check_that_fails_at_the_deadline_never_calls_the_page_stalled() {
    let mut w = world(vec![(1_000, started("a"))]);
    w.running = Box::new(|_| Err(ProcessError::new("ps failed")));
    assert_eq!(wait_for_page(&w, 30_000), PageOutcome::Unknown);
}

#[test]
fn a_log_that_cannot_be_read_counts_as_nothing_new() {
    let mut w = world(vec![]);
    w.unreadable = true;
    assert_eq!(wait_for_page(&w, 30_000), PageOutcome::Unknown);
}

#[test]
fn a_watch_reads_only_what_claude_logged_after_it_began() {
    let (_dir, files) = log_dir();
    fs::write(&files.current, started("1") + &loaded("2")).unwrap();
    let watch = watch_claude_launch(&files, Arc::new(|| Ok(true))).expect("a watch");
    append(&files.current, &(started("3") + &loaded("4")));
    assert_eq!(watch.wait(30_000), PageOutcome::Loaded);
    let (_other, empty) = log_dir();
    assert!(watch_claude_launch(&empty, Arc::new(|| Ok(true))).is_none());
}
