//! Port of `tests/profile-lock.test.ts`.

mod lock_child;

use std::fs;
use std::path::PathBuf;

use lock_child::hold_profile;
use relay_core::profile_lock::{
    ProfileLockError, ProfileLockKind, acquire_profile_lock, any_exclusive_profile_lock,
    profile_lock_holders,
};

const A: &str = "0b7b2d6e-3c1f-4f8e-9a51-2a8d1c4b5e6f";
const B: &str = "1c8c3e7f-4d20-4a9f-8b62-3b9e2d5c6f70";

fn locks_dir() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::Builder::new()
        .prefix("relay-profile-locks-")
        .tempdir()
        .unwrap();
    let locks = dir.path().join("profiles").join(".locks");
    (dir, locks)
}

#[test]
fn shared_holders_coexist_exclusive_excludes_everyone() {
    let (_dir, locks) = locks_dir();
    let _one = hold_profile(&locks, A, "shared");
    let _two = hold_profile(&locks, A, "shared");
    let release = acquire_profile_lock(&locks, A, ProfileLockKind::Shared).unwrap();
    assert_eq!(profile_lock_holders(&locks, A, None).unwrap().len(), 3);
    drop(release);
    match acquire_profile_lock(&locks, A, ProfileLockKind::Exclusive) {
        Err(ProfileLockError::Busy(e)) => {
            assert_eq!(e.account_id, A);
            assert_eq!(e.holders.len(), 2);
            assert!(e.holders.iter().all(|h| h.kind == ProfileLockKind::Shared));
            assert_eq!(e.to_string(), "Claude Code is running with this account.");
        }
        other => panic!("expected ProfileLockBusyError, got {other:?}"),
    }
    assert_eq!(profile_lock_holders(&locks, A, None).unwrap().len(), 2);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(locks.join(A)).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
}

#[test]
fn an_exclusive_holder_blocks_shared_and_other_accounts_are_free() {
    let (_dir, locks) = locks_dir();
    let _child = hold_profile(&locks, A, "exclusive");
    match acquire_profile_lock(&locks, A, ProfileLockKind::Shared) {
        Err(ProfileLockError::Busy(e)) => assert_eq!(
            e.to_string(),
            "Another process is signing this account in or renewing its connection."
        ),
        other => panic!("expected ProfileLockBusyError, got {other:?}"),
    }
    acquire_profile_lock(&locks, B, ProfileLockKind::Exclusive)
        .unwrap()
        .release();
}

#[test]
fn dead_holders_are_swept() {
    let (_dir, locks) = locks_dir();
    fs::create_dir_all(locks.join(A)).unwrap();
    fs::write(
        locks
            .join(A)
            .join("999999-2d9f4e80-5e31-4b0a-9c73-4caf3e6d7081.json"),
        format!(
            r#"{{"pid":999999,"kind":"exclusive","startedAt":"{}","token":"x"}}"#,
            relay_core::fs_util::iso_timestamp(relay_core::clock::now_ms())
        ),
    )
    .unwrap();
    assert_eq!(profile_lock_holders(&locks, A, None).unwrap(), vec![]);
    assert_eq!(fs::read_dir(locks.join(A)).unwrap().count(), 0);
    acquire_profile_lock(&locks, A, ProfileLockKind::Exclusive)
        .unwrap()
        .release();
}

#[test]
fn any_exclusive_profile_lock_sees_an_exclusive_lock_on_any_account() {
    let (_dir, locks) = locks_dir();
    assert!(!any_exclusive_profile_lock(&locks, None).unwrap());
    let _shared = hold_profile(&locks, A, "shared");
    assert!(!any_exclusive_profile_lock(&locks, None).unwrap());
    let exclusive = hold_profile(&locks, B, "exclusive");
    assert!(any_exclusive_profile_lock(&locks, None).unwrap());
    assert!(!any_exclusive_profile_lock(&locks, Some(exclusive.pid())).unwrap());
}

#[test]
fn an_account_id_that_is_not_a_uuid_is_refused() {
    let (_dir, locks) = locks_dir();
    assert!(matches!(
        acquire_profile_lock(&locks, "../x", ProfileLockKind::Shared),
        Err(ProfileLockError::InvalidAccountId)
    ));
}

// Cross-language: the holder file has the TS name and JSON shape, and a TS-written one is read.

#[test]
fn holder_files_have_the_ts_name_and_shape() {
    let (_dir, locks) = locks_dir();
    let guard = acquire_profile_lock(&locks, &A.to_uppercase(), ProfileLockKind::Shared).unwrap();
    let names: Vec<String> = fs::read_dir(locks.join(A))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(names.len(), 1);
    let (pid, id) = names[0]
        .strip_suffix(".json")
        .unwrap()
        .split_once('-')
        .unwrap();
    assert_eq!(pid, std::process::id().to_string());
    assert!(uuid::Uuid::parse_str(id).is_ok());
    let text = fs::read_to_string(locks.join(A).join(&names[0])).unwrap();
    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        text,
        format!(
            r#"{{"pid":{},"kind":"shared","startedAt":"{}"}}"#,
            std::process::id(),
            value["startedAt"].as_str().unwrap()
        )
    );
    drop(guard);
    assert_eq!(fs::read_dir(locks.join(A)).unwrap().count(), 0);
}

#[test]
fn a_holder_file_written_by_the_ts_profile_lock_is_read() {
    let (_dir, locks) = locks_dir();
    let child = hold_profile(&locks, B, "shared");
    let started = relay_core::fs_util::iso_timestamp(relay_core::clock::now_ms());
    // The exact bytes Node writes for a holder of A, whose pid is the live child's.
    fs::create_dir_all(locks.join(A)).unwrap();
    fs::write(
        locks.join(A).join(format!(
            "{}-2d9f4e80-5e31-4b0a-9c73-4caf3e6d7081.json",
            child.pid()
        )),
        format!(
            r#"{{"pid":{},"kind":"exclusive","startedAt":"{started}"}}"#,
            child.pid()
        ),
    )
    .unwrap();
    let holders = profile_lock_holders(&locks, A, None).unwrap();
    assert_eq!(holders.len(), 1);
    assert_eq!(holders[0].pid, child.pid());
    assert_eq!(holders[0].kind, ProfileLockKind::Exclusive);
    assert_eq!(holders[0].started_at, started);
}
