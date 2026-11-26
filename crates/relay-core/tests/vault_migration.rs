//! Port of `tests/vault-migration.test.ts`.

#[path = "common/vault.rs"]
mod helpers;

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use helpers::{legacy_seal, legacy_unseal};
use relay_core::desktop_files::{json_bytes, read_bytes, write_bytes};
use relay_core::vault_crypto::{Sealer, is_sealed_v2};
use relay_core::vault_migration::{
    Migration, VaultMigrationError, VaultState, mark_vault_format, migrate_vault, sealed_files,
    vault_state,
};
use serde_json::json;

const BACKUP: &str = "11111111-2222-4333-8444-555555555555";
const ACCOUNT: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OLD: &str = "99999999-2222-4333-8444-555555555555";

fn put(vault: &Path, relative: &str, data: &[u8]) {
    write_bytes(vault, relative, Some(data)).unwrap();
}

fn get(vault: &Path, relative: &str) -> Option<Vec<u8>> {
    read_bytes(vault, relative).unwrap()
}

fn legacy_vault() -> tempfile::TempDir {
    let dir = tempfile::Builder::new()
        .prefix("relay-vault-mig-")
        .tempdir()
        .unwrap();
    let vault = dir.path();
    put(
        vault,
        &format!("accounts/{ACCOUNT}.bin"),
        &legacy_seal("account-a"),
    );
    put(
        vault,
        &format!("backups/{BACKUP}.bin"),
        &legacy_seal("backup-b"),
    );
    put(vault, "drafts/pending.bin", &legacy_seal("drafts"));
    put(vault, "history-seen.json", &json_bytes(&json!({})));
    dir
}

fn sealer() -> Sealer {
    let mut key = [0u8; 32];
    getrandom::fill(&mut key).unwrap();
    Sealer::with_legacy(&key, std::sync::Arc::new(legacy_unseal)).unwrap()
}

fn kind(vault: &Path) -> &'static str {
    match vault_state(vault).unwrap() {
        VaultState::Empty => "empty",
        VaultState::Ready => "ready",
        VaultState::Legacy { .. } => "legacy",
        VaultState::Newer { .. } => "newer",
    }
}

#[test]
fn a_format_1_vault_migrates_every_sealed_file_and_gets_the_marker() {
    let dir = legacy_vault();
    let vault = dir.path();
    let s = sealer();
    assert_eq!(
        sealed_files(vault).unwrap(),
        [
            format!("accounts/{ACCOUNT}.bin"),
            format!("backups/{BACKUP}.bin"),
            "drafts/pending.bin".to_owned()
        ]
    );
    match vault_state(vault).unwrap() {
        VaultState::Legacy { files } => assert_eq!(files.len(), 3),
        other => panic!("expected legacy, got {other:?}"),
    }
    let r = migrate_vault(vault, &s, &legacy_unseal).unwrap();
    assert_eq!(
        r,
        Migration {
            migrated: 3,
            moved_aside: vec![]
        }
    );
    assert_eq!(kind(vault), "ready");
    let account = get(vault, &format!("accounts/{ACCOUNT}.bin")).unwrap();
    assert!(is_sealed_v2(&account));
    assert_eq!(s.unseal(&account).unwrap(), "account-a");
    let marker: serde_json::Value =
        serde_json::from_slice(&get(vault, "format.json").unwrap()).unwrap();
    assert_eq!(marker, json!({ "version": 2 }));
}

#[test]
fn migration_keeps_each_files_mtime_so_backup_pruning_keeps_its_order() {
    let dir = legacy_vault();
    let vault = dir.path();
    let file = vault.join(format!("backups/{BACKUP}.bin"));
    // 2026-01-02T03:04:05Z
    let old = UNIX_EPOCH + Duration::from_millis(1_767_323_045_000);
    std::fs::File::options()
        .write(true)
        .open(&file)
        .unwrap()
        .set_times(
            std::fs::FileTimes::new()
                .set_accessed(old)
                .set_modified(old),
        )
        .unwrap();
    migrate_vault(vault, &sealer(), &legacy_unseal).unwrap();
    let modified: SystemTime = std::fs::metadata(&file).unwrap().modified().unwrap();
    assert_eq!(modified, old);
}

#[test]
fn a_second_run_is_a_no_op_and_a_run_stopped_half_way_resumes() {
    let dir = legacy_vault();
    let vault = dir.path();
    let s = sealer();
    put(
        vault,
        &format!("accounts/{ACCOUNT}.bin"),
        &s.seal("account-a"),
    );
    assert_eq!(
        migrate_vault(vault, &s, &legacy_unseal).unwrap().migrated,
        2
    );
    assert_eq!(
        migrate_vault(vault, &s, &legacy_unseal).unwrap().migrated,
        0
    );
    assert_eq!(kind(vault), "ready");
}

