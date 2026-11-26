//! Port of the reader and service cases of tests/meters.test.ts. Elsewhere: the feature-risk
//! part of "turning a meter on needs its risk accepted…" (shared_meters.rs; its main-source
//! assertions are source-text checks), "the meters setting is optional…" (store_settings.rs),
//! and "the Overview shows a row per enabled meter…" (React UI).

#[path = "common/platform.rs"]
mod platform;

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::Engine;
use platform::{Reply, Seen, TestServer};
use relay_core::meters::common::{
    MeterError, MeterFetch, MeterRead, MeterReaderOptions, MeterRequest, default_meter_fetch,
};
use relay_core::meters::copilot::{
    CopilotToken, GhToken, copilot_token_from_file, find_copilot_token, gh_token_from_hosts,
    parse_copilot_user, read_copilot,
};
use relay_core::meters::cursor::{
    CursorSession, cursor_session_cookie, cursor_state_path, parse_cursor_legacy_usage,
    parse_cursor_summary, read_cursor,
};
use relay_core::meters::gemini_cli::{
    CodeAssistTier, parse_gemini_quota, parse_load_code_assist, read_gemini_cli,
};
use relay_core::meters::{MeterReader, MeterService, MeterServiceOptions};
use relay_core::relay_paths::Platform;
use relay_core::shared::meters::{
    MeterIssue, MeterProvider, MeterReading, MeterReadingError, MeterSource, MeterUnit,
    MeterWindow, MeterWindowKind, MeterWindowName,
};
use relay_core::shared::types::js::{date_parse, iso};
use serde_json::{Value, json};

fn now() -> f64 {
    date_parse("2026-11-23T12:00:00Z")
}
const GH_TOKEN: &str = "gho_madeUpCopilotTokenForTests0123456789";

fn temp_home() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("relay-meters-")
        .tempdir()
        .unwrap()
}

/// A local server standing in for the providers: answers by path, records what each request
/// sent. The readers' real URLs are sent to it instead, path and query kept.
fn fake_provider(
    answer: impl Fn(&str, &str) -> (u16, Value) + Send + Sync + 'static,
) -> (TestServer, MeterFetch) {
    let server = TestServer::start(move |seen: &Seen| {
        let (status, body) = answer(&seen.url, &seen.body);
        let text = match body {
            Value::String(text) => text,
            other => other.to_string(),
        };
        Reply::json(status, text)
    });
    let port = server.port;
    let real = default_meter_fetch();
    let fetch: MeterFetch = Arc::new(move |request: &MeterRequest| {
        let url = url::Url::parse(&request.url).unwrap();
        let query = url.query().map(|q| format!("?{q}")).unwrap_or_default();
        let mut local = request.clone();
        local.url = format!("http://127.0.0.1:{port}{}{query}", url.path());
        real(&local)
    });
    (server, fetch)
}

fn options(home: &Path) -> MeterReaderOptions {
    MeterReaderOptions {
        home: Some(home.to_path_buf()),
        env: Some(BTreeMap::new()),
        now: Some(Arc::new(now)),
        ..MeterReaderOptions::default()
    }
}

fn gh(token: Option<&'static str>) -> GhToken {
    Arc::new(move |_env: &BTreeMap<String, String>| token.map(str::to_owned))
}

fn issue<T: std::fmt::Debug>(result: Result<T, MeterError>) -> MeterIssue {
    result.unwrap_err().issue
}

