//! Port of `tests/process-lock.test.ts`, plus the cross-language lock file checks.

mod lock_child;

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use lock_child::hold_in_child;
use relay_core::clock::now_ms;
use relay_core::fs_util::{iso_timestamp, parse_iso_ms};
use relay_core::process_lock::{
    LockBy, LockDeps, ProcessLock, ProcessLockError, RacePoint, holder_alive, process_started_at,
};

/// A lock file in a fresh temporary folder, the folder removed when the guard drops.
fn temp_lock() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::Builder::new()
        .prefix("relay-lock-")
        .tempdir()
        .unwrap();
    let file = dir.path().join("vault").join("operation.lock");
    (dir, file)
}

/// A pid no process has: far above macOS's pid range.
const DEAD_PID: i64 = 999_999;

/// This process's parent, which runs for the whole test.
fn parent_pid() -> i64 {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let me = Pid::from_u32(std::process::id());
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[me]),
        true,
        ProcessRefreshKind::nothing(),
    );
    i64::from(system.process(me).unwrap().parent().unwrap().as_u32())
}

fn write_lock(file: &std::path::Path, json: &str) {
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, json).unwrap();
}

fn busy(result: Result<(), ProcessLockError>) -> relay_core::process_lock::LockInfo {
    match result {
        Err(ProcessLockError::Busy(e)) => e.holder,
        other => panic!("expected LockBusyError, got {other:?}"),
    }
}

#[test]
fn a_live_holder_in_another_process_makes_try_acquire_throw_lock_busy_error_naming_it() {
    let (_dir, file) = temp_lock();
    let child = hold_in_child(&file, "switch", "cli", 0);
    let holder = busy(ProcessLock::new(&file, LockBy::App).try_acquire("switch"));
    assert_eq!(holder.by, LockBy::Cli);
    assert_eq!(holder.kind, "switch");
    assert_eq!(holder.pid, child.pid());
    assert_eq!(
        ProcessLock::new(&file, LockBy::App).holder().map(|h| h.pid),
        Some(child.pid())
    );
}

