//! LevelDB golden files (plan Phase 4 parity). `scripts/parity/golden.ts` writes
//! `tests/golden/leveldb/`: an extension storage made by classic-level (Google LevelDB) and a
//! claude.ai Local Storage made by Electron's Chromium. These tests read both with the Rust code;
//! `write_golden_leveldb` (ignored) writes `tests/golden/out/leveldb/` for
//! `golden.ts --verify crates/relay-core/tests/golden/out` to open with classic-level.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use relay_core::draft_storage::copy_local_storage;
use relay_core::draft_transfer::{DraftJob, DraftResult, read_drafts};
use relay_core::extension_storage::{ExtensionStorage, LevelExtensionStorage};
use relay_core::shared::extension_auth::SignIn;
use relay_core::shared::types::js::JsMap;
use relay_core::sidebar_keys::SIDEBAR_KEYS;

fn golden() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden")
}

fn json<T: serde::de::DeserializeOwned>(file: &Path) -> T {
    serde_json::from_slice(&fs::read(file).unwrap()).unwrap()
}

#[derive(serde::Deserialize)]
struct Extension {
    before: BTreeMap<String, String>,
    #[serde(rename = "signIn")]
    sign_in: SignIn,
    after: BTreeMap<String, String>,
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &to.join(entry.file_name()));
        } else {
            fs::copy(entry.path(), to.join(entry.file_name())).unwrap();
        }
    }
}

/// The golden extension storage, copied: an open writes into the folder, the golden stays as is.
fn extension_copy(into: &Path) -> PathBuf {
    let copy = into.join("extension");
    copy_dir(&golden().join("leveldb/extension"), &copy);
    copy
}

fn read(dir: &Path) -> BTreeMap<String, String> {
    LevelExtensionStorage
        .read(dir)
        .unwrap()
        .into_iter()
        .collect()
}

#[test]
fn the_classic_level_extension_storage_reads_back_as_classic_level_wrote_it() {
    let expected: Extension = json(&golden().join("leveldb/extension.json"));
    let temp = tempfile::tempdir().unwrap();
    assert_eq!(read(&extension_copy(temp.path())), expected.before);
}

#[test]
fn a_write_into_the_classic_level_extension_storage_leaves_what_the_ts_write_leaves() {
    let expected: Extension = json(&golden().join("leveldb/extension.json"));
    let temp = tempfile::tempdir().unwrap();
    let copy = extension_copy(temp.path());
    LevelExtensionStorage
        .write(&copy, &expected.sign_in)
        .unwrap();
    assert_eq!(read(&copy), expected.after);
}

#[test]
fn the_electron_local_storage_reads_as_chromium_wrote_it() {
    let seed: JsMap<String> = json(&golden().join("leveldb/local-storage.json"));
    let temp = tempfile::tempdir().unwrap();
    let storage = temp.path().join("copy");
    assert!(copy_local_storage(&golden().join("leveldb/local-storage"), &storage).unwrap());
    let DraftResult::Ok { drafts, sidebar } = read_drafts(&DraftJob {
        storage,
        scratch: temp.path().to_path_buf(),
    }) else {
        panic!("the golden Local Storage did not read");
    };
    let want_drafts: JsMap<String> = seed
        .iter()
        .filter(|(k, _)| k.starts_with("composer-draft:"))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let want_sidebar: JsMap<String> = SIDEBAR_KEYS
        .iter()
        .filter_map(|k| seed.get(k).map(|v| ((*k).to_owned(), v.clone())))
        .collect();
    assert_eq!(drafts, want_drafts);
    assert_eq!(sidebar, Some(want_sidebar));
    // Both encodings were read: a draft outside Latin-1 (UTF-16) and one inside it.
    assert!(drafts.values().any(|v| v.contains("ğüşİ")));
    assert!(drafts.values().any(|v| v.contains("latin draft é")));
}

/// Writes `tests/golden/out/leveldb/extension` (the golden storage after a Rust write of
/// `signIn`) and `extension-fresh` (a new rusty-leveldb database holding `after`).
#[test]
#[ignore]
fn write_golden_leveldb() {
    let expected: Extension = json(&golden().join("leveldb/extension.json"));
    let out = golden().join("out/leveldb");
    let _ = fs::remove_dir_all(&out);
    fs::create_dir_all(&out).unwrap();
    let copy = extension_copy(&out);
    LevelExtensionStorage
        .write(&copy, &expected.sign_in)
        .unwrap();
    let fresh = out.join("extension-fresh");
    let options = rusty_leveldb::Options {
        create_if_missing: true,
        ..Default::default()
    };
    let mut db = rusty_leveldb::DB::open(&fresh, options).unwrap();
    let mut batch = rusty_leveldb::WriteBatch::default();
    for (k, v) in &expected.after {
        batch.put(k.as_bytes(), v.as_bytes());
    }
    db.write(batch, true).unwrap();
    db.close().unwrap();
}
