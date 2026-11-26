//! Port of `tests/config-sync.test.ts`. Skipped: "Settings → Switching shows the four choices…"
//! (React UI).

#[path = "common/desktop.rs"]
mod desktop_fixture;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use relay_core::config_sync::{
    CONFIG_SYNC_BACKUP_LIMIT, ConfigSyncOptions, ConfigSyncResult, account_local_env,
    prune_config_sync_backups, sync_profile_config,
};
use relay_core::fs_util::{iso_timestamp, set_times};
use relay_core::shared::types::{ConfigSyncSettings, default_settings};
use relay_core::store::settings_patch_schema;
use serde_json::{Value, json};

const ALL: ConfigSyncSettings = ConfigSyncSettings {
    mcp_servers: true,
    skills: true,
    settings: true,
    claude_md: true,
};
const NONE: ConfigSyncSettings = ConfigSyncSettings {
    mcp_servers: false,
    skills: false,
    settings: false,
    claude_md: false,
};
/// 2026-11-23T10:00:00Z.
const NOW: i64 = 1_795_428_000_000;

/// `minutes` after NOW, for utimes.
fn at(minutes: u64) -> std::time::SystemTime {
    UNIX_EPOCH + Duration::from_millis(NOW as u64) + Duration::from_secs(minutes * 60)
}

/// Two account profiles and the backups folder, in a temporary folder.
struct Dirs {
    _root: tempfile::TempDir,
    from: PathBuf,
    to: PathBuf,
    backups: PathBuf,
}

fn temp() -> Dirs {
    let root = tempfile::Builder::new()
        .prefix("relay-config-sync-")
        .tempdir()
        .unwrap();
    let from = root.path().join("profiles").join("a");
    let to = root.path().join("profiles").join("b");
    fs::create_dir_all(&from).unwrap();
    fs::create_dir_all(&to).unwrap();
    let backups = root.path().join("config-sync-backups");
    Dirs {
        _root: root,
        from,
        to,
        backups,
    }
}

fn write(file: &Path, value: impl Into<Value>, minutes: Option<u64>) {
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    let value = value.into();
    let text = match &value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    fs::write(file, text).unwrap();
    if let Some(minutes) = minutes {
        set_times(file, at(minutes)).unwrap();
    }
}

fn read_json(file: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap()
}

fn sync(dirs: &Dirs, choice: ConfigSyncSettings) -> ConfigSyncResult {
    let now = || NOW;
    sync_profile_config(&ConfigSyncOptions {
        from: &dirs.from,
        to: &dirs.to,
        backups: &dirs.backups,
        choice,
        now: Some(&now),
    })
}

fn vertex() -> Value {
    json!({ "type": "stdio", "command": "vertex-mcp", "args": ["--port", "1"] })
}

fn only(change: impl FnOnce(&mut ConfigSyncSettings)) -> ConfigSyncSettings {
    let mut choice = NONE;
    change(&mut choice);
    choice
}

