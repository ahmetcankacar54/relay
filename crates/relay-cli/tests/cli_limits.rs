//! Port of `tests/cli-limits.test.ts`: `relay connect` and `relay usage`. macOS only, as the TS
//! skips elsewhere.
#![cfg(target_os = "macos")]

mod common;
// The lock holder in its own process, shared with relay-core's lock tests (tests/lock-child.ts).
#[path = "../../relay-core/tests/lock_child/mod.rs"]
mod lock_child;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use common::{Fixture, Options, cli_fixture};
use lock_child::hold_profile;
use relay_core::clock::now_ms;
use relay_core::fs_util::iso_timestamp;
use relay_core::shared::types::{Account, AccountAuth};
use relay_core::usage::UsageEndpoint;
use relay_core::usage_credentials::credential_service;
use serde_json::{Value, json};

const TOKEN: &str = "sk-ant-oat01-FAKEACCESSTOKENFORTESTS0000000000000000";
const REFRESH: &str = "sk-ant-ort01-FAKEREFRESHTOKENFORTESTS000000000000000";

/// A fake `claude` that answers `auth status --json` with the given identity and logs every call.
struct FakeClaude {
    file: PathBuf,
    log: PathBuf,
}

impl FakeClaude {
    fn new(dir: &Path, status: &Value, version: Option<&str>) -> FakeClaude {
        let file = dir.join("fake-claude");
        let log = dir.join("claude.log");
        let script = format!(
            "#!/bin/sh\necho \"$*|$CLAUDE_CONFIG_DIR\" >> \"{log}\"\ncase \"$1 $2\" in\n  \"auth status\") echo '{status}';;\n  \"--version \") echo \"{version} (Claude Code)\";;\nesac\nexit 0\n",
            log = log.display(),
            version = version.unwrap_or("2.1.300"),
        );
        std::fs::write(&file, script).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        FakeClaude { file, log }
    }
    fn log(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }
    fn install(&self, f: &mut Fixture) {
        let file = self.file.to_string_lossy().into_owned();
        f.deps.claude = Arc::new(move |_| Some(file.clone()));
    }
}

fn desktop(a: &Account) -> (String, String) {
    let d = a.desktop.as_ref().unwrap();
    (d.account_uuid.clone(), d.org_id.clone())
}

#[test]
fn connect_signs_the_account_s_profile_in_with_the_official_cli_and_stores_who_it_is() {
    let mut f = cli_fixture(Options::default());
    let (a, _) = f.saved("A", None);
    let (uuid, org) = desktop(&a);
    let claude = FakeClaude::new(
        f.temp(),
        &json!({
            "loggedIn": true,
            "authMethod": "claude.ai",
            "email": "a@example.test",
            "accountUuid": uuid,
            "orgId": org,
        }),
        None,
    );
    claude.install(&mut f);
    assert_eq!(f.run(&["connect", "A"]), 0);
    let profile = f.home.join("profiles").join(&a.id);
    let expected = format!("auth login --claudeai|{}", profile.display());
    assert!(
        claude.log().lines().any(|l| l == expected),
        "{}",
        claude.log()
    );
    let auth = f.store().account(&a.id).unwrap().auth.unwrap();
    assert!(auth.logged_in);
    assert_eq!(auth.account_uuid.as_deref(), Some(uuid.as_str()));
    assert!(f.out().contains("a@example.test"));
}

#[test]
fn a_login_to_another_account_is_signed_out_again_and_fails() {
    let mut f = cli_fixture(Options::default());
    let (a, _) = f.saved("A", None);
    let (_, org) = desktop(&a);
    let claude = FakeClaude::new(
        f.temp(),
        &json!({
            "loggedIn": true,
            "authMethod": "claude.ai",
            "email": "other@example.test",
            "accountUuid": uuid::Uuid::new_v4().to_string(),
            "orgId": org,
        }),
        None,
    );
    claude.install(&mut f);
    assert_eq!(f.run(&["connect", "A"]), 1);
    assert!(claude.log().contains("auth logout"));
    assert!(f.err().contains("other@example.test"));
    assert_eq!(f.store().account(&a.id).unwrap().auth, None);
}

