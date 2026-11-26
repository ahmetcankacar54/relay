//! Port of `electron/core/relay-paths.ts`: where Relay and Claude Desktop keep their data.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::fs_util::resolve;

/// The operating system a path layout is for (Node's `process.platform`); every other Unix
/// takes the Linux layout, as in the TS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    MacOs,
    Windows,
    Linux,
}

impl Platform {
    /// The platform this binary runs on.
    pub const fn current() -> Platform {
        if cfg!(target_os = "macos") {
            Platform::MacOs
        } else if cfg!(windows) {
            Platform::Windows
        } else {
            Platform::Linux
        }
    }
}

/// The folders Relay uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayPaths {
    /// Relay's data folder: the menu-bar app's userData.
    pub data: PathBuf,
    /// Claude Desktop's data folder.
    pub claude: PathBuf,
    /// Claude.app bundles to look for, first found wins; none by default off macOS.
    pub claude_apps: Vec<PathBuf>,
    pub vault: PathBuf,
    pub profiles: PathBuf,
    /// Per-account profile locks.
    pub locks: PathBuf,
    /// The CLI's detached-worker records.
    pub cli_operations: PathBuf,
}

/// An environment lookup; an empty value counts as unset.
fn get(env: &dyn Fn(&str) -> Option<OsString>, key: &str) -> Option<OsString> {
    env(key).filter(|value| !value.is_empty())
}

/// An absolute override from the environment, resolved; a relative one is ignored.
fn override_path(value: Option<OsString>) -> Option<PathBuf> {
    let value = PathBuf::from(value?);
    is_absolute(&value).then(|| resolve(&value))
}

/// Node's `path.isAbsolute` on this host: on Windows a leading separator counts, as there.
fn is_absolute(path: &Path) -> bool {
    if cfg!(windows) {
        path.to_str().is_some_and(win32_is_absolute)
    } else {
        path.is_absolute()
    }
}

/// `path.win32.isAbsolute`: a leading separator, or a drive letter and a separator.
fn win32_is_absolute(text: &str) -> bool {
    let b = text.as_bytes();
    let sep = |c: u8| c == b'/' || c == b'\\';
    match b {
        [first, ..] if sep(*first) => true,
        [drive, b':', third, ..] => drive.is_ascii_alphabetic() && sep(*third),
        _ => false,
    }
}

/// `path.posix.normalize` of an absolute path: `.` and `..` folded, no repeated or trailing `/`.
fn posix_normalize(text: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in text.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    format!("/{}", parts.join("/"))
}

/// `path.posix.join(home, ".config")`.
fn posix_join(base: &str, name: &str) -> String {
    let joined = format!("{base}/{name}");
    if joined.starts_with('/') {
        posix_normalize(&joined)
    } else {
        // A relative home stays relative; only the separators are folded.
        posix_normalize(&joined).trim_start_matches('/').to_owned()
    }
}

/// `path.win32.join(home, "AppData", "Roaming")`, separators turned to `\` and folded.
fn win32_join(base: &str, parts: &[&str]) -> String {
    let mut joined = base.replace('/', "\\");
    for part in parts {
        if !joined.ends_with('\\') {
            joined.push('\\');
        }
        joined.push_str(part);
    }
    let unc = joined.starts_with("\\\\");
    let mut out = String::with_capacity(joined.len());
    for c in joined.chars() {
        if c == '\\' && out.ends_with('\\') && !(unc && out.len() == 1) {
            continue;
        }
        out.push(c);
    }
    out
}

/// The folder apps keep their data in, as Electron's `app.getPath("appData")`: Application
/// Support on macOS, %APPDATA% on Windows, and on Linux $XDG_CONFIG_HOME when absolute, else
/// ~/.config.
pub fn app_data_root(
    platform: Platform,
    home: &Path,
    env: &dyn Fn(&str) -> Option<OsString>,
) -> PathBuf {
    match platform {
        Platform::MacOs => home.join("Library").join("Application Support"),
        Platform::Windows => {
            let appdata = get(env, "APPDATA");
            match appdata.as_ref().and_then(|v| v.to_str()) {
                Some(value) if win32_is_absolute(value) => PathBuf::from(value),
                _ => PathBuf::from(win32_join(&home.to_string_lossy(), &["AppData", "Roaming"])),
            }
        }
        Platform::Linux => {
            let xdg = get(env, "XDG_CONFIG_HOME");
            match xdg.as_ref().and_then(|v| v.to_str()) {
                Some(value) if value.starts_with('/') => PathBuf::from(posix_normalize(value)),
                _ => PathBuf::from(posix_join(&home.to_string_lossy(), ".config")),
            }
        }
    }
}

/// The folders Relay uses. RELAY_HOME, RELAY_CLAUDE_DIR and RELAY_CLAUDE_APP override them,
/// for tests and power users; a relative override is ignored.
pub fn relay_paths_with(
    env: &dyn Fn(&str) -> Option<OsString>,
    home: &Path,
    platform: Platform,
) -> RelayPaths {
    let support = app_data_root(platform, home, env);
    let data = override_path(get(env, "RELAY_HOME")).unwrap_or_else(|| support.join("Relay"));
    let claude_apps = match override_path(get(env, "RELAY_CLAUDE_APP")) {
        Some(app) => vec![app],
        None if platform == Platform::MacOs => vec![
            PathBuf::from("/Applications/Claude.app"),
            home.join("Applications").join("Claude.app"),
        ],
        None => Vec::new(),
    };
    RelayPaths {
        claude: override_path(get(env, "RELAY_CLAUDE_DIR"))
            .unwrap_or_else(|| support.join("Claude")),
        claude_apps,
        vault: data.join("desktop-vault"),
        profiles: data.join("profiles"),
        locks: data.join("profiles").join(".locks"),
        cli_operations: data.join("cli-operations"),
        data,
    }
}

/// The folders Relay uses on this machine, from this process's environment and home folder.
pub fn relay_paths() -> RelayPaths {
    relay_paths_with(
        &|key| std::env::var_os(key),
        &home_dir(),
        Platform::current(),
    )
}

/// Node's `os.homedir()`.
pub fn home_dir() -> PathBuf {
    std::env::home_dir().unwrap_or_default()
}
