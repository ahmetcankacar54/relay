//! Port of `electron/core/extension-vault.ts`: the Claude extension's sign-ins, sealed like the
//! rest of the vault, one file per account.

use std::fs;
use std::path::PathBuf;

use serde_json::{Map, Value, json};

use crate::desktop_files::{read_bytes, safe_file, write_bytes};
use crate::draft_vault::{Clock, Seal, Unseal, VaultError, system_clock};
use crate::fs_util::{iso_timestamp, system_time_ms};
use crate::shared::browser_extension::SavedSignIn;
use crate::shared::extension_auth::{SignIn, is_account_uuid, without_failure};

fn invalid(message: &str) -> VaultError {
    VaultError::Invalid(message.to_owned())
}

/// Inside the vault, one sealed file per account: `extension/<account uuid>.bin`.
const DIR: &str = "extension";
/// Which account the extension was last on; not an account's file, so `list` skips it.
const OWNER: &str = "extension/owner.bin";
/// Present while a swap writes the profile's pair; left behind when Relay stopped in the middle.
const SWAPPING: &str = "extension/swapping.bin";

fn file(account_uuid: &str) -> Result<String, VaultError> {
    if !is_account_uuid(account_uuid) {
        return Err(invalid("Invalid account uuid."));
    }
    Ok(format!("{DIR}/{}.bin", account_uuid.to_lowercase()))
}

/// When each account's file in `dir` was saved, from the files; nothing is opened.
pub(crate) fn list_saved(vault: &std::path::Path, dir: &str) -> Vec<SavedSignIn> {
    let Ok(dir) = safe_file(vault, dir) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".bin") else {
            continue;
        };
        if !is_account_uuid(id) {
            continue;
        }
        // Gone since the listing: left out.
        if let Ok(modified) = fs::metadata(entry.path()).and_then(|st| st.modified()) {
            out.push(SavedSignIn {
                account_uuid: id.to_lowercase(),
                saved_at: iso_timestamp(system_time_ms(modified).floor() as i64),
            });
        }
    }
    out
}

/// The extension's sign-ins, sealed like the rest of the vault. Each is kept under the account
/// uuid the extension itself says it belongs to, so a copy can never be put in place for another
/// account.
pub struct ExtensionVault {
    vault: PathBuf,
    seal: Seal,
    unseal: Unseal,
    now: Clock,
}

impl ExtensionVault {
    pub fn new(vault: impl Into<PathBuf>, seal: Seal, unseal: Unseal, now: Option<Clock>) -> Self {
        ExtensionVault {
            vault: vault.into(),
            seal,
            unseal,
            now: now.unwrap_or_else(system_clock),
        }
    }

    fn open(&self, data: &[u8]) -> Result<Value, VaultError> {
        let text = (self.unseal)(data).map_err(VaultError::Unseal)?;
        Ok(serde_json::from_str(&text)?)
    }

    /// Keeps `sign_in` as the account's (the account the extension named), replacing the one
    /// saved. The extension's record of a failed sign-in is never kept (see `FAILURE_KEYS`).
    pub fn save(&self, account_uuid: &str, sign_in: &SignIn) -> Result<(), VaultError> {
        if !is_account_uuid(account_uuid) {
            return Err(invalid("This sign-in names no account."));
        }
        let saved = json!({
            "accountUuid": account_uuid.to_lowercase(),
            "savedAt": iso_timestamp((self.now)()),
            "signIn": without_failure(sign_in),
        });
        let sealed = (self.seal)(&saved.to_string()).map_err(VaultError::Seal)?;
        write_bytes(&self.vault, &file(account_uuid)?, Some(&sealed))?;
        Ok(())
    }

    /// The sign-in saved for the first of `account_uuids` that has one; None when none does.
    /// Without the record of a failed sign-in, which Relay 0.14.1 and earlier kept too. Fails when
    /// a file is damaged or sealed with another key, or names another account.
    pub fn load(&self, account_uuids: &[String]) -> Result<Option<SignIn>, VaultError> {
        for account_uuid in account_uuids {
            let Some(data) = read_bytes(&self.vault, &file(account_uuid)?)? else {
                continue;
            };
            let saved = self.open(&data)?;
            let sign_in = saved.get("signIn").and_then(Value::as_object);
            let named = saved.get("accountUuid").and_then(Value::as_str);
            let (Some(sign_in), Some(named)) = (sign_in, named) else {
                return Err(invalid("Invalid saved extension sign-in."));
            };
            if named != account_uuid.to_lowercase() {
                return Err(invalid("Invalid saved extension sign-in."));
            }
            let sign_in: SignIn = sign_in
                .iter()
                .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_owned())))
                .collect();
            return Ok(Some(without_failure(&sign_in)));
        }
        Ok(None)
    }

    /// The account Relay last knew the extension to be on: the one it named, the one Relay put in
    /// place, or the one the user said it was. Used when the extension's own data names no account.
    pub fn owner(&self) -> Result<Option<String>, VaultError> {
        let Some(data) = read_bytes(&self.vault, OWNER)? else {
            return Ok(None);
        };
        Ok(self
            .open(&data)
            .ok()
            .and_then(|v| v.get("accountUuid")?.as_str().map(str::to_owned))
            .filter(|uuid| is_account_uuid(uuid))
            .map(|uuid| uuid.to_lowercase()))
    }

    /// Written before a swap changes the profile's hints and cookies, and cleared once both are in
    /// place.
    pub fn mark_swap(&self) -> Result<(), VaultError> {
        let at = iso_timestamp(crate::clock::now_ms());
        write_bytes(&self.vault, SWAPPING, Some(at.as_bytes()))?;
        Ok(())
    }

    pub fn clear_swap(&self) -> Result<(), VaultError> {
        write_bytes(&self.vault, SWAPPING, None)?;
        Ok(())
    }

    /// A swap stopped between its two writes: the profile's hints and cookies may name different
    /// accounts.
    pub fn swap_interrupted(&self) -> bool {
        matches!(read_bytes(&self.vault, SWAPPING), Ok(Some(_)))
    }

    pub fn set_owner(&self, account_uuid: &str) -> Result<(), VaultError> {
        if !is_account_uuid(account_uuid) {
            return Ok(());
        }
        let mut record = Map::new();
        record.insert("accountUuid".into(), account_uuid.to_lowercase().into());
        let sealed = (self.seal)(&Value::Object(record).to_string()).map_err(VaultError::Seal)?;
        write_bytes(&self.vault, OWNER, Some(&sealed))?;
        Ok(())
    }

    /// When each account's sign-in was saved, from the files; nothing is opened.
    pub fn list(&self) -> Vec<SavedSignIn> {
        list_saved(&self.vault, DIR)
    }
}