#[test]
fn a_login_to_the_account_s_other_workspace_moves_the_profile_there_once_claude_has_that_workspace()
{
    let mut f = cli_fixture(Options::default());
    let (a, _) = f.saved("A", None);
    let (uuid, org) = desktop(&a);
    let other = uuid::Uuid::new_v4().to_string();
    let claude = FakeClaude::new(
        f.temp(),
        &json!({
            "loggedIn": true,
            "authMethod": "claude.ai",
            "email": "a@example.test",
            "accountUuid": uuid,
            "orgId": other,
        }),
        None,
    );
    claude.install(&mut f);
    // The Claude app has never opened that workspace: nothing to move to, the sign-in is undone.
    assert_eq!(f.run(&["connect", "A"]), 1);
    assert!(claude.log().contains("auth logout"));
    let account = f.store().account(&a.id).unwrap();
    assert_eq!(account.auth, None);
    assert_eq!(account.desktop.unwrap().org_id, org);
    // With the workspace there, the profile moves and the sign-in stays.
    std::fs::create_dir_all(
        f.claude
            .join("claude-code-sessions")
            .join(&uuid)
            .join(&other),
    )
    .unwrap();
    assert_eq!(f.run(&["connect", "A"]), 0);
    let after = f.store().account(&a.id).unwrap();
    assert_eq!(after.desktop.unwrap().org_id, other);
    assert_eq!(after.auth.unwrap().org_id.as_deref(), Some(other.as_str()));
}

#[derive(Default)]
struct Connected {
    expires_at: Option<i64>,
    five: Option<i64>,
    /// `Some(None)` is a seat without a weekly limit.
    seven: Option<Option<i64>>,
}

fn connected(opts: Connected) -> (Fixture, Account, FakeClaude) {
    let mut f = cli_fixture(Options::default());
    let (a, _) = f.saved("A", None);
    let (uuid, org) = desktop(&a);
    f.store()
        .update(|s| {
            s.accounts[0].auth = Some(AccountAuth {
                logged_in: true,
                account_uuid: Some(uuid.clone()),
                org_id: Some(org.clone()),
                email: Some("a@example.test".into()),
                checked_at: iso_timestamp(now_ms()),
                ..AccountAuth::default()
            });
        })
        .unwrap();
    let profile = f.home.join("profiles").join(&a.id);
    f.security.set_item(
        &credential_service(&profile),
        &json!({
            "claudeAiOauth": {
                "accessToken": TOKEN,
                "refreshToken": REFRESH,
                "expiresAt": opts.expires_at.unwrap_or(now_ms() + 3_600_000),
                "scopes": ["user:inference", "user:profile"],
            }
        })
        .to_string(),
    );
    let resets = iso_timestamp(now_ms() + (2 * 60 + 10) * 60_000 + 30_000);
    let five = opts.five.unwrap_or(94);
    let seven = opts.seven.unwrap_or(Some(40));
    f.deps.request = Arc::new(move |endpoint, _| {
        Ok(match endpoint {
            UsageEndpoint::Profile => json!({
                "account": { "uuid": uuid, "email_address": "a@example.test" },
                "organization": { "uuid": org },
            }),
            UsageEndpoint::Usage => {
                let mut usage =
                    json!({ "five_hour": { "utilization": five, "resets_at": resets } });
                if let Some(seven) = seven {
                    usage["seven_day"] = json!({ "utilization": seven, "resets_at": resets });
                }
                usage
            }
        })
    });
    let claude = FakeClaude::new(f.temp(), &json!({}), None);
    claude.install(&mut f);
    (f, a, claude)
}

