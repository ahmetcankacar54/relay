//! Port of `tests/cli-reset.test.ts`: `relay reset-vault`. macOS only, as the TS skips elsewhere.
#![cfg(target_os = "macos")]

mod common;

use std::fs;
use std::sync::Arc;

use common::{Options, cli_fixture};

fn lost_key_folders(vault: &std::path::Path) -> Vec<String> {
    fs::read_dir(vault)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("lost-key-"))
        .collect()
}

#[test]
fn a_lost_vault_key_points_to_reset_vault_which_sets_the_old_files_aside_and_lets_accounts_be_saved_again()
 {
    let f = cli_fixture(Options::default());
    f.saved("A", None);
    let (b, _) = f.saved("B", None); // Desktop is signed in to B
    // The extension's sealed sign-ins are lost with the key too.
    let vault = f.vault();
    fs::create_dir_all(vault.join("extension")).unwrap();
    fs::write(
        vault.join("extension").join("x.bin"),
        "RLY2 sealed with the lost key",
    )
    .unwrap();
    f.security.remove_item("Relay Vault Key");
    assert_eq!(f.run(&["switch", "A", "--yes"]), 5);
    assert!(f.err().contains("relay reset-vault"), "{}", f.err());
    f.clear();
    assert_eq!(f.run(&["reset-vault"]), 4);
    assert_eq!(f.run(&["reset-vault", "--yes"]), 0);
    assert!(!vault.join("accounts").exists());
    let lost = lost_key_folders(&vault).into_iter().next().unwrap();
    assert!(vault.join(&lost).join("accounts").exists());
    assert!(!vault.join("extension").exists());
    assert!(vault.join(&lost).join("extension").join("x.bin").exists());
    assert_ne!(f.security.stored(), "");
    assert!(
        f.store()
            .state()
            .accounts
            .iter()
            .all(|a| a.desktop.is_none())
    );
    f.clear();
    assert_eq!(f.run(&["add", "B", "--yes"]), 0);
    assert_eq!(
        f.store()
            .account(&b.id)
            .unwrap()
            .desktop
            .unwrap()
            .account_uuid,
        b.desktop.unwrap().account_uuid
    );
}

#[test]
fn reset_vault_refuses_while_the_key_is_readable() {
    let f = cli_fixture(Options::default());
    f.saved("A", None);
    assert_eq!(f.run(&["reset-vault", "--yes"]), 1);
    assert!(f.err().to_lowercase().contains("nothing to reset"));
    assert!(f.store().state().accounts[0].desktop.is_some());
}

#[test]
fn reset_vault_refuses_a_vault_still_in_the_old_format_there_was_never_a_key_to_lose() {
    let f = cli_fixture(Options::default());
    let vault = f.vault();
    let old = vault
        .join("accounts")
        .join("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.bin");
    fs::create_dir_all(vault.join("accounts")).unwrap();
    fs::write(&old, "v10old").unwrap();
    assert_eq!(f.run(&["reset-vault", "--yes"]), 1);
    assert!(f.err().contains("old format"));
    assert!(old.exists());
    assert!(lost_key_folders(&vault).is_empty());
}

#[test]
fn reset_vault_refuses_while_relay_app_runs_since_it_keeps_its_own_key_in_memory() {
    let mut f = cli_fixture(Options::default());
    f.saved("A", None);
    f.security.remove_item("Relay Vault Key");
    f.deps.process_list =
        Arc::new(|| Ok("  501     1 /Applications/Relay.app/Contents/MacOS/Relay\n".into()));
    assert_eq!(f.run(&["reset-vault", "--yes"]), 3);
    assert!(f.err().contains("Quit Relay.app"));
    assert!(f.store().state().accounts[0].desktop.is_some());
}
