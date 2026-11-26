//! Port of `electron/core/draft-storage.ts`: copying Claude's Chromium Local Storage for the
//! draft reader, and removing what the first draft design left behind.

use std::fs;
use std::io;
use std::path::Path;

use regex::Regex;

use crate::fs_util::create_private_dir;

/// Claude's Chromium Local Storage, under the Claude root.
pub const LOCAL_STORAGE: &str = "Local Storage";
/// The LevelDB directory inside it, which holds the drafts.
pub const LEVELDB: &str = "Local Storage/leveldb";

// The first design (draft preservation) left these behind; this one only removes them.
// Its unfinished copies beside `leveldb`, `leveldb.relay-<uuid>`.
const COPY: &str = "leveldb.relay-";
// Where it set Claude's previous leveldb aside. That holds a leveldb Claude used: never removed.
const OLD: &str = "leveldb.relay-old-";
// Its working dirs beside `leveldb`, `.relay-work-<uuid>`.
const WORK: &str = ".relay-work-";

/// Its plaintext backups of Local Storage, `<vault>/drafts/<stamp>`, where the stamp is
/// `now.toISOString()` with `:` and `.` replaced by `-`.
fn is_stamp(name: &str) -> bool {
    static STAMP: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z$")
            .expect("static pattern")
    });
    STAMP.is_match(name)
}

/// Why a copy of Local Storage failed.
#[derive(Debug, thiserror::Error)]
pub enum DraftStorageError {
    /// A link or something that is not a directory where a directory belongs.
    #[error("{0}")]
    Refused(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl DraftStorageError {
    /// The errno-like code of an I/O failure (`EEXIST`, `EACCES`, ...), as Node reports it.
    pub fn io_kind(&self) -> Option<io::ErrorKind> {
        match self {
            DraftStorageError::Io(error) => Some(error.kind()),
            DraftStorageError::Refused(_) => None,
        }
    }
}

/// True when `target` is a real directory and false when it does not exist. Fails on a symlink
/// or any other kind of file, so nothing is ever read or written through a link.
fn real_directory(target: &Path, name: &str) -> Result<bool, DraftStorageError> {
    let st = match fs::symlink_metadata(target) {
        Ok(st) => st,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.into()),
    };
    if st.is_symlink() {
        return Err(DraftStorageError::Refused(format!(
            "{name} is a symbolic link."
        )));
    }
    if !st.is_dir() {
        return Err(DraftStorageError::Refused(format!(
            "{name} is not a directory."
        )));
    }
    Ok(true)
}

/// True when `<root>/Local Storage/leveldb` is a real directory. Never fails.
fn leveldb_in_place(root: &Path) -> bool {
    fs::symlink_metadata(root.join(LEVELDB)).is_ok_and(|st| st.is_dir())
}

/// `relative` with `/` separators, as Node's `path.relative` prints it on POSIX.
fn shown(relative: &Path) -> String {
    relative
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// `fs.cp(source, target, {recursive, errorOnExist, verbatimSymlinks})` with a filter that refuses
/// any link: every entry is checked before it is copied, the top one included.
fn copy_tree(
    source: &Path,
    target: &Path,
    live: &Path,
    refuse: &dyn Fn(&Path) -> String,
) -> Result<(), DraftStorageError> {
    let st = fs::symlink_metadata(source)?;
    if st.is_symlink() {
        let relative = source.strip_prefix(live).unwrap_or(source);
        return Err(DraftStorageError::Refused(refuse(relative)));
    }
    if st.is_dir() {
        match fs::create_dir(target) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists && target.is_dir() => {}
            Err(e) => return Err(e.into()),
        }
        let mut entries: Vec<_> = fs::read_dir(source)?.collect::<Result<_, _>>()?;
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            copy_tree(&entry.path(), &target.join(entry.file_name()), live, refuse)?;
        }
        return Ok(());
    }
    if fs::symlink_metadata(target).is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("Target already exists: {}", target.display()),
        )
        .into());
    }
    fs::copy(source, target)?;
    Ok(())
}

/// Copies `<root>/Local Storage/leveldb` to `<storage>/leveldb`, making `storage` (mode 0700; one
/// that exists already is never copied into). Returns false, making nothing, when Local Storage or
/// leveldb is missing. Fails when either is a symlink or not a directory, and when leveldb holds a
/// symlink anywhere: Chromium's leveldb has none, and followed from the copy a link could reach
/// Claude's own files.
pub fn copy_local_storage(root: &Path, storage: &Path) -> Result<bool, DraftStorageError> {
    if !real_directory(&root.join(LOCAL_STORAGE), LOCAL_STORAGE)? {
        return Ok(false);
    }
    let live = root.join(LEVELDB);
    if !real_directory(&live, LEVELDB)? {
        return Ok(false);
    }
    create_private_dir(storage)?;
    copy_tree(&live, &storage.join("leveldb"), &live, &|relative| {
        format!("{LEVELDB}/{} is a symbolic link.", shown(relative))
    })?;
    Ok(true)
}

/// Removes what the first design left beside `<root>/Local Storage/leveldb`: working dirs
/// (`.relay-work-*`) and unfinished copies (`leveldb.relay-<uuid>`). Never fails, and never
/// deletes a `leveldb.relay-old-*`, which holds a leveldb Claude used. Does nothing unless Local
/// Storage is a real directory and leveldb is in place, so it never reaches through a link and
/// never removes what may be the only copy of Claude's data.
pub fn sweep_draft_leftovers(root: &Path) {
    let storage = root.join(LOCAL_STORAGE);
    if !fs::symlink_metadata(&storage).is_ok_and(|st| st.is_dir()) || !leveldb_in_place(root) {
        return;
    }
    let Ok(entries) = fs::read_dir(&storage) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(WORK) || (name.starts_with(COPY) && !name.starts_with(OLD)) {
            let _ = remove_any(&entry.path());
        }
    }
}

/// `fs.rm(target, {recursive: true, force: true})`: a link is removed, never what it points to.
pub(crate) fn remove_any(target: &Path) -> io::Result<()> {
    let st = match fs::symlink_metadata(target) {
        Ok(st) => st,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if st.is_dir() {
        fs::remove_dir_all(target)
    } else {
        // A link to a folder on Windows is a directory entry.
        fs::remove_file(target).or_else(|_| fs::remove_dir(target))
    }
}

/// Removes the first design's plaintext backups of Claude's Local Storage: the real directories in
/// `<vault>/drafts` named like a stamp. Everything else there, such as `pending.bin` and
/// `last.json`, stays. Never follows a link, the drafts dir included, and never fails.
pub fn remove_legacy_draft_backups(vault: &Path) {
    let drafts = vault.join("drafts");
    if !matches!(real_directory(&drafts, "The drafts directory"), Ok(true)) {
        return;
    }
    let Ok(entries) = fs::read_dir(&drafts) else {
        return;
    };
    for entry in entries.flatten() {
        // Dirents come from lstat: a link named like a stamp is not a directory here.
        let is_dir = entry.file_type().is_ok_and(|t| t.is_dir());
        if is_dir && is_stamp(&entry.file_name().to_string_lossy()) {
            let _ = remove_any(&entry.path());
        }
    }
}
