//! Port of `electron/core/data-reset.ts`.
//!
//! Settings → Advanced → Remove Relay's data, in two steps. The first runs in the running Relay:
//! it stops what lives outside the data folder (the gateway, the clients bound to it, the login
//! item, Relay's own Keychain items), leaves a marker, and relaunches. The second runs at the very
//! start of the next launch, before the shell or its webviews open the folder, and removes
//! everything in it, so nothing is open while it goes and no timer writes a file back. Claude's
//! own data is never in that folder: the Claude app stays signed in to the account it is on.

use std::error::Error;
use std::ffi::OsStr;
use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

use crate::fs_util::{iso_timestamp, resolve};

pub const RESET_MARKER: &str = ".relay-reset-pending";

/// Why the reset was refused; nothing was changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResetRefused {
    pub reason: String,
}

impl fmt::Display for ResetRefused {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.reason)
    }
}

impl Error for ResetRefused {}

/// A failure of a port's step: whatever the shell reports.
pub type PortError = Box<dyn Error + Send + Sync>;

/// Why `begin_reset` stopped.
#[derive(Debug)]
pub enum BeginResetError {
    Refused(ResetRefused),
    /// A step outside the folder failed; nothing was deleted and the marker was not written.
    Step(PortError),
    /// The marker could not be written.
    Io(io::Error),
}

impl fmt::Display for BeginResetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(refused) => refused.fmt(f),
            Self::Step(error) => error.fmt(f),
            Self::Io(error) => error.fmt(f),
        }
    }
}

impl Error for BeginResetError {}

/// The running Relay's side of the first step; the app implements it, tests fake it.
pub trait ResetPorts {
    /// Relay's data folder.
    fn root(&self) -> PathBuf;
    /// Why the reset must wait (a Desktop operation, a running terminal, a sign-in), or None.
    fn busy(&self) -> Option<String>;
    fn stop_gateway(&self) -> Result<(), PortError>;
    /// Gives each client bound to the gateway its own settings back.
    fn unbind_clients(&self) -> Result<(), PortError>;
    fn remove_login_item(&self) -> Result<(), PortError>;
    /// Relay's secrets outside the folder: the vault key and the profiles' Claude Code Keychain items.
    fn remove_secrets(&self) -> Result<(), PortError>;
    /// Quits and opens Relay again; the next launch finishes the reset.
    fn relaunch(&self);
}

/// The file operations the second step uses, so a test can watch every removal.
pub trait ResetFs {
    fn exists(&self, file: &Path) -> bool;
    /// The entry names of `dir`.
    fn read_dir(&self, dir: &Path) -> io::Result<Vec<String>>;
    /// `rm -rf`: a link is removed, never followed; a missing path is no error.
    fn remove(&self, file: &Path) -> io::Result<()>;
    /// Writes `data`, creating the file with `mode` when it is new.
    fn write_file(&self, file: &Path, data: &str, mode: u32) -> io::Result<()>;
}

/// The real file system.
#[derive(Clone, Copy, Debug, Default)]
pub struct NodeFs;

impl ResetFs for NodeFs {
    fn exists(&self, file: &Path) -> bool {
        file.exists()
    }

    fn read_dir(&self, dir: &Path) -> io::Result<Vec<String>> {
        fs::read_dir(dir)?
            .map(|entry| Ok(entry?.file_name().to_string_lossy().into_owned()))
            .collect()
    }

    fn remove(&self, file: &Path) -> io::Result<()> {
        let meta = match fs::symlink_metadata(file) {
            Ok(meta) => meta,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let kind = meta.file_type();
        let result = if kind.is_dir() {
            fs::remove_dir_all(file)
        } else if cfg!(windows) && kind.is_symlink() {
            // A link to a folder is a directory entry on Windows.
            fs::remove_file(file).or_else(|_| fs::remove_dir(file))
        } else {
            fs::remove_file(file)
        };
        match result {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }

    fn write_file(&self, file: &Path, data: &str, mode: u32) -> io::Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(mode);
        }
        #[cfg(not(unix))]
        let _ = mode;
        options.open(file)?.write_all(data.as_bytes())
    }
}

