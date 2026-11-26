//! Port of `tests/provider-usage.test.ts`: its provider-usage cases. The plan cases
//! (`claudePlan`, `readProfileIdentity`/`authStatus`) are the Store slice's profile-identity, and
//! the startup plan case drives `Service`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use relay_core::provider_credentials::{CodexCredential, CodexCredentialKind};
use relay_core::provider_usage::{
    ANTIGRAVITY_READ_MS, ANTIGRAVITY_SUMMARY_AGENT, AntigravityRequest, FetchFn, FetchedResponse,
    ProviderUsageResult, parse_antigravity_quota, parse_antigravity_summary,
    parse_antigravity_tier, parse_codex_usage, read_antigravity_tier, read_antigravity_usage,
    read_codex_usage,
};
use relay_core::shared::types::js::{date_parse, iso};
use relay_core::shared::types::{
    AccountAuth, AccountKind, AccountProvider, CreateAccount, ModelWindow, ModelWindowPeriod,
    UsageIssue, UsageStatus, UsageWindow,
};
use relay_core::store::{Store, StoreOptions};
use relay_core::usage::{UsageLimits, UsageManager, UsageManagerDeps};
use relay_core::usage_credentials::UsageError;
use serde_json::{Value, json};

fn now_ms() -> f64 {
    date_parse("2026-11-09T12:00:00Z")
}

fn wall() -> f64 {
    relay_core::clock::now_ms() as f64
}

fn answer(status: u16, body: &str) -> FetchedResponse {
    FetchedResponse {
        status,
        retry_after: None,
        body: body.into(),
    }
}

#[test]
fn codex_usage_the_primary_window_is_the_five_hour_one_the_secondary_the_weekly_one() {
    let now = now_ms();
    let result = parse_codex_usage(
        &json!({
            "plan_type": "Plus",
            "rate_limit": {
                "allowed": true,
                "limit_reached": false,
                "primary_window": { "used_percent": 12, "limit_window_seconds": 18_000, "reset_at": 1_794_272_497 },
                "secondary_window": { "used_percent": 76, "limit_window_seconds": 604_800, "reset_after_seconds": 3_600 },
            },
        }),
        now,
    )
    .unwrap();
    assert_eq!(result.plan.as_deref(), Some("plus"));
    assert_eq!(
        result.limits.five_hour,
        Some(UsageWindow::new(12.0, Some(&iso(1_794_272_497_000.0))))
    );
    assert_eq!(
        result.limits.seven_day,
        Some(UsageWindow::new(76.0, Some(&iso(now + 3_600_000.0))))
    );
    assert_eq!(result.limits.other_limit_reached, None);
}

#[test]
fn codex_usage_windows_are_placed_by_their_length_and_an_answer_without_any_is_refused() {
    let weekly_only = parse_codex_usage(
        &json!({ "rate_limit": { "primary_window": { "used_percent": 40, "limit_window_seconds": 604_800 } } }),
        now_ms(),
    )
    .unwrap();
    assert_eq!(weekly_only.limits.five_hour, None);
    assert_eq!(
        weekly_only.limits.seven_day.map(|w| w.used_percent),
        Some(40.0)
    );
    assert_eq!(
        parse_codex_usage(&json!({ "rate_limit": {} }), now_ms())
            .unwrap_err()
            .issue,
        UsageIssue::Unsupported
    );
}

#[test]
fn codex_usage_an_api_key_is_never_sent_and_a_refused_token_is_an_expired_sign_in() {
    let never: FetchFn = Arc::new(|_, _| panic!("no request"));
    let api_key = CodexCredential {
        kind: CodexCredentialKind::ApiKey,
        access_token: "sk-x".into(),
        expires_at: None,
        account_id: None,
    };
    assert_eq!(
        read_codex_usage(Some(&api_key), Some(&never), None)
            .unwrap_err()
            .issue,
        UsageIssue::Unsupported
    );
    let headers: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
    let fetch: FetchFn = Arc::new({
        let headers = headers.clone();
        move |_, sent| {
            *headers.lock().unwrap() = sent.to_vec();
            Ok(answer(401, "{}"))
        }
    });
    let chatgpt = CodexCredential {
        kind: CodexCredentialKind::Chatgpt,
        access_token: "tok".into(),
        expires_at: None,
        account_id: Some("acct-1".into()),
    };
    assert_eq!(
        read_codex_usage(Some(&chatgpt), Some(&fetch), None)
            .unwrap_err()
            .issue,
        UsageIssue::Expired
    );
    let header = |name: &str| {
        headers
            .lock()
            .unwrap()
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.clone())
    };
    assert_eq!(header("Authorization").as_deref(), Some("Bearer tok"));
    assert_eq!(header("ChatGPT-Account-Id").as_deref(), Some("acct-1"));
}