#[test]
fn a_dead_holders_lock_is_swept_and_taken() {
    let (_dir, file) = temp_lock();
    write_lock(
        &file,
        &format!(
            r#"{{"pid":{DEAD_PID},"token":"x","by":"cli","kind":"switch","startedAt":"{}"}}"#,
            iso_timestamp(now_ms())
        ),
    );
    let lock = ProcessLock::new(&file, LockBy::App);
    assert_eq!(lock.holder(), None);
    lock.try_acquire("merge").unwrap();
    let written: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    assert_eq!(written["pid"], i64::from(std::process::id()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    lock.release();
    assert!(!file.exists());
}

#[test]
fn a_pid_reused_by_a_newer_process_counts_as_stale() {
    let (_dir, file) = temp_lock();
    write_lock(
        &file,
        &format!(
            r#"{{"pid":{},"token":"x","by":"app","kind":"switch","startedAt":"2026-01-01T00:00:00.000Z"}}"#,
            parent_pid()
        ),
    );
    let lock = ProcessLock::with_deps(
        &file,
        LockBy::Cli,
        LockDeps {
            started_at: Some(Box::new(|_| parse_iso_ms("2026-06-01T00:00:00.000Z"))),
            ..LockDeps::default()
        },
    );
    lock.try_acquire("switch").unwrap();
    assert!(lock.held());
    lock.release();
}

#[test]
fn reentrant_within_one_instance_two_acquires_need_two_releases() {
    let (_dir, file) = temp_lock();
    let lock = ProcessLock::new(&file, LockBy::App);
    lock.try_acquire("operation").unwrap();
    lock.try_acquire("switch").unwrap();
    lock.release();
    assert!(file.exists());
    assert!(lock.held());
    lock.release();
    assert!(!file.exists());
    assert!(!lock.held());
}

#[test]
fn acquire_sync_waits_for_a_short_holder_and_gives_up_after_wait_ms() {
    let (_dir, file) = temp_lock();
    let short = hold_in_child(&file, "state", "cli", 150);
    let lock = ProcessLock::new(&file, LockBy::App);
    // The child releases after 150 ms; the wait must outlast it.
    lock.acquire("state", Duration::from_millis(3000)).unwrap();
    assert!(lock.held());
    lock.release();
    short.exited();
    let _held = hold_in_child(&file, "state", "cli", 0);
    let started = Instant::now();
    busy(ProcessLock::new(&file, LockBy::App).acquire("state", Duration::from_millis(200)));
    assert!(started.elapsed() >= Duration::from_millis(200));
}

#[test]
fn release_never_removes_a_lock_whose_token_is_not_ours() {
    let (_dir, file) = temp_lock();
    let lock = ProcessLock::new(&file, LockBy::App);
    lock.try_acquire("switch").unwrap();
    let other = format!(
        r#"{{"pid":{},"token":"someone-else","by":"cli","kind":"switch","startedAt":"{}"}}"#,
        std::process::id(),
        iso_timestamp(now_ms())
    );
    fs::write(&file, other).unwrap();
    lock.release();
    let written: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    assert_eq!(written["token"], "someone-else");
}

// The TS skips this on Windows (it asks /bin/ps); the Rust port reads start times everywhere.
#[test]
fn process_started_at_reads_this_processs_start_before_now() {
    let started = process_started_at(i64::from(std::process::id()));
    assert!(started.is_some_and(|s| s <= now_ms()));
    assert_eq!(process_started_at(DEAD_PID), None);
}

#[test]
fn a_live_pid_whose_start_time_cannot_be_read_still_counts_as_holding_the_lock() {
    let unknown = LockDeps {
        started_at: Some(Box::new(|_| None)),
        ..LockDeps::default()
    };
    let now = iso_timestamp(now_ms());
    assert!(holder_alive(parent_pid(), &now, &unknown));
    assert!(!holder_alive(DEAD_PID, &now, &unknown));
}

/// A lock held by the live parent process, then the race hook removes it at `point`.
fn vanishing_lock(by: &str, point: RacePoint, take_as: LockBy) {
    let (_dir, file) = temp_lock();
    write_lock(
        &file,
        &format!(
            r#"{{"pid":{},"token":"x","by":"{by}","kind":"switch","startedAt":"{}"}}"#,
            parent_pid(),
            iso_timestamp(now_ms())
        ),
    );
    let vanished = std::sync::Arc::new(Mutex::new(false));
    let seen = vanished.clone();
    let target = file.clone();
    let lock = ProcessLock::with_deps(
        &file,
        take_as,
        LockDeps {
            race: Some(Box::new(move |at| {
                let mut done = seen.lock().unwrap();
                if at == point && !*done {
                    *done = true;
                    fs::remove_file(&target).unwrap();
                }
            })),
            ..LockDeps::default()
        },
    );
    lock.try_acquire("state").unwrap();
    assert!(*vanished.lock().unwrap());
    assert!(lock.held());
    lock.release();
}

#[test]
fn a_holder_that_lets_go_between_the_failed_create_and_the_look_at_its_file_is_retried_not_an_error()
 {
    vanishing_lock("cli", RacePoint::CreateFailed, LockBy::App);
}

#[test]
fn a_lock_that_vanishes_while_it_is_being_read_is_retried_not_reported_busy() {
    vanishing_lock("app", RacePoint::Looked, LockBy::Cli);
}

// The TS skips this on Windows (it reads start times through /bin/ps); sysinfo reads them there.
#[test]
fn a_lock_this_pid_wrote_before_this_process_started_is_stale() {
    let me = i64::from(std::process::id());
    let deps = LockDeps::default();
    assert!(!holder_alive(me, "2000-01-01T00:00:00.000Z", &deps));
    assert!(holder_alive(me, &iso_timestamp(now_ms()), &deps));
}

// Cross-language: the file the TS ProcessLock writes (`JSON.stringify(info)`) is read by the
// Rust one, and the Rust one writes the same shape.

#[test]
fn a_lock_file_written_by_the_ts_process_lock_is_read_as_its_holder() {
    let (_dir, file) = temp_lock();
    let child = hold_in_child(&file, "probe", "cli", 0);
    // Replace the child's file with the exact bytes Node writes for the same holder.
    let started = iso_timestamp(now_ms());
    let ts = format!(
        r#"{{"pid":{},"token":"4f0c1f7e-2b8a-4c5e-9d3f-6a7b8c9d0e1f","by":"app","kind":"switch","startedAt":"{started}"}}"#,
        child.pid()
    );
    fs::write(&file, &ts).unwrap();
    let holder = ProcessLock::new(&file, LockBy::Cli).holder().unwrap();
    assert_eq!(holder.pid, child.pid());
    assert_eq!(holder.token, "4f0c1f7e-2b8a-4c5e-9d3f-6a7b8c9d0e1f");
    assert_eq!(holder.by, LockBy::App);
    assert_eq!(holder.kind, "switch");
    assert_eq!(holder.started_at, started);
    let busy = busy(ProcessLock::new(&file, LockBy::Cli).try_acquire("switch"));
    assert_eq!(busy.pid, child.pid());
    // The same holder, but written before the pid's process began: a reused pid, stale.
    let reused = ts.replace(&started, "2000-01-01T00:00:00.000Z");
    fs::write(&file, reused).unwrap();
    assert_eq!(ProcessLock::new(&file, LockBy::Cli).holder(), None);
}

#[test]
fn the_rust_lock_file_has_the_ts_shape_and_key_order() {
    let (_dir, file) = temp_lock();
    let lock = ProcessLock::with_deps(
        &file,
        LockBy::Cli,
        LockDeps {
            now: Some(Box::new(|| {
                parse_iso_ms("2026-11-26T10:20:30.456Z").unwrap()
            })),
            ..LockDeps::default()
        },
    );
    lock.try_acquire("state").unwrap();
    let text = fs::read_to_string(&file).unwrap();
    let token = serde_json::from_str::<serde_json::Value>(&text).unwrap()["token"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(uuid::Uuid::parse_str(&token).is_ok());
    assert_eq!(
        text,
        format!(
            r#"{{"pid":{},"token":"{token}","by":"cli","kind":"state","startedAt":"2026-11-26T10:20:30.456Z"}}"#,
            std::process::id()
        )
    );
    lock.release();
}

#[test]
fn an_unreadable_lock_is_busy_while_fresh_and_swept_when_old() {
    let (_dir, file) = temp_lock();
    write_lock(&file, "{");
    let holder = busy(ProcessLock::new(&file, LockBy::App).try_acquire("state"));
    assert_eq!(holder.by, LockBy::Unknown);
    assert_eq!(holder.pid, 0);
    let old = std::time::SystemTime::now() - Duration::from_secs(60);
    relay_core::fs_util::set_times(&file, old).unwrap();
    let lock = ProcessLock::new(&file, LockBy::App);
    lock.try_acquire("state").unwrap();
    lock.release();
    assert!(!file.exists());
}

#[test]
fn busy_messages_name_the_holders_side() {
    let (_dir, file) = temp_lock();
    let _child = hold_in_child(&file, "switch", "app", 0);
    let error = ProcessLock::new(&file, LockBy::Cli)
        .try_acquire("switch")
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "Relay.app is using Claude Desktop. Try again when it ends."
    );
}
