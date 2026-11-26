//! Port of the app-side cases of `tests/statusline.test.ts`: the snapshot Relay.app writes
//! (`statusline-file`) and the Claude Code settings installer (`claude-statusline`). The line
//! itself is in `shared_statusline.rs`; the CLI and `relay-cli-path` cases belong to their ports.

use std::fs;
use std::path::Path;

use indexmap::IndexMap;
use relay_core::claude_statusline::{
    ClaudeStatuslineError, InstallOutcome, StatuslineSetup, UninstallOutcome, install_statusline,
    is_relay_statusline, statusline_command, statusline_setup, uninstall_statusline,
};
use relay_core::relay_paths::Platform;
use relay_core::shared::proxy_types::ProxySessionState;
use relay_core::shared::statusline::{
    STATUSLINE_FILE, StatuslineRender, StatuslineSnapshot, StatuslineStyle, parse_statusline_input,
    parse_statusline_snapshot, render_statusline,
};
use relay_core::shared::terminal_identity::{TerminalIdentity, TerminalMode};
use relay_core::shared::types::js::{date_parse, iso};
use relay_core::shared::types::{
    Account, AccountAuth, AccountProvider, AccountUsage, UsageStatus, UsageWindow,
};
use relay_core::statusline_file::{
    StatuslineSnapshotInput, build_statusline_snapshot, write_statusline_file,
};
use relay_i18n::Locale;
use serde_json::{Value, json};

fn now() -> f64 {
    date_parse("2026-11-23T12:00:00Z")
}

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn temp() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("relay-statusline-")
        .tempdir()
        .unwrap()
}

fn render(
    snapshot: &StatuslineSnapshot,
    input: Value,
    sign_in: Option<TerminalIdentity>,
    at: f64,
) -> String {
    let input = parse_statusline_input(Some(&input.to_string()));
    render_statusline(StatuslineRender {
        snapshot,
        input: &input,
        config_dir: None,
        sign_in: Box::new(move || sign_in),
        now: at,
        paint: &|_style: StatuslineStyle, text: &str| text.to_owned(),
    })
}