fn windows(result: &ProviderUsageResult) -> Vec<(String, String, f64, Option<ModelWindowPeriod>)> {
    result
        .limits
        .model_windows
        .iter()
        .flatten()
        .map(|w| (w.key.clone(), w.label.clone(), w.used_percent, w.period))
        .collect()
}

fn row(
    key: &str,
    label: &str,
    used: f64,
    period: Option<ModelWindowPeriod>,
) -> (String, String, f64, Option<ModelWindowPeriod>) {
    (key.into(), label.into(), used, period)
}

#[test]
fn antigravity_quota_fallback_model_shares_folded_into_their_pools_the_roomiest_pool_as_the_headline()
 {
    let soon = iso(wall() + 3.0 * 3_600_000.0);
    let next_week = iso(wall() + 6.0 * 86_400_000.0);
    let result = parse_antigravity_quota(&json!({
        "models": {
            "gemini-3-flash": { "displayName": "Gemini 3 Flash", "quotaInfo": { "remainingFraction": 0.8, "resetTime": soon } },
            "gemini-3-pro-high": { "displayName": "Gemini 3 Pro (High)", "quotaInfo": { "remainingFraction": 0.6, "resetTime": soon } },
            "claude-opus-high": { "displayName": "Claude Opus", "quotaInfo": { "resetTime": next_week } },
            "gpt-oss-120b": { "displayName": "GPT-OSS 120B", "quotaInfo": { "remainingFraction": 0.5, "resetTime": next_week } },
            "tab_flash_lite": { "quotaInfo": { "remainingFraction": 1 } },
            "no-quota": { "displayName": "No quota" },
        },
    }))
    .unwrap();
    assert_eq!(
        windows(&result),
        [
            row("antigravity_gemini", "Gemini", 40.0, None),
            row("antigravity_claude_gpt", "Claude & GPT", 100.0, None),
        ]
    );
    assert_eq!(result.limits.five_hour.map(|w| w.used_percent), Some(40.0));
    assert_eq!(result.limits.seven_day, None);
    // One spent pool leaves the account usable.
    assert_eq!(result.limits.other_limit_reached, None);
}

fn summary(now: f64) -> Value {
    json!({
        "groups": [
            {
                "displayName": "Gemini Models",
                "buckets": [
                    { "bucketId": "gemini-weekly", "displayName": "Weekly", "window": "weekly", "remainingFraction": 0.02, "resetTime": iso(now + 4.0 * 86_400_000.0) },
                    { "bucketId": "gemini-5h", "displayName": "5-hour", "window": "5h", "remainingFraction": 1, "resetTime": iso(now + 5.0 * 3_600_000.0) },
                ],
            },
            {
                "displayName": "Claude and GPT models",
                "buckets": [
                    { "bucketId": "3p-5h", "window": "5h", "resetTime": iso(now + 2.0 * 3_600_000.0) },
                    { "bucketId": "3p-weekly", "window": "weekly", "remainingFraction": 0.75, "resetTime": iso(now + 6.0 * 86_400_000.0) },
                    { "bucketId": "3p-extra", "window": "weekly", "disabled": true, "remainingFraction": 0 },
                    { "bucketId": "3p-unread", "window": "weekly" },
                ],
            },
        ],
    })
}

