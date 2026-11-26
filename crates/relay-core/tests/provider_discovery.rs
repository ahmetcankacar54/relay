//! Port of tests/provider-discovery.test.ts.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use relay_core::clock::now_ms;
use relay_core::environment::Env;
use relay_core::provider_discovery::{
    OneClickCascadeDeps, OneClickError, OpenAiKeyCheck, ProviderDiscoveryPaths, detect_providers,
    execute_one_click_cascade, one_click_connect_schema,
};
use relay_core::shared::types::{
    AccountAuth, AccountKind, AccountProvider, CascadeLayerStatus, CreateAccount,
    DetectedProviderSession,
};
use relay_core::store::{Store, StoreOptions};
use serde_json::{Value, json};

fn home() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("relay-discovery-")
        .tempdir()
        .unwrap()
}

fn write(file: &Path, value: &Value) {
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, value.to_string()).unwrap();
}

fn jwt(payload: &Value) -> String {
    let body = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.to_string());
    format!("h.{body}.s")
}

fn by_provider(
    list: Vec<DetectedProviderSession>,
) -> HashMap<AccountProvider, DetectedProviderSession> {
    list.into_iter().map(|s| (s.provider, s)).collect()
}

fn paths(dir: &Path, env: Env) -> ProviderDiscoveryPaths {
    ProviderDiscoveryPaths {
        home_dir: Some(dir.to_path_buf()),
        claude_desktop_root: Some(dir.join("Claude")),
        platform: None,
        env: Some(env),
    }
}

fn detect(
    accounts: &[relay_core::shared::types::Account],
    dir: &Path,
) -> HashMap<AccountProvider, DetectedProviderSession> {
    by_provider(detect_providers(accounts, &paths(dir, Env::new())))
}

fn future() -> i64 {
    now_ms() / 1000 + 3600
}
const CHATGPT_ID: &str = "33333333-3333-4333-8333-333333333333";

fn codex_session(dir: &Path, exp: i64) {
    write(
        &dir.join(".codex").join("auth.json"),
        &json!({
            "tokens": {
                "access_token": jwt(&json!({ "exp": exp, "https://api.openai.com/auth": { "chatgpt_account_id": CHATGPT_ID, "chatgpt_plan_type": "pro" } })),
                "refresh_token": "rt-never-copied",
                // The id token expires long before the access token.
                "id_token": jwt(&json!({ "email": "dev@example.com", "exp": now_ms() / 1000 - 10 })),
                "account_id": CHATGPT_ID,
            },
        }),
    );
}

fn store_in(dir: &Path) -> Store {
    Store::open(dir.join("relay"), StoreOptions::default()).unwrap()
}

fn input(provider: &str, name: &str) -> Value {
    json!({ "provider": provider, "name": name, "kind": "personal" })
}

fn deps<'a>(store: &'a Store, dir: &Path) -> OneClickCascadeDeps<'a> {
    OneClickCascadeDeps {
        home_dir: Some(dir.to_path_buf()),
        env: Some(Env::new()),
        ..OneClickCascadeDeps::new(store, dir.join("Claude"))
    }
}

fn account_count(store: &Store) -> usize {
    store.with_state(|s| s.accounts.len())
}

#[test]
fn nothing_on_disk_detects_nothing_for_all_three_providers() {
    let dir = home();
    let found = detect(&[], dir.path());
    assert!(!found[&AccountProvider::Claude].detected);
    assert!(!found[&AccountProvider::Codex].detected);
    assert!(!found[&AccountProvider::Antigravity].detected);
}

#[test]
fn codex_is_read_from_codex_auth_json_with_the_email_and_plan_its_tokens_state() {
    let dir = home();
    codex_session(dir.path(), future());
    let found = detect(&[], dir.path());
    let codex = &found[&AccountProvider::Codex];
    assert!(codex.detected);
    assert_eq!(codex.email.as_deref(), Some("dev@example.com"));
    assert_eq!(codex.plan.as_deref(), Some("pro"));
    let source: PathBuf = ["~", ".codex", "auth.json"].iter().collect();
    assert_eq!(
        codex.source.as_deref(),
        Some(source.to_string_lossy().as_ref())
    );
    assert!(!found[&AccountProvider::Antigravity].detected);
}

