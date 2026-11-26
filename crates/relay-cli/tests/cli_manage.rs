//! Port of `tests/cli-manage.test.ts`. macOS only, as the TS skips elsewhere.
#![cfg(target_os = "macos")]

mod common;
#[path = "../../relay-core/tests/lock_child/mod.rs"]
mod lock_child;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use common::{Options, cli_fixture};
use lock_child::hold_profile;
use relay_core::shared::types::{AccountAuth, DesktopHistoryTransfer};
use serde_json::Value;

/// Every file under `dir` with its bytes, in name order (the TS hashes the same walk).
fn digest(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut out = Vec::new();
    let mut names: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    names.sort();
    for p in names {
        if p.is_dir() {
            out.extend(digest(&p));
        } else {
            out.push((p.clone(), fs::read(&p).unwrap()));
        }
    }
    out
}

/// A Claude Code stand-in that logs its arguments and profile.
fn fake_claude(dir: &Path) -> (PathBuf, PathBuf) {
    let file = dir.join("fake-claude");
    let log = dir.join("claude.log");
    fs::write(
        &file,
        format!(
            "#!/bin/sh\necho \"$*|$CLAUDE_CONFIG_DIR\" >> \"{}\"\nexit 0\n",
            log.display()
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
    (file, log)
}

fn logged_in() -> AccountAuth {
    AccountAuth {
        logged_in: true,
        checked_at: relay_core::fs_util::iso_timestamp(relay_core::clock::now_ms()),
        ..AccountAuth::default()
    }
}

#[test]
fn remove_forgets_an_account_its_sealed_sign_in_and_its_profile_and_leaves_claude_s_data_alone() {
    let f = cli_fixture(Options::default());
    f.saved("A", None);
    let (b, _) = f.saved("B", None);
    f.run(&["switch", "A", "--yes"]);
    let b_id = b.id.clone();
    f.store()
        .update(|s| {
            s.settings.desktop_history_accounts = vec![b_id.clone()];
            s.settings.auto_switch_accounts = vec![b_id.clone()];
            s.settings.planning.accounts =
                serde_json::from_value(serde_json::json!([{ "id": b_id }])).unwrap();
        })
        .unwrap();
    let uuid = &b.desktop.as_ref().unwrap().account_uuid;
    let sealed = f.vault().join("accounts").join(format!("{uuid}.bin"));
    assert!(sealed.exists());
    // The Claude extension's saved sign-in for B goes too; A's stays.
    let extension = f.vault().join("extension");
    fs::create_dir_all(&extension).unwrap();
    fs::write(extension.join(format!("{uuid}.bin")), "sealed").unwrap();
    fs::write(extension.join("other.bin"), "sealed").unwrap();
    let before = digest(&f.claude);
    assert_eq!(f.run(&["remove", "B", "--yes"]), 0);
    assert!(!sealed.exists());
    assert!(!extension.join(format!("{uuid}.bin")).exists());
    assert!(extension.join("other.bin").exists());
    assert!(!f.home.join("profiles").join(&b.id).exists());
    let after = f.store().state();
    assert_eq!(
        after
            .accounts
            .iter()
            .map(|a| a.name.as_str())
            .collect::<Vec<_>>(),
        ["A"]
    );
    assert!(after.settings.desktop_history_accounts.is_empty());
    assert!(after.settings.auto_switch_accounts.is_empty());
    assert_eq!(
        serde_json::to_value(&after.settings.planning.accounts).unwrap(),
        serde_json::json!([])
    );
    assert!(digest(&f.claude) == before);
}

#[test]
fn remove_refuses_the_active_account_and_asks_first_without_a_terminal() {
    let f = cli_fixture(Options::default());
    f.saved("A", None);
    f.saved("B", None);
    assert_eq!(f.run(&["remove", "B", "--yes"]), 3);
    assert_eq!(f.run(&["remove", "A"]), 4);
    assert_eq!(f.store().state().accounts.len(), 2);
}

#[test]
fn a_connected_account_is_signed_out_with_the_official_cli_in_its_own_profile() {
    let mut f = cli_fixture(Options::default());
    let (a, _) = f.saved("A", None);
    f.saved("B", None);
    let (claude, log) = fake_claude(&f.base);
    let file = claude.to_string_lossy().into_owned();
    f.deps.claude = Arc::new(move |_| Some(file.clone()));
    f.store()
        .update(|s| s.accounts[0].auth = Some(logged_in()))
        .unwrap();
    assert_eq!(f.run(&["remove", "A", "--yes"]), 0);
    assert_eq!(
        fs::read_to_string(log).unwrap().trim(),
        format!(
            "auth logout|{}",
            f.home.join("profiles").join(&a.id).display()
        )
    );
}

#[test]
fn a_held_profile_lock_exits_3() {
    let f = cli_fixture(Options::default());
    let (a, _) = f.saved("A", None);
    f.saved("B", None);
    let _child = hold_profile(&f.home.join("profiles").join(".locks"), &a.id, "shared");
    assert_eq!(f.run(&["remove", "A", "--yes"]), 3);
    assert_eq!(f.store().state().accounts.len(), 2);
}

#[test]
fn rename_renames_and_refuses_a_name_another_account_has() {
    let f = cli_fixture(Options::default());
    f.saved("A", None);
    f.saved("B", None);
    assert_eq!(f.run(&["rename", "A", "Ana"]), 0);
    let names: Vec<String> = f
        .store()
        .state()
        .accounts
        .into_iter()
        .map(|a| a.name)
        .collect();
    assert_eq!(names, ["Ana", "B"]);
    assert_eq!(f.run(&["rename", "Ana", "b"]), 2);
    assert_eq!(f.run(&["rename", "Ana"]), 2);
}

#[test]
fn history_mode_persists_selected_needs_two_accounts() {
    let f = cli_fixture(Options::default());
    let (a, _) = f.saved("A", None);
    let (b, _) = f.saved("B", None);
    assert_eq!(f.run(&["history", "mode", "off"]), 0);
    assert_eq!(
        f.store().state().settings.desktop_history_transfer,
        DesktopHistoryTransfer::Off
    );
    assert_eq!(
        f.run(&["history", "mode", "selected", "--accounts", "A"]),
        2
    );
    assert_eq!(
        f.run(&["history", "mode", "selected", "--accounts", "A,B"]),
        0
    );
    let s = f.store().state().settings;
    assert_eq!(s.desktop_history_transfer, DesktopHistoryTransfer::Selected);
    assert_eq!(s.desktop_history_accounts, vec![a.id, b.id]);
    assert_eq!(f.run(&["history", "mode", "sometimes"]), 2);
}

#[test]
fn history_json_reports_the_mode_and_the_active_account_s_summary() {
    let f = cli_fixture(Options::default());
    f.saved("A", None);
    let (b, _) = f.saved("B", None);
    assert_eq!(f.run(&["history", "--json"]), 0);
    let h: Value = serde_json::from_str(&f.out()).unwrap();
    assert_eq!(h["mode"], "same-group");
    assert_eq!(h["account"]["id"], b.id.as_str());
    assert_eq!(h["sources"], serde_json::json!(["A"]));
    assert!(h["summary"]["indexed"].is_number());
}

#[test]
fn history_sync_yes_restarts_claude_once() {
    let f = cli_fixture(Options::default());
    f.saved("A", None);
    f.saved("B", None);
    assert_eq!(f.run(&["history", "sync", "--yes"]), 0);
    assert_eq!(f.quits(), 1);
    assert_eq!(f.starts(), 1);
}