#[test]
fn an_mcp_server_added_on_account_a_appears_on_b_bs_own_servers_and_sign_in_stay() {
    let dirs = temp();
    write(
        &dirs.from.join(".claude.json"),
        json!({
            "oauthAccount": { "accountUuid": "from-account", "emailAddress": "a@example.com" },
            "userID": "from-user",
            "mcpServers": { "vertex": vertex() },
        }),
        None,
    );
    write(
        &dirs.from.join(".credentials.json"),
        json!({ "claudeAiOauth": { "accessToken": "secret-a" } }),
        None,
    );
    write(
        &dirs.to.join(".claude.json"),
        json!({
            "oauthAccount": { "accountUuid": "to-account", "emailAddress": "b@example.com" },
            "mcpServers": { "alto": { "type": "http", "url": "https://example.com/mcp" } },
        }),
        None,
    );
    let mcp = only(|c| c.mcp_servers = true);
    let result = sync(&dirs, mcp);
    assert_eq!(result.mcp_servers, 1);
    assert_eq!(result.backup, None);
    let config = read_json(&dirs.to.join(".claude.json"));
    let mut names: Vec<_> = config["mcpServers"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    names.sort();
    assert_eq!(names, ["alto", "vertex"]);
    assert_eq!(config["mcpServers"]["vertex"], vertex());
    assert_eq!(config["oauthAccount"]["accountUuid"], "to-account");
    assert_eq!(config.get("userID"), None);
    assert!(!dirs.to.join(".credentials.json").exists());
    // Windows has no owner-only file mode to check.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(dirs.to.join(".claude.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    // A second switch finds nothing to carry.
    assert_eq!(sync(&dirs, mcp).mcp_servers, 0);
}

#[test]
fn a_profile_without_a_config_gets_one_with_only_the_mcp_servers() {
    let dirs = temp();
    write(
        &dirs.from.join(".claude.json"),
        json!({ "oauthAccount": { "accountUuid": "x" }, "mcpServers": { "vertex": vertex() } }),
        None,
    );
    sync(&dirs, only(|c| c.mcp_servers = true));
    assert_eq!(
        read_json(&dirs.to.join(".claude.json")),
        json!({ "mcpServers": { "vertex": vertex() } })
    );
}

#[test]
fn a_server_both_accounts_have_the_newer_copy_wins_and_the_loser_is_backed_up() {
    let dirs = temp();
    let mut mine = vertex();
    mine["args"] = json!(["--port", "2"]);
    let mcp = only(|c| c.mcp_servers = true);
    write(
        &dirs.from.join(".claude.json"),
        json!({ "mcpServers": { "vertex": vertex() } }),
        Some(10),
    );
    write(
        &dirs.to.join(".claude.json"),
        json!({ "mcpServers": { "vertex": mine } }),
        Some(5),
    );
    let result = sync(&dirs, mcp);
    assert_eq!(result.mcp_servers, 1);
    assert_eq!(
        read_json(&dirs.to.join(".claude.json"))["mcpServers"]["vertex"],
        vertex()
    );
    let backup = result.backup.unwrap();
    assert!(backup.starts_with(&dirs.backups));
    assert_eq!(
        read_json(&backup.join("mcpServers.json")),
        json!({ "vertex": mine })
    );

    // The account switched to changed it later: its copy stays, and nothing is backed up.
    let later = temp();
    write(
        &later.from.join(".claude.json"),
        json!({ "mcpServers": { "vertex": vertex() } }),
        Some(5),
    );
    write(
        &later.to.join(".claude.json"),
        json!({ "mcpServers": { "vertex": mine } }),
        Some(10),
    );
    let kept = sync(&later, mcp);
    assert_eq!(kept.mcp_servers, 0);
    assert_eq!(kept.backup, None);
    assert_eq!(
        read_json(&later.to.join(".claude.json"))["mcpServers"]["vertex"],
        mine
    );
}

#[test]
fn settings_only_the_allow_listed_keys_travel_and_no_key_token_or_endpoint_does() {
    let dirs = temp();
    write(
        &dirs.from.join("settings.json"),
        json!({
            "permissions": { "allow": ["Bash(npm test)"] },
            "model": "opus",
            "hooks": { "Stop": [] },
            "statusLine": { "type": "command", "command": "relay statusline" },
            "env": {
                "DISABLE_TELEMETRY": "1",
                "ANTHROPIC_AUTH_TOKEN": "from-token",
                "ANTHROPIC_API_KEY": "from-key",
                "ANTHROPIC_BASE_URL": "http://127.0.0.1:8317",
                "GITHUB_TOKEN": "from-github",
            },
            "apiKeyHelper": "/usr/local/bin/key-helper",
            "forceLoginMethod": "console",
        }),
        Some(10),
    );
    write(
        &dirs.to.join("settings.json"),
        json!({ "env": { "ANTHROPIC_AUTH_TOKEN": "to-token" }, "theme": "dark" }),
        Some(5),
    );
    let result = sync(&dirs, only(|c| c.settings = true));
    assert_eq!(result.settings, 5);
    assert_eq!(
        read_json(&dirs.to.join("settings.json")),
        json!({
            "env": { "ANTHROPIC_AUTH_TOKEN": "to-token", "DISABLE_TELEMETRY": "1" },
            "theme": "dark",
            "permissions": { "allow": ["Bash(npm test)"] },
            "model": "opus",
            "hooks": { "Stop": [] },
            "statusLine": { "type": "command", "command": "relay statusline" },
        })
    );
    for name in [
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "GITHUB_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "AWS_SECRET_ACCESS_KEY",
    ] {
        assert!(account_local_env(name), "{name}");
    }
    for name in ["DISABLE_TELEMETRY", "MAX_THINKING_TOKENS", "MONKEY_PATCH"] {
        assert!(!account_local_env(name), "{name}");
    }
    // Nothing of B's was replaced, so nothing was backed up.
    assert_eq!(result.backup, None);
}

#[test]
fn settings_an_older_key_on_the_switched_to_side_is_replaced_and_backed_up_without_its_secrets() {
    let dirs = temp();
    write(
        &dirs.from.join("settings.json"),
        json!({ "model": "opus", "env": { "MAX_THINKING_TOKENS": "8000" } }),
        Some(10),
    );
    write(
        &dirs.to.join("settings.json"),
        json!({ "model": "sonnet", "env": { "MAX_THINKING_TOKENS": "1", "ANTHROPIC_API_KEY": "to-key" } }),
        Some(5),
    );
    let result = sync(&dirs, only(|c| c.settings = true));
    // B's API key stays whoever wins; its replaced variables are backed up without it.
    assert_eq!(result.settings, 2);
    assert_eq!(
        read_json(&dirs.to.join("settings.json")),
        json!({ "model": "opus", "env": { "ANTHROPIC_API_KEY": "to-key", "MAX_THINKING_TOKENS": "8000" } })
    );
    assert_eq!(
        read_json(&result.backup.unwrap().join("settings.json")),
        json!({ "model": "sonnet", "env": { "MAX_THINKING_TOKENS": "1" } })
    );
}

#[test]
fn skills_and_agents_travel_by_name_a_newer_one_replaces_the_older_after_a_backup() {
    let dirs = temp();
    write(
        &dirs.from.join("skills/review/SKILL.md"),
        "review v2",
        Some(10),
    );
    write(
        &dirs.from.join("skills/deploy/SKILL.md"),
        "deploy",
        Some(10),
    );
    write(&dirs.from.join("agents/tester.md"), "tester", Some(10));
    write(
        &dirs.to.join("skills/review/SKILL.md"),
        "review v1",
        Some(5),
    );
    set_times(&dirs.to.join("skills/review"), at(5)).unwrap();
    write(&dirs.to.join("skills/mine/SKILL.md"), "mine", Some(5));
    let skills = only(|c| c.skills = true);
    let result = sync(&dirs, skills);
    assert_eq!(result.entries, 3);
    let read = |p: &Path| fs::read_to_string(p).unwrap();
    assert_eq!(read(&dirs.to.join("skills/review/SKILL.md")), "review v2");
    assert_eq!(read(&dirs.to.join("skills/deploy/SKILL.md")), "deploy");
    assert_eq!(read(&dirs.to.join("skills/mine/SKILL.md")), "mine");
    assert_eq!(read(&dirs.to.join("agents/tester.md")), "tester");
    assert_eq!(
        read(&result.backup.unwrap().join("skills/review/SKILL.md")),
        "review v1"
    );
    let mut names: Vec<String> = fs::read_dir(dirs.to.join("skills"))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, ["deploy", "mine", "review"]);
    // Copied as is, a second switch carries nothing.
    assert_eq!(sync(&dirs, skills).entries, 0);
}

