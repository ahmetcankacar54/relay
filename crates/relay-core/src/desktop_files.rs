//! Port of `electron/core/desktop-files.ts`: the file primitives for Claude Desktop's data and
//! Relay's desktop vault. The conversation and project merge planners (`planHistory`,
//! `planPermissionPreferences`, `duplicateSessions`) are ported with `desktop.ts` in Phase 4.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::fs_util::{create_new_private, create_private_dir_all, dirname, resolve};

/// A JSON object, keys in file order.
pub type JsonObject = Map<String, Value>;

/// The largest Desktop file Relay reads, 64 MiB.
pub const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// The `config.json` keys that sign Claude Desktop in.
pub const AUTH_KEYS: [&str; 3] = [
    "oauth:tokenCache",
    "oauth:tokenCacheV2",
    "lastKnownAccountUuid",
];

/// Claude Desktop's cookie database and its journals, old and new layout.
pub const COOKIE_FILES: [&str; 8] = [
    "Cookies",
    "Cookies-journal",
    "Cookies-wal",
    "Cookies-shm",
    "Network/Cookies",
    "Network/Cookies-journal",
    "Network/Cookies-wal",
    "Network/Cookies-shm",
];

#[derive(Debug, thiserror::Error)]
pub enum DesktopFileError {
    #[error("Invalid Desktop path.")]
    InvalidPath,
    #[error("Desktop data cannot contain symbolic links.")]
    SymbolicLink,
    #[error("Unsupported Desktop file size or type.")]
    UnsupportedFile,
    #[error("Unsupported Desktop data format.")]
    UnsupportedFormat,
    /// An id that is not a uuid (zod's `z.uuid().parse`).
    #[error("Invalid UUID")]
    InvalidUuid,
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// zod 4's `z.uuid()`: RFC 9562 versions 1–8 with the variant bits, or the nil and max uuids.
pub fn is_uuid(text: &str) -> bool {
    if text == "00000000-0000-0000-0000-000000000000"
        || text == "ffffffff-ffff-ffff-ffff-ffffffffffff"
    {
        return true;
    }
    let bytes = text.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (i, &b) in bytes.iter().enumerate() {
        let ok = match i {
            8 | 13 | 18 | 23 => b == b'-',
            14 => (b'1'..=b'8').contains(&b),
            19 => matches!(b, b'8' | b'9' | b'a' | b'b' | b'A' | b'B'),
            _ => b.is_ascii_hexdigit(),
        };
        if !ok {
            return false;
        }
    }
    true
}

/// `relative` under `root`, refused when it leaves `root` or passes through a symbolic link
/// (`root` itself included).
pub fn safe_file(root: &Path, relative: &str) -> Result<PathBuf, DesktopFileError> {
    let base = resolve(root);
    let target = resolve(&base.join(relative));
    let mut prefix = base.as_os_str().as_encoded_bytes().to_vec();
    prefix.push(std::path::MAIN_SEPARATOR as u8);
    if !target.as_os_str().as_encoded_bytes().starts_with(&prefix) {
        return Err(DesktopFileError::InvalidPath);
    }
    let mut p = target.as_path();
    loop {
        match fs::symlink_metadata(p) {
            Ok(meta) if meta.is_symlink() => return Err(DesktopFileError::SymbolicLink),
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        if p == base {
            break;
        }
        p = dirname(p);
    }
    Ok(target)
}

/// The file's bytes, or None when it is not there.
pub fn read_bytes(root: &Path, relative: &str) -> Result<Option<Vec<u8>>, DesktopFileError> {
    let file = safe_file(root, relative)?;
    let read = || -> Result<Vec<u8>, DesktopFileError> {
        let st = fs::metadata(&file)?;
        if !st.is_file() || st.len() > MAX_FILE_BYTES {
            return Err(DesktopFileError::UnsupportedFile);
        }
        Ok(fs::read(&file)?)
    };
    match read() {
        Ok(data) => Ok(Some(data)),
        Err(DesktopFileError::Io(e)) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// The file's JSON object, or None when it is not there. Anything but an object is refused.
pub fn read_object(root: &Path, relative: &str) -> Result<Option<JsonObject>, DesktopFileError> {
    let Some(data) = read_bytes(root, relative)? else {
        return Ok(None);
    };
    // Buffer#toString: invalid UTF-8 becomes U+FFFD, a byte-order mark stays (and fails).
    match serde_json::from_str::<Value>(&String::from_utf8_lossy(&data))? {
        Value::Object(obj) => Ok(Some(obj)),
        _ => Err(DesktopFileError::UnsupportedFormat),
    }
}

/// Replaces the file with `data` through a private `<file>.relay-<uuid>` file that is flushed
/// and renamed into place; missing folders are created private. `None` removes the file.
pub fn write_bytes(
    root: &Path,
    relative: &str,
    data: Option<&[u8]>,
) -> Result<(), DesktopFileError> {
    let file = safe_file(root, relative)?;
    let Some(data) = data else {
        return match fs::remove_file(&file) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        };
    };
    create_private_dir_all(dirname(&file))?;
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(format!(".relay-{}", uuid::Uuid::new_v4()));
    let tmp = PathBuf::from(tmp);
    let result = (|| -> io::Result<()> {
        let mut handle = create_new_private(&tmp)?;
        handle.write_all(data)?;
        handle.sync_all()?;
        drop(handle);
        fs::rename(&tmp, &file)
    })();
    match fs::remove_file(&tmp) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(result?),
    }
}

/// `JSON.stringify(value, null, 2)` as bytes, no trailing newline.
pub fn json_bytes<T: Serialize + ?Sized>(value: &T) -> Vec<u8> {
    serde_json::to_vec_pretty(value).expect("JSON values always serialize")
}

/// The account Claude Desktop's `config.json` is signed in as: its `lastKnownAccountUuid`
/// when it is a uuid and a `oauth:tokenCacheV2` is present.
pub fn identity(config: Option<&JsonObject>) -> Option<String> {
    let config = config?;
    let id = config.get("lastKnownAccountUuid")?.as_str()?;
    let cache = config.get("oauth:tokenCacheV2")?.as_str()?;
    (is_uuid(id) && !cache.is_empty()).then(|| id.to_owned())
}

/// The uuid-named folders in `relative`, in directory order; none when it is not there.
pub fn directories(root: &Path, relative: &str) -> Result<Vec<String>, DesktopFileError> {
    let dir = safe_file(root, relative)?;
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry?;
        // Dirent#isDirectory: a link to a folder is not one.
        if !entry.file_type()?.is_dir() {
            continue;
        }
        if let Some(name) = entry.file_name().to_str().filter(|n| is_uuid(n)) {
            names.push(name.to_owned());
        }
    }
    Ok(names)
}

/// An account in an organization: where Claude Desktop keeps its per-account data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub account_uuid: String,
    pub org_id: String,
}

/// `<kind>/<accountUuid>/<orgId>`, refusing ids that are not uuids.
pub fn scope_path(kind: &str, scope: &Scope) -> Result<String, DesktopFileError> {
    if !is_uuid(&scope.account_uuid) || !is_uuid(&scope.org_id) {
        return Err(DesktopFileError::InvalidUuid);
    }
    Ok(format!("{kind}/{}/{}", scope.account_uuid, scope.org_id))
}
