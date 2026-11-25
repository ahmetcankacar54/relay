//! Port of `electron/core/continuation-journal.ts`: the bounded private JSON file reader and
//! writer, and the private journal folder. The journal itself (`FileContinuationJournal`) is
//! ported with the continuation engine in Phase 4.

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::fs_util::{
    FileId, create_new_private, create_private_dir_all, dirname, set_mode, sync_directory,
};

/// The default size cap of a private JSON file, 1 MiB.
pub const MAX_BYTES: u64 = 1_048_576;

#[derive(Debug, thiserror::Error)]
pub enum PrivateJsonError {
    /// Not a regular file, a symbolic link, over the cap, or replaced while it was opened.
    #[error("continuation-file-invalid")]
    Invalid,
    #[error("continuation-file-too-large")]
    TooLarge,
    #[error("continuation-directory-invalid")]
    DirectoryInvalid,
    /// The bytes are not UTF-8 (`TextDecoder`'s fatal mode).
    #[error("The encoded data was not valid for encoding utf-8")]
    Encoding,
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl PrivateJsonError {
    /// The file is not there (Node's `ENOENT`).
    pub fn is_not_found(&self) -> bool {
        matches!(self, PrivateJsonError::Io(e) if e.kind() == io::ErrorKind::NotFound)
    }
}

/// Creates `directory` private (0700) and refuses one that is a symbolic link or not a folder.
/// JSON only: no credentials, native code or shell commands are persisted.
pub fn private_journal_directory(directory: &Path) -> Result<(), PrivateJsonError> {
    create_private_dir_all(directory)?;
    let info = fs::symlink_metadata(directory)?;
    if !info.is_dir() || info.is_symlink() {
        return Err(PrivateJsonError::DirectoryInvalid);
    }
    set_mode(directory, 0o700)?;
    Ok(())
}

fn open_no_follow(file: &Path) -> io::Result<File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    options.open(file)
}

/// Reads a JSON file of at most `max_bytes`, refusing a symbolic link, a non-file, a file that
/// changed between the look and the open, and bytes that are not UTF-8. A leading byte-order
/// mark is dropped, as `TextDecoder` does.
pub fn read_private_json(file: &Path, max_bytes: u64) -> Result<Value, PrivateJsonError> {
    let before = fs::symlink_metadata(file)?;
    if !before.is_file() || before.is_symlink() || before.len() > max_bytes {
        return Err(PrivateJsonError::Invalid);
    }
    let mut handle = open_no_follow(file)?;
    let info = handle.metadata()?;
    let named = fs::symlink_metadata(file)?;
    if !info.is_file()
        || named.is_symlink()
        || FileId::of_file(&handle)? != FileId::of_path(file)?
        || info.len() > max_bytes
    {
        return Err(PrivateJsonError::Invalid);
    }
    let mut data = Vec::new();
    (&mut handle).take(max_bytes + 1).read_to_end(&mut data)?;
    if data.len() as u64 > max_bytes {
        return Err(PrivateJsonError::TooLarge);
    }
    let text = std::str::from_utf8(&data).map_err(|_| PrivateJsonError::Encoding)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    Ok(serde_json::from_str(text)?)
}

/// Replaces `file` with compact JSON of at most `max_bytes` through a private temporary file,
/// returning once the file and its folder entry are durable. Never writes through a symbolic
/// link.
pub fn write_private_json<T: Serialize + ?Sized>(
    file: &Path,
    value: &T,
    max_bytes: u64,
) -> Result<(), PrivateJsonError> {
    let data = serde_json::to_vec(value)?;
    if data.len() as u64 > max_bytes {
        return Err(PrivateJsonError::TooLarge);
    }
    // `existsSync` follows links: only a link that resolves is refused, as in the TS.
    if file.exists() && fs::symlink_metadata(file)?.is_symlink() {
        return Err(PrivateJsonError::Invalid);
    }
    let mut temporary = file.as_os_str().to_owned();
    temporary.push(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let temporary = PathBuf::from(temporary);
    let result = (|| -> Result<(), PrivateJsonError> {
        let mut handle = create_new_private(&temporary)?;
        io::Write::write_all(&mut handle, &data)?;
        handle.sync_all()?;
        drop(handle);
        fs::rename(&temporary, file)?;
        sync_directory(dirname(file))?;
        Ok(())
    })();
    if temporary.exists() {
        fs::remove_file(&temporary)?;
    }
    result
}