#[test]
fn an_expired_codex_cli_sign_in_is_not_offered_and_no_plan_is_made_up() {
    let dir = home();
    write(
        &dir.path().join(".codex").join("auth.json"),
        &json!({ "tokens": { "access_token": jwt(&json!({ "exp": 1 })) } }),
    );
    let found = detect(&[], dir.path());
    assert!(!found[&AccountProvider::Codex].detected);
    assert_eq!(found[&AccountProvider::Codex].plan, None);
}

#[test]
fn antigravity_uses_its_own_oauth_flow_never_a_gemini_api_key_from_the_environment() {
    let dir = home();
    write(
        &dir.path().join(".antigravity").join("auth.json"),
        &json!({ "access_token": "ag", "email": "ag@example.com" }),
    );
    let file = detect(&[], dir.path());
    assert!(!file[&AccountProvider::Antigravity].detected);
    let empty = home();
    let env: Env = [("GEMINI_API_KEY".to_owned(), "AIza-test-key".to_owned())].into();
    let found = by_provider(detect_providers(&[], &paths(empty.path(), env)));
    assert!(!found[&AccountProvider::Antigravity].detected);
}

#[test]
fn claude_is_detected_from_the_claude_apps_sign_in_not_from_the_claude_code_clis_tokens() {
    let dir = home();
    write(
        &dir.path().join(".claude").join(".credentials.json"),
        &json!({ "claudeAiOauth": { "accessToken": "cl", "subscriptionType": "max" } }),
    );
    let cli_only = detect(&[], dir.path());
    assert!(!cli_only[&AccountProvider::Claude].detected);
    write(
        &dir.path().join("Claude").join("config.json"),
        &json!({ "lastKnownAccountUuid": ACCOUNT_UUID, "oauth:tokenCacheV2": "sealed" }),
    );
    let desktop = detect(&[], dir.path());
    let claude = &desktop[&AccountProvider::Claude];
    assert!(claude.detected);
    assert_eq!(claude.source.as_deref(), Some("Claude Desktop"));
    assert_eq!(claude.plan, None);
}

#[test]
fn a_codex_sign_in_that_is_already_an_account_says_which_one() {
    let dir = home();
    codex_session(dir.path(), future());
    let store = store_in(dir.path());
    let existing = store
        .create(&CreateAccount {
            name: "Work Codex".into(),
            kind: AccountKind::Personal,
            group: None,
            provider: Some(AccountProvider::Codex),
        })
        .unwrap();
    store
        .update(|s| {
            s.accounts[0].auth = Some(AccountAuth {
                logged_in: true,
                checked_at: relay_core::fs_util::iso_timestamp(now_ms()),
                account_uuid: Some(CHATGPT_ID.into()),
                ..Default::default()
            });
        })
        .unwrap();
    let accounts = store.with_state(|s| s.accounts.clone());
    let found = detect(&accounts, dir.path());
    let codex = &found[&AccountProvider::Codex];
    assert_eq!(
        codex.already_linked_account_id.as_deref(),
        Some(existing.id.as_str())
    );
    assert_eq!(
        codex.already_linked_account_name.as_deref(),
        Some("Work Codex")
    );
}

#[test]
fn the_one_click_schema_accepts_claude_and_codex_antigravity_has_a_separate_oauth_flow() {
    let schema = one_click_connect_schema();
    for provider in ["claude", "codex"] {
        let parsed = schema
            .parse(&json!({ "provider": provider, "name": " A ", "kind": "personal" }))
            .unwrap();
        assert_eq!(parsed["name"], "A");
    }
    for bad in [
        json!({ "provider": "antigravity", "name": "A", "kind": "personal" }),
        json!({ "provider": "other", "name": "A", "kind": "personal" }),
        json!({ "provider": "codex", "name": "", "kind": "personal" }),
        json!({ "provider": "codex", "name": "A", "kind": "personal", "extra": 1 }),
        json!({ "provider": "claude", "name": "A", "kind": "personal", "email": "x@y.z" }),
    ] {
        assert!(schema.parse(&bad).is_err());
    }
}