#[test]
fn usage_json_shows_how_much_of_each_window_is_used_as_claude_s_usage_page_does() {
    let (f, a, _) = connected(Connected::default());
    assert_eq!(f.run(&["usage", "--json"]), 0);
    let rows: Value = serde_json::from_str(&f.out()).unwrap();
    let row = &rows[0];
    assert_eq!(row["id"], a.id.as_str());
    assert_eq!(row["status"], "ready");
    assert_eq!(row["fiveHour"]["usedPercent"].as_f64(), Some(94.0));
    assert_eq!(row["sevenDay"]["usedPercent"].as_f64(), Some(40.0));
    f.clear();
    assert_eq!(f.run(&["usage"]), 0);
    assert!(
        f.out().contains("94% used · resets in 2 h 10 min"),
        "{}",
        f.out()
    );
    f.clear();
    f.run(&["usage", "--lang", "tr"]);
    assert!(
        f.out()
            .contains("%94 kullanıldı · 2 sa 10 dk sonra yenilenir"),
        "{}",
        f.out()
    );
    let all = f.out() + &f.err();
    assert!(!all.contains(TOKEN) && !all.contains("FIXTURE-SECRET"));
}

#[test]
fn a_seat_that_reports_no_weekly_limit_says_so() {
    let (f, _, _) = connected(Connected {
        seven: Some(None),
        ..Connected::default()
    });
    f.run(&["usage", "--json"]);
    let rows: Value = serde_json::from_str(&f.out()).unwrap();
    assert_eq!(rows[0]["sevenDay"], "not-reported");
}

#[test]
fn an_expiring_credential_is_not_renewed_while_another_process_holds_the_profile_lock() {
    let (f, a, claude) = connected(Connected {
        expires_at: Some(now_ms() + 60_000),
        ..Connected::default()
    });
    let _child = hold_profile(&f.home.join("profiles").join(".locks"), &a.id, "exclusive");
    f.run(&["usage"]);
    assert!(
        f.out().contains("another process is renewing it"),
        "{}",
        f.out()
    );
    // `claude.log().replace(/--version.*\n?/g, "")`
    let log: String = claude
        .log()
        .split_inclusive('\n')
        .map(|line| line.find("--version").map_or(line, |at| &line[..at]))
        .collect();
    assert!(
        !["auth", "--print", "refresh"]
            .iter()
            .any(|w| log.contains(w)),
        "{log}"
    );
    assert!(!(f.out() + &f.err()).contains(TOKEN));
}

#[test]
fn an_account_without_a_connection_gets_the_connect_hint() {
    let f = cli_fixture(Options::default());
    f.saved("A", None);
    assert_eq!(f.run(&["usage"]), 0);
    assert!(f.out().contains("relay connect"));
    f.clear();
    f.run(&["usage", "--json"]);
    let rows: Value = serde_json::from_str(&f.out()).unwrap();
    assert_eq!(rows[0]["status"], "not-connected");
}

// The two CLI cases of `tests/gateway-phase5.test.ts`.

const HOUR: i64 = 3_600_000;