#[test]
fn antigravity_quota_summary_one_line_per_pool_and_window_in_the_apps_order_five_hours_first() {
    use ModelWindowPeriod::{FiveHour, SevenDay};
    let now = wall();
    let result = parse_antigravity_summary(&summary(now), now).unwrap();
    assert_eq!(
        windows(&result),
        [
            row("antigravity_gemini_5h", "Gemini", 0.0, Some(FiveHour)),
            row("antigravity_gemini_weekly", "Gemini", 98.0, Some(SevenDay)),
            // No fraction but a reset: spent (proto3 leaves a zero out). Disabled and unread buckets are left out.
            row("antigravity_3p_5h", "Claude & GPT", 100.0, Some(FiveHour)),
            row(
                "antigravity_3p_weekly",
                "Claude & GPT",
                25.0,
                Some(SevenDay)
            ),
        ]
    );
    // Gemini binds at 98%, Claude & GPT at 100%: Gemini's week is the headline the gateway reads.
    assert_eq!(result.limits.seven_day.map(|w| w.used_percent), Some(98.0));
    assert_eq!(result.limits.five_hour, None);
    assert_eq!(
        parse_antigravity_summary(&json!({ "groups": [] }), now),
        None
    );
    assert_eq!(
        parse_antigravity_summary(&json!({ "models": {} }), now),
        None
    );
    // The cadence can come from the bucket id or name alone.
    let named = parse_antigravity_summary(
        &json!({ "groups": [{ "displayName": "Gemini", "buckets": [
            { "displayName": "Weekly limit", "remainingFraction": 0.5 },
            { "bucketId": "x-5h", "remainingFraction": 0.5 },
        ] }] }),
        now,
    )
    .unwrap();
    assert_eq!(
        named
            .limits
            .model_windows
            .unwrap()
            .iter()
            .map(|w| w.period)
            .collect::<Vec<_>>(),
        [Some(FiveHour), Some(SevenDay)]
    );
}

