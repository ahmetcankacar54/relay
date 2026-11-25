//! Port of `tests/vault-key.test.ts`. Like the TS, these run wherever a shell stand-in for
//! `security` can (not on Windows); the fake mirrors `tests/fake-security.ts`.
#![cfg(unix)]

#[path = "common/vault.rs"]
mod helpers;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use helpers::{FakeSecurity, Options};
use relay_core::vault_key::{LoadVaultKey, VaultKeyError, load_vault_key, read_vault_key};

#[test]
fn reads_an_existing_key_with_find_generic_password_and_the_exact_item_names() {
    let f = FakeSecurity::new(Options {
        stored: Some(&STANDARD.encode([7u8; 32])),
        ..Options::default()
    });
    assert_eq!(read_vault_key(f.tool()).unwrap(), [7u8; 32]);
    assert!(
        f.argv_log()
            .contains("find-generic-password -s Relay Vault Key -a relay-vault -w")
    );
}

#[test]
fn a_missing_key_is_created_through_stdin_never_argv_and_read_back() {
    let f = FakeSecurity::new(Options::default());
    let key = load_vault_key(&LoadVaultKey {
        tool: Some(f.tool()),
        may_create: true,
    })
    .unwrap();
    assert_eq!(key.len(), 32);
    let encoded = STANDARD.encode(key);
    assert!(!f.argv_log().contains(&encoded));
    assert!(f.stdin_log().contains(&encoded));
    assert!(
        f.stdin_log()
            .contains("add-generic-password -s \"Relay Vault Key\" -a relay-vault")
    );
    assert_eq!(f.stored(), encoded);
}

#[test]
fn a_race_keeps_the_key_that_is_stored_not_the_one_generated() {
    let winner = STANDARD.encode([1u8; 32]);
    let f = FakeSecurity::new(Options {
        store_on_first_find: Some(&winner),
        ..Options::default()
    });
    let key = load_vault_key(&LoadVaultKey {
        tool: Some(f.tool()),
        may_create: true,
    })
    .unwrap();
    assert_eq!(STANDARD.encode(key), winner);
}

#[test]
fn missing_without_may_create_locked_and_malformed_are_distinct_errors() {
    let missing = FakeSecurity::new(Options::default());
    let locked = FakeSecurity::new(Options {
        exit: Some(51),
        ..Options::default()
    });
    let short = FakeSecurity::new(Options {
        stored: Some("c2hvcnQ="),
        ..Options::default()
    });
    assert_eq!(
        load_vault_key(&LoadVaultKey {
            tool: Some(missing.tool()),
            may_create: false,
        }),
        Err(VaultKeyError::Missing)
    );
    assert_eq!(missing.stdin_log(), "");
    assert_eq!(read_vault_key(locked.tool()), Err(VaultKeyError::Locked));
    assert_eq!(read_vault_key(short.tool()), Err(VaultKeyError::Invalid));
}

#[test]
fn a_tool_that_cannot_start_is_a_locked_keychain() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        read_vault_key(&dir.path().join("absent")),
        Err(VaultKeyError::Locked)
    );
}

#[test]
fn errors_keep_the_ts_messages() {
    assert_eq!(
        VaultKeyError::Missing.to_string(),
        "The Keychain item \"Relay Vault Key\" was not found."
    );
    assert_eq!(
        VaultKeyError::Locked.to_string(),
        "The Keychain item \"Relay Vault Key\" could not be read. Unlock the login keychain and try again."
    );
    assert_eq!(
        VaultKeyError::Invalid.to_string(),
        "The Keychain item \"Relay Vault Key\" does not hold a vault key."
    );
}
