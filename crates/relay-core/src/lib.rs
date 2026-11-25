//! Relay's data layer: paths, the state file, the vault, locks and backups.

pub mod relay_paths;
pub mod desktop_files;
pub mod continuation_journal;
pub mod redact;
pub mod process_lock;
pub mod profile_lock;
pub mod cli_refresh_lock;
pub mod vault_crypto;
pub mod vault_key;
pub mod legacy_unseal;
