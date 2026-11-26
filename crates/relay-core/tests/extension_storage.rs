//! Port of `tests/extension-storage.test.ts`. The TS made its LevelDBs with classic-level; these
//! make them with rusty-leveldb (the cross-check with classic-level is `golden_leveldb.rs`).

#[path = "common/browser.rs"]
mod browser;

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use browser::sign_in_for;
use relay_core::extension_storage::{
    ExtensionStorage, LevelExtensionStorage, StorageReason, backup_folder, clear_scratch,
    restore_folder,
};
use relay_core::shared::extension_auth::{SignIn, pick_sign_in};
use rusty_leveldb::{DB, LdbIterator, Options, WriteBatch};

fn temp() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("relay-ext-storage-")
        .tempdir()
        .unwrap()
}

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// A LevelDB like the extension's: the sign-in keys and other keys, closed afterwards.
fn extension_db(dir: &Path, entries: &[(String, String)]) {
    let options = Options {
        create_if_missing: true,
        ..Default::default()
    };
    let mut db = DB::open(dir, options).unwrap();
    let mut batch = WriteBatch::default();
    for (k, v) in entries {
        batch.put(k.as_bytes(), v.as_bytes());
    }
    db.write(batch, true).unwrap();
    db.close().unwrap();
}

fn dump(dir: &Path) -> BTreeMap<String, String> {
    let mut db = DB::open(
        dir,
        Options {
            create_if_missing: false,
            ..Default::default()
        },
    )
    .unwrap();
    let mut out = BTreeMap::new();
    {
        let mut iter = db.new_iter().unwrap();
        while let Some((k, v)) = iter.next() {
            out.insert(String::from_utf8(k).unwrap(), String::from_utf8(v).unwrap());
        }
    }
    db.close().unwrap();
    out
}

fn pairs(sign_in: &SignIn, extra: &[(&str, &str)]) -> Vec<(String, String)> {
    sign_in
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .chain(
            extra
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned())),
        )
        .collect()
}

/// The sign-in in a folder, as the step picks it.
fn sign_in_of(dir: &Path, known: &[String]) -> Option<SignIn> {
    let entries = LevelExtensionStorage.read(dir).unwrap();
    pick_sign_in(
        entries.iter().map(|(k, v)| (k.as_str(), Some(v.as_str()))),
        known,
    )
    .map(|p| p.sign_in)
}

#[test]
fn read_returns_every_entry_and_the_sign_in_is_picked_out_of_them() {
    let t = temp();
    let dir = t.path().join("ext");
    let a = uuid();
    extension_db(
        &dir,
        &pairs(
            &sign_in_for(&a, 1),
            &[("savedPrompts", "[\"p\"]"), ("other", "1")],
        ),
    );
    let mut keys: Vec<String> = LevelExtensionStorage
        .read(&dir)
        .unwrap()
        .into_iter()
        .map(|(k, _)| k)
        .collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "accessToken",
            "accountUuid",
            "other",
            "refreshToken",
            "savedPrompts",
            "tokenExpiry"
        ]
    );
    assert_eq!(
        sign_in_of(&dir, std::slice::from_ref(&a)),
        Some(sign_in_for(&a, 1))
    );
}

#[test]
fn a_store_with_no_sign_in_has_none_to_pick() {
    let t = temp();
    let dir = t.path().join("ext");
    extension_db(&dir, &[("savedPrompts".into(), "[\"p\"]".into())]);
    assert_eq!(sign_in_of(&dir, &[uuid()]), None);
}

#[test]
fn write_puts_the_sign_in_keys_deletes_the_ones_it_lacks_and_leaves_every_other_key() {
    let t = temp();
    let dir = t.path().join("ext");
    let a = uuid();
    let b = uuid();
    extension_db(
        &dir,
        &pairs(
            &sign_in_for(&a, 1),
            &[("savedPrompts", "[\"p\"]"), ("other", "1")],
        ),
    );
    let mut wanted = sign_in_for(&b, 2);
    wanted.remove("tokenExpiry");
    LevelExtensionStorage.write(&dir, &wanted).unwrap();
    let after = dump(&dir);
    assert_eq!(after.get("accountUuid"), wanted.get("accountUuid"));
    assert_eq!(after.get("refreshToken"), wanted.get("refreshToken"));
    // The old expiry belonged to the old account.
    assert!(!after.contains_key("tokenExpiry"));
    assert_eq!(after["savedPrompts"], "[\"p\"]");
    assert_eq!(after["other"], "1");
    assert_eq!(sign_in_of(&dir, &[b]), Some(wanted));
}

