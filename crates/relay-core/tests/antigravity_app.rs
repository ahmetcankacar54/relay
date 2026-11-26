//! Port of tests/antigravity-app.test.ts.

use std::collections::BTreeMap;
use std::fs;

use relay_core::antigravity_app::{
    AntigravityLastLogin, antigravity_data_dir, antigravity_last_login, match_antigravity_app,
};
use relay_core::relay_paths::Platform;
use relay_core::shared::types::{Account, AccountAuth, AccountProvider, AntigravityAppState};

fn account(id: &str, provider: AccountProvider, email: &str) -> Account {
    let mut account = Account::new(id, id);
    account.provider = Some(provider);
    account.auth = Some(AccountAuth {
        logged_in: true,
        email: Some(email.to_owned()),
        checked_at: "2026-11-19T00:00:00Z".to_owned(),
        ..AccountAuth::default()
    });
    account
}

fn accounts() -> Vec<Account> {
    vec![
        account("c", AccountProvider::Claude, "same@example.test"),
        account("g1", AccountProvider::Antigravity, "One@Example.test"),
        account("g2", AccountProvider::Antigravity, "two@example.test"),
    ]
}

fn read(installed: bool, email: Option<&str>) -> AntigravityLastLogin {
    AntigravityLastLogin {
        installed,
        email: email.map(str::to_owned),
    }
}

#[test]
fn the_antigravity_apps_last_sign_in_is_read_from_its_settings_file_and_only_a_valid_email_counts()
{
    let dir = tempfile::Builder::new()
        .prefix("agy-app-")
        .tempdir()
        .unwrap();
    let dir = dir.path();
    assert_eq!(
        antigravity_last_login(&dir.join("missing")),
        read(false, None)
    );
    assert_eq!(antigravity_last_login(dir), read(true, None));
    let file = dir.join("app_storage.json");
    fs::write(
        &file,
        r#"{"agy.onboarding.lastLoginUsername":"one@example.test","other":"x"}"#,
    )
    .unwrap();
    assert_eq!(
        antigravity_last_login(dir),
        read(true, Some("one@example.test"))
    );
    fs::write(
        &file,
        r#"{"agy.onboarding.lastLoginUsername":"not an e-mail"}"#,
    )
    .unwrap();
    assert_eq!(antigravity_last_login(dir), read(true, None));
    fs::write(&file, "{broken").unwrap();
    assert_eq!(antigravity_last_login(dir), read(true, None));
}

#[test]
fn the_apps_sign_in_names_a_relay_antigravity_account_by_id_never_by_email_and_ignores_other_providers()
 {
    let accounts = accounts();
    assert_eq!(
        match_antigravity_app(&read(true, Some("one@example.test")), &accounts, true),
        AntigravityAppState {
            installed: true,
            can_open: true,
            account_id: Some("g1".into()),
            ..AntigravityAppState::default()
        }
    );
    // A Claude account with the same e-mail is not the app's account.
    assert_eq!(
        match_antigravity_app(&read(true, Some("same@example.test")), &accounts, false),
        AntigravityAppState {
            installed: true,
            can_open: false,
            other_sign_in: Some(true),
            ..AntigravityAppState::default()
        }
    );
    assert_eq!(
        match_antigravity_app(&read(true, None), &accounts, true),
        AntigravityAppState {
            installed: true,
            can_open: true,
            ..AntigravityAppState::default()
        }
    );
    assert_eq!(
        match_antigravity_app(&read(false, Some("one@example.test")), &accounts, true),
        AntigravityAppState::default()
    );
    let state = match_antigravity_app(&read(true, Some("two@example.test")), &accounts, true);
    assert!(!serde_json::to_string(&state).unwrap().contains('@'));
    assert_eq!(
        serde_json::to_value(AntigravityAppState::default()).unwrap(),
        serde_json::json!({ "installed": false, "canOpen": false })
    );
}

#[test]
fn the_apps_data_folder_follows_each_platforms_convention() {
    let env = |pairs: &[(&str, &str)]| -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    };
    assert_eq!(
        antigravity_data_dir(Platform::MacOs, "/Users/u", &env(&[])),
        "/Users/u/Library/Application Support/Antigravity"
    );
    assert_eq!(
        antigravity_data_dir(Platform::Linux, "/home/u", &env(&[])),
        "/home/u/.config/Antigravity"
    );
    assert_eq!(
        antigravity_data_dir(
            Platform::Linux,
            "/home/u",
            &env(&[("XDG_CONFIG_HOME", "/x")])
        ),
        "/x/Antigravity"
    );
    assert_eq!(
        antigravity_data_dir(
            Platform::Windows,
            "C:\\Users\\u",
            &env(&[("APPDATA", "C:\\Users\\u\\AppData\\Roaming")])
        ),
        "C:\\Users\\u\\AppData\\Roaming\\Antigravity"
    );
    assert_eq!(
        antigravity_data_dir(Platform::Windows, "C:\\Users\\u", &env(&[])),
        "C:\\Users\\u\\AppData\\Roaming\\Antigravity"
    );
}
