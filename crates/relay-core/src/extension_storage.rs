//! Port of `electron/core/extension-storage.ts`: the Claude extension's `chrome.storage.local`
//! folder, a LevelDB, read and written with `rusty-leveldb` while the browser is closed, and the
//! backups a step keeps of it.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::draft_storage::remove_any;
use crate::fs_util::{create_private_dir_all, mtime_ms, system_time_ms};
use crate::shared::extension_auth::{SignIn, is_sign_in_entry, same_sign_in};

/// Why the extension's storage could not be used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageReason {
    /// A browser holds it.
    Locked,
    Missing,
    /// It is not a folder, or not a LevelDB, or a read or write failed.
    Failed,
    /// A write did not read back.
    Mismatch,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct StorageError {
    pub reason: StorageReason,
    pub message: String,
}

impl StorageError {
    pub fn new(reason: StorageReason, message: impl Into<String>) -> StorageError {
        StorageError {
            reason,
            message: message.into(),
        }
    }
}

/// The extension's `chrome.storage.local` folder, a LevelDB. Only ever used with the browser not
/// running: every call opens the database, and closes it before it returns.
pub trait ExtensionStorage: Send + Sync {
    /// Whether the LevelDB library can be used here. Asked before a browser is quit.
    fn available(&self) -> bool;
    /// Every key and value the folder holds (JSON text); the caller picks the sign-in out of them
    /// (`pick_sign_in`).
    fn read(&self, dir: &Path) -> Result<Vec<(String, String)>, StorageError>;
    /// Puts `sign_in`'s keys, and deletes the sign-in entries it lacks, in one batch, then reads
    /// the folder again and compares. Keys that are not part of a sign-in are never touched.
    /// Fails on a failure and on a mismatch; the caller restores its backup.
    fn write(&self, dir: &Path, sign_in: &SignIn) -> Result<(), StorageError>;
}

/// At most this many entries are read: the extension keeps a few dozen.
const MAX_ENTRIES: usize = 5000;

/// Whether another process holds the LevelDB's `LOCK`. Google LevelDB (the browser's) locks it
/// with `fcntl`, rusty-leveldb with `flock`, which need not see each other: asked without taking
/// a lock, so this process's own open is never in the way.
#[cfg(unix)]
fn held_elsewhere(dir: &Path) -> bool {
    use std::os::fd::AsRawFd;
    let Ok(file) = fs::OpenOptions::new().read(true).open(dir.join("LOCK")) else {
        return false;
    };
    // SAFETY: `flock` is plain data, fully initialised here; the fd is open for the call.
    unsafe {
        let mut lock: libc::flock = std::mem::zeroed();
        lock.l_type = libc::F_WRLCK as _;
        lock.l_whence = libc::SEEK_SET as _;
        lock.l_start = 0;
        lock.l_len = 0;
        libc::fcntl(file.as_raw_fd(), libc::F_GETLK, &mut lock) == 0
            && i64::from(lock.l_type) != i64::from(libc::F_UNLCK)
    }
}

#[cfg(not(unix))]
fn held_elsewhere(_dir: &Path) -> bool {
    // Windows: both LevelDBs lock with LockFileEx, which the open below sees.
    false
}

fn open_database(dir: &Path) -> Result<rusty_leveldb::DB, StorageError> {
    // A real directory only: a link could lead into somebody else's files.
    let st = fs::symlink_metadata(dir).map_err(|_| {
        StorageError::new(
            StorageReason::Missing,
            "The extension's storage folder is missing.",
        )
    })?;
    if !st.is_dir() || st.is_symlink() {
        return Err(StorageError::new(
            StorageReason::Failed,
            "The extension's storage is not a folder.",
        ));
    }
    let could_not =
        |reason| StorageError::new(reason, "The extension's storage could not be opened.");
    if held_elsewhere(dir) {
        return Err(could_not(StorageReason::Locked));
    }
    let options = rusty_leveldb::Options {
        create_if_missing: false,
        ..Default::default()
    };
    rusty_leveldb::DB::open(dir, options).map_err(|error| {
        let text = format!("{:?} {}", error.code, error.err).to_lowercase();
        let locked = ["lock", "already held", "resource temporarily unavailable"]
            .iter()
            .any(|word| text.contains(word));
        could_not(if locked {
            StorageReason::Locked
        } else {
            StorageReason::Failed
        })
    })
}

fn with_database<T>(
    dir: &Path,
    use_db: impl FnOnce(&mut rusty_leveldb::DB) -> Result<T, StorageError>,
) -> Result<T, StorageError> {
    let mut db = open_database(dir)?;
    let result = use_db(&mut db);
    let _ = db.close();
    result
}

fn failed() -> StorageError {
    StorageError::new(StorageReason::Failed, "The extension's storage failed.")
}