/// A Codex and an Antigravity account signed in through the app, with a Codex ChatGPT sign-in
/// saved, and Codex's usage endpoint answered in-process (the TS replaced `globalThis.fetch`).
fn provider_accounts() -> (Fixture, Account, Arc<std::sync::Mutex<Vec<String>>>) {
    let mut f = cli_fixture(Options::default());
    let store = f.store();
    let codex = store
        .create(&relay_core::shared::types::CreateAccount {
            name: "Codex".into(),
            kind: relay_core::shared::types::AccountKind::Personal,
            group: None,
            provider: Some(relay_core::shared::types::AccountProvider::Codex),
        })
        .unwrap();
    store
        .create(&relay_core::shared::types::CreateAccount {
            name: "Google".into(),
            kind: relay_core::shared::types::AccountKind::Personal,
            group: None,
            provider: Some(relay_core::shared::types::AccountProvider::Antigravity),
        })
        .unwrap();
    store
        .update(|state| {
            for account in &mut state.accounts {
                account.auth = Some(AccountAuth {
                    logged_in: true,
                    checked_at: iso_timestamp(now_ms()),
                    subscription: Some("plus".into()),
                    ..AccountAuth::default()
                });
            }
        })
        .unwrap();
    let profile = f.home.join("profiles").join(&codex.id);
    std::fs::create_dir_all(&profile).unwrap();
    let file = profile.join("provider-credential.json");
    let credential = json!({ "kind": "chatgpt", "accessToken": "codex-test-token", "expiresAt": now_ms() + HOUR });
    std::fs::write(&file, credential.to_string()).unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    let asked = Arc::new(std::sync::Mutex::new(Vec::new()));
    let log = asked.clone();
    f.deps.fetch = Arc::new(move |url: &str, headers: &[(String, String)]| {
        let auth = headers
            .iter()
            .find(|(name, _)| name == "Authorization")
            .map_or("", |(_, v)| v.as_str());
        log.lock().unwrap().push(format!("{url} {auth}"));
        Ok(relay_core::provider_usage::FetchedResponse {
            status: 200,
            retry_after: None,
            body: json!({
                "plan_type": "pro",
                "rate_limit": {
                    "primary_window": { "used_percent": 12, "limit_window_seconds": 18_000, "reset_after_seconds": 3_600 },
                    "secondary_window": { "used_percent": 40, "limit_window_seconds": 604_800, "reset_after_seconds": 86_400 },
                },
            })
            .to_string(),
        })
    });
    (f, codex, asked)
}

#[test]
fn relay_usage_reads_a_codex_account_s_limits_as_the_app_does_and_sends_antigravity_to_the_app() {
    let (f, codex, asked) = provider_accounts();
    assert_eq!(f.run(&["usage", "--json"]), 0);
    let rows: Value = serde_json::from_str(&f.out()).unwrap();
    let row = |name: &str| {
        rows.as_array()
            .unwrap()
            .iter()
            .find(|r| r["name"] == name)
            .cloned()
            .unwrap()
    };
    assert_eq!(row("Codex")["status"], "ready");
    assert_eq!(row("Codex")["fiveHour"]["usedPercent"], 12);
    assert_eq!(row("Codex")["sevenDay"]["usedPercent"], 40);
    assert_eq!(row("Google")["issue"], "unsupported");
    assert_eq!(
        *asked.lock().unwrap(),
        ["https://chatgpt.com/backend-api/wham/usage Bearer codex-test-token"]
    );
    // The plan the answer names is the app's to save: relay only reads.
    let saved = f.store().account(&codex.id).unwrap();
    assert_eq!(saved.auth.unwrap().subscription.as_deref(), Some("plus"));

    f.clear();
    assert_eq!(f.run(&["usage", "--lang", "en"]), 0);
    let out = f.out();
    let line = |name: &str| {
        out.lines()
            .find(|l| l.starts_with(name))
            .map(|l| l[name.len()..].trim_start().to_owned())
            .unwrap()
    };
    assert!(line("Codex").starts_with("12% used"), "{out}");
    assert!(
        line("Google").starts_with("Antigravity limits are read in the Relay app only"),
        "{out}"
    );
    assert!(
        !out.contains("relay connect"),
        "relay connect signs in Claude accounts only"
    );
    assert!(!format!("{out}{}", f.err()).contains("codex-test-token"));
}

#[test]
fn a_codex_or_antigravity_account_without_a_sign_in_is_sent_to_the_app_not_to_relay_connect() {
    let (f, _, _) = provider_accounts();
    f.store()
        .update(|state| {
            for account in &mut state.accounts {
                account.auth = None;
            }
        })
        .unwrap();
    assert_eq!(f.run(&["usage", "--lang", "en"]), 0);
    let out = f.out();
    let codex = out.lines().find(|l| l.starts_with("Codex")).unwrap();
    assert!(
        codex["Codex".len()..]
            .trim_start()
            .starts_with("not signed in: sign in again in the Relay app"),
        "{out}"
    );
    assert!(!out.contains("relay connect"));
}