#[test]
fn write_into_a_store_with_no_sign_in_puts_one() {
    let t = temp();
    let dir = t.path().join("ext");
    extension_db(&dir, &[("other".into(), "1".into())]);
    let b = uuid();
    LevelExtensionStorage
        .write(&dir, &sign_in_for(&b, 1))
        .unwrap();
    assert_eq!(
        sign_in_of(&dir, std::slice::from_ref(&b)),
        Some(sign_in_for(&b, 1))
    );
}

#[test]
fn a_database_another_handle_holds_is_refused_as_locked_and_nothing_is_changed() {
    let t = temp();
    let dir = t.path().join("ext");
    extension_db(&dir, &pairs(&sign_in_for(&uuid(), 1), &[("other", "1")]));
    let before = dump(&dir);
    let held = DB::open(
        &dir,
        Options {
            create_if_missing: false,
            ..Default::default()
        },
    )
    .unwrap();
    let error = LevelExtensionStorage.read(&dir).unwrap_err();
    assert_eq!(error.reason, StorageReason::Locked);
    let error = LevelExtensionStorage
        .write(&dir, &sign_in_for(&uuid(), 1))
        .unwrap_err();
    assert_eq!(error.reason, StorageReason::Locked);
    drop(held);
    assert_eq!(dump(&dir), before);
}

#[test]
fn a_missing_folder_a_file_and_a_link_are_refused_and_nothing_is_created() {
    let t = temp();
    let missing = t.path().join("nope");
    assert_eq!(
        LevelExtensionStorage.read(&missing).unwrap_err().reason,
        StorageReason::Missing
    );
    assert!(!missing.exists());
    let file = t.path().join("file");
    fs::write(&file, "x").unwrap();
    assert!(LevelExtensionStorage.read(&file).is_err());
    #[cfg(unix)]
    {
        let real = t.path().join("real");
        extension_db(&real, &pairs(&sign_in_for(&uuid(), 1), &[]));
        let link = t.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(LevelExtensionStorage.read(&link).is_err());
    }
}

#[test]
fn a_folder_that_is_not_a_leveldb_is_refused_not_initialised() {
    let t = temp();
    let dir = t.path().join("ext");
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("data.txt"), "ORIGINAL").unwrap();
    assert!(LevelExtensionStorage.read(&dir).is_err());
    let names: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n != "LOG" && n != "LOCK" && !n.starts_with("LOG"))
        .collect();
    assert_eq!(names, ["data.txt"]);
}

#[test]
fn a_backup_restores_the_folder_as_it_was_after_a_write() {
    let t = temp();
    let dir = t.path().join("ext");
    let scratch = t.path().join("scratch");
    extension_db(&dir, &pairs(&sign_in_for(&uuid(), 1), &[("other", "1")]));
    let before = dump(&dir);
    let backup = backup_folder(&dir, &scratch).unwrap();
    assert!(backup.starts_with(&scratch));
    LevelExtensionStorage
        .write(&dir, &sign_in_for(&uuid(), 2))
        .unwrap();
    assert_ne!(dump(&dir), before);
    restore_folder(&dir, &backup).unwrap();
    assert_eq!(dump(&dir), before);
    clear_scratch(&scratch);
    assert!(!scratch.exists());
}

#[test]
#[cfg(unix)]
fn a_backup_refuses_a_folder_that_holds_a_link() {
    let t = temp();
    let dir = t.path().join("ext");
    fs::create_dir(&dir).unwrap();
    fs::write(t.path().join("target"), "x").unwrap();
    std::os::unix::fs::symlink(t.path().join("target"), dir.join("link")).unwrap();
    let error = backup_folder(&dir, &t.path().join("scratch")).unwrap_err();
    assert!(error.to_string().contains("symbolic link"));
}

#[test]
fn writing_a_sign_in_removes_the_record_of_a_failed_one_and_the_previous_org_hint_and_keeps_the_rest()
 {
    let t = temp();
    let dir = t.path().join("ext");
    let a = uuid();
    let b = uuid();
    let hint = serde_json::to_string(&uuid()).unwrap();
    extension_db(
        &dir,
        &pairs(
            &sign_in_for(&a, 1),
            &[
                ("lastActiveOrgHint", &hint),
                ("lastAuthFailureReason", "\"session_expired\""),
                (
                    "startupReauthState",
                    "{\"terminal\":true,\"stop\":\"definitive\"}",
                ),
                ("savedPrompts", "[\"p\"]"),
            ],
        ),
    );
    LevelExtensionStorage
        .write(&dir, &sign_in_for(&b, 1))
        .unwrap();
    let expected: BTreeMap<String, String> =
        pairs(&sign_in_for(&b, 1), &[("savedPrompts", "[\"p\"]")])
            .into_iter()
            .collect();
    assert_eq!(dump(&dir), expected);
}
