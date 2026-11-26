//! Port of `tests/app-vault-startup.test.ts` (`prepare_vault`). The cases the TS skips on
//! Windows (they need the shell stand-in for `security` to run) are `cfg(unix)` here.

#[path = "common/vault.rs"]
mod helpers;

use std::path::Path;
use std::sync::Arc;

use helpers::{FakeSecurity, Options, legacy_seal, legacy_unseal};
use relay_core::desktop_files::write_bytes;
use relay_core::vault_crypto::{LegacyUnseal, Sealer};
use relay_core::vault_migration::{
    PrepareVault, PreparedVault, VaultState, prepare_vault, vault_state,
};

const ACCOUNT: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

fn vault_dir() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("relay-prepare-")
        .tempdir()
        .unwrap()
}

fn put(vault: &Path, relative: &str, data: &[u8]) {
    write_bytes(vault, relative, Some(data)).unwrap();
}

#[cfg(unix)]
fn get(vault: &Path, relative: &str) -> Vec<u8> {
    relay_core::desktop_files::read_bytes(vault, relative)
        .unwrap()
        .unwrap()
}

fn unseal() -> LegacyUnseal {
    Arc::new(legacy_unseal)
}

fn foreign_seal(text: &str) -> Vec<u8> {
    let mut key = [0u8; 32];
    getrandom::fill(&mut key).unwrap();
    Sealer::new(&key).unwrap().seal(text)
}

fn prepare(vault: &Path, security: &FakeSecurity) -> PreparedVault {
    prepare_vault(PrepareVault {
        vault,
        legacy_unseal: unseal(),
        legacy_available: None,
        tool: Some(security.tool()),
    })
}

fn is_legacy(vault: &Path) -> bool {
    matches!(vault_state(vault).unwrap(), VaultState::Legacy { .. })
}

#[cfg(unix)]
#[test]
fn prepare_vault_migrates_a_format_1_vault_and_returns_a_sealer_that_opens_both_formats() {
    let dir = vault_dir();
    let vault = dir.path();
    let security = FakeSecurity::new(Options::default());
    put(
        vault,
        &format!("accounts/{ACCOUNT}.bin"),
        &legacy_seal("account"),
    );
    let r = prepare(vault, &security);
    assert_eq!(r.error, None);
    let migration = r.migration.as_ref().unwrap();
    assert_eq!((migration.migrated, migration.moved_aside.len()), (1, 0));
    assert_eq!(vault_state(vault).unwrap(), VaultState::Ready);
    let account = get(vault, &format!("accounts/{ACCOUNT}.bin"));
    assert_eq!(r.sealer.unseal(&account).unwrap(), "account");
    assert_eq!(r.sealer.unseal(&legacy_seal("old")).unwrap(), "old");
    assert_eq!(
        r.sealer.unseal(&r.sealer.seal("new").unwrap()).unwrap(),
        "new"
    );
}

#[test]
fn prepare_vault_never_creates_a_key_for_a_ready_vault_whose_key_is_missing() {
    let dir = vault_dir();
    let vault = dir.path();
    let security = FakeSecurity::new(Options::default());
    put(
        vault,
        &format!("accounts/{ACCOUNT}.bin"),
        &foreign_seal("account"),
    );
    let r = prepare(vault, &security);
    assert!(r.error.unwrap().contains("Relay Vault Key"));
    assert_eq!(security.stdin_log(), "");
    assert!(
        r.sealer
            .seal("x")
            .unwrap_err()
            .to_string()
            .contains("Relay Vault Key")
    );
}

#[cfg(unix)]
#[test]
fn prepare_vault_gives_an_empty_vault_a_key_and_the_marker() {
    let dir = vault_dir();
    let vault = dir.path();
    let security = FakeSecurity::new(Options::default());
    let r = prepare(vault, &security);
    assert_eq!(r.error, None);
    assert_ne!(security.stored(), "");
    let marker: serde_json::Value = serde_json::from_slice(&get(vault, "format.json")).unwrap();
    assert_eq!(marker, serde_json::json!({ "version": 2 }));
}

#[test]
fn prepare_vault_reports_a_newer_vault_and_seals_nothing() {
    let dir = vault_dir();
    let vault = dir.path();
    let security = FakeSecurity::new(Options::default());
    put(vault, "format.json", br#"{"version":3}"#);
    let r = prepare(vault, &security);
    assert!(r.error.unwrap().contains("newer"));
    assert!(r.sealer.seal("x").is_err());
    assert_eq!(security.argv_log(), "");
}

#[test]
fn prepare_vault_keeps_old_files_readable_when_the_keychain_is_locked() {
    let dir = vault_dir();
    let vault = dir.path();
    let security = FakeSecurity::new(Options {
        exit: Some(51),
        ..Options::default()
    });
    put(
        vault,
        &format!("accounts/{ACCOUNT}.bin"),
        &legacy_seal("account"),
    );
    let r = prepare(vault, &security);
    assert!(r.error.unwrap().contains("Relay Vault Key"));
    assert_eq!(r.sealer.unseal(&legacy_seal("account")).unwrap(), "account");
    assert!(is_legacy(vault));
}

#[cfg(unix)]
#[test]
fn prepare_vault_leaves_an_old_vault_alone_while_safe_storage_cannot_be_used() {
    let dir = vault_dir();
    let vault = dir.path();
    let security = FakeSecurity::new(Options::default());
    put(
        vault,
        &format!("accounts/{ACCOUNT}.bin"),
        &legacy_seal("account"),
    );
    let r = prepare_vault(PrepareVault {
        vault,
        legacy_unseal: unseal(),
        legacy_available: Some(&|| false),
        tool: Some(security.tool()),
    });
    assert!(r.error.unwrap().contains("Nothing was moved"));
    assert!(r.migration.is_none());
    assert!(is_legacy(vault));
    assert_eq!(
        get(vault, &format!("accounts/{ACCOUNT}.bin")),
        legacy_seal("account")
    );
}

#[cfg(unix)]
#[test]
fn prepare_vault_reports_files_it_set_aside() {
    let dir = vault_dir();
    let vault = dir.path();
    let security = FakeSecurity::new(Options::default());
    put(
        vault,
        &format!("accounts/{ACCOUNT}.bin"),
        &legacy_seal("account"),
    );
    put(
        vault,
        "backups/99999999-2222-4333-8444-555555555555.bin",
        b"v10broken!",
    );
    let r = prepare_vault(PrepareVault {
        vault,
        legacy_unseal: Arc::new(|data| {
            if String::from_utf8_lossy(data).contains("broken") {
                return Err(relay_core::legacy_unseal::LegacyUnsealError::Decrypt);
            }
            legacy_unseal(data)
        }),
        legacy_available: None,
        tool: Some(security.tool()),
    });
    assert!(r.error.unwrap().contains("unreadable"));
    assert_eq!(r.migration.unwrap().moved_aside.len(), 1);
}

#[test]
fn prepare_vault_never_creates_a_key_for_a_half_migrated_vault() {
    let dir = vault_dir();
    let vault = dir.path();
    let security = FakeSecurity::new(Options::default());
    put(
        vault,
        &format!("accounts/{ACCOUNT}.bin"),
        &foreign_seal("migrated"),
    );
    put(
        vault,
        "backups/11111111-2222-4333-8444-555555555555.bin",
        &legacy_seal("old"),
    );
    let r = prepare(vault, &security);
    assert!(r.error.unwrap().contains("Relay Vault Key"));
    assert_eq!(security.stdin_log(), "");
    assert!(is_legacy(vault));
}
