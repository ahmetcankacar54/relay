//! Port of tests/linux-terminal.test.ts (the Linux ports of electron/core/terminal-identity).

#[path = "common/usage_terminal.rs"]
mod helpers;

use relay_core::relay_paths::Platform;
use relay_core::terminal_identity::{linux_terminal_ports, mac_terminal_ports};

fn temp_home() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("relay-linux-terminal-")
        .tempdir()
        .unwrap()
}

#[cfg(unix)]
fn mode(file: &std::path::Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(file).unwrap().permissions().mode() & 0o777
}

#[test]
fn the_linux_ports_are_the_plain_claude_s_on_linux_only() {
    let home = temp_home();
    let home = home.path();
    assert!(linux_terminal_ports(Some(home), Platform::MacOs).is_none());
    assert!(linux_terminal_ports(Some(home), Platform::Windows).is_none());
    assert!(mac_terminal_ports(Some(home), Platform::Linux).is_none());
    assert!(linux_terminal_ports(Some(home), Platform::Linux).is_some());
}

// POSIX file modes: Windows reports 0o666.
#[cfg(unix)]
#[test]
fn the_credentials_file_is_read_written_privately_and_atomically_and_removed() {
    use helpers::oauth;
    use serde_json::{Value, json};
    use std::os::unix::fs::PermissionsExt;

    let home = temp_home();
    let home = home.path();
    let dir = home.join(".claude");
    let file = dir.join(".credentials.json");
    let item = linux_terminal_ports(Some(home), Platform::Linux)
        .unwrap()
        .keychain;
    // No folder yet: nothing signed in; a write makes the folder private too.
    assert_eq!(item.read(), Ok(None));
    item.write(&json!({ "claudeAiOauth": oauth(1) }).to_string())
        .unwrap();
    assert_eq!(mode(&file), 0o600);
    assert_eq!(mode(&dir), 0o700);
    let read: Value = serde_json::from_str(&item.read().unwrap().unwrap()).unwrap();
    assert_eq!(read["claudeAiOauth"], Value::Object(oauth(1)));
    // A file Claude Code left readable becomes private at the next write, and nothing is left
    // beside it.
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
    item.write(&json!({ "claudeAiOauth": oauth(2) }).to_string())
        .unwrap();
    assert_eq!(mode(&file), 0o600);
    let names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(names, [".credentials.json"]);
    item.remove().unwrap();
    assert_eq!(item.read(), Ok(None));
    // Removing what is not there is fine, as the Keychain's "not found" is.
    item.remove().unwrap();
}

// Making a link needs std::os::unix here; the TS runs it everywhere.
#[cfg(unix)]
#[test]
fn a_link_or_folder_where_the_credentials_file_belongs_is_refused_never_followed_or_replaced() {
    use relay_core::shared::terminal_identity::TerminalReason;
    use relay_core::terminal_identity::{TerminalError, TerminalKeychain, credentials_file};

    let home = temp_home();
    let home = home.path();
    let target = home.join("elsewhere.json");
    std::fs::write(&target, "{}").unwrap();
    let file = home.join(".credentials.json");
    std::os::unix::fs::symlink(&target, &file).unwrap();
    let item = credentials_file(&file);
    assert_eq!(item.read(), Err(TerminalError(TerminalReason::Unreadable)));
    assert_eq!(
        item.write("{}"),
        Err(TerminalError(TerminalReason::WriteFailed))
    );
    assert_eq!(
        item.remove(),
        Err(TerminalError(TerminalReason::WriteFailed))
    );
    assert_eq!(std::fs::read_link(&file).unwrap(), target);
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "{}");
}

// POSIX file modes: Windows reports 0o666.
#[cfg(unix)]
#[test]
fn a_switch_through_the_linux_ports_keeps_mcp_sign_ins_and_other_keys_and_the_config_s_other_keys()
{
    use std::collections::HashMap;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    use std::sync::{Arc, Mutex};

    use helpers::{access, oauth, object, owner_from, random_id, sealed_vault};
    use relay_core::shared::terminal_identity::{TerminalIdentity, TerminalMode, TerminalResult};
    use relay_core::terminal_identity::{TerminalPorts, TerminalRequest, TerminalSwitcher};
    use serde_json::{Value, json};

    let home = temp_home();
    let home = home.path();
    let dir = home.join(".claude");
    std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
    let file = dir.join(".credentials.json");
    let a = random_id();
    let b = random_id();
    let account = |id: &TerminalIdentity, email: &str| {
        object(json!({
            "accountUuid": id.account_uuid,
            "organizationUuid": id.org_id,
            "emailAddress": email,
        }))
    };
    {
        use std::io::Write;
        let mut handle = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&file)
            .unwrap();
        handle
            .write_all(
                json!({
                    "claudeAiOauth": oauth(1),
                    "mcpOAuth": { "server": { "token": "mcp" } },
                    "future": 1,
                })
                .to_string()
                .as_bytes(),
            )
            .unwrap();
    }
    std::fs::write(
        home.join(".claude.json"),
        json!({ "theme": "dark", "oauthAccount": account(&a, "a@x") }).to_string(),
    )
    .unwrap();
    let owners = Arc::new(Mutex::new(HashMap::from([
        (access(1), a.clone()),
        (access(2), b.clone()),
    ])));
    let ports = TerminalPorts {
        owner: Some(owner_from(owners)),
        ..linux_terminal_ports(Some(home), Platform::Linux).unwrap()
    };
    let vault = sealed_vault(&home.join("vault"));
    vault
        .save(&b, &oauth(2), &account(&b, "b@x"), true)
        .unwrap();
    let outcome = TerminalSwitcher::new(ports, vault.clone()).run(&TerminalRequest {
        mode: TerminalMode::Follow,
        target: vec![b.clone()],
        known: vec![a.clone(), b.clone()],
    });
    assert_eq!(outcome.result, TerminalResult::Switched);
    let item: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(item["claudeAiOauth"], Value::Object(oauth(2)));
    assert_eq!(item["mcpOAuth"], json!({ "server": { "token": "mcp" } }));
    assert_eq!(item["future"], 1);
    assert_eq!(mode(&file), 0o600);
    let config: Value =
        serde_json::from_slice(&std::fs::read(home.join(".claude.json")).unwrap()).unwrap();
    assert_eq!(config["oauthAccount"]["emailAddress"], "b@x");
    assert_eq!(config["theme"], "dark");
    assert_eq!(
        vault
            .load(std::slice::from_ref(&a))
            .unwrap()
            .map(|s| s.oauth),
        Some(oauth(1))
    );
    // Claude Code's refresh locks were taken and given back.
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, [".credentials.json"]);
}
