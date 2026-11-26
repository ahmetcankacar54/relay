//! Port of `tests/backup-prune.test.ts`. Skipped: "a switch prunes once its backup and journal
//! are written" (source text of electron/core/desktop.ts; the Desktop port keeps that order).

use std::fs;
use std::path::Path;
use std::time::{Duration, UNIX_EPOCH};

use relay_core::backup_prune::{SWITCH_BACKUP_LIMIT, prune_switch_backups};
use relay_core::fs_util::set_times;

/// 2026-10-13T09:00:00Z, seconds.
const START: u64 = 1_791_882_000;

fn vault() -> tempfile::TempDir {
    let root = tempfile::Builder::new()
        .prefix("relay-backups-")
        .tempdir()
        .unwrap();
    fs::create_dir(root.path().join("backups")).unwrap();
    root
}

/// Writes `count` backups, oldest first, a minute apart; returns their ids in that order.
fn backups(root: &Path, count: u64) -> Vec<String> {
    (0..count)
        .map(|i| {
            let id = uuid::Uuid::new_v4().to_string();
            let file = root.join("backups").join(format!("{id}.bin"));
            fs::write(&file, "sealed").unwrap();
            set_times(&file, UNIX_EPOCH + Duration::from_secs(START + i * 60)).unwrap();
            id
        })
        .collect()
}

fn left(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(root.join("backups"))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

fn bins(ids: &[String]) -> Vec<String> {
    let mut names: Vec<String> = ids.iter().map(|id| format!("{id}.bin")).collect();
    names.sort();
    names
}

#[test]
fn the_newest_20_switch_backups_stay_and_older_ones_go() {
    assert_eq!(SWITCH_BACKUP_LIMIT, 20);
    let root = vault();
    let ids = backups(root.path(), 25);
    assert_eq!(prune_switch_backups(root.path(), SWITCH_BACKUP_LIMIT), 5);
    assert_eq!(left(root.path()), bins(&ids[5..]));
    // Nothing more to remove the next time.
    assert_eq!(prune_switch_backups(root.path(), SWITCH_BACKUP_LIMIT), 0);
}

#[test]
fn the_backup_the_recovery_journal_names_is_never_removed_however_old() {
    let root = vault();
    let ids = backups(root.path(), 23);
    fs::write(
        root.path().join("journal.json"),
        serde_json::json!({ "backup": ids[0] }).to_string(),
    )
    .unwrap();
    assert_eq!(prune_switch_backups(root.path(), SWITCH_BACKUP_LIMIT), 2);
    let mut kept = vec![ids[0].clone()];
    kept.extend_from_slice(&ids[3..]);
    assert_eq!(left(root.path()), bins(&kept));
}

#[test]
fn a_journal_that_cannot_be_read_removes_nothing_and_pruning_never_throws() {
    let root = vault();
    backups(root.path(), 22);
    fs::write(root.path().join("journal.json"), "{not json").unwrap();
    assert_eq!(prune_switch_backups(root.path(), SWITCH_BACKUP_LIMIT), 0);
    assert_eq!(left(root.path()).len(), 22);
    // No backups folder at all.
    let empty = tempfile::Builder::new()
        .prefix("relay-backups-")
        .tempdir()
        .unwrap();
    assert_eq!(prune_switch_backups(empty.path(), SWITCH_BACKUP_LIMIT), 0);
}

#[test]
fn only_backup_files_are_considered_other_files_stay() {
    let root = vault();
    backups(root.path(), 21);
    fs::write(root.path().join("backups").join("notes.txt"), "keep").unwrap();
    fs::create_dir(
        root.path()
            .join("backups")
            .join(format!("{}.bin", uuid::Uuid::new_v4())),
    )
    .unwrap();
    assert_eq!(prune_switch_backups(root.path(), SWITCH_BACKUP_LIMIT), 1);
    assert!(left(root.path()).contains(&"notes.txt".to_string()));
    assert_eq!(left(root.path()).len(), 22);
}