/// A JWT with the given claims, unsigned: the readers only decode it.
fn jwt(claims: Value) -> String {
    let b64 = |text: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(text);
    format!(
        "{}.{}.sig",
        b64(r#"{"alg":"none"}"#),
        b64(&claims.to_string())
    )
}

// --- GitHub Copilot ---------------------------------------------------------------------------

fn copilot_user() -> Value {
    json!({
        "copilot_plan": "individual",
        "access_type_sku": "plus_monthly_subscriber_quota",
        "quota_reset_date": "2026-12-01",
        "quota_snapshots": {
            "premium_interactions": {
                "entitlement": 300, "remaining": 114, "percent_remaining": 38,
                "unlimited": false, "quota_id": "premium_interactions"
            },
            "chat": {
                "entitlement": 0, "remaining": 0, "percent_remaining": 100,
                "unlimited": true, "quota_id": "chat"
            },
            // An org seat's placeholder: nothing to show.
            "completions": {
                "entitlement": 0, "remaining": 0, "unlimited": false, "quota_id": "completions"
            }
        }
    })
}

#[test]
fn copilot_quota_snapshots_become_monthly_windows_unlimited_and_placeholder_ones_are_left_out() {
    let read = parse_copilot_user(&copilot_user(), Some("alto")).unwrap();
    assert_eq!(read.label.as_deref(), Some("individual · alto"));
    assert_eq!(
        read.windows,
        vec![MeterWindow {
            name: MeterWindowName::Premium,
            kind: MeterWindowKind::Monthly,
            unit: MeterUnit::PremiumRequests,
            used_percent: Some(62.0),
            used: Some(186.0),
            limit: Some(300.0),
            resets_at: Some("2026-12-01T00:00:00.000Z".into()),
        }]
    );
    // Copilot Free before quota snapshots: the month's allowance and what is left of it.
    let free = parse_copilot_user(
        &json!({
            "copilot_plan": "free",
            "limited_user_reset_date": "2026-12-05",
            "monthly_quotas": { "chat": 50, "completions": 2000 },
            "limited_user_quotas": { "chat": 40, "completions": 1500 }
        }),
        None,
    )
    .unwrap();
    let rows: Vec<_> = free
        .windows
        .iter()
        .map(|w| (w.name, w.used_percent, w.used, w.limit, w.resets_at.clone()))
        .collect();
    let reset = Some("2026-12-05T00:00:00.000Z".to_owned());
    assert_eq!(
        rows,
        vec![
            (
                MeterWindowName::Chat,
                Some(20.0),
                Some(10.0),
                Some(50.0),
                reset.clone()
            ),
            (
                MeterWindowName::Completions,
                Some(25.0),
                Some(500.0),
                Some(2000.0),
                reset
            ),
        ]
    );
    assert_eq!(
        issue(parse_copilot_user(
            &json!({ "access_type_sku": "subscription_ended" }),
            None
        )),
        MeterIssue::NotAvailable
    );
}

#[test]
fn copilot_the_token_comes_from_apps_json_hosts_json_ghs_hosts_yml_then_gh_auth_token() {
    let dir = temp_home();
    let home = dir.path();
    let env: BTreeMap<String, String> = [(
        "XDG_CONFIG_HOME".to_owned(),
        home.join(".config").to_string_lossy().into_owned(),
    )]
    .into_iter()
    .collect();
    let opts = MeterReaderOptions {
        home: Some(home.to_path_buf()),
        env: Some(env),
        platform: Some(Platform::MacOs),
        ..MeterReaderOptions::default()
    };
    assert_eq!(find_copilot_token(&opts, Some(&gh(None))), None);

    // gh's own answer is the last resort.
    assert_eq!(
        find_copilot_token(&opts, Some(&gh(Some(GH_TOKEN)))),
        Some(CopilotToken {
            token: GH_TOKEN.into(),
            login: None
        })
    );

    fs::create_dir_all(home.join(".config/gh")).unwrap();
    fs::write(
        home.join(".config/gh/hosts.yml"),
        format!(
            "github.com:\n    user: alto\n    oauth_token: {GH_TOKEN}\n    git_protocol: https\n"
        ),
    )
    .unwrap();
    assert_eq!(
        find_copilot_token(&opts, Some(&gh(None))),
        Some(CopilotToken {
            token: GH_TOKEN.into(),
            login: Some("alto".into())
        })
    );

    fs::create_dir_all(home.join(".config/github-copilot")).unwrap();
    fs::write(
        home.join(".config/github-copilot/apps.json"),
        json!({
            "github.com:Iv1.0000000000000000": {
                "user": "vertex",
                "oauth_token": "ghu_madeUpAppsJsonToken0123456789abc",
                "githubAppId": "Iv1.0000000000000000"
            }
        })
        .to_string(),
    )
    .unwrap();
    assert_eq!(
        find_copilot_token(&opts, Some(&gh(None))),
        Some(CopilotToken {
            token: "ghu_madeUpAppsJsonToken0123456789abc".into(),
            login: Some("vertex".into())
        })
    );

    // A host other than github.com is not this meter's.
    assert_eq!(
        copilot_token_from_file(&json!({ "ghe.example.com": { "oauth_token": GH_TOKEN } })),
        None
    );
    assert_eq!(
        gh_token_from_hosts(&format!("ghe.example.com:\n    oauth_token: {GH_TOKEN}\n")),
        None
    );
}

fn linux(home: &Path, fetch: Option<MeterFetch>) -> MeterReaderOptions {
    MeterReaderOptions {
        platform: Some(Platform::Linux),
        fetch,
        ..options(home)
    }
}

#[test]
fn copilot_reads_with_the_token_scheme_and_copilot_chats_headers() {
    let dir = temp_home();
    let home = dir.path();
    let (server, fetch) = fake_provider(|_, _| (200, copilot_user()));
    let read = read_copilot(&linux(home, Some(fetch)), Some(&gh(Some(GH_TOKEN)))).unwrap();
    assert_eq!(read.windows[0].used_percent, Some(62.0));
    let seen = server.seen();
    let request = &seen[0];
    assert_eq!(request.url, "/copilot_internal/user");
    assert_eq!(
        request.headers["authorization"],
        format!("token {GH_TOKEN}")
    );
    assert_eq!(request.headers["editor-version"], "vscode/1.96.2");
    assert_eq!(request.headers["x-github-api-version"], "2025-04-01");

    // No Copilot on the account; a token GitHub no longer takes; no token at all.
    for (status, expected) in [(404, MeterIssue::NotAvailable), (401, MeterIssue::Expired)] {
        let (_refusing, fetch) = fake_provider(move |_, _| (status, json!({ "message": "x" })));
        assert_eq!(
            issue(read_copilot(
                &linux(home, Some(fetch)),
                Some(&gh(Some(GH_TOKEN)))
            )),
            expected
        );
    }
    assert_eq!(
        issue(read_copilot(&linux(home, None), Some(&gh(None)))),
        MeterIssue::NotSignedIn
    );
}

// --- Cursor -----------------------------------------------------------------------------------

fn cursor_summary() -> Value {
    json!({
        "billingCycleStart": "2026-11-05T00:00:00.000Z",
        "billingCycleEnd": "2026-12-05T00:00:00.000Z",
        "membershipType": "pro",
        "limitType": "user",
        "isUnlimited": false,
        "individualUsage": {
            "plan": {
                "enabled": true, "used": 1820, "limit": 2000, "remaining": 180,
                "breakdown": { "included": 1820, "bonus": 0, "total": 1820 },
                "autoPercentUsed": 40, "apiPercentUsed": 51, "totalPercentUsed": 91
            },
            "onDemand": { "enabled": true, "used": 250, "limit": 1000, "remaining": 750 }
        }
    })
}

#[test]
fn cursor_the_usage_summary_becomes_the_months_plan_budget_its_shares_and_on_demand_spend() {
    let read = parse_cursor_summary(&cursor_summary()).unwrap();
    assert_eq!(read.label.as_deref(), Some("pro"));
    let end = Some("2026-12-05T00:00:00.000Z".to_owned());
    let rows: Vec<_> = read
        .windows
        .iter()
        .map(|w| {
            (
                w.name,
                w.unit,
                w.used_percent,
                w.used,
                w.limit,
                w.resets_at.clone(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        vec![
            (
                MeterWindowName::Included,
                MeterUnit::Dollars,
                Some(91.0),
                Some(18.2),
                Some(20.0),
                end.clone()
            ),
            (
                MeterWindowName::Auto,
                MeterUnit::Dollars,
                Some(40.0),
                None,
                None,
                end.clone()
            ),
            (
                MeterWindowName::Api,
                MeterUnit::Dollars,
                Some(51.0),
                None,
                None,
                end.clone()
            ),
            (
                MeterWindowName::OnDemand,
                MeterUnit::Dollars,
                Some(25.0),
                Some(2.5),
                Some(10.0),
                end
            ),
        ]
    );
    // An older plan counted in requests.
    assert_eq!(
        parse_cursor_legacy_usage(&json!({
            "gpt-4": { "numRequests": 120, "maxRequestUsage": 500 },
            "startOfMonth": "2026-11-10T00:00:00.000Z"
        })),
        vec![MeterWindow {
            name: MeterWindowName::Requests,
            kind: MeterWindowKind::Monthly,
            unit: MeterUnit::Requests,
            used_percent: Some(24.0),
            used: Some(120.0),
            limit: Some(500.0),
            resets_at: Some("2026-12-10T00:00:00.000Z".into()),
        }]
    );
}

#[test]
fn cursor_the_session_cookie_carries_the_tokens_user_and_is_refused_within_a_minute_of_its_end() {
    let token = jwt(json!({ "sub": "auth0|user_01ALTO", "exp": now() / 1000.0 + 3600.0 }));
    assert_eq!(
        cursor_session_cookie(&token, now()).unwrap(),
        CursorSession {
            cookie: format!("WorkosCursorSessionToken=user_01ALTO%3A%3A{token}"),
            user_id: "user_01ALTO".into()
        }
    );
    assert_eq!(
        issue(cursor_session_cookie(
            &jwt(json!({ "sub": "auth0|u1", "exp": now() / 1000.0 + 30.0 })),
            now()
        )),
        MeterIssue::Expired
    );
    assert_eq!(
        issue(cursor_session_cookie("not-a-jwt", now())),
        MeterIssue::Unsupported
    );
}

fn cursor_state(home: &Path, value: &str) {
    let file = cursor_state_path(home, &BTreeMap::new(), Platform::MacOs);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    let db = rusqlite::Connection::open(&file).unwrap();
    db.execute_batch(
        "create table if not exists ItemTable (key text unique on conflict replace, value blob)",
    )
    .unwrap();
    db.execute(
        "insert into ItemTable (key, value) values (?, ?)",
        ["cursorAuth/accessToken", value],
    )
    .unwrap();
}

fn mac(home: &Path, fetch: Option<MeterFetch>) -> MeterReaderOptions {
    MeterReaderOptions {
        platform: Some(Platform::MacOs),
        fetch,
        ..options(home)
    }
}

#[test]
fn cursor_reads_the_token_from_the_apps_state_vscdb_and_sends_it_only_as_the_dashboard_cookie() {
    let dir = temp_home();
    let home = dir.path();
    let token = jwt(json!({ "sub": "auth0|user_01ALTO", "exp": now() / 1000.0 + 3600.0 }));
    assert_eq!(
        issue(read_cursor(&mac(home, None))),
        MeterIssue::NotSignedIn
    );
    cursor_state(home, &token);
    let (server, fetch) = fake_provider(|_, _| (200, cursor_summary()));
    let read = read_cursor(&mac(home, Some(fetch))).unwrap();
    assert_eq!(read.windows.len(), 4);
    let seen = server.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].url, "/api/usage-summary");
    assert_eq!(
        seen[0].headers["cookie"],
        format!("WorkosCursorSessionToken=user_01ALTO%3A%3A{token}")
    );
    assert!(!seen[0].headers.contains_key("authorization"));

    // A plan with no budget in the summary falls back to the request count.
    let (legacy, fetch) = fake_provider(|url, _| {
        if url.starts_with("/api/usage?") {
            (
                200,
                json!({ "gpt-4": { "numRequests": 50, "maxRequestUsage": 500 } }),
            )
        } else {
            (200, json!({ "membershipType": "pro" }))
        }
    });
    let old = read_cursor(&mac(home, Some(fetch))).unwrap();
    assert_eq!(old.windows[0].name, MeterWindowName::Requests);
    assert_eq!(legacy.seen()[1].url, "/api/usage?user=user_01ALTO");

    // Encrypted with the app's Keychain key: never opened, never sent.
    cursor_state(home, "cursor-safe-storage:v1:djEwAAAA");
    let (untouched, fetch) = fake_provider(|_, _| (200, cursor_summary()));
    assert_eq!(
        issue(read_cursor(&mac(home, Some(fetch)))),
        MeterIssue::Encrypted
    );
    assert!(untouched.seen().is_empty());
}

// --- Gemini CLI -------------------------------------------------------------------------------

fn gemini_quota() -> Value {
    json!({
        "buckets": [
            { "modelId": "gemini-3-pro-preview", "tokenType": "REQUESTS", "remainingFraction": 0.8, "resetTime": "2026-11-24T08:00:00Z" },
            { "modelId": "gemini-2.5-pro", "tokenType": "REQUESTS", "remainingFraction": 0.66, "resetTime": "2026-11-24T07:00:00Z" },
            { "modelId": "gemini-2.5-flash", "tokenType": "REQUESTS", "remainingFraction": 0.9, "resetTime": "2026-11-24T07:00:00Z" },
            { "modelId": "gemini-2.5-flash-lite", "tokenType": "REQUESTS", "remainingFraction": 1, "resetTime": "2026-11-24T07:00:00Z" },
            { "modelId": "text-embedding", "tokenType": "REQUESTS", "remainingFraction": 0 }
        ]
    })
}

fn daily(name: MeterWindowName, used_percent: f64) -> MeterWindow {
    MeterWindow {
        name,
        kind: MeterWindowKind::Daily,
        unit: MeterUnit::Requests,
        used_percent: Some(used_percent),
        used: None,
        limit: None,
        resets_at: Some("2026-11-24T07:00:00.000Z".into()),
    }
}

#[test]
fn gemini_cli_each_model_familys_least_left_bucket_becomes_a_daily_window() {
    let windows = parse_gemini_quota(&gemini_quota()).unwrap();
    assert_eq!(
        windows,
        vec![
            daily(MeterWindowName::Pro, 34.0),
            daily(MeterWindowName::Flash, 10.0),
            daily(MeterWindowName::FlashLite, 0.0),
        ]
    );
    assert_eq!(
        parse_load_code_assist(&json!({
            "currentTier": { "id": "standard-tier", "name": "Standard" },
            "cloudaicompanionProject": "alto-project-1"
        }))
        .unwrap(),
        CodeAssistTier {
            label: Some("Standard".into()),
            project: Some("alto-project-1".into())
        }
    );
    // A personal account since 2026-06-18: no current tier, its tiers ineligible.
    assert_eq!(
        issue(parse_load_code_assist(&json!({
            "ineligibleTiers": [{ "reasonCode": "UNSUPPORTED_CLIENT", "tierId": "free-tier" }]
        }))),
        MeterIssue::NotAvailable
    );
}

fn gemini_home(creds: &Value, settings: Option<Value>) -> tempfile::TempDir {
    let dir = temp_home();
    let gemini = dir.path().join(".gemini");
    fs::create_dir_all(&gemini).unwrap();
    fs::write(gemini.join("oauth_creds.json"), creds.to_string()).unwrap();
    if let Some(settings) = settings {
        fs::write(gemini.join("settings.json"), settings.to_string()).unwrap();
    }
    dir
}

#[test]
fn gemini_cli_reads_the_tier_then_the_quota_with_the_saved_token_and_never_renews_it() {
    let creds = json!({
        "access_token": "ya29.madeUpGeminiToken",
        "refresh_token": "1//madeUpRefresh",
        "expiry_date": now() + 3_600_000.0
    });
    let dir = gemini_home(
        &creds,
        Some(json!({ "security": { "auth": { "selectedType": "oauth-personal" } } })),
    );
    let (server, fetch) = fake_provider(|url, _| {
        if url.ends_with(":loadCodeAssist") {
            (
                200,
                json!({
                    "currentTier": { "id": "standard-tier", "name": "Standard" },
                    "cloudaicompanionProject": { "id": "alto-project-1" }
                }),
            )
        } else {
            (200, gemini_quota())
        }
    });
    let read = read_gemini_cli(&MeterReaderOptions {
        fetch: Some(fetch),
        ..options(dir.path())
    })
    .unwrap();
    assert_eq!(read.label.as_deref(), Some("Standard"));
    assert_eq!(
        read.windows.iter().map(|w| w.name).collect::<Vec<_>>(),
        vec![
            MeterWindowName::Pro,
            MeterWindowName::Flash,
            MeterWindowName::FlashLite
        ]
    );
    let seen = server.seen();
    assert_eq!(
        seen.iter()
            .map(|r| (r.method.as_str(), r.url.as_str()))
            .collect::<Vec<_>>(),
        vec![
            ("POST", "/v1internal:loadCodeAssist"),
            ("POST", "/v1internal:retrieveUserQuota"),
        ]
    );
    assert_eq!(
        seen[0].headers["authorization"],
        "Bearer ya29.madeUpGeminiToken"
    );
    assert_eq!(
        serde_json::from_str::<Value>(&seen[1].body).unwrap(),
        json!({ "project": "alto-project-1" })
    );
    // Nothing was sent to Google's token endpoint, and the saved file is untouched.
    assert!(seen.iter().all(|r| !r.url.contains("token")));
    let saved: Value =
        serde_json::from_slice(&fs::read(dir.path().join(".gemini/oauth_creds.json")).unwrap())
            .unwrap();
    assert_eq!(saved, creds);
}

#[test]
fn gemini_cli_a_personal_account_an_api_key_and_an_ended_token_each_say_why() {
    let valid = json!({ "access_token": "ya29.madeUp", "expiry_date": now() + 3_600_000.0 });
    let read = |home: &Path, fetch: &MeterFetch| {
        read_gemini_cli(&MeterReaderOptions {
            fetch: Some(fetch.clone()),
            ..options(home)
        })
    };
    let (_personal, fetch) = fake_provider(|_, _| {
        (
            200,
            json!({ "ineligibleTiers": [{ "reasonCode": "UNSUPPORTED_CLIENT" }] }),
        )
    });
    let home = gemini_home(&valid, None);
    assert_eq!(issue(read(home.path(), &fetch)), MeterIssue::NotAvailable);
    let (_refused, fetch) = fake_provider(|_, _| {
        (
            403,
            json!({ "error": { "status": "PERMISSION_DENIED", "message": "UNSUPPORTED_CLIENT" } }),
        )
    });
    assert_eq!(issue(read(home.path(), &fetch)), MeterIssue::NotAvailable);

    let (untouched, fetch) = fake_provider(|_, _| (200, json!({})));
    let api_key = gemini_home(
        &valid,
        Some(json!({ "security": { "auth": { "selectedType": "gemini-api-key" } } })),
    );
    assert_eq!(
        issue(read(api_key.path(), &fetch)),
        MeterIssue::UnsupportedAuth
    );
    let mut ending = valid.clone();
    ending["expiry_date"] = json!(now() + 10_000.0);
    let ended = gemini_home(&ending, None);
    assert_eq!(issue(read(ended.path(), &fetch)), MeterIssue::Expired);
    let empty = temp_home();
    assert_eq!(issue(read(empty.path(), &fetch)), MeterIssue::NotSignedIn);
    assert!(untouched.seen().is_empty());
}

// --- The service ------------------------------------------------------------------------------

#[test]
fn the_service_reads_only_enabled_meters_at_most_every_interval_and_keeps_the_last_windows_on_a_failure()
 {
    let clock = Arc::new(Mutex::new(now()));
    let enabled: Arc<Mutex<Vec<MeterProvider>>> = Arc::new(Mutex::new(Vec::new()));
    let calls: Arc<Mutex<Vec<MeterProvider>>> = Arc::new(Mutex::new(Vec::new()));
    let fail = Arc::new(Mutex::new(false));
    let reader = |provider: MeterProvider| -> MeterReader {
        let (calls, fail, clock) = (calls.clone(), fail.clone(), clock.clone());
        Arc::new(move || {
            calls.lock().unwrap().push(provider);
            if *fail.lock().unwrap() {
                return Err(MeterError {
                    issue: MeterIssue::RateLimited,
                    retry_at: Some(*clock.lock().unwrap() + 30.0 * 60_000.0),
                    detail: Some(format!("{} 429", provider.as_str())),
                });
            }
            Ok(MeterRead {
                label: Some("pro".into()),
                windows: vec![MeterWindow {
                    name: MeterWindowName::Included,
                    kind: MeterWindowKind::Monthly,
                    unit: MeterUnit::Dollars,
                    used_percent: Some(50.0),
                    used: None,
                    limit: None,
                    resets_at: None,
                }],
            })
        })
    };
    let logs = Arc::new(Mutex::new(Vec::<String>::new()));
    let changes = Arc::new(Mutex::new(0));
    let mut options = {
        let enabled = enabled.clone();
        MeterServiceOptions::new(move || enabled.lock().unwrap().clone())
    };
    options.readers = HashMap::from([
        (MeterProvider::Copilot, reader(MeterProvider::Copilot)),
        (MeterProvider::Cursor, reader(MeterProvider::Cursor)),
        (MeterProvider::GeminiCli, reader(MeterProvider::GeminiCli)),
    ]);
    options.now = Some({
        let clock = clock.clone();
        Arc::new(move || *clock.lock().unwrap())
    });
    options.on_change = Some({
        let changes = changes.clone();
        Arc::new(move || *changes.lock().unwrap() += 1)
    });
    options.log = Some({
        let logs = logs.clone();
        Arc::new(move |line: &str| logs.lock().unwrap().push(line.to_owned()))
    });
    let service = MeterService::new(options);
    // Off: nothing is read and nothing is shown.
    service.tick();
    assert!(calls.lock().unwrap().is_empty());
    assert!(service.snapshot().is_empty());

    *enabled.lock().unwrap() = vec![MeterProvider::Cursor];
    service.tick();
    assert_eq!(*calls.lock().unwrap(), vec![MeterProvider::Cursor]);
    assert_eq!(*changes.lock().unwrap(), 1);
    let first = MeterReading {
        provider: MeterProvider::Cursor,
        label: Some("pro".into()),
        windows: vec![MeterWindow {
            name: MeterWindowName::Included,
            kind: MeterWindowKind::Monthly,
            unit: MeterUnit::Dollars,
            used_percent: Some(50.0),
            used: None,
            limit: None,
            resets_at: None,
        }],
        source: MeterSource::Unofficial,
        read_at: Some(iso(now())),
        error: None,
    };
    assert_eq!(service.snapshot(), vec![first.clone()]);
    assert_eq!(
        serde_json::to_value(&service.snapshot()[0]).unwrap(),
        json!({
            "provider": "cursor",
            "label": "pro",
            "windows": [{ "name": "included", "kind": "monthly", "unit": "$", "usedPercent": 50 }],
            "source": "unofficial",
            "readAt": iso(now()),
        })
    );
    // Within ten minutes, not again; off and on again does not read sooner either.
    *clock.lock().unwrap() += 9.0 * 60_000.0;
    *enabled.lock().unwrap() = Vec::new();
    service.tick();
    *enabled.lock().unwrap() = vec![MeterProvider::Cursor];
    service.tick();
    assert_eq!(calls.lock().unwrap().len(), 1);

    *clock.lock().unwrap() += 60_000.0;
    *fail.lock().unwrap() = true;
    service.tick();
    assert_eq!(calls.lock().unwrap().len(), 2);
    let failed = service.snapshot().remove(0);
    assert_eq!(failed.windows.len(), 1);
    assert_eq!(failed.read_at, Some(iso(now())));
    let at = *clock.lock().unwrap();
    assert_eq!(
        failed.error,
        Some(MeterReadingError {
            issue: MeterIssue::RateLimited,
            retry_at: Some(iso(at + 30.0 * 60_000.0)),
        })
    );
    assert_eq!(
        *logs.lock().unwrap(),
        vec!["cursor: rate-limited (cursor 429)"]
    );
    // The provider asked for 30 minutes: ten are not enough.
    *clock.lock().unwrap() += 10.0 * 60_000.0;
    service.tick();
    assert_eq!(calls.lock().unwrap().len(), 2);
}

#[test]
fn a_meters_reading_carries_no_token_from_the_reader_to_the_windows_snapshot() {
    let dir = temp_home();
    let home: PathBuf = dir.path().to_path_buf();
    let (_server, fetch) = fake_provider(|_, _| (200, copilot_user()));
    let mut options = MeterServiceOptions::new(|| vec![MeterProvider::Copilot]);
    options.readers = HashMap::from([(
        MeterProvider::Copilot,
        Arc::new(move || {
            read_copilot(
                &MeterReaderOptions {
                    home: Some(home.clone()),
                    env: Some(BTreeMap::new()),
                    platform: Some(Platform::Linux),
                    fetch: Some(fetch.clone()),
                    ..MeterReaderOptions::default()
                },
                Some(&gh(Some(GH_TOKEN))),
            )
        }) as MeterReader,
    )]);
    options.now = Some(Arc::new(now));
    let service = MeterService::new(options);
    service.tick();
    let snapshot = serde_json::to_string(&service.snapshot()).unwrap();
    assert!(snapshot.contains("\"premium\""));
    assert!(!snapshot.contains(GH_TOKEN));
    let lower = snapshot.to_lowercase();
    assert!(!lower.contains("token") && !lower.contains("oauth") && !lower.contains("cookie"));
}