/// Node's `path.isAbsolute`: on Windows a rooted path (`\foo`) counts, a drive-relative one
/// (`C:foo`) does not.
fn is_absolute(path: &Path) -> bool {
    path.has_root()
}

fn same_name(a: &OsStr, b: &OsStr) -> bool {
    if cfg!(windows) {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

/// `path.relative(from, to)` starts with ".." or is absolute: `to` is not `from` or below it.
fn outside(from: &Path, to: &Path) -> bool {
    let from: Vec<Component> = from.components().collect();
    let to: Vec<Component> = to.components().collect();
    if to.len() < from.len()
        || !from
            .iter()
            .zip(&to)
            .all(|(a, b)| same_name(a.as_os_str(), b.as_os_str()))
    {
        return true;
    }
    // Below: the relative path is the rest, which "starts with .." only for such a name.
    to.get(from.len())
        .is_some_and(|next| next.as_os_str().to_string_lossy().starts_with(".."))
}

/// A folder the reset may empty: absolute, and neither the filesystem's root, the home folder
/// nor one of its parents. The data folder is always deeper; this keeps a wrong override from
/// wiping more than Relay's own.
pub fn safe_reset_root(root: &Path, home: &Path) -> bool {
    if !is_absolute(root) {
        return false;
    }
    let resolved = resolve(root);
    if resolved.parent().is_none() {
        return false;
    }
    outside(&resolved, &resolve(home))
}

/// The first step. Refused while `busy` names a reason, and nothing is touched then. Every step
/// that reaches outside the folder runs before the marker is written; a failing one stops the
/// reset with nothing deleted, so it can be tried again. `home` is the user's home folder
/// (`relay_paths::home_dir()`).
pub fn begin_reset(
    ports: &dyn ResetPorts,
    fs_impl: &dyn ResetFs,
    home: &Path,
    now_ms: i64,
) -> Result<(), BeginResetError> {
    let root = ports.root();
    if !safe_reset_root(&root, home) {
        return Err(BeginResetError::Refused(ResetRefused {
            reason: "This folder cannot be reset.".into(),
        }));
    }
    if let Some(reason) = ports.busy().filter(|reason| !reason.is_empty()) {
        return Err(BeginResetError::Refused(ResetRefused { reason }));
    }
    ports.stop_gateway().map_err(BeginResetError::Step)?;
    ports.unbind_clients().map_err(BeginResetError::Step)?;
    ports.remove_login_item().map_err(BeginResetError::Step)?;
    ports.remove_secrets().map_err(BeginResetError::Step)?;
    let marker = serde_json::json!({ "at": iso_timestamp(now_ms) });
    fs_impl
        .write_file(&root.join(RESET_MARKER), &format!("{marker}\n"), 0o600)
        .map_err(BeginResetError::Io)?;
    ports.relaunch();
    Ok(())
}

/// The second step: when the marker is there, removes every entry of `root` and each of `extra`
/// (the log folder, which macOS keeps outside the data folder). A link is removed, never
/// followed. The marker goes last, and only when everything else went, so an interrupted or
/// refused removal is tried again at the next launch. Answers the paths it removed, or None when
/// no reset was pending. Never fails: it runs before anything else at launch.
pub fn finish_pending_reset(
    root: &Path,
    extra: &[PathBuf],
    fs_impl: &dyn ResetFs,
    home: &Path,
) -> Option<Vec<PathBuf>> {
    let marker = root.join(RESET_MARKER);
    if !safe_reset_root(root, home) || !fs_impl.exists(&marker) {
        return None;
    }
    let mut removed = Vec::new();
    let names = fs_impl.read_dir(root);
    let mut complete = names.is_ok();
    let mut remove = |target: PathBuf| match fs_impl.remove(&target) {
        Ok(()) => {
            removed.push(target);
            true
        }
        Err(_) => false,
    };
    for name in names.unwrap_or_default() {
        if name != RESET_MARKER {
            complete &= remove(root.join(name));
        }
    }
    for target in extra {
        if safe_reset_root(target, home) && fs_impl.exists(target) {
            complete &= remove(target.clone());
        }
    }
    if complete {
        remove(marker);
    }
    Some(removed)
}
