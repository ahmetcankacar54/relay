//! The Electron app's UI preferences, handed to the Tauri pages once (plan Phase 5 step 5).
//! Electron kept the pages' `localStorage` (sidebar width, Private mode, dismissals, language,
//! "update later", the lost-and-found collection) in `<data>/Local Storage/leveldb` under the
//! `file://` origin. The first Tauri launch reads a private copy of it and returns every entry;
//! `ui-storage-migrated.json` then says it was done, and later launches return nothing.

use std::fs;
use std::io;
use std::path::Path;

use relay_core::draft_storage::copy_local_storage;
use serde_json::{Map, Value};

/// Written once the entries were handed over (or there were none to hand over).
pub const MIGRATED_FILE: &str = "ui-storage-migrated.json";
const MIGRATED_CONTENT: &str = r#"{"version":1}"#;

/// How Chromium keys an origin's Local Storage entries: `_<origin>\0<key>`.
const FILE_ORIGIN_PREFIX: &[u8] = b"_file://\0";

/// Electron's `localStorage` entries, once: `None` when they were handed over already, Electron
/// left none, or they cannot be read now (tried again next launch).
pub fn legacy_ui_storage(data_dir: &Path) -> Option<Map<String, Value>> {
    let marker = data_dir.join(MIGRATED_FILE);
    if fs::symlink_metadata(&marker).is_ok() {
        return None;
    }
    let entries = match read_entries(data_dir) {
        Ok(entries) => entries,
        Err(error) => {
            eprintln!("Relay could not read the old app's preferences. {error}");
            return None;
        }
    };
    if let Err(error) = write_marker(&marker) {
        // Handing them over again next time is harmless: only absent keys are set.
        eprintln!("Relay could not note the old preferences as moved. {error}");
    }
    entries.filter(|entries| !entries.is_empty())
}

/// `None` when Electron left no Local Storage.
fn read_entries(data_dir: &Path) -> Result<Option<Map<String, Value>>, String> {
    let scratch = tempfile_dir()?;
    let storage = scratch.join("Local Storage");
    let result = (|| {
        // The live files stay untouched: leveldb writes its log and lock on open.
        if !copy_local_storage(data_dir, &storage).map_err(|e| e.to_string())? {
            return Ok(None);
        }
        read_file_origin(&storage.join("leveldb")).map(Some)
    })();
    let _ = fs::remove_dir_all(&scratch);
    result
}

fn tempfile_dir() -> Result<std::path::PathBuf, String> {
    let dir = std::env::temp_dir().join(format!("relay-ui-storage-{}", uuid::Uuid::new_v4()));
    create_private_dir(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().mode(0o700).create(dir)
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir(dir)
}

fn read_file_origin(leveldb: &Path) -> Result<Map<String, Value>, String> {
    use rusty_leveldb::LdbIterator;
    let options = rusty_leveldb::Options {
        create_if_missing: false,
        ..Default::default()
    };
    let mut db = rusty_leveldb::DB::open(leveldb, options)
        .map_err(|e| format!("Local Storage could not be opened: {}", e.err))?;
    let mut entries = Map::new();
    {
        let mut iter = db
            .new_iter()
            .map_err(|e| format!("Local Storage could not be read: {}", e.err))?;
        iter.seek(FILE_ORIGIN_PREFIX);
        while iter.valid() {
            let Some((key, value)) = iter.current() else {
                break;
            };
            let Some(name) = key.strip_prefix(FILE_ORIGIN_PREFIX) else {
                break;
            };
            if let (Some(name), Some(value)) = (decode(name), decode(&value)) {
                entries.insert(name, Value::String(value));
            }
            if !iter.advance() {
                break;
            }
        }
    }
    let _ = db.close();
    Ok(entries)
}

/// Chromium's DOMStorage string encoding: a format byte, then Latin-1 (1) or UTF-16LE (0).
fn decode(bytes: &[u8]) -> Option<String> {
    let (&format, rest) = bytes.split_first()?;
    match format {
        1 => Some(rest.iter().map(|&b| char::from(b)).collect()),
        0 if rest.len() % 2 == 0 => {
            let units: Vec<u16> = rest
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            Some(String::from_utf16_lossy(&units))
        }
        _ => None,
    }
}

fn write_marker(marker: &Path) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    io::Write::write_all(&mut options.open(marker)?, MIGRATED_CONTENT.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn electron_data(entries: &[(&[u8], &[u8])]) -> tempfile::TempDir {
        let data = tempfile::tempdir().unwrap();
        let leveldb = data.path().join("Local Storage/leveldb");
        fs::create_dir_all(&leveldb).unwrap();
        let mut db = rusty_leveldb::DB::open(&leveldb, rusty_leveldb::Options::default()).unwrap();
        for (key, value) in entries {
            db.put(key, value).unwrap();
        }
        db.flush().unwrap();
        db.close().unwrap();
        data
    }

    #[test]
    fn hands_the_file_origin_entries_over_once() {
        let utf16: Vec<u8> = std::iter::once(0)
            .chain("Kişisel".encode_utf16().flat_map(u16::to_le_bytes))
            .collect();
        let data = electron_data(&[
            (b"_file://\0\x01relay.sidebar.width", b"\x01248"),
            (b"_file://\0\x01relay.private", b"\x01true"),
            (b"_file://\0\x01relay.name", &utf16),
            (b"_https://claude.ai\0\x01other", b"\x01no"),
            (b"META:file://", b"\x08\x01"),
        ]);
        let first = legacy_ui_storage(data.path()).expect("entries");
        assert_eq!(first.len(), 3);
        assert_eq!(first["relay.sidebar.width"], "248");
        assert_eq!(first["relay.private"], "true");
        assert_eq!(first["relay.name"], "Kişisel");
        assert_eq!(
            fs::read_to_string(data.path().join(MIGRATED_FILE)).unwrap(),
            r#"{"version":1}"#
        );
        assert_eq!(legacy_ui_storage(data.path()), None);
    }

    #[test]
    fn no_electron_storage_marks_it_done() {
        let data = tempfile::tempdir().unwrap();
        assert_eq!(legacy_ui_storage(data.path()), None);
        assert!(data.path().join(MIGRATED_FILE).exists());
    }
}
