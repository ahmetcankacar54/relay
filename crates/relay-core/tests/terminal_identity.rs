//! Port of tests/terminal-identity.test.ts (electron/core/terminal-identity). The
//! `terminalIdentities`/`terminalLine` cases are in shared_terminal_identity.rs and the
//! cli-refresh-lock cases in cli_refresh_lock.rs.

#[path = "common/usage_terminal.rs"]
mod helpers;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use helpers::{World, WorldOptions, access, busy_lock, oauth, object, person, random_id};
use relay_core::clock::now_ms;
use relay_core::relay_paths::Platform;
use relay_core::shared::terminal_identity::{
    TerminalCurrentState, TerminalMode, TerminalReason, TerminalResult, terminal_line,
};
#[cfg(unix)]
use relay_core::terminal_identity::TerminalKeychain;
use relay_core::terminal_identity::{
    SignInPorts, TerminalAdoption, TerminalConfig, TerminalRequest, TerminalSwitcher,
    TerminalVault, adopt_terminal_sign_in, json_config, peek_terminal, scratch_sign_in_ports,
};
use serde_json::{Value, json};

fn follow(
    w: &World,
    target: &[&relay_core::shared::terminal_identity::TerminalIdentity],
) -> TerminalRequest {
    TerminalRequest {
        mode: TerminalMode::Follow,
        target: target.iter().map(|x| (*x).clone()).collect(),
        known: vec![w.a.clone(), w.b.clone()],
    }
}

fn world() -> World {
    World::new(WorldOptions::default())
}

#[test]
fn a_switch_saves_the_terminal_s_sign_in_for_its_account_and_puts_the_target_s_in_place() {
    let w = world();
    w.sign_in(&w.a, 1, "a@x");
    w.save(&w.b, 2, "b@x", true);
    let outcome = w.switcher.run(&follow(&w, &[&w.b]));
    assert_eq!(outcome.result, TerminalResult::Switched);
    assert!(outcome.saved);
    let item = w.item_json();
    assert_eq!(item["claudeAiOauth"], Value::Object(oauth(2)));
    // MCP servers' sign-ins in the same item stay.
    assert_eq!(item["mcpOAuth"], json!({ "server": { "token": "mcp" } }));
    assert_eq!(w.account_field("emailAddress"), "b@x");
    assert_eq!(w.state().config["theme"], "dark");
    assert_eq!(w.saved_oauth(&w.a), Some(oauth(1)));
    assert_eq!(
        outcome.current.and_then(|c| c.account_uuid),
        Some(w.b.account_uuid.clone())
    );
    // And back: B's sign-in, as Claude Code renewed it meanwhile, is saved on the way out.
    let mut renewed = object(item);
    renewed.insert("claudeAiOauth".into(), Value::Object(oauth(3)));
    w.set_item(Some(serde_json::to_string(&renewed).unwrap()));
    let back = w.switcher.run(&follow(&w, &[&w.a]));
    assert_eq!(back.result, TerminalResult::Switched);
    assert_eq!(w.item_json()["claudeAiOauth"], Value::Object(oauth(1)));
    assert_eq!(w.saved_oauth(&w.b), Some(oauth(3)));
}

#[test]
fn a_sign_in_relay_cannot_name_is_never_overwritten() {
    let w = world();
    let stranger = random_id();
    w.sign_in(&stranger, 1, "other@x");
    w.save(&w.b, 2, "b@x", true);
    let before = w.item();
    let outcome = w.switcher.run(&follow(&w, &[&w.b]));
    assert_eq!(outcome.result, TerminalResult::Skipped);
    assert_eq!(outcome.reason, Some(TerminalReason::UnknownAccount));
    let current = outcome.current.unwrap();
    assert_eq!(current.email.as_deref(), Some("other@x"));
    assert_eq!(current.known, Some(false));
    assert_eq!(w.item(), before);
    // The same person in another organization is another account.
    let other_org = relay_core::shared::terminal_identity::TerminalIdentity {
        account_uuid: w.a.account_uuid.clone(),
        org_id: random_id().org_id,
    };
    w.sign_in(&other_org, 1, "a@x");
    let again = w.switcher.run(&follow(&w, &[&w.b]));
    assert_eq!(again.reason, Some(TerminalReason::UnknownAccount));
}