#[test]
fn claude_md_newer_wins_with_a_backup_older_stays() {
    let dirs = temp();
    write(&dirs.from.join("CLAUDE.md"), "use tabs", Some(10));
    write(&dirs.to.join("CLAUDE.md"), "use spaces", Some(5));
    let md = only(|c| c.claude_md = true);
    let result = sync(&dirs, md);
    assert!(result.claude_md);
    assert_eq!(
        fs::read_to_string(dirs.to.join("CLAUDE.md")).unwrap(),
        "use tabs"
    );
    assert_eq!(
        fs::read_to_string(result.backup.unwrap().join("CLAUDE.md")).unwrap(),
        "use spaces"
    );
    write(&dirs.from.join("CLAUDE.md"), "older", Some(1));
    assert!(!sync(&dirs, md).claude_md);
    assert_eq!(
        fs::read_to_string(dirs.to.join("CLAUDE.md")).unwrap(),
        "use tabs"
    );
}

#[test]
fn nothing_is_chosen_nothing_changes() {
    let dirs = temp();
    write(
        &dirs.from.join(".claude.json"),
        json!({ "mcpServers": { "vertex": vertex() } }),
        None,
    );
    write(&dirs.from.join("CLAUDE.md"), "rules", None);
    let result = sync(&dirs, NONE);
    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        json!({ "mcpServers": 0, "entries": 0, "settings": 0, "claudeMd": false, "failed": [] })
    );
    assert_eq!(fs::read_dir(&dirs.to).unwrap().count(), 0);
}

