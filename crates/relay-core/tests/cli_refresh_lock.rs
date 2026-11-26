//! Port of the refresh-lock cases of `tests/terminal-identity.test.ts`.

use std::cell::Cell;
use std::fs;
use std::time::{Duration, SystemTime};

use relay_core::cli_refresh_lock::{
    CliRefreshLockError, cli_refresh_lock_paths, take_lock_dir, with_cli_refresh_lock,
};
use relay_core::clock::now_ms;
use relay_core::fs_util::{real_path, set_times};

#[test]
fn claude_codes_refresh_locks_are_held_during_the_action_waited_for_and_taken_over_when_stale() {
    let home = tempfile::Builder::new()
        .prefix("relay-terminal-lock-")
        .tempdir()
        .unwrap();
    let dir = home.path().join(".claude");
    fs::create_dir(&dir).unwrap();
    let lock = dir.join(".oauth_refresh.lock");
    let mut legacy = real_path(&dir).unwrap().into_os_string();
    legacy.push(".lock");
    let legacy = std::path::PathBuf::from(legacy);
    assert_eq!(
        cli_refresh_lock_paths(&dir),
        relay_core::cli_refresh_lock::CliRefreshLockPaths {
            current: lock.clone(),
            legacy: legacy.clone()
        }
    );
    let seen = with_cli_refresh_lock(&dir, 0, || [lock.exists(), legacy.exists()]).unwrap();
    assert_eq!(seen, [true, true]);
    assert!(!lock.exists());
    assert!(!legacy.exists());
    // A CLI holds it: waited for, then given up.
    fs::create_dir(&lock).unwrap();
    assert!(matches!(
        with_cli_refresh_lock(&dir, 300, || "ran"),
        Err(CliRefreshLockError::Busy(_))
    ));
    assert!(lock.exists());
    assert!(!legacy.exists());
    // Released meanwhile: taken.
    let release = {
        let lock = lock.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            fs::remove_dir(lock).unwrap();
        })
    };
    assert_eq!(with_cli_refresh_lock(&dir, 2_000, || "ran").unwrap(), "ran");
    release.join().unwrap();
    // Left by a CLI that died: stale after a minute, taken over.
    fs::create_dir(&lock).unwrap();
    set_times(&lock, SystemTime::now() - Duration::from_secs(120)).unwrap();
    assert_eq!(with_cli_refresh_lock(&dir, 0, || "ran").unwrap(), "ran");
    assert!(!lock.exists());
}

#[test]
fn only_the_stale_lock_that_was_judged_is_taken_over_never_a_fresh_one_made_meanwhile() {
    let dir = tempfile::Builder::new()
        .prefix("relay-terminal-takeover-")
        .tempdir()
        .unwrap();
    let file = dir.path().join("x.lock");
    fs::create_dir(&file).unwrap();
    set_times(&file, SystemTime::now() - Duration::from_secs(120)).unwrap();
    // Another process takes it over between this one's look and its removal: the fresh lock
    // looks stale on the first look only.
    let reads = Cell::new(0);
    let now = || {
        reads.set(reads.get() + 1);
        if reads.get() == 2 {
            fs::remove_dir(&file).unwrap();
            fs::create_dir(&file).unwrap();
        }
        now_ms()
    };
    let error = take_lock_dir(&file, 0, &now).unwrap_err();
    assert_eq!(error.to_string(), "x.lock is held by another process");
    assert!(file.exists());
    let lock = take_lock_dir(&dir.path().join("y.lock"), 0, &now_ms).unwrap();
    lock.release();
    assert!(!dir.path().join("y.lock").exists());
}

#[test]
fn a_held_lock_is_touched_and_a_replaced_one_is_left_alone() {
    let dir = tempfile::Builder::new()
        .prefix("relay-terminal-touch-")
        .tempdir()
        .unwrap();
    let file = dir.path().join("z.lock");
    let lock = take_lock_dir(&file, 0, &now_ms).unwrap();
    let old = SystemTime::now() - Duration::from_secs(30);
    set_times(&file, old).unwrap();
    lock.touch();
    assert!(fs::metadata(&file).unwrap().modified().unwrap() > old);
    // Someone else's lock under the same name now: neither touched nor removed. The old one is
    // moved aside first so the new directory cannot reuse its inode (ext4 and tmpfs do).
    let aside = dir.path().join("z.lock.old");
    fs::rename(&file, &aside).unwrap();
    fs::create_dir(&file).unwrap();
    fs::remove_dir(&aside).unwrap();
    set_times(&file, old).unwrap();
    lock.touch();
    assert_eq!(fs::metadata(&file).unwrap().modified().unwrap(), old);
    lock.release();
    assert!(file.exists());
}