#[test]
fn a_target_with_nothing_saved_leaves_the_terminal_as_it_is_its_sign_in_saved() {
    let w = world();
    w.sign_in(&w.a, 1, "a@x");
    let before = w.item();
    let outcome = w.switcher.run(&follow(&w, &[&w.b]));
    assert_eq!(outcome.result, TerminalResult::Saved);
    assert_eq!(outcome.reason, Some(TerminalReason::NoSavedLogin));
    assert_eq!(w.item(), before);
    assert_eq!(w.saved_oauth(&w.a), Some(oauth(1)));
    // Saved already and unchanged: nothing new to say.
    let again = w.switcher.run(&follow(&w, &[&w.b]));
    assert_eq!(again.result, TerminalResult::Unchanged);
}

#[test]
fn a_signed_out_terminal_gets_the_target_s_sign_in() {
    let w = world();
    w.save(&w.b, 2, "b@x", true);
    let outcome = w.switcher.run(&follow(&w, &[&w.b]));
    assert_eq!(outcome.result, TerminalResult::Switched);
    assert_eq!(w.item_json(), json!({ "claudeAiOauth": oauth(2) }));
}

#[test]
fn the_terminal_already_on_the_target_is_left_alone() {
    let w = world();
    w.sign_in(&w.b, 4, "b@x");
    w.save(&w.b, 2, "b@x", true);
    let outcome = w.switcher.run(&follow(&w, &[&w.b]));
    assert_eq!(outcome.reason, Some(TerminalReason::AlreadyThere));
    assert_eq!(w.item_json()["claudeAiOauth"], Value::Object(oauth(4)));
    // The live copy replaced the older saved one.
    assert_eq!(w.saved_oauth(&w.b), Some(oauth(4)));
}

#[test]
fn a_write_that_does_not_read_back_puts_the_previous_sign_in_back() {
    let w = World::new(WorldOptions {
        fail_write: true,
        ..Default::default()
    });
    w.sign_in(&w.a, 1, "a@x");
    w.save(&w.b, 2, "b@x", true);
    let before = w.item();
    let outcome = w.switcher.run(&follow(&w, &[&w.b]));
    assert_eq!(outcome.result, TerminalResult::Failed);
    assert_eq!(outcome.reason, Some(TerminalReason::WriteFailed));
    assert_eq!(w.item(), before);
    assert_eq!(w.account_field("emailAddress"), "a@x");
}

#[test]
fn mode_off_and_a_busy_lock_change_nothing() {
    let w = world();
    w.sign_in(&w.a, 1, "a@x");
    w.save(&w.b, 2, "b@x", true);
    let before = w.item();
    let off = TerminalRequest {
        mode: TerminalMode::Off,
        ..follow(&w, &[&w.b])
    };
    assert_eq!(w.switcher.run(&off).reason, Some(TerminalReason::Off));
    let busy = TerminalSwitcher::new(w.ports_with_lock(busy_lock()), w.vault.clone());
    let outcome = busy.run(&follow(&w, &[&w.b]));
    assert_eq!(
        (outcome.result, outcome.reason),
        (TerminalResult::Skipped, Some(TerminalReason::Busy))
    );
    assert_eq!(w.item(), before);
    assert_eq!(
        w.switcher
            .check(TerminalMode::Off, std::slice::from_ref(&w.a)),
        None
    );
}

#[test]
fn a_check_links_a_known_sign_in_and_only_reads_an_unknown_one() {
    let w = world();
    w.sign_in(&w.a, 1, "a@x");
    let current = w
        .switcher
        .check(TerminalMode::Follow, &[w.a.clone(), w.b.clone()])
        .unwrap();
    assert_eq!(current.state, TerminalCurrentState::SignedIn);
    assert_eq!(current.known, Some(true));
    assert_eq!(w.saved_oauth(&w.a), Some(oauth(1)));
    assert_eq!(
        w.vault
            .list()
            .into_iter()
            .map(|x| (x.account_uuid, x.org_id))
            .collect::<Vec<_>>(),
        [(w.a.account_uuid.clone(), w.a.org_id.clone())]
    );
    w.sign_in(&w.b, 2, "b@x");
    w.switcher
        .check(TerminalMode::Follow, std::slice::from_ref(&w.a));
    assert_eq!(w.saved_oauth(&w.b), None);
    // peek reads only.
    let peeked = peek_terminal(&w.ports, &[w.a.clone(), w.b.clone()], &now_ms);
    assert_eq!(peeked.account_uuid, Some(w.b.account_uuid.clone()));
    assert_eq!(w.saved_oauth(&w.b), None);
    w.set_item(Some("not json".into()));
    assert_eq!(
        w.switcher
            .check(TerminalMode::Follow, std::slice::from_ref(&w.a))
            .map(|c| c.state),
        Some(TerminalCurrentState::Unreadable)
    );
}