#[test]
fn relay_app_s_snapshot_claude_accounts_with_current_limits_gateway_sessions_and_translated_labels()
{
    let (vertex, alto, codex) = (uuid(), uuid(), uuid());
    let person = TerminalIdentity {
        account_uuid: uuid(),
        org_id: uuid(),
    };
    let account = |id: &str, name: &str| {
        let mut account = Account::new(id, name);
        account.group = "personal".into();
        account.created_at = iso(now());
        account
    };
    let usage = |id: &str, five: f64, reset: &str| {
        let mut usage = AccountUsage::new(id, UsageStatus::Ready);
        usage.checked_at = Some(iso(now() - 60_000.0));
        usage.five_hour = Some(UsageWindow::new(five, Some(reset)));
        usage.seven_day = Some(UsageWindow::new(
            30.9,
            Some(&iso(now() + 3.0 * 86_400_000.0)),
        ));
        usage
    };
    let mut vertex_account = account(&vertex, "Vertex");
    vertex_account.auth = Some(AccountAuth {
        logged_in: true,
        account_uuid: Some(person.account_uuid.to_uppercase()),
        org_id: Some(person.org_id.clone()),
        ..AccountAuth::default()
    });
    let mut codex_account = account(&codex, "Codex");
    codex_account.provider = Some(AccountProvider::Codex);
    let accounts = vec![vertex_account, account(&alto, "Alto"), codex_account];
    let mut usages = IndexMap::new();
    usages.insert(vertex.clone(), usage(&vertex, 41.6, "2026-11-23T13:30:00Z"));
    // An old read is left out.
    let mut old = usage(&alto, 10.0, "2026-11-23T13:00:00Z");
    old.checked_at = Some(iso(now() - 3.0 * 3_600_000.0));
    usages.insert(alto.clone(), old);
    let session = |key: &str, account: &str, at: f64, count: f64| ProxySessionState {
        session_key: key.into(),
        account_id: account.into(),
        assigned_at: at,
        last_active_at: at,
        request_count: count,
        moved_at: None,
    };
    let sessions = vec![
        session("hdr:s-old", &vertex, now() - 9000.0, 1.0),
        session("hdr:s-new", &alto, now() - 1000.0, 3.0),
        session("user:abc", &alto, now(), 1.0),
        session("hdr:s-codex", &codex, now(), 1.0),
    ];
    let input = |language: Locale, gateway: bool| StatuslineSnapshotInput {
        accounts: &accounts,
        usage: &usages,
        desktop_account_id: Some(&alto),
        terminal_mode: TerminalMode::Follow,
        gateway_sessions: gateway.then_some(sessions.as_slice()),
        profiles: "/data/Relay/profiles",
        language,
        zone: "UTC",
        now: now(),
    };
    let en = build_statusline_snapshot(&input(Locale::En, true));
    let names: Vec<&str> = en.accounts.iter().map(|a| a.name.as_str()).collect();
    assert_eq!(names, ["Vertex", "Alto"]);
    assert_eq!(en.accounts[0].identities, std::slice::from_ref(&person));
    assert_eq!(
        serde_json::to_value(&en.accounts[0].five_hour).unwrap(),
        json!({ "used": 41, "resetsAt": date_parse("2026-11-23T13:30:00Z") as i64, "resets": "renews 13:30" })
    );
    assert_eq!(en.accounts[0].week.as_ref().unwrap().used, 30.0);
    let week = en.accounts[0]
        .week
        .as_ref()
        .unwrap()
        .resets
        .clone()
        .unwrap_or_default();
    assert!(
        regex::Regex::new(r"^renews \S+ 12:00$")
            .unwrap()
            .is_match(&week),
        "{week}"
    );
    assert_eq!(en.accounts[1].five_hour, None);
    assert_eq!(
        serde_json::to_value(&en.gateway).unwrap(),
        json!({ "sessions": { "s-new": alto, "s-old": vertex } })
    );
    assert_eq!(en.desktop_account_id.as_deref(), Some(alto.as_str()));
    assert_eq!(en.format_locale, "en-GB");
    assert_eq!(
        render(&en, json!({ "session_id": "s-old" }), None, now()),
        "Vertex · via gateway · 5 h 41% · week 30% · renews 13:30"
    );
    assert_eq!(
        build_statusline_snapshot(&input(Locale::En, false)).gateway,
        None
    );
    let tr = build_statusline_snapshot(&input(Locale::Tr, true));
    assert_eq!(
        tr.accounts[0].five_hour.as_ref().unwrap().resets.as_deref(),
        Some("13:30’da yenilenir")
    );
    assert_eq!(
        render(&tr, json!({}), Some(person.clone()), now()),
        "Vertex · 5 sa %41 · hafta %30 · 13:30’da yenilenir"
    );
    let aged = render(
        &tr,
        json!({}),
        Some(person.clone()),
        now() + 20.0 * 60_000.0,
    );
    assert!(
        regex::Regex::new(r"20 dk\.? önce güncellendi$")
            .unwrap()
            .is_match(&aged),
        "{aged}"
    );

    // What the app writes is what `relay statusline` reads, as compact private JSON.
    let dir = temp();
    write_statusline_file(dir.path(), &en).unwrap();
    let text = fs::read_to_string(dir.path().join(STATUSLINE_FILE)).unwrap();
    assert!(!text.contains('\n'));
    assert_eq!(parse_statusline_snapshot(Some(&text)), Some(en.clone()));
    let keys: Vec<String> = serde_json::from_str::<serde_json::Map<String, Value>>(&text)
        .unwrap()
        .keys()
        .cloned()
        .collect();
    assert_eq!(
        keys,
        [
            "version",
            "generatedAt",
            "formatLocale",
            "profiles",
            "desktopAccountId",
            "terminalFollows",
            "accounts",
            "gateway",
            "text"
        ]
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(dir.path().join(STATUSLINE_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

fn read_json(file: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap()
}

#[test]
fn install_keeps_every_other_key_saves_another_status_line_and_uninstall_puts_it_back() {
    let dir = temp();
    let claude = dir.path().join(".claude");
    let previous = dir
        .path()
        .join("relay")
        .join("claude-statusline-previous.json");
    let file = claude.join("settings.json");
    fs::create_dir(&claude).unwrap();
    let theirs = json!({ "type": "command", "command": "~/.claude/statusline.sh", "padding": 2 });
    fs::write(
        &file,
        json!({ "env": { "FOO": "1" }, "model": "opus", "statusLine": theirs }).to_string(),
    )
    .unwrap();
    assert_eq!(
        statusline_setup(&claude).unwrap(),
        StatuslineSetup {
            installed: false,
            other: true
        }
    );
    let command = statusline_command(&["/opt/homebrew/bin/relay"], Platform::MacOs);
    assert_eq!(command, "/opt/homebrew/bin/relay statusline");
    assert_eq!(
        install_statusline(&claude, &previous, &command).unwrap(),
        InstallOutcome::Replaced
    );
    assert_eq!(
        read_json(&file),
        json!({ "env": { "FOO": "1" }, "model": "opus", "statusLine": { "type": "command", "command": command } })
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert_eq!(
        statusline_setup(&claude).unwrap(),
        StatuslineSetup {
            installed: true,
            other: false
        }
    );
    assert_eq!(
        install_statusline(&claude, &previous, &command).unwrap(),
        InstallOutcome::Already
    );
    // Relay's own at another path is moved there, and the saved one is kept.
    assert_eq!(
        install_statusline(&claude, &previous, "/usr/local/bin/relay statusline").unwrap(),
        InstallOutcome::Installed
    );
    assert!(previous.exists());
    assert_eq!(
        uninstall_statusline(&claude, &previous).unwrap(),
        UninstallOutcome::Restored
    );
    assert_eq!(
        read_json(&file),
        json!({ "env": { "FOO": "1" }, "model": "opus", "statusLine": theirs })
    );
    assert!(!previous.exists());
    assert_eq!(
        uninstall_statusline(&claude, &previous).unwrap(),
        UninstallOutcome::NotInstalled
    );
}

#[test]
fn without_an_earlier_status_line_uninstall_removes_the_key_a_stale_saved_one_never_comes_back() {
    let dir = temp();
    let claude = dir.path().join(".claude");
    let previous = dir.path().join("relay").join("previous.json");
    // No settings file at all yet.
    assert_eq!(
        install_statusline(&claude, &previous, "relay statusline").unwrap(),
        InstallOutcome::Installed
    );
    assert_eq!(
        uninstall_statusline(&claude, &previous).unwrap(),
        UninstallOutcome::Removed
    );
    assert_eq!(read_json(&claude.join("settings.json")), json!({}));
    fs::create_dir_all(previous.parent().unwrap()).unwrap();
    fs::write(
        &previous,
        json!({ "statusLine": { "type": "command", "command": "old" } }).to_string(),
    )
    .unwrap();
    assert_eq!(
        install_statusline(&claude, &previous, "relay statusline").unwrap(),
        InstallOutcome::Installed
    );
    assert_eq!(
        uninstall_statusline(&claude, &previous).unwrap(),
        UninstallOutcome::Removed
    );
    // `relay statusline --color` set by hand is Relay's too.
    fs::write(
        claude.join("settings.json"),
        json!({ "statusLine": { "type": "command", "command": "relay statusline --color" } })
            .to_string(),
    )
    .unwrap();
    assert!(statusline_setup(&claude).unwrap().installed);
}

#[test]
fn a_settings_json_that_is_not_json_is_left_alone() {
    let dir = temp();
    let claude = dir.path().join(".claude");
    fs::create_dir(&claude).unwrap();
    fs::write(claude.join("settings.json"), "{ not json").unwrap();
    let error =
        install_statusline(&claude, &dir.path().join("p.json"), "relay statusline").unwrap_err();
    assert!(
        matches!(error, ClaudeStatuslineError::SettingsUnreadable(_)),
        "{error}"
    );
    assert_eq!(
        error.to_string(),
        format!(
            "{} is not valid JSON.",
            claude.join("settings.json").display()
        )
    );
    assert_eq!(
        fs::read_to_string(claude.join("settings.json")).unwrap(),
        "{ not json"
    );
}

#[test]
fn the_command_names_every_part_by_absolute_path_quoted_when_it_has_to_be_with_forward_slashes_on_windows()
 {
    assert_eq!(
        statusline_command(
            &["/Users/Ada Lovelace/.nvm/versions/node/v22.12.0/bin/relay"],
            Platform::MacOs
        ),
        "\"/Users/Ada Lovelace/.nvm/versions/node/v22.12.0/bin/relay\" statusline"
    );
    assert_eq!(
        statusline_command(
            &[
                "C:\\Program Files\\nodejs\\node.exe",
                "C:\\Users\\ada\\AppData\\Roaming\\npm\\node_modules\\@ahmetcankacar\\relay\\dist\\relay.js",
            ],
            Platform::Windows,
        ),
        "\"C:/Program Files/nodejs/node.exe\" C:/Users/ada/AppData/Roaming/npm/node_modules/@ahmetcankacar/relay/dist/relay.js statusline"
    );
    assert_eq!(
        statusline_command(&["/tmp/a\"b$c/relay"], Platform::Linux),
        "\"/tmp/a\\\"b\\$c/relay\" statusline"
    );
    for command in [
        "relay statusline",
        "/opt/homebrew/bin/relay statusline --color",
        "\"/Users/Ada Lovelace/bin/relay\" statusline",
        "/usr/bin/node /x/node_modules/@ahmetcankacar/relay/dist/relay.js statusline",
    ] {
        assert!(
            is_relay_statusline(Some(&json!({ "type": "command", "command": command }))),
            "{command}"
        );
    }
    for command in [
        "~/.claude/statusline.sh",
        "myrelay statusline",
        "relay status",
        "relay statusline; rm -rf ~",
    ] {
        assert!(
            !is_relay_statusline(Some(&json!({ "type": "command", "command": command }))),
            "{command}"
        );
    }
}