fn read_entries(db: &mut rusty_leveldb::DB) -> Result<Vec<(String, String)>, StorageError> {
    use rusty_leveldb::LdbIterator;
    let mut iter = db.new_iter().map_err(|_| failed())?;
    let mut entries = Vec::new();
    while entries.len() < MAX_ENTRIES {
        let Some((key, value)) = iter.next() else {
            break;
        };
        // utf8 encoding, as classic-level decodes: invalid bytes become U+FFFD.
        entries.push((
            String::from_utf8_lossy(&key).into_owned(),
            String::from_utf8_lossy(&value).into_owned(),
        ));
    }
    Ok(entries)
}

/// The entries that belong to a sign-in: what a write replaces.
fn sign_in_part(entries: &[(String, String)], keep: &SignIn) -> SignIn {
    entries
        .iter()
        .filter(|(key, value)| keep.contains_key(key) || is_sign_in_entry(key, value))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// The extension storage on `rusty-leveldb`.
#[derive(Debug, Clone, Copy, Default)]
pub struct LevelExtensionStorage;

impl ExtensionStorage for LevelExtensionStorage {
    fn available(&self) -> bool {
        // Linked in: always there.
        true
    }

    fn read(&self, dir: &Path) -> Result<Vec<(String, String)>, StorageError> {
        with_database(dir, read_entries)
    }

    fn write(&self, dir: &Path, sign_in: &SignIn) -> Result<(), StorageError> {
        with_database(dir, |db| {
            let current = sign_in_part(&read_entries(db)?, sign_in);
            let mut batch = rusty_leveldb::WriteBatch::default();
            for key in current.keys().filter(|key| !sign_in.contains_key(key)) {
                batch.delete(key.as_bytes());
            }
            for (key, value) in sign_in {
                batch.put(key.as_bytes(), value.as_bytes());
            }
            db.write(batch, true).map_err(|_| failed())
        })?;
        // A second, separate open: what the browser will read, not what this handle remembers.
        let back = sign_in_part(&with_database(dir, read_entries)?, sign_in);
        if !same_sign_in(&back, sign_in) {
            return Err(StorageError::new(
                StorageReason::Mismatch,
                "The extension's sign-in did not read back.",
            ));
        }
        Ok(())
    }
}

/// Copies `source` into `target` (which must not exist), refusing any link with `refused`.
pub(crate) fn copy_folder(source: &Path, target: &Path, refused: &str) -> io::Result<()> {
    let st = fs::symlink_metadata(source)?;
    if st.is_symlink() {
        return Err(io::Error::other(refused.to_owned()));
    }
    if st.is_dir() {
        fs::create_dir(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_folder(&entry.path(), &target.join(entry.file_name()), refused)?;
        }
        return Ok(());
    }
    if fs::symlink_metadata(target).is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("Target already exists: {}", target.display()),
        ));
    }
    fs::copy(source, target).map(|_| ())
}

/// Copies `dir` into a new folder in `scratch` (mode 0700) and returns that folder.
pub fn backup_folder(dir: &Path, scratch: &Path) -> io::Result<PathBuf> {
    create_private_dir_all(scratch)?;
    let backup = scratch.join(uuid::Uuid::new_v4().to_string());
    copy_folder(
        dir,
        &backup,
        "The extension's storage holds a symbolic link.",
    )?;
    Ok(backup)
}

/// `fs.cp(source, target, {recursive, force: true})`: files over what is there.
fn copy_over(source: &Path, target: &Path) -> io::Result<()> {
    let st = fs::symlink_metadata(source)?;
    if st.is_dir() {
        match fs::create_dir(target) {
            Err(e) if e.kind() != io::ErrorKind::AlreadyExists => return Err(e),
            _ => {}
        }
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_over(&entry.path(), &target.join(entry.file_name()))?;
        }
        return Ok(());
    }
    fs::copy(source, target).map(|_| ())
}

/// Puts `backup`'s files in `dir`, which loses what it held.
pub fn restore_folder(dir: &Path, backup: &Path) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        remove_any(&entry?.path())?;
    }
    copy_over(backup, dir)
}

/// A scratch folder holding the backups of a failed restore says so, and keeps them for a week.
const KEPT_MARKER: &str = ".kept";
const KEPT_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;

/// Marks `scratch` as the only copy of what a failed restore could not put back.
pub fn keep_scratch(scratch: &Path) {
    // `fs.writeFile(marker, "", {mode: 0o600})`: made or emptied, and its time is now.
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let _ = options.open(scratch.join(KEPT_MARKER));
}

/// Removes one backup folder; never fails.
pub fn remove_backup(backup: &Path) {
    let _ = remove_any(backup);
}

/// Removes Relay's scratch backups; never fails. A scratch folder marked by `keep_scratch` stays
/// for a week: the next switch and the next start must not delete the user's only copy.
pub fn clear_scratch(scratch: &Path) {
    if let Ok(meta) = fs::metadata(scratch.join(KEPT_MARKER))
        && let Ok(mtime) = mtime_ms(&meta)
        && system_time_ms(std::time::SystemTime::now()) - mtime < KEPT_MS
    {
        return;
    }
    let _ = remove_any(scratch);
}
