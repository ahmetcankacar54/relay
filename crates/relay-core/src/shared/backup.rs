//! Port of `shared/backup.ts`: the account backup's IPC shapes.

use serde::{Deserialize, Serialize};

use super::types::js::ser_num;
use super::types::{AccountProvider, literal_enum};

/// The extension of an account backup file.
pub const BACKUP_EXTENSION: &str = "relaybackup";

/// The shortest passphrase an export accepts.
pub const MIN_BACKUP_PASSPHRASE: usize = 10;

literal_enum!(
    /// How an import treats what is already here.
    BackupImportMode { Merge = "merge", Replace = "replace" }
);

/// What an export wrote.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupExportResult {
    #[serde(serialize_with = "ser_num")]
    pub accounts: f64,
    /// Saved sign-ins written into the file; 0 when they were left out.
    #[serde(serialize_with = "ser_num")]
    pub sign_ins: f64,
}

/// A backup file picked for import, before its passphrase was given.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupFileChoice {
    /// The file's name, without its folder.
    pub name: String,
}

/// One account the opened backup holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummaryAccount {
    pub name: String,
    pub provider: AccountProvider,
    /// Its sign-ins are in the file.
    pub sign_in: bool,
    /// An account with this id, or this Claude app account, is already here: a merge skips it.
    pub present: bool,
}

/// What an opened backup holds, shown before the user picks merge or replace.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub created_at: String,
    pub relay_version: String,
    /// The `process.platform` it was made on.
    pub platform: String,
    pub accounts: Vec<BackupSummaryAccount>,
    pub sign_ins: bool,
    /// Accounts here now: what a replace takes out of the list.
    #[serde(serialize_with = "ser_num")]
    pub current_accounts: f64,
}

/// What an import did.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupImportResult {
    pub mode: BackupImportMode,
    #[serde(serialize_with = "ser_num")]
    pub added: f64,
    /// Accounts a merge left out: already here, or over the 50-account limit.
    #[serde(serialize_with = "ser_num")]
    pub skipped: f64,
    /// Sign-ins put back and sealed with this computer's key.
    #[serde(serialize_with = "ser_num")]
    pub sign_ins: f64,
    /// Sign-ins in the file that could not be put back.
    #[serde(serialize_with = "ser_num")]
    pub sign_ins_failed: f64,
    /// A replace first saves what was here, with the same passphrase: that file's name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
}