#[test]
fn an_unreadable_file_other_than_the_journals_backup_is_moved_aside_and_the_rest_migrates() {
    let dir = legacy_vault();
    let vault = dir.path();
    put(vault, &format!("backups/{OLD}.bin"), b"v10BROKEN");
    let r = migrate_vault(vault, &sealer(), &legacy_unseal).unwrap();
    assert_eq!(r.moved_aside, [format!("backups/{OLD}.bin")]);
    assert_eq!(r.migrated, 3);
    assert_eq!(
        get(vault, &format!("unreadable/backups/{OLD}.bin")).unwrap(),
        b"v10BROKEN"
    );
    assert_eq!(get(vault, &format!("backups/{OLD}.bin")), None);
    assert_eq!(kind(vault), "ready");
}

#[test]
fn an_unreadable_backup_named_in_journal_json_stops_the_migration_and_moves_nothing() {
    let dir = legacy_vault();
    let vault = dir.path();
    put(vault, &format!("backups/{BACKUP}.bin"), b"v10BROKEN");
    put(
        vault,
        "journal.json",
        &json_bytes(&json!({ "backup": BACKUP })),
    );
    let error = migrate_vault(vault, &sealer(), &legacy_unseal).unwrap_err();
    assert!(matches!(error, VaultMigrationError::RecoveryBackup));
    assert!(error.to_string().contains("recovery backup"));
    assert_eq!(kind(vault), "legacy");
    assert_eq!(
        get(vault, &format!("backups/{BACKUP}.bin")).unwrap(),
        b"v10BROKEN"
    );
    assert!(!vault.join("unreadable").exists());
}

#[test]
fn a_newer_marker_is_reported_an_empty_vault_is_empty_and_a_marked_empty_vault_is_ready() {
    let dir = tempfile::Builder::new()
        .prefix("relay-vault-state-")
        .tempdir()
        .unwrap();
    let vault = dir.path();
    assert_eq!(kind(vault), "empty");
    mark_vault_format(vault).unwrap();
    assert_eq!(kind(vault), "ready");
    put(vault, "format.json", &json_bytes(&json!({ "version": 3 })));
    assert_eq!(
        vault_state(vault).unwrap(),
        VaultState::Newer { version: 3 }
    );
}

#[test]
fn an_unmarked_vault_whose_files_are_all_format_2_is_ready() {
    let dir = tempfile::Builder::new()
        .prefix("relay-vault-state-")
        .tempdir()
        .unwrap();
    let vault = dir.path();
    put(
        vault,
        &format!("accounts/{ACCOUNT}.bin"),
        &sealer().seal("a"),
    );
    assert_eq!(kind(vault), "ready");
}

#[test]
fn when_no_old_file_can_be_opened_nothing_is_moved_and_no_marker_is_written() {
    let dir = legacy_vault();
    let vault = dir.path();
    for file in [
        format!("accounts/{ACCOUNT}.bin"),
        format!("backups/{BACKUP}.bin"),
        "drafts/pending.bin".to_owned(),
    ] {
        put(vault, &file, b"v10BROKEN");
    }
    let error = migrate_vault(vault, &sealer(), &legacy_unseal).unwrap_err();
    assert!(error.to_string().to_lowercase().contains("none of"));
    assert_eq!(
        get(vault, &format!("accounts/{ACCOUNT}.bin")).unwrap(),
        b"v10BROKEN"
    );
    assert!(!vault.join("unreadable").exists());
    assert_eq!(kind(vault), "legacy");
}

#[test]
fn a_broken_journal_backup_stops_the_migration_before_any_other_file_is_moved() {
    let dir = legacy_vault();
    let vault = dir.path();
    put(vault, &format!("accounts/{ACCOUNT}.bin"), b"v10BROKEN");
    put(vault, &format!("backups/{BACKUP}.bin"), b"v10BROKEN");
    put(
        vault,
        "journal.json",
        &json_bytes(&json!({ "backup": BACKUP })),
    );
    let error = migrate_vault(vault, &sealer(), &legacy_unseal).unwrap_err();
    assert!(error.to_string().contains("recovery backup"));
    assert_eq!(
        get(vault, &format!("accounts/{ACCOUNT}.bin")).unwrap(),
        b"v10BROKEN"
    );
    assert!(!vault.join("unreadable").exists());
}

#[test]
fn a_corrupt_old_file_left_after_the_rest_migrated_is_set_aside_so_the_migration_can_finish() {
    let dir = tempfile::Builder::new()
        .prefix("relay-vault-mig-")
        .tempdir()
        .unwrap();
    let vault = dir.path();
    let s = sealer();
    put(
        vault,
        &format!("accounts/{ACCOUNT}.bin"),
        &s.seal("already migrated"),
    );
    put(vault, &format!("backups/{OLD}.bin"), b"v10BROKEN");
    let r = migrate_vault(vault, &s, &legacy_unseal).unwrap();
    assert_eq!(r.moved_aside, [format!("backups/{OLD}.bin")]);
    assert_eq!(kind(vault), "ready");
}

#[test]
fn an_invalid_marker_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    put(dir.path(), "format.json", br#"{"version":1.5}"#);
    assert!(matches!(
        vault_state(dir.path()),
        Err(VaultMigrationError::InvalidMarker)
    ));
}