#[test]
fn an_unreadable_config_is_left_alone_and_named_while_the_other_items_still_sync() {
    let dirs = temp();
    write(
        &dirs.from.join(".claude.json"),
        json!({ "mcpServers": { "vertex": vertex() } }),
        None,
    );
    write(&dirs.to.join(".claude.json"), "{broken", None);
    write(&dirs.from.join("CLAUDE.md"), "rules", None);
    let result = sync(&dirs, ALL);
    assert_eq!(result.failed, ["mcpServers"]);
    assert_eq!(
        fs::read_to_string(dirs.to.join(".claude.json")).unwrap(),
        "{broken"
    );
    assert!(result.claude_md);
}

#[test]
fn backups_are_pruned_to_the_newest_10() {
    assert_eq!(CONFIG_SYNC_BACKUP_LIMIT, 10);
    let dirs = temp();
    for i in 0..12 {
        let name = iso_timestamp(NOW - (20 - i) * 60_000).replace([':', '.'], "-");
        fs::create_dir_all(dirs.backups.join(name)).unwrap();
    }
    // An unrelated folder is never touched.
    fs::create_dir(dirs.backups.join("keep-me")).unwrap();
    write(&dirs.from.join("CLAUDE.md"), "new", Some(10));
    write(&dirs.to.join("CLAUDE.md"), "old", Some(5));
    let result = sync(&dirs, only(|c| c.claude_md = true));
    let mut left: Vec<String> = fs::read_dir(&dirs.backups)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|n| n != "keep-me")
        .collect();
    left.sort();
    assert_eq!(left.len(), 10);
    assert_eq!(
        left.last().unwrap(),
        result
            .backup
            .unwrap()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
    );
    assert!(dirs.backups.join("keep-me").exists());
    assert_eq!(
        prune_config_sync_backups(&dirs.backups, CONFIG_SYNC_BACKUP_LIMIT),
        0
    );
}

#[test]
fn the_setting_is_off_by_default_and_a_patch_takes_all_four_choices() {
    assert_eq!(default_settings().config_sync, Some(NONE));
    let all = serde_json::to_value(ALL).unwrap();
    let patch = settings_patch_schema();
    assert_eq!(
        patch.parse(&json!({ "configSync": all })).unwrap(),
        json!({ "configSync": all })
    );
    assert!(
        patch
            .parse(&json!({ "configSync": { "mcpServers": true } }))
            .is_err()
    );
    let mut extra = all.clone();
    extra["oauth"] = json!(true);
    assert!(patch.parse(&json!({ "configSync": extra })).is_err());
}

#[test]
fn a_desktop_switch_carries_account_as_mcp_server_into_account_bs_profile() {
    let f = desktop_fixture::Fixture::new();
    let events: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = Arc::clone(&events);
    f.manager.configure(|h| {
        h.on_draft_event = Some(Arc::new(move |event: &str, _| {
            sink.lock().unwrap().push(event.to_string())
        }))
    });
    let a = f.account("Vertex", None);
    let b = f.account("Alto", None); // Alto is open in Claude
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    write(
        &f.store.profile(&a.id).unwrap().join(".claude.json"),
        json!({ "mcpServers": { "vertex": vertex() } }),
        None,
    );

    // Off by default: the switch to B leaves B's profile alone.
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert!(
        !f.store
            .profile(&b.id)
            .unwrap()
            .join(".claude.json")
            .exists()
    );

    f.manager.switch_to(&a.id, Default::default()).unwrap();
    f.store
        .update(|s| s.settings.config_sync = Some(only(|c| c.mcp_servers = true)))
        .unwrap();
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(
        read_json(&f.store.profile(&b.id).unwrap().join(".claude.json"))["mcpServers"],
        json!({ "vertex": vertex() })
    );
    assert!(events.lock().unwrap().iter().any(|e| e == "config-sync"));
}
