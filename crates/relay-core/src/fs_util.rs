//! File-system helpers the ported modules share: file identity, private files and folders,
//! directory sync, lexical path resolution (Node's `path.resolve`), and JS date/number rules.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// A file's identity, Node's `(dev, ino)`: the same identity means the same file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileId {
    pub dev: u64,
    pub ino: u64,
}

impl FileId {
    /// The identity of the entry at `path` itself, a symbolic link not followed (`lstat`).
    pub fn of_path(path: &Path) -> io::Result<FileId> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let meta = fs::symlink_metadata(path)?;
            Ok(FileId {
                dev: meta.dev(),
                ino: meta.ino(),
            })
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows::Win32::Storage::FileSystem::{
                FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
                FILE_SHARE_READ, FILE_SHARE_WRITE,
            };
            // Attribute access only, any sharing, the link itself, folders too.
            let file = OpenOptions::new()
                .access_mode(0)
                .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE).0)
                .custom_flags((FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT).0)
                .open(path)?;
            FileId::of_file(&file)
        }
    }

    /// The identity of an open file (`fstat`).
    pub fn of_file(file: &File) -> io::Result<FileId> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let meta = file.metadata()?;
            Ok(FileId {
                dev: meta.dev(),
                ino: meta.ino(),
            })
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows::Win32::Foundation::HANDLE;
            use windows::Win32::Storage::FileSystem::{
                BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
            };
            let mut info = BY_HANDLE_FILE_INFORMATION::default();
            // SAFETY: the handle is open for the duration of the call and `info` is writable.
            unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }
                .map_err(io::Error::other)?;
            Ok(FileId {
                dev: u64::from(info.dwVolumeSerialNumber),
                ino: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
            })
        }
    }
}

/// Flushes a folder's entries. Windows refuses fsync on a folder handle; the file itself was
/// flushed before it was linked or renamed into place.
pub fn sync_directory(directory: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        let _ = directory;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        File::open(directory)?.sync_all()
    }
}

/// Node's `path.dirname`: `.` for a bare name.
pub fn dirname(path: &Path) -> &Path {
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        Some(_) => Path::new("."),
        None => path,
    }
}

/// `fs.mkdirSync(dir, { recursive: true, mode: 0o700 })`: the folders it creates are private.
pub fn create_private_dir_all(dir: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

/// `fs.mkdirSync(dir, { mode: 0o700 })`: one folder, failing when it exists.
pub fn create_private_dir(dir: &Path) -> io::Result<()> {
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

/// `fs.openSync(file, "wx", 0o600)`: a new private file, failing when one exists.
pub fn create_new_private(file: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(file)
}

/// `chmod` on POSIX; Windows keeps its ACLs.
pub fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
        Ok(())
    }
}

/// `fs.utimesSync(path, at, at)` for a file or a folder.
pub fn set_times(path: &Path, at: SystemTime) -> io::Result<()> {
    let times = fs::FileTimes::new().set_accessed(at).set_modified(at);
    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::OpenOptionsExt;
        use windows::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
            FILE_WRITE_ATTRIBUTES,
        };
        OpenOptions::new()
            .access_mode(FILE_WRITE_ATTRIBUTES.0)
            .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE).0)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0)
            .open(path)?
    };
    #[cfg(not(windows))]
    let file = File::open(path)?;
    file.set_times(times)
}

/// Node's `stats.mtimeMs`: the modification time in epoch milliseconds, fractional.
pub fn mtime_ms(meta: &fs::Metadata) -> io::Result<f64> {
    Ok(system_time_ms(meta.modified()?))
}

/// A time in epoch milliseconds, fractional; negative before 1970.
pub fn system_time_ms(time: SystemTime) -> f64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(after) => after.as_secs_f64() * 1000.0,
        Err(before) => -before.duration().as_secs_f64() * 1000.0,
    }
}

/// `new Date(ms).toISOString()`: `2026-01-01T00:00:00.000Z`.
pub fn iso_timestamp(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// `Date.parse` for the ISO 8601 timestamps Relay writes; None where JS gives NaN.
pub fn parse_iso_ms(text: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|time| time.timestamp_millis())
}

/// `Number.isSafeInteger(value)` for a JSON value: `5` and `5.0` are, `5.5` and `"5"` are not.
pub fn safe_integer(value: &serde_json::Value) -> Option<i64> {
    const MAX: i64 = (1 << 53) - 1;
    let number = value.as_number()?;
    let n = if let Some(n) = number.as_i64() {
        n
    } else if number.is_u64() {
        return None;
    } else {
        let f = number.as_f64()?;
        if f.fract() != 0.0 || f.abs() > MAX as f64 {
            return None;
        }
        f as i64
    };
    (-MAX..=MAX).contains(&n).then_some(n)
}

/// Node's `path.resolve(path)`: absolute against the working folder, `.` and `..` folded
/// lexically, no trailing separator, symbolic links untouched.
pub fn resolve(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
    };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                out.push(component.as_os_str())
            }
            Component::CurDir => {}
            Component::ParentDir => {
                // `..` above the root stays at the root.
                if out.parent().is_some() {
                    out.pop();
                }
            }
        }
    }
    out
}

/// Node's `fs.realpathSync`: `canonicalize` without Windows's `\\?\` prefix.
pub fn real_path(path: &Path) -> io::Result<PathBuf> {
    let real = fs::canonicalize(path)?;
    #[cfg(windows)]
    {
        let text = real.as_os_str().to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return Ok(PathBuf::from(format!(r"\\{rest}")));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return Ok(PathBuf::from(rest));
        }
    }
    Ok(real)
}