#[test]
fn antigravity_quota_the_summary_on_the_daily_host_first_then_prod_then_the_model_list() {
    let now = wall();
    let models = json!({ "models": { "m": { "displayName": "Gemini 3", "quotaInfo": { "remainingFraction": 1 } } } }).to_string();
    let asked: Mutex<Vec<String>> = Mutex::default();
    let agents: Mutex<Vec<Option<String>>> = Mutex::default();
    let call = |request: &AntigravityRequest| {
        let short = request
            .url
            .replace("https://", "")
            .replace(".googleapis.com/v1internal", "");
        let mut asked = asked.lock().unwrap();
        asked.push(short);
        agents.lock().unwrap().push(request.user_agent.clone());
        assert_eq!(
            serde_json::from_str::<Value>(&request.body).unwrap(),
            json!({ "project": "proj-1" })
        );
        Ok(if request.url.contains("retrieveUserQuotaSummary") {
            if request.url.contains("daily") {
                answer(403, "")
            } else {
                answer(200, &json!({ "groups": [] }).to_string())
            }
        } else if asked.len() == 3 {
            answer(503, "")
        } else {
            answer(200, &models)
        })
    };
    let ok = read_antigravity_usage(&call, Some("proj-1"), None).unwrap();
    assert_eq!(
        *asked.lock().unwrap(),
        [
            "daily-cloudcode-pa:retrieveUserQuotaSummary",
            "cloudcode-pa:retrieveUserQuotaSummary",
            "daily-cloudcode-pa:fetchAvailableModels",
            "cloudcode-pa:fetchAvailableModels",
        ]
    );
    assert_eq!(
        agents.lock().unwrap()[..2],
        [
            Some(ANTIGRAVITY_SUMMARY_AGENT.to_owned()),
            Some(ANTIGRAVITY_SUMMARY_AGENT.to_owned())
        ]
    );
    assert_eq!(ok.limits.model_windows.unwrap()[0].label, "Gemini");
    // A daily summary with buckets is the answer: nothing else is asked.
    let one = AtomicUsize::new(0);
    let body = summary(now).to_string();
    let pools = read_antigravity_usage(
        &|_: &AntigravityRequest| {
            one.fetch_add(1, Ordering::SeqCst);
            Ok(answer(200, &body))
        },
        None,
        None,
    )
    .unwrap();
    assert_eq!(one.load(Ordering::SeqCst), 1);
    assert_eq!(pools.limits.model_windows.map(|w| w.len()), Some(4));
    // A refused sign-in stops at the first call.
    let calls = AtomicUsize::new(0);
    let refused = read_antigravity_usage(
        &|_: &AntigravityRequest| {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(answer(401, ""))
        },
        None,
        None,
    );
    assert_eq!(refused.unwrap_err().issue, UsageIssue::Expired);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

fn provider_store(
    root: &std::path::Path,
    name: &str,
    provider: AccountProvider,
) -> (Arc<Store>, String) {
    let store = Arc::new(Store::open(root, StoreOptions::default()).unwrap());
    let created = store
        .create(&CreateAccount {
            name: name.into(),
            kind: AccountKind::Personal,
            group: None,
            provider: Some(provider),
        })
        .unwrap();
    (store, created.id)
}

fn claude_unused() -> UsageManagerDeps {
    let mut deps = UsageManagerDeps::new(Arc::new(|_, _| {
        panic!("no Claude credential for this account")
    }));
    deps.request = Arc::new(|_, _| panic!("no Claude request for this account"));
    deps
}

#[test]
fn a_codex_accounts_limits_are_read_through_its_provider_and_its_plan_follows_the_answer() {
    let root = tempfile::Builder::new()
        .prefix("relay-provider-usage-")
        .tempdir()
        .unwrap();
    let (store, id) = provider_store(root.path(), "Codex", AccountProvider::Codex);
    store
        .update(|s| {
            s.accounts[0].auth = Some(AccountAuth {
                logged_in: true,
                email: Some("dev@example.com".into()),
                subscription: Some("free".into()),
                checked_at: iso(now_ms()),
                ..AccountAuth::default()
            })
        })
        .unwrap();
    let mut deps = claude_unused();
    deps.now = Arc::new(|| now_ms() as i64);
    deps.provider_usage = Some(Arc::new({
        let id = id.clone();
        move |account| {
            assert_eq!(account.id, id);
            Ok(ProviderUsageResult {
                limits: UsageLimits {
                    five_hour: Some(UsageWindow::new(10.0, None)),
                    seven_day: Some(UsageWindow::new(76.0, None)),
                    ..UsageLimits::default()
                },
                plan: Some("plus".into()),
            })
        }
    }));
    let manager = UsageManager::new(store.clone(), deps);
    let usage = manager.refresh(&id, false).unwrap();
    assert_eq!(usage.status, UsageStatus::Ready);
    assert_eq!(usage.seven_day.map(|w| w.used_percent), Some(76.0));
    assert_eq!(
        store
            .account(&id)
            .unwrap()
            .auth
            .and_then(|a| a.subscription)
            .as_deref(),
        Some("plus")
    );
}

/// TS `manager.tick()` then letting its reads start: here the accounts a tick would read are
/// checked with `due()`, and read with `refresh` where the TS awaits them.
#[test]
fn an_antigravity_pool_that_resets_is_read_again_at_once_also_while_failed_reads_back_off() {
    let start = now_ms();
    let root = tempfile::Builder::new()
        .prefix("relay-provider-usage-")
        .tempdir()
        .unwrap();
    let (store, id) = provider_store(root.path(), "Antigravity", AccountProvider::Antigravity);
    store
        .update(|s| {
            s.accounts[0].auth = Some(AccountAuth {
                logged_in: true,
                email: Some("dev@example.com".into()),
                checked_at: iso(start),
                ..AccountAuth::default()
            })
        })
        .unwrap();
    let now = Arc::new(Mutex::new(start));
    let at = |ms: f64| Some(iso(start + ms));
    // The headline is the roomiest pool's week, six days off; Claude & GPT's five hours end in 30 minutes.
    let gemini = ModelWindow {
        key: "antigravity_gemini_weekly".into(),
        label: "Gemini".into(),
        used_percent: 13.0,
        resets_at: at(6.0 * 86_400_000.0),
        period: Some(ModelWindowPeriod::SevenDay),
        ..ModelWindow::default()
    };
    let third_party = ModelWindow {
        key: "antigravity_3p_5h".into(),
        label: "Claude & GPT".into(),
        used_percent: 100.0,
        resets_at: at(30.0 * 60_000.0),
        period: Some(ModelWindowPeriod::FiveHour),
        ..ModelWindow::default()
    };
    let spent = UsageLimits {
        five_hour: None,
        seven_day: Some(UsageWindow {
            used_percent: 13.0,
            resets_at: at(6.0 * 86_400_000.0),
            ..UsageWindow::default()
        }),
        other_limit_reached: None,
        model_windows: Some(vec![gemini.clone(), third_party.clone()]),
    };
    let answers: Arc<Mutex<Vec<UsageLimits>>> = Arc::new(Mutex::new(vec![spent.clone()]));
    let reads = Arc::new(AtomicUsize::new(0));
    let mut deps = claude_unused();
    deps.now = Arc::new({
        let now = now.clone();
        move || *now.lock().unwrap() as i64
    });
    deps.provider_usage = Some(Arc::new({
        let (answers, reads) = (answers.clone(), reads.clone());
        move |_| {
            reads.fetch_add(1, Ordering::SeqCst);
            let mut answers = answers.lock().unwrap();
            if answers.is_empty() {
                return Err(UsageError::with_detail(
                    UsageIssue::Unavailable,
                    "antigravity quota: no answer: TimeoutError",
                ));
            }
            Ok(ProviderUsageResult {
                limits: answers.remove(0),
                plan: None,
            })
        }
    }));
    let manager = UsageManager::new(store, deps);
    let set = |ms: f64| *now.lock().unwrap() = start + ms;
    manager.refresh(&id, false).unwrap();
    assert!(!manager.snapshot()[id.as_str()].stale);
    // Four failed reads in a row (6, 8, 12 and 20 minutes in): the next waits until 36 minutes.
    for minute in [6.0, 8.0, 12.0, 20.0] {
        set(minute * 60_000.0);
        manager.refresh(&id, false).unwrap();
    }
    assert_eq!(reads.load(Ordering::SeqCst), 5);
    // Before the reset nothing is owed: the tick waits for the backoff.
    set(30.0 * 60_000.0 - 1_000.0);
    assert!(manager.due().is_empty());
    assert_eq!(reads.load(Ordering::SeqCst), 5);
    // The pool reset: the reading is old, and one read goes out now.
    set(30.0 * 60_000.0 + 1_000.0);
    assert!(manager.snapshot()[id.as_str()].stale);
    answers.lock().unwrap().push(UsageLimits {
        model_windows: Some(vec![
            gemini,
            ModelWindow {
                used_percent: 0.0,
                resets_at: at(5.0 * 3_600_000.0),
                ..third_party
            },
        ]),
        ..spent
    });
    assert_eq!(manager.due(), [id.as_str()]);
    manager.refresh(&id, false).unwrap();
    assert_eq!(reads.load(Ordering::SeqCst), 6);
    let fresh = manager.snapshot()[id.as_str()].clone();
    assert!(!fresh.stale);
    assert_eq!(fresh.model_windows.unwrap()[1].used_percent, 0.0);
    // Owed once per reset: the next ticks keep to the poll's pace.
    assert!(manager.due().is_empty());
    assert!(manager.due().is_empty());
    assert_eq!(reads.load(Ordering::SeqCst), 6);
}

#[test]
fn an_antigravity_read_stops_asking_once_it_has_taken_a_minute() {
    let now = Mutex::new(now_ms());
    let asked: Mutex<Vec<String>> = Mutex::default();
    let result = read_antigravity_usage(
        &|request: &AntigravityRequest| {
            asked.lock().unwrap().push(request.url.clone());
            *now.lock().unwrap() += ANTIGRAVITY_READ_MS / 2.0;
            Err("timed out".into())
        },
        None,
        Some(&|| *now.lock().unwrap()),
    );
    assert_eq!(result.unwrap_err().issue, UsageIssue::Unavailable);
    assert_eq!(asked.lock().unwrap().len(), 2);
}

#[test]
fn an_antigravity_sign_ins_google_plan_comes_from_load_code_assist_the_paid_tier_first() {
    let tier = |v: Value| parse_antigravity_tier(&v);
    assert_eq!(
        tier(json!({ "currentTier": { "id": "free-tier" }, "paidTier": { "id": "g1-pro-tier", "name": "Google AI Pro" } })).as_deref(),
        Some("pro")
    );
    assert_eq!(
        tier(json!({ "currentTier": { "id": "g1-ultra-tier" } })).as_deref(),
        Some("ultra")
    );
    assert_eq!(
        tier(json!({ "currentTier": { "id": "free-tier" } })).as_deref(),
        Some("free")
    );
    assert_eq!(
        tier(json!({ "currentTier": { "id": "standard-tier" } })).as_deref(),
        Some("standard")
    );
    assert_eq!(tier(json!({})), None);
    let asked: Mutex<Vec<String>> = Mutex::default();
    let read = read_antigravity_tier(
        &|request: &AntigravityRequest| {
            let mut asked = asked.lock().unwrap();
            asked.push(request.url.clone());
            Ok(if asked.len() == 1 {
                answer(503, "")
            } else {
                answer(
                    200,
                    &json!({ "paidTier": { "id": "g1-ultra-tier" } }).to_string(),
                )
            })
        },
        Some("proj-1"),
    );
    assert_eq!(read.as_deref(), Some("ultra"));
    assert_eq!(
        asked.lock().unwrap().len(),
        2,
        "the second host after an outage"
    );
    assert_eq!(
        read_antigravity_tier(&|_: &AntigravityRequest| Err("down".into()), None),
        None
    );
}
