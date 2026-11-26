//! Port of `electron/core/vault-migration.ts`: the desktop vault's format marker, and the move
//! of sealed files from the old seal (Electron safeStorage) to format 2.

use std::fs;
use std::io;
use std::path::Path;

use serde_json::json;

use crate::desktop_files::{DesktopFileError, json_bytes, read_bytes, read_object, write_bytes};
use crate::fs_util::safe_integer;
use crate::legacy_unseal::LegacyUnsealError;
use crate::vault_crypto::{LegacyUnseal, Sealer, UnsealError, is_sealed_v2};
use crate::vault_key::{LoadVaultKey, VAULT_KEY_SERVICE, VaultKeyError, load_vault_key};

/// The vault format this build reads and writes.
pub const VAULT_FORMAT: i64 = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultState {
    Empty,
    Ready,
    Legacy { files: Vec<String> },
    Newer { version: i64 },
}

/// The folders whose `.bin` files are sealed, and the draft vault's one file.
const SEALED_DIRS: [&str; 2] = ["accounts", "backups"];
const DRAFTS: &str = "drafts/pending.bin";

#[derive(Debug, thiserror::Error)]
pub enum VaultMigrationError {
    #[error("Invalid vault format marker.")]
    InvalidMarker,
    #[error(
        "None of the old saved sign-in files could be opened, so nothing was moved. Relay tries again at its next start."
    )]
    NoneOpened,
    #[error(
        "The recovery backup named in journal.json could not be opened, so the saved sign-ins were not moved to the new format."
    )]
    RecoveryBackup,
    #[error(transparent)]
    Files(#[from] DesktopFileError),
    #[error(transparent)]
    Io(#[from] io::Error),
}

fn is_plain_file(file: &Path) -> bool {
    fs::symlink_metadata(file).is_ok_and(|meta| meta.is_file())
}

/// Every sealed file in the vault, as paths relative to it, sorted.
pub fn sealed_files(vault: &Path) -> Result<Vec<String>, VaultMigrationError> {
    let mut found = Vec::new();
    for dir in SEALED_DIRS {
        let entries = match fs::read_dir(vault.join(dir)) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        // A name that is not UTF-8 is one Node could not lstat back either: skipped.
        let mut names = entries
            .map(|entry| entry.map(|e| e.file_name().into_string().ok()))
            .collect::<io::Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        // `Array#sort`: UTF-16 code unit order.
        names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        for name in names {
            if name.ends_with(".bin") && is_plain_file(&vault.join(dir).join(&name)) {
                found.push(format!("{dir}/{name}"));
            }
        }
    }
    if is_plain_file(&vault.join(DRAFTS)) {
        found.push(DRAFTS.to_owned());
    }
    Ok(found)
}

fn marker_version(vault: &Path) -> Result<Option<i64>, VaultMigrationError> {
    let Some(marker) = read_object(vault, "format.json")? else {
        return Ok(None);
    };
    match marker.get("version").and_then(safe_integer) {
        Some(version) if version >= 1 => Ok(Some(version)),
        _ => Err(VaultMigrationError::InvalidMarker),
    }
}

/// Old files not in format 2 yet, read without changing anything.
fn legacy_files(vault: &Path, files: &[String]) -> Result<Vec<String>, VaultMigrationError> {
    let mut legacy = Vec::new();
    for relative in files {
        if read_bytes(vault, relative)?.is_some_and(|data| !is_sealed_v2(&data)) {
            legacy.push(relative.clone());
        }
    }
    Ok(legacy)
}

/// What the vault holds: a newer format than this build knows; format 2 (marked, or every
/// sealed file already in it); nothing sealed yet; or old files still to migrate.
pub fn vault_state(vault: &Path) -> Result<VaultState, VaultMigrationError> {
    let version = marker_version(vault)?;
    if let Some(version) = version.filter(|v| *v > VAULT_FORMAT) {
        return Ok(VaultState::Newer { version });
    }
    if version == Some(VAULT_FORMAT) {
        return Ok(VaultState::Ready);
    }
    let files = sealed_files(vault)?;
    if files.is_empty() {
        return Ok(VaultState::Empty);
    }
    let legacy = legacy_files(vault, &files)?;
    Ok(if legacy.is_empty() {
        VaultState::Ready
    } else {
        VaultState::Legacy { files: legacy }
    })
}

pub fn mark_vault_format(vault: &Path) -> Result<(), VaultMigrationError> {
    write_bytes(
        vault,
        "format.json",
        Some(&json_bytes(&json!({ "version": VAULT_FORMAT }))),
    )?;
    Ok(())
}

/// Moves an unreadable file under `unreadable/`, keeping its relative path; never deletes it.
fn move_aside(vault: &Path, relative: &str) -> Result<(), VaultMigrationError> {
    let mut target = vault.join("unreadable").join(relative).into_os_string();
    let parent = crate::fs_util::dirname(Path::new(&target)).to_path_buf();
    crate::fs_util::create_private_dir_all(&parent)?;
    if fs::metadata(&target).is_ok() {
        target.push(format!(".{}", crate::clock::now_ms()));
    }
    fs::rename(vault.join(relative), target)?;
    Ok(())
}

/// `fs.utimes(file, atime, mtime)`.
fn restore_times(file: &Path, meta: &fs::Metadata) -> io::Result<()> {
    let mut times = fs::FileTimes::new().set_modified(meta.modified()?);
    if let Ok(accessed) = meta.accessed() {
        times = times.set_accessed(accessed);
    }
    fs::OpenOptions::new()
        .write(true)
        .open(file)?
        .set_times(times)
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Migration {
    pub migrated: usize,
    pub moved_aside: Vec<String>,
}

/// Re-seals every old file in format 2, keeping its modification time, and writes the marker
/// once none is left. A run stopped half-way resumes, since format-2 files are skipped. Every old
/// file is opened before anything changes:
/// - none opens, and none was migrated before: the old seal is unusable this run (macOS refused
///   it), so nothing moves and no marker is written; the next start tries again;
/// - the backup journal.json names does not open: recovery depends on it, so nothing moves;
/// - otherwise each file that does not open is moved aside, never deleted.
pub fn migrate_vault(
    vault: &Path,
    sealer: &Sealer,
    legacy_unseal: &dyn Fn(&[u8]) -> Result<String, LegacyUnsealError>,
) -> Result<Migration, VaultMigrationError> {
    let journal = read_object(vault, "journal.json")?;
    let recovery = journal
        .as_ref()
        .and_then(|j| j.get("backup"))
        .and_then(|b| b.as_str())
        .map(|backup| format!("backups/{}.bin", backup.to_lowercase()));
    let mut opened: Vec<(String, String)> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    let mut any_v2 = false;
    for relative in sealed_files(vault)? {
        let data = read_bytes(vault, &relative)?;
        let Some(data) = data else { continue };
        if is_sealed_v2(&data) {
            any_v2 = true;
            continue;
        }
        match legacy_unseal(&data) {
            Ok(text) => opened.push((relative, text)),
            Err(_) => failed.push(relative),
        }
    }
    // Nothing opening at all means the old seal was refused this run, unless an earlier run
    // already migrated files with it: then what is left is damaged, and is set aside below.
    if !failed.is_empty() && opened.is_empty() && !any_v2 {
        return Err(VaultMigrationError::NoneOpened);
    }
    if let Some(recovery) = &recovery
        && failed
            .iter()
            .any(|relative| relative.to_lowercase() == *recovery)
    {
        return Err(VaultMigrationError::RecoveryBackup);
    }
    let mut migrated = 0;
    for (relative, text) in &opened {
        let file = vault.join(relative);
        let meta = fs::metadata(&file)?;
        write_bytes(vault, relative, Some(&sealer.seal(text)))?;
        restore_times(&file, &meta)?;
        migrated += 1;
    }
    for relative in &failed {
        move_aside(vault, relative)?;
    }
    if legacy_files(vault, &sealed_files(vault)?)?.is_empty() {
        mark_vault_format(vault)?;
    }
    Ok(Migration {
        migrated,
        moved_aside: failed,
    })
}

/// Why a [`VaultSealer`] did not seal or open a file.
#[derive(Debug, thiserror::Error)]
pub enum VaultSealError {
    /// The vault cannot be used this run; the message says why.
    #[error("{0}")]
    Refused(String),
    #[error(transparent)]
    Unseal(#[from] UnsealError),
}

/// The app's vault sealer: format 2 with the key, or one that refuses (old files stay readable
/// through the legacy unseal, when it was given).
pub enum VaultSealer {
    Ready(Box<Sealer>),
    Refusing {
        message: String,
        legacy: Option<LegacyUnseal>,
    },
}

impl VaultSealer {
    pub fn seal(&self, text: &str) -> Result<Vec<u8>, VaultSealError> {
        match self {
            Self::Ready(sealer) => Ok(sealer.seal(text)),
            Self::Refusing { message, .. } => Err(VaultSealError::Refused(message.clone())),
        }
    }

    pub fn unseal(&self, data: &[u8]) -> Result<String, VaultSealError> {
        match self {
            Self::Ready(sealer) => Ok(sealer.unseal(data)?),
            Self::Refusing {
                legacy: Some(legacy),
                ..
            } if !is_sealed_v2(data) => {
                Ok(legacy(data).map_err(|e| VaultSealError::Unseal(e.into()))?)
            }
            Self::Refusing { message, .. } => Err(VaultSealError::Refused(message.clone())),
        }
    }
}

pub struct PrepareVault<'a> {
    pub vault: &'a Path,
    pub legacy_unseal: LegacyUnseal,
    /// Whether the old seal can be used now; false when the OS refused its key this run.
    pub legacy_available: Option<&'a dyn Fn() -> bool>,
    /// The `security` stand-in; `None` is this platform's key store.
    pub tool: Option<&'a Path>,
}

pub struct PreparedVault {
    pub sealer: VaultSealer,
    pub migration: Option<Migration>,
    pub error: Option<String>,
}

fn refusing(message: String, legacy: Option<LegacyUnseal>) -> PreparedVault {
    PreparedVault {
        sealer: VaultSealer::Refusing {
            message: message.clone(),
            legacy,
        },
        migration: None,
        error: Some(message),
    }
}

/// Readies the app's vault at startup: loads the vault key, creating it only while no format-2
/// file needs an existing one; migrates old files; marks the format. It never fails: `error`
/// says what went wrong, and the sealer then refuses with that message, except that old files
/// stay readable through `legacy_unseal`.
pub fn prepare_vault(options: PrepareVault<'_>) -> PreparedVault {
    let PrepareVault {
        vault,
        legacy_unseal,
        legacy_available,
        tool,
    } = options;
    let state = match vault_state(vault) {
        Ok(state) => state,
        Err(error) => {
            return refusing(
                format!("Relay’s saved sign-ins could not be read: {error}"),
                Some(legacy_unseal),
            );
        }
    };
    if let VaultState::Newer { version } = state {
        return refusing(
            format!(
                "Relay’s saved sign-ins were written by a newer version (format {version}). Update Relay."
            ),
            None,
        );
    }
    // A key is only ever made for a vault no format-2 file depends on: one a migration stopped
    // half-way through already has some, sealed with the key that is missing now.
    let mut any_v2 = false;
    if matches!(state, VaultState::Legacy { .. }) {
        let files = match sealed_files(vault) {
            Ok(files) => files,
            Err(error) => return refusing(error.to_string(), Some(legacy_unseal)),
        };
        for relative in files {
            match read_bytes(vault, &relative) {
                Ok(Some(data)) if is_sealed_v2(&data) => any_v2 = true,
                Ok(_) => {}
                Err(error) => return refusing(error.to_string(), Some(legacy_unseal)),
            }
        }
    }
    let may_create = match state {
        VaultState::Empty => true,
        VaultState::Legacy { .. } => !any_v2,
        _ => false,
    };
    let key = match load_vault_key(&LoadVaultKey { tool, may_create }) {
        Ok(key) => key,
        Err(error) => {
            let lost = matches!(error, VaultKeyError::Missing | VaultKeyError::Invalid);
            let message = if state == VaultState::Ready || any_v2 {
                format!(
                    "The Keychain item \"{VAULT_KEY_SERVICE}\" could not be read, so saved Claude app sign-ins cannot be opened. {error}{}",
                    if lost {
                        " To start over, run relay reset-vault (npm i -g @ahmetcankacar/relay) and save each account again."
                    } else {
                        ""
                    }
                )
            } else {
                format!("The Keychain item \"{VAULT_KEY_SERVICE}\" could not be read. {error}")
            };
            return refusing(message, Some(legacy_unseal));
        }
    };
    let sealer =
        Sealer::with_legacy(&key, legacy_unseal.clone()).expect("a loaded vault key is 32 bytes");
    let (migration, error) = if matches!(state, VaultState::Legacy { .. }) {
        if legacy_available.is_some_and(|available| !available()) {
            (
                None,
                Some("Relay could not open its old saved sign-ins this time (macOS did not allow access to their key). Nothing was moved; Relay tries again at its next start.".to_owned()),
            )
        } else {
            match migrate_vault(vault, &sealer, &*legacy_unseal) {
                Ok(migration) => {
                    // shared/error-text.ts matches this sentence to give it in Turkish: change
                    // both together.
                    let error = match migration.moved_aside.len() {
                        0 => None,
                        1 => Some("1 saved sign-in file could not be opened and was set aside in desktop-vault/unreadable. Save the affected accounts’ Claude app sign-ins again.".to_owned()),
                        n => Some(format!("{n} saved sign-in files could not be opened and were set aside in desktop-vault/unreadable. Save the affected accounts’ Claude app sign-ins again.")),
                    };
                    (Some(migration), error)
                }
                Err(error) => (None, Some(error.to_string())),
            }
        }
    } else {
        (None, mark_vault_format(vault).err().map(|e| e.to_string()))
    };
    PreparedVault {
        sealer: VaultSealer::Ready(Box::new(sealer)),
        migration,
        error,
    }
}