#[cfg(unix)]
#[test]
fn the_keychain_item_is_read_through_security_hex_decoded_and_written_with_the_secret_on_stdin_only()
 {
    use helpers::write_script;
    use relay_core::terminal_identity::security_keychain;
    let dir = tempfile::Builder::new()
        .prefix("relay-terminal-security-")
        .tempdir()
        .unwrap();
    let dir = dir.path();
    let tool = dir.join("security");
    write_script(
        &tool,
        r#"#!/bin/sh
dir="$(dirname "$0")"
echo "$*" >> "$dir/argv.log"
if [ "$1" = "-i" ]; then cat > "$dir/stdin.log"; exit 0; fi
if [ "$1" = "find-generic-password" ]; then [ -f "$dir/item" ] || exit 44; cat "$dir/item"; exit 0; fi
if [ "$1" = "delete-generic-password" ]; then rm -f "$dir/item"; exit 0; fi
exit 9
"#,
    );
    let keychain = security_keychain(Some("someone"), Some(&tool), Some("Test-credentials"));
    assert_eq!(keychain.read(), Ok(None));
    let text = serde_json::to_string(&json!({ "claudeAiOauth": oauth(1) })).unwrap();
    let hex: String = text.bytes().map(|b| format!("{b:02x}")).collect();
    std::fs::write(dir.join("item"), format!("{hex}\n")).unwrap();
    assert_eq!(keychain.read(), Ok(Some(text.clone())));
    keychain.write(&text).unwrap();
    let argv = std::fs::read_to_string(dir.join("argv.log")).unwrap();
    assert!(!argv.contains("access-1") && !argv.contains("7b22"));
    let stdin = std::fs::read_to_string(dir.join("stdin.log")).unwrap();
    assert_eq!(
        stdin,
        format!(
            "add-generic-password -U -a \"someone\" -s \"Test-credentials\" -X \"{hex}\"\nquit\n"
        )
    );
    keychain.remove().unwrap();
    assert_eq!(keychain.read(), Ok(None));
    // A name it cannot quote stops only the terminal step, at use.
    assert!(
        security_keychain(Some("bad\"user"), Some(&tool), None)
            .read()
            .is_err()
    );
}

#[cfg(unix)]
#[test]
fn an_item_too_long_for_one_interactive_line_is_written_through_the_arguments_whole() {
    use helpers::write_script;
    use relay_core::terminal_identity::{SECURITY_STDIN_LIMIT, security_keychain};
    let dir = tempfile::Builder::new()
        .prefix("relay-terminal-security-")
        .tempdir()
        .unwrap();
    let dir = dir.path();
    let tool = dir.join("security");
    // Like the real one: an interactive line is cut at 4 KB; the arguments are taken whole.
    write_script(
        &tool,
        r#"#!/bin/sh
dir="$(dirname "$0")"
if [ "$1" = "-i" ]; then head -c 4095 | sed -n 's/.*-X "\([0-9a-f]*\).*/\1/p' | head -1 > "$dir/item"; echo stdin >> "$dir/how.log"; exit 0; fi
if [ "$1" = "add-generic-password" ]; then shift; while [ "$1" != "-X" ]; do shift; done; echo "$2" > "$dir/item"; echo argv >> "$dir/how.log"; exit 0; fi
if [ "$1" = "find-generic-password" ]; then [ -f "$dir/item" ] || exit 44; cat "$dir/item"; exit 0; fi
exit 9
"#,
    );
    let keychain = security_keychain(Some("someone"), Some(&tool), Some("Test-credentials"));
    // Several MCP servers' sign-ins make the item many kilobytes long.
    let mcp: serde_json::Map<String, Value> = (0..12)
        .map(|i| {
            (
                format!("plugin:server-{i}|0123456789abcdef"),
                json!({
                    "accessToken": format!("access-{i}-{}", "a".repeat(300)),
                    "refreshToken": format!("refresh-{i}-{}", "r".repeat(300)),
                }),
            )
        })
        .collect();
    let large =
        serde_json::to_string(&json!({ "claudeAiOauth": oauth(1), "mcpOAuth": mcp })).unwrap();
    assert!(large.len() * 2 > SECURITY_STDIN_LIMIT);
    keychain.write(&large).unwrap();
    assert_eq!(keychain.read(), Ok(Some(large.clone())), "nothing is cut");
    let small = serde_json::to_string(&json!({ "claudeAiOauth": oauth(2) })).unwrap();
    keychain.write(&small).unwrap();
    assert_eq!(keychain.read(), Ok(Some(small)));
    assert_eq!(
        std::fs::read_to_string(dir.join("how.log"))
            .unwrap()
            .trim()
            .split('\n')
            .collect::<Vec<_>>(),
        ["argv", "stdin"]
    );
    // A refused write through the arguments says so.
    write_script(&tool, "#!/bin/sh\nexit 51\n");
    assert!(keychain.write(&large).is_err());
}