#[test]
fn one_click_imports_the_codex_clis_chatgpt_sign_in_without_its_refresh_token_expiring_with_the_access_token()
 {
    let dir = home();
    let exp = future();
    codex_session(dir.path(), exp);
    let store = store_in(dir.path());
    let no_key = |_: &str| -> OpenAiKeyCheck { panic!("no key to check") };
    let result = execute_one_click_cascade(
        &input("codex", "OpenAI · Codex"),
        &OneClickCascadeDeps {
            check_open_ai_key: Some(&no_key),
            ..deps(&store, dir.path())
        },
    )
    .unwrap();
    assert_eq!(result.account.provider, Some(AccountProvider::Codex));
    let auth = result.account.auth.as_ref().unwrap();
    assert!(auth.logged_in);
    assert_eq!(auth.email.as_deref(), Some("dev@example.com"));
    assert_eq!(auth.account_uuid.as_deref(), Some(CHATGPT_ID));
    assert_eq!(auth.subscription.as_deref(), Some("pro"));
    assert_eq!(
        serde_json::to_value(&result.layers).unwrap(),
        json!({ "desktop": "skipped", "usage": "skipped", "terminal": "skipped", "extensionAndProxy": "done" })
    );
    let file = store
        .profile(&result.account.id)
        .unwrap()
        .join("provider-credential.json");
    let text = fs::read_to_string(&file).unwrap();
    let saved: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(saved["kind"], "chatgpt");
    assert_eq!(saved["expiresAt"].as_f64(), Some((exp * 1000) as f64));
    assert!(!text.contains("rt-never-copied"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    // The same sign-in again is refused instead of making a duplicate.
    let again =
        execute_one_click_cascade(&input("codex", "Again"), &deps(&store, dir.path())).unwrap_err();
    assert!(
        again
            .to_string()
            .contains("already the account OpenAI · Codex")
    );
}

#[test]
fn one_click_checks_an_openai_api_key_with_openai_before_saving_it_and_saves_nothing_when_it_is_refused()
 {
    let dir = home();
    let store = store_in(dir.path());
    let checked = std::cell::RefCell::new(Vec::<String>::new());
    let reject = |k: &str| {
        checked.borrow_mut().push(k.into());
        OpenAiKeyCheck::Rejected
    };
    let with_key = |key: &str| {
        let mut value = input("codex", "Key");
        value["apiKey"] = json!(key);
        value
    };
    let error = execute_one_click_cascade(
        &with_key("sk-bad"),
        &OneClickCascadeDeps {
            check_open_ai_key: Some(&reject),
            ..deps(&store, dir.path())
        },
    )
    .unwrap_err();
    assert!(error.to_string().contains("rejected this API key"));
    let error =
        execute_one_click_cascade(&with_key("not-a-key"), &deps(&store, dir.path())).unwrap_err();
    assert!(error.to_string().contains("starts with sk-"));
    assert_eq!(account_count(&store), 0);
    let accept = |k: &str| {
        checked.borrow_mut().push(k.into());
        OpenAiKeyCheck::Ok
    };
    let ok = execute_one_click_cascade(
        &with_key("sk-good"),
        &OneClickCascadeDeps {
            check_open_ai_key: Some(&accept),
            ..deps(&store, dir.path())
        },
    )
    .unwrap();
    assert_eq!(*checked.borrow(), vec!["sk-bad", "sk-good"]);
    let auth = ok.account.auth.unwrap();
    assert!(auth.logged_in);
    assert_eq!(auth.subscription.as_deref(), Some("API key"));
}

#[test]
fn one_click_never_creates_a_codex_account_without_a_usable_credential() {
    let dir = home();
    let store = store_in(dir.path());
    let error =
        execute_one_click_cascade(&input("codex", "codex"), &deps(&store, dir.path())).unwrap_err();
    assert!(error.to_string().contains("No usable credential"));
    assert_eq!(account_count(&store), 0);
}

#[test]
fn an_antigravity_token_cannot_enter_the_codex_one_click_flow() {
    let dir = home();
    let store = store_in(dir.path());
    let mut value = input("antigravity", "Google");
    value["apiKey"] = json!("oauth-token");
    let error = execute_one_click_cascade(&value, &deps(&store, dir.path())).unwrap_err();
    assert!(matches!(error, OneClickError::Invalid(_)));
    assert!(error.to_string().contains("Invalid option"));
    assert_eq!(account_count(&store), 0);
}

#[test]
fn one_click_on_claude_with_no_current_desktop_session_starts_the_sign_in_and_says_it_is_needed() {
    let dir = home();
    let store = store_in(dir.path());
    let began = std::cell::RefCell::new(Vec::<String>::new());
    let armed = std::cell::RefCell::new(Vec::<String>::new());
    let begin = |id: &str| {
        began.borrow_mut().push(id.into());
        Ok(())
    };
    let arm = |id: &str| armed.borrow_mut().push(id.into());
    let result = execute_one_click_cascade(
        &input("claude", "Kişisel · Claude"),
        &OneClickCascadeDeps {
            begin_desktop_login: Some(&begin),
            arm_auto_capture: Some(&arm),
            ..deps(&store, dir.path())
        },
    )
    .unwrap();
    assert_eq!(result.account.provider, Some(AccountProvider::Claude));
    assert_eq!(result.needs_sign_in, Some(true));
    assert_eq!(result.layers.desktop, CascadeLayerStatus::Pending);
    assert_eq!(
        result.account.auth, None,
        "no sign-in is claimed before the capture"
    );
    assert_eq!(*began.borrow(), vec![result.account.id.clone()]);
    assert_eq!(*armed.borrow(), vec![result.account.id.clone()]);
}

const ACCOUNT_UUID: &str = "11111111-1111-4111-8111-111111111111";
const ORG_ID: &str = "22222222-2222-4222-8222-222222222222";

#[test]
fn one_click_on_claude_captures_the_current_desktop_sign_in_when_code_has_its_one_workspace() {
    let dir = home();
    let root = dir.path().join("Claude");
    write(
        &root.join("config.json"),
        &json!({ "lastKnownAccountUuid": ACCOUNT_UUID, "oauth:tokenCacheV2": "sealed" }),
    );
    fs::create_dir_all(
        root.join("claude-code-sessions")
            .join(ACCOUNT_UUID)
            .join(ORG_ID),
    )
    .unwrap();
    // The Claude Code CLI's tokens are never copied into the new profile.
    write(
        &dir.path().join(".claude").join(".credentials.json"),
        &json!({ "claudeAiOauth": { "accessToken": "cli", "refreshToken": "cli-rt" } }),
    );
    let store = store_in(dir.path());
    let captured = std::cell::RefCell::new(Vec::<(String, String)>::new());
    let capture = |id: &str, org: &str| {
        captured.borrow_mut().push((id.into(), org.into()));
        Ok(())
    };
    let begin = |_: &str| -> Result<(), relay_core::provider_discovery::HookError> {
        panic!("a current session needs no sign-in")
    };
    let result = execute_one_click_cascade(
        &input("claude", "Kişisel · Claude"),
        &OneClickCascadeDeps {
            capture_desktop: Some(&capture),
            begin_desktop_login: Some(&begin),
            ..deps(&store, dir.path())
        },
    )
    .unwrap();
    assert_eq!(
        *captured.borrow(),
        vec![(result.account.id.clone(), ORG_ID.to_owned())]
    );
    assert_eq!(result.needs_sign_in, None);
    assert!(
        !store
            .profile(&result.account.id)
            .unwrap()
            .join(".credentials.json")
            .exists()
    );
}

#[test]
fn one_click_on_claude_waits_for_code_instead_of_faking_its_workspace_folder() {
    let dir = home();
    let root = dir.path().join("Claude");
    write(
        &root.join("config.json"),
        &json!({ "lastKnownAccountUuid": ACCOUNT_UUID, "oauth:tokenCacheV2": "sealed" }),
    );
    write(
        &dir.path().join(".claude.json"),
        &json!({ "oauthAccount": { "accountUuid": ACCOUNT_UUID, "organizationUuid": ORG_ID } }),
    );
    let store = store_in(dir.path());
    let armed = std::cell::RefCell::new(Vec::<String>::new());
    let capture = |_: &str, _: &str| -> Result<(), relay_core::provider_discovery::HookError> {
        panic!("no workspace to capture yet")
    };
    let begin = |_: &str| -> Result<(), relay_core::provider_discovery::HookError> {
        panic!("the current sign-in is kept")
    };
    let arm = |id: &str| armed.borrow_mut().push(id.into());
    let result = execute_one_click_cascade(
        &input("claude", "Kişisel · Claude"),
        &OneClickCascadeDeps {
            capture_desktop: Some(&capture),
            begin_desktop_login: Some(&begin),
            arm_auto_capture: Some(&arm),
            ..deps(&store, dir.path())
        },
    )
    .unwrap();
    assert_eq!(*armed.borrow(), vec![result.account.id.clone()]);
    assert_eq!(result.layers.desktop, CascadeLayerStatus::Pending);
    assert!(!root.join("claude-code-sessions").exists());
}