#[test]
fn the_config_keeps_every_other_key_and_its_mode_when_the_account_changes() {
    let dir = tempfile::Builder::new()
        .prefix("relay-terminal-config-")
        .tempdir()
        .unwrap();
    let dir = dir.path();
    let file = dir.join(".claude.json");
    std::fs::write(
        &file,
        serde_json::to_string(
            &json!({ "theme": "dark", "oauthAccount": { "accountUuid": "old" } }),
        )
        .unwrap(),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let config = json_config(&file);
    config
        .write_account(Some(&object(json!({ "accountUuid": "new" }))))
        .unwrap();
    let written: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(
        written,
        json!({ "theme": "dark", "oauthAccount": { "accountUuid": "new" } })
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    config.write_account(None).unwrap();
    assert_eq!(config.read(), Ok(Some(object(json!({ "theme": "dark" })))));
    let names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(names, [".claude.json"]);
    assert_eq!(json_config(dir.join("none.json")).read(), Ok(None));
}

#[test]
fn a_token_anthropic_says_is_another_account_s_is_neither_saved_nor_replaced() {
    let w = world();
    w.sign_in(&w.a, 1, "a@x");
    // ~/.claude.json names A, but the token is B's (a sign-in by hand caught half written).
    w.owners.lock().unwrap().insert(access(1), w.b.clone());
    let current = w
        .switcher
        .check(TerminalMode::Follow, &[w.a.clone(), w.b.clone()])
        .unwrap();
    assert_eq!(current.mismatch, Some(true));
    assert_eq!(current.known, Some(false));
    assert_eq!(w.saved_oauth(&w.a), None);
    w.save(&w.b, 2, "b@x", true);
    let before = w.item();
    let outcome = w.switcher.run(&follow(&w, &[&w.b]));
    assert_eq!(
        (outcome.result, outcome.reason),
        (TerminalResult::Skipped, Some(TerminalReason::Mismatch))
    );
    assert_eq!(w.item(), before);
    assert_eq!(w.saved_oauth(&w.a), None);
}

#[test]
fn a_token_that_cannot_be_asked_about_is_saved_by_a_switch_only_never_by_a_check() {
    let w = world();
    w.sign_in(&w.a, 1, "a@x");
    w.owners.lock().unwrap().clear();
    w.switcher
        .check(TerminalMode::Follow, &[w.a.clone(), w.b.clone()]);
    assert_eq!(w.saved_oauth(&w.a), None);
    w.save(&w.b, 2, "b@x", true);
    let outcome = w.switcher.run(&follow(&w, &[&w.b]));
    assert_eq!(outcome.result, TerminalResult::Switched);
    let parked = w.vault.load(std::slice::from_ref(&w.a)).unwrap().unwrap();
    assert_eq!(parked.oauth, oauth(1));
    assert!(parked.parked);
}

#[test]
fn a_token_that_cannot_be_asked_about_never_replaces_the_only_copy_taken_away_at_a_switch() {
    let w = world();
    w.save(&w.a, 1, "a@x", true);
    w.save(&w.b, 2, "b@x", true);
    // A write stopped between the Keychain and the config: B's token, the config naming A.
    w.sign_in(&w.a, 3, "a@x");
    w.set_item(Some(
        serde_json::to_string(&json!({ "claudeAiOauth": oauth(2) })).unwrap(),
    ));
    w.owners.lock().unwrap().clear();
    w.switcher.run(&follow(&w, &[&w.b]));
    assert_eq!(w.saved_oauth(&w.a), Some(oauth(1)));
}

#[test]
fn a_copy_saved_while_in_use_is_put_back_flagged_one_taken_away_at_a_switch_is_not() {
    let w = world();
    w.sign_in(&w.a, 1, "a@x");
    w.switcher
        .check(TerminalMode::Follow, &[w.a.clone(), w.b.clone()]);
    assert_eq!(w.saved_parked(&w.a), Some(false));
    // The user signs the terminal in to B by hand; Relay never took A away.
    w.sign_in(&w.b, 2, "b@x");
    let to_a = w.switcher.run(&follow(&w, &[&w.a]));
    assert_eq!(to_a.result, TerminalResult::Switched);
    assert_eq!(to_a.unconfirmed, Some(true));
    assert!(
        terminal_line(&to_a, relay_i18n::Locale::En, Some("A"))
            .unwrap()
            .contains("claude auth login")
    );
    // B was taken away at that switch: still good, and listed so.
    let mut listed: Vec<(&str, bool)> = w
        .vault
        .list()
        .into_iter()
        .map(|x| {
            (
                if x.account_uuid == w.b.account_uuid {
                    "b"
                } else {
                    "a"
                },
                x.parked,
            )
        })
        .collect();
    listed.sort();
    assert_eq!(listed, [("a", false), ("b", true)]);
    let to_b = w.switcher.run(&follow(&w, &[&w.b]));
    assert_eq!(to_b.result, TerminalResult::Switched);
    assert_eq!(to_b.unconfirmed, None);
    // A copy now in use again no longer counts as the only one.
    assert_eq!(w.saved_parked(&w.b), Some(false));
    assert_eq!(w.saved_parked(&w.a), Some(true));
}

#[test]
fn a_check_waits_on_claude_code_s_lock_only_looks_while_it_is_busy_and_reads_on_when_the_vault_fails()
 {
    let w = world();
    w.sign_in(&w.a, 1, "a@x");
    let locked = Arc::new(AtomicUsize::new(0));
    let counter = locked.clone();
    let counting = TerminalSwitcher::new(
        w.ports_with_lock(Arc::new(move |action: &mut dyn FnMut()| {
            counter.fetch_add(1, Ordering::SeqCst);
            action();
            Ok(())
        })),
        w.vault.clone(),
    );
    counting.check(TerminalMode::Follow, std::slice::from_ref(&w.a));
    assert_eq!(locked.load(Ordering::SeqCst), 1);
    w.sign_in(&w.a, 5, "a@x");
    let busy = TerminalSwitcher::new(w.ports_with_lock(busy_lock()), w.vault.clone());
    let seen = busy
        .check(TerminalMode::Follow, std::slice::from_ref(&w.a))
        .unwrap();
    assert_eq!(seen.state, TerminalCurrentState::SignedIn);
    assert_eq!(seen.known, Some(true));
    assert_eq!(w.saved_oauth(&w.a), Some(oauth(1)));
    let broken = TerminalSwitcher::new(
        w.ports.clone(),
        TerminalVault::new(
            w.temp.path().join("vault"),
            Arc::new(|_: &str| Err("no key yet".to_owned())),
            Arc::new(|_: &[u8]| Err("no key yet".to_owned())),
        ),
    );
    let read = broken
        .check(TerminalMode::Follow, std::slice::from_ref(&w.a))
        .unwrap();
    assert_eq!(read.state, TerminalCurrentState::SignedIn);
    assert_eq!(read.known, Some(true));
}

#[test]
fn a_config_write_that_fails_leaves_both_the_keychain_item_and_the_config_as_they_were() {
    let w = World::new(WorldOptions {
        fail_config: true,
        ..Default::default()
    });
    w.sign_in(&w.a, 1, "a@x");
    w.save(&w.b, 2, "b@x", true);
    let before = w.item();
    let outcome = w.switcher.run(&follow(&w, &[&w.b]));
    assert_eq!(
        (outcome.result, outcome.reason),
        (TerminalResult::Failed, Some(TerminalReason::WriteFailed))
    );
    assert_eq!(w.item(), before);
    assert_eq!(w.account_field("emailAddress"), "a@x");
}

#[test]
fn a_sign_in_made_for_the_terminal_in_a_scratch_folder_is_kept_for_its_account_only_as_the_one_good_copy()
 {
    let w = world();
    let ports = SignInPorts::from(&w.ports);
    let adopt = || adopt_terminal_sign_in(&ports, std::slice::from_ref(&w.a), &w.vault).unwrap();
    // Nothing signed in there: nothing kept.
    assert_eq!(adopt(), TerminalAdoption::SignedOut);
    // Approved with another account, or in another workspace of the same account.
    w.sign_in(&w.b, 2, "b@x");
    assert_eq!(adopt(), TerminalAdoption::OtherAccount);
    let other_workspace = relay_core::shared::terminal_identity::TerminalIdentity {
        account_uuid: w.a.account_uuid.clone(),
        org_id: w.b.org_id.clone(),
    };
    w.sign_in(&other_workspace, 3, "a@x");
    assert_eq!(adopt(), TerminalAdoption::OtherAccount);
    // The file names the account, the token is someone else's.
    w.sign_in(&w.a, 4, "a@x");
    w.owners.lock().unwrap().insert(access(4), w.b.clone());
    assert_eq!(adopt(), TerminalAdoption::OtherAccount);
    assert_eq!(w.saved_oauth(&w.a), None);
    // The account's own: saved as taken away, so the next switch puts it in the terminal.
    w.sign_in(&w.a, 5, "a@x");
    assert_eq!(adopt(), TerminalAdoption::Saved);
    let saved = w.vault.load(std::slice::from_ref(&w.a)).unwrap().unwrap();
    assert!(saved.parked);
    assert_eq!(saved.oauth["accessToken"], access(5));
    // The terminal, on B, follows to A with that sign-in, and its MCP sign-ins stay.
    w.sign_in(&w.b, 6, "b@x");
    let outcome = w.switcher.run(&follow(&w, &[&w.a]));
    assert_eq!(outcome.result, TerminalResult::Switched);
    assert_eq!(outcome.unconfirmed, None);
    let item = w.item_json();
    assert_eq!(item["claudeAiOauth"]["accessToken"], access(5));
    assert_eq!(item["mcpOAuth"]["server"]["token"], "mcp");
    assert_eq!(w.account_field("accountUuid"), w.a.account_uuid.as_str());
}

#[test]
fn a_scratch_folder_s_sign_in_is_read_from_its_own_files_never_from_the_terminal_s() {
    let dir = tempfile::Builder::new()
        .prefix("relay-terminal-link-")
        .tempdir()
        .unwrap();
    let dir = dir.path();
    let id = random_id();
    // Off macOS there is no Keychain item: the CLI's private file is the sign-in.
    let ports = scratch_sign_in_ports(dir, Platform::Linux);
    assert_eq!(ports.keychain.read(), Ok(None));
    std::fs::write(
        dir.join(".credentials.json"),
        serde_json::to_string(&json!({ "claudeAiOauth": oauth(7) })).unwrap(),
    )
    .unwrap();
    std::fs::write(
        dir.join(".claude.json"),
        serde_json::to_string(&json!({ "oauthAccount": person(&id, "a@x") })).unwrap(),
    )
    .unwrap();
    let item: Value = serde_json::from_str(&ports.keychain.read().unwrap().unwrap()).unwrap();
    assert_eq!(item["claudeAiOauth"]["accessToken"], access(7));
    assert_eq!(
        ports.config.read().unwrap().unwrap()["oauthAccount"]["accountUuid"],
        id.account_uuid.as_str()
    );
    assert!(ports.keychain.write("{}").is_err());
    ports.keychain.remove().unwrap();
    assert_eq!(ports.keychain.read(), Ok(None));
}
