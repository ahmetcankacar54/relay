//! Port of tests/gateway-overflow.test.ts.

mod common;

use common::*;
use relay_gateway::model_prices::{ResponseUsage, response_cost};
use relay_gateway::overflow::{
    deepseek_peak, local_day_bounds, overflow_cost, overflow_model, overflow_preset, spent_today,
};
use relay_gateway::overflow_upstream::{
    OpenRouterPrices, OpenRouterPricesOptions, overflow_headers, parse_open_router_models,
    test_overflow_upstream,
};
use relay_gateway::proxy_request_log::{GatewayRequestLog, RequestLogOptions};
use relay_gateway::proxy_status::{overflow_url_allowed, parse_proxy_extras};
use relay_gateway::{
    Account, ApiUpstream, ApiUpstreamAuth, ApiUpstreamPreset, OverflowRates, OverflowSettings,
    OverflowTrigger, ProxyConfig, ProxyRequestLog, ServerOptions, TokenTally, Upstreams, UsageMap,
    UserPrices,
};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

const KEY: &str = "sk-test-overflow-key-0000-alto";

fn vertex(id: &str) -> Account {
    named(id, &format!("Vertex {id}"))
}

fn full(id: &str, now: i64) -> relay_gateway::AccountUsage {
    ready(
        id,
        Some(window(100.0, Some(iso(now + 2 * 3_600_000)))),
        Some(window(40.0, None)),
    )
}

fn message(model: &str, usage: Value) -> String {
    json!({
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": [{ "type": "text", "text": "Hi" }],
        "usage": usage,
    })
    .to_string()
}

fn default_usage() -> Value {
    json!({ "input_tokens": 1_000, "output_tokens": 200 })
}

fn upstream(preset: ApiUpstreamPreset, base_url: &str) -> ApiUpstream {
    let defaults = overflow_preset(preset);
    let id = serde_json::to_value(preset)
        .unwrap()
        .as_str()
        .unwrap()
        .to_string();
    ApiUpstream {
        id: format!("up-{id}"),
        label: format!("Alto {id}"),
        preset,
        base_url: base_url.into(),
        auth_style: defaults.auth_style,
        model_map: defaults.model_map,
        enabled: true,
        order: 0.0,
        prices: None,
    }
}

fn settings(upstreams: Vec<ApiUpstream>) -> OverflowSettings {
    OverflowSettings {
        enabled: true,
        trigger: None,
        daily_cap_usd: Some(5.0),
        upstreams: upstreams
            .into_iter()
            .enumerate()
            .map(|(order, mut u)| {
                u.order = order as f64;
                u
            })
            .collect(),
    }
}

struct Pool {
    gateway: Gateway,
    subscription: FakeUpstream,
}

impl Pool {
    async fn close(&self) {
        self.gateway.stop().await;
        self.subscription.close().await;
    }
}

type SubscriptionReply =
    Box<dyn Fn(&Seen) -> http::Response<relay_gateway::client_res::ResponseBody> + Send + Sync>;

#[derive(Default)]
struct PoolOptions {
    limited: bool,
    overflow: Option<OverflowSettings>,
    subscription: Option<SubscriptionReply>,
    request_log: Option<GatewayRequestLog>,
    now: Option<i64>,
    accounts: Option<Vec<Account>>,
}

/// A gateway with one Claude account (limited or not), the subscription upstream and the
/// overflow given.
async fn gateway(options: PoolOptions) -> Pool {
    let subscription = match options.subscription {
        Some(reply) => FakeUpstream::sync(reply).await,
        None => {
            FakeUpstream::sync(|_| {
                json_reply(200, &message("claude-sonnet-5-5", default_usage()), &[])
            })
            .await
        }
    };
    let accounts = options.accounts.unwrap_or_else(|| vec![vertex("a")]);
    let mut usage = UsageMap::new();
    if options.limited {
        usage.insert("a".into(), full("a", options.now.unwrap_or_else(now_ms)));
    }
    let mut hooks = Hooks::new(accounts).token("tok-subscription").usage(usage);
    hooks.overflow_key = Some(KEY.into());
    hooks.time_zone = Some("UTC".into());
    if let Some(log) = options.request_log {
        hooks = hooks.with_log(log);
    }
    let config = ProxyConfig {
        overflow: options.overflow,
        ..config()
    };
    let gateway = Gateway::start_with(
        config,
        hooks,
        Upstreams {
            anthropic_url: Some(subscription.url.clone()),
            ..Default::default()
        },
        ServerOptions {
            now: options.now.map(fixed),
            ..Default::default()
        },
    )
    .await;
    Pool {
        gateway,
        subscription,
    }
}

async fn post(port: u16, body: Value, extra: &[(&str, &str)], path: &str) -> Answer {
    let mut pairs = vec![
        ("content-type", "application/json"),
        ("anthropic-version", "2023-06-01"),
    ];
    pairs.extend_from_slice(extra);
    request(port, "POST", path, &pairs, &body.to_string()).await
}

async fn post_messages(port: u16, body: Value) -> Answer {
    post(port, body, &[], "/v1/messages").await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn overflow_takes_a_request_only_when_every_subscription_account_is_limited() {
    let api = FakeUpstream::sync(|_| {
        json_reply(200, &message("claude-sonnet-5-5", default_usage()), &[])
    })
    .await;
    let overflow = settings(vec![upstream(ApiUpstreamPreset::Anthropic, &api.url)]);
    let free = gateway(PoolOptions {
        overflow: Some(overflow.clone()),
        ..Default::default()
    })
    .await;
    let answer = post_messages(
        free.gateway.port,
        json!({ "model": "claude-sonnet-5-5", "max_tokens": 10, "messages": [] }),
    )
    .await;
    assert_eq!(answer.status, 200);
    assert_eq!(free.subscription.count(), 1, "a free account answers");
    assert_eq!(
        api.count(),
        0,
        "overflow is not used while an account has room"
    );
    free.close().await;

    let limited = gateway(PoolOptions {
        limited: true,
        overflow: Some(overflow),
        ..Default::default()
    })
    .await;
    let answer = post_messages(
        limited.gateway.port,
        json!({ "model": "claude-sonnet-5-5", "max_tokens": 10, "messages": [] }),
    )
    .await;
    assert_eq!(answer.status, 200);
    assert_eq!(
        limited.subscription.count(),
        0,
        "a full account is not tried"
    );
    assert_eq!(api.count(), 1, "the API key answers");
    limited.gateway.idle().await;
    let entry = limited.gateway.recent().remove(0);
    assert_eq!(entry.upstream.as_deref(), Some("Alto anthropic"));
    assert_eq!(
        entry.pick.unwrap().reason,
        relay_gateway::ProxyPickReason::Overflow
    );
    assert_eq!(entry.account_id, None);
    limited.close().await;
    api.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn with_overflow_off_or_disabled_upstreams_an_all_limited_pool_still_answers_429() {
    let api = FakeUpstream::sync(|_| json_reply(200, &message("x", default_usage()), &[])).await;
    let mut off = settings(vec![upstream(ApiUpstreamPreset::Anthropic, &api.url)]);
    off.enabled = false;
    let mut disabled_upstream = upstream(ApiUpstreamPreset::Anthropic, &api.url);
    disabled_upstream.enabled = false;
    for overflow in [off, settings(vec![disabled_upstream])] {
        let pool = gateway(PoolOptions {
            limited: true,
            overflow: Some(overflow),
            ..Default::default()
        })
        .await;
        let answer = post_messages(
            pool.gateway.port,
            json!({ "model": "claude-sonnet-5-5", "messages": [] }),
        )
        .await;
        assert_eq!(answer.status, 429);
        assert_eq!(answer.json()["error"]["type"], "rate_limit_error");
        pool.close().await;
    }
    assert_eq!(api.count(), 0);
    api.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_limit_met_live_on_the_only_account_overflows_and_the_account_cools_down() {
    let api =
        FakeUpstream::sync(|_| json_reply(200, &message("claude-opus-5-5", default_usage()), &[]))
            .await;
    let pool = gateway(PoolOptions {
        overflow: Some(settings(vec![upstream(
            ApiUpstreamPreset::Anthropic,
            &api.url,
        )])),
        subscription: Some(Box::new(|_| {
            json_reply(
                429,
                &error_body("rate_limit_error", "limit"),
                &[
                    ("retry-after", "600"),
                    ("anthropic-ratelimit-unified-status", "rejected"),
                    ("anthropic-ratelimit-unified-5h-status", "rejected"),
                ],
            )
        })),
        ..Default::default()
    })
    .await;
    let answer = post_messages(
        pool.gateway.port,
        json!({ "model": "claude-opus-5-5", "messages": [] }),
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.body);
    assert_eq!(pool.subscription.count(), 1);
    assert_eq!(api.count(), 1);
    assert_eq!(
        pool.gateway
            .server
            .router()
            .cooldown_of("a")
            .map(|c| c.reason),
        Some(relay_gateway::proxy_router::CooldownReason::Limit)
    );
    pool.gateway.idle().await;
    let recent = pool.gateway.recent();
    let (served, held) = (&recent[0], &recent[1]);
    assert_eq!(
        served.pick.as_ref().unwrap().after.as_deref(),
        Some("a"),
        "the log says which account was held first"
    );
    assert_eq!(held.account_id.as_deref(), Some("a"));
    pool.close().await;
    api.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_model_is_rewritten_by_family_and_the_key_goes_in_the_presets_header() {
    let api = FakeUpstream::sync(|_| json_reply(200, &message("x", default_usage()), &[])).await;
    let pool = gateway(PoolOptions {
        limited: true,
        overflow: Some(settings(vec![upstream(
            ApiUpstreamPreset::DeepSeek,
            &format!("{}/anthropic", api.url),
        )])),
        ..Default::default()
    })
    .await;
    for (asked, sent) in [
        ("claude-opus-5-5", "deepseek-v4-pro"),
        ("claude-sonnet-5-5[1m]", "deepseek-flash"),
        ("claude-haiku-5-5-20260101", "deepseek-flash"),
        ("claude-fable-5-2", "deepseek-flash"),
    ] {
        post(
            pool.gateway.port,
            json!({ "model": asked, "max_tokens": 5, "messages": [{ "role": "user", "content": "x" }] }),
            &[
                ("authorization", "Bearer relay-client"),
                ("anthropic-beta", "oauth-2025-04-20,claude-code-20250219"),
                ("x-claude-code-session-id", "s-1"),
            ],
            "/v1/messages",
        )
        .await;
        let last = api.seen().pop().unwrap();
        assert_eq!(last.url, "/anthropic/v1/messages");
        let body: Value = serde_json::from_str(&last.body).unwrap();
        assert_eq!(body["model"], sent, "{asked}");
        assert_eq!(body["max_tokens"], 5, "the rest of the body is kept");
        assert_eq!(last.header("x-api-key"), Some(KEY));
        assert_eq!(
            last.header("authorization"),
            None,
            "the client's key never goes upstream"
        );
        assert_eq!(
            last.header("anthropic-beta"),
            None,
            "third parties get no betas"
        );
        assert_eq!(last.header("x-claude-code-session-id"), None);
    }
    pool.close().await;
    api.close().await;
}

#[test]
fn each_preset_sends_its_key_as_it_should_and_anthropic_keeps_all_betas_but_oauths() {
    let source = headers(&[
        ("anthropic-beta", "oauth-2025-04-20, context-1m-2025-08-07"),
        ("content-type", "application/json"),
    ]);
    let anthropic = overflow_headers(
        &source,
        ApiUpstreamPreset::Anthropic,
        ApiUpstreamAuth::XApiKey,
        KEY,
    );
    let get = |h: &http::HeaderMap, n: &str| h.get(n).map(|v| v.to_str().unwrap().to_string());
    assert_eq!(get(&anthropic, "x-api-key").as_deref(), Some(KEY));
    assert_eq!(
        get(&anthropic, "anthropic-beta").as_deref(),
        Some("context-1m-2025-08-07")
    );
    assert_eq!(
        get(&anthropic, "anthropic-version").as_deref(),
        Some("2023-06-01")
    );
    for preset in [
        ApiUpstreamPreset::OpenRouter,
        ApiUpstreamPreset::Kimi,
        ApiUpstreamPreset::KimiCn,
        ApiUpstreamPreset::Glm,
        ApiUpstreamPreset::GlmCn,
    ] {
        let headers = overflow_headers(&source, preset, overflow_preset(preset).auth_style, KEY);
        assert_eq!(
            get(&headers, "authorization"),
            Some(format!("Bearer {KEY}")),
            "{preset:?}"
        );
        assert_eq!(get(&headers, "x-api-key"), None, "{preset:?}");
        assert_eq!(get(&headers, "anthropic-beta"), None, "{preset:?}");
    }
    let map = |preset| overflow_preset(preset).model_map;
    assert_eq!(
        overflow_model(&map(ApiUpstreamPreset::OpenRouter), "claude-opus-5-5"),
        "anthropic/claude-opus-5.5"
    );
    assert_eq!(
        overflow_model(&map(ApiUpstreamPreset::Kimi), "claude-haiku-5-5"),
        "kimi-k3"
    );
    assert_eq!(
        overflow_model(&map(ApiUpstreamPreset::Glm), "claude-sonnet-5-5"),
        "glm-5.4"
    );
    assert_eq!(
        overflow_model(&map(ApiUpstreamPreset::Anthropic), "claude-opus-5-5[1m]"),
        "claude-opus-5-5"
    );
    let all: Vec<String> = relay_gateway::OVERFLOW_PRESET_IDS
        .iter()
        .map(|p| format!("{:?}", overflow_preset(*p)))
        .collect();
    assert!(!all.join(" ").contains("k2"), "no preset targets Kimi K2");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_sse_answer_streams_through_unchanged_and_is_priced_from_its_final_usage() {
    let mut start: Value = serde_json::from_str(&message(
        "deepseek-flash",
        json!({ "input_tokens": 2_000_000, "output_tokens": 1 }),
    ))
    .unwrap();
    start = json!({ "type": "message_start", "message": start });
    let events = [
        format!("event: message_start\ndata: {start}\n\n"),
        format!(
            "event: content_block_delta\ndata: {}\n\n",
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "Hi" } })
        ),
        format!(
            "event: message_delta\ndata: {}\n\n",
            json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "input_tokens": 2_000_000, "output_tokens": 1_000_000, "cache_read_input_tokens": 0 } })
        ),
        format!(
            "event: message_stop\ndata: {}\n\n",
            json!({ "type": "message_stop" })
        ),
    ];
    let parts: Vec<(u64, String)> = events.iter().map(|e| (0, e.clone())).collect();
    let api = FakeUpstream::sync(move |_| sse(parts.clone(), true)).await;
    // A Saturday: DeepSeek's off-peak price all day.
    let at = parse("2026-11-21T12:00:00Z");
    let pool = gateway(PoolOptions {
        limited: true,
        now: Some(at),
        overflow: Some(settings(vec![upstream(
            ApiUpstreamPreset::DeepSeek,
            &format!("{}/anthropic", api.url),
        )])),
        ..Default::default()
    })
    .await;
    let answer = post_messages(
        pool.gateway.port,
        json!({ "model": "claude-sonnet-5-5", "stream": true, "messages": [] }),
    )
    .await;
    assert_eq!(answer.status, 200);
    assert_eq!(answer.header("content-type"), Some("text/event-stream"));
    assert_eq!(
        answer.body,
        events.join(""),
        "the stream reaches the client byte for byte"
    );
    pool.gateway.idle().await;
    let entry = pool.gateway.recent().remove(0);
    assert_eq!(entry.model.as_deref(), Some("deepseek-flash"));
    assert_eq!(
        entry.tokens,
        Some(TokenTally {
            input: Some(2_000_000.0),
            output: Some(1_000_000.0),
            cache_read: Some(0.0),
            ..Default::default()
        })
    );
    // 2M input at $0.15 and 1M output at $0.60.
    assert_eq!(entry.cost, Some(0.9));
    assert_eq!(pool.gateway.server.overflow_spent_today(), 0.9);
    pool.close().await;
    api.close().await;
}

#[test]
fn costs_anthropic_list_prices_preset_tables_with_deepseeks_peak_user_prices_else_unknown() {
    let tokens = TokenTally {
        input: Some(1_000_000.0),
        output: Some(1_000_000.0),
        ..Default::default()
    };
    let off_peak = parse("2026-11-21T12:00:00Z");
    let peak = parse("2026-11-23T02:00:00Z");
    assert!(!deepseek_peak(off_peak));
    assert!(deepseek_peak(peak));
    use ApiUpstreamPreset::*;
    assert_eq!(
        overflow_cost(
            Anthropic,
            None,
            "claude-sonnet-5-5",
            &tokens,
            off_peak,
            None
        ),
        response_cost(
            "claude-sonnet-5-5",
            &ResponseUsage {
                input: 1_000_000.0,
                output: 1_000_000.0,
                ..Default::default()
            }
        )
    );
    assert_eq!(
        overflow_cost(DeepSeek, None, "deepseek-v4-pro", &tokens, off_peak, None),
        Some(0.66 + 1.98)
    );
    assert_eq!(
        overflow_cost(DeepSeek, None, "deepseek-v4-pro", &tokens, peak, None),
        Some((0.66 + 1.98) * 2.0)
    );
    assert_eq!(
        overflow_cost(Glm, None, "glm-5.3-flash", &tokens, off_peak, None),
        Some(0.15 + 0.5)
    );
    assert_eq!(
        overflow_cost(Kimi, None, "kimi-k3", &tokens, off_peak, None),
        None,
        "Kimi has no table"
    );
    assert_eq!(
        overflow_cost(
            Kimi,
            Some(UserPrices {
                input: 1.0,
                output: 4.0
            }),
            "kimi-k3",
            &tokens,
            off_peak,
            None
        ),
        Some(5.0)
    );
    assert_eq!(
        overflow_cost(
            OpenRouter,
            None,
            "anthropic/claude-opus-5.5",
            &TokenTally {
                input: Some(1_000_000.0),
                cache_read: Some(1_000_000.0),
                ..Default::default()
            },
            off_peak,
            Some(OverflowRates {
                input: 5.0,
                output: 25.0,
                cache_read: Some(0.5),
                cache_write: None,
            }),
        ),
        Some(5.5)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_answer_with_no_known_price_is_logged_as_unpriced_and_does_not_count_toward_the_cap() {
    let api =
        FakeUpstream::sync(|_| json_reply(200, &message("kimi-k3.1-pro", default_usage()), &[]))
            .await;
    let pool = gateway(PoolOptions {
        limited: true,
        overflow: Some(settings(vec![upstream(ApiUpstreamPreset::Kimi, &api.url)])),
        ..Default::default()
    })
    .await;
    post_messages(
        pool.gateway.port,
        json!({ "model": "claude-sonnet-5-5", "messages": [] }),
    )
    .await;
    pool.gateway.idle().await;
    let entry = pool.gateway.recent().remove(0);
    assert_eq!(entry.note.as_deref(), Some("unpriced"));
    assert_eq!(entry.cost, None);
    assert_eq!(
        api.seen()[0].header("authorization").map(str::to_string),
        Some(format!("Bearer {KEY}"))
    );
    assert_eq!(pool.gateway.server.overflow_spent_today(), 0.0);
    pool.close().await;
    api.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn past_the_daily_cap_overflow_answers_429_with_anthropics_error_shape_until_the_day_ends() {
    let api = FakeUpstream::sync(|_| {
        json_reply(
            200,
            &message(
                "claude-opus-5-5",
                json!({ "input_tokens": 1_000_000, "output_tokens": 0 }),
            ),
            &[],
        )
    })
    .await;
    let at = parse("2026-11-23T20:00:00Z");
    let mut overflow = settings(vec![upstream(ApiUpstreamPreset::Anthropic, &api.url)]);
    overflow.daily_cap_usd = Some(1.0);
    let pool = gateway(PoolOptions {
        limited: true,
        now: Some(at),
        overflow: Some(overflow),
        ..Default::default()
    })
    .await;
    let first = post_messages(
        pool.gateway.port,
        json!({ "model": "claude-opus-5-5", "messages": [] }),
    )
    .await;
    assert_eq!(first.status, 200);
    pool.gateway.idle().await;
    assert!(
        pool.gateway.server.overflow_spent_today() >= 1.0,
        "one request spent the cap"
    );
    let second = post_messages(
        pool.gateway.port,
        json!({ "model": "claude-opus-5-5", "messages": [] }),
    )
    .await;
    assert_eq!(second.status, 429);
    assert_eq!(
        second.json(),
        json!({ "type": "error", "error": { "type": "rate_limit_error", "message": "Relay overflow daily cap of $1 reached" } })
    );
    assert_eq!(
        second.header("retry-after"),
        Some("14400"),
        "until midnight in the planning zone (UTC)"
    );
    assert_eq!(api.count(), 1, "nothing more is sent past the cap");
    pool.gateway.idle().await;
    assert_eq!(
        pool.gateway.recent()[0].note.as_deref(),
        Some("overflow-cap")
    );
    pool.close().await;
    api.close().await;
}

#[test]
fn the_caps_spend_survives_a_restart_through_the_request_log_by_planning_day() {
    let dir = tempfile::tempdir().unwrap();
    let now = parse("2026-11-23T10:00:00Z");
    let file = dir.path().join("gateway-requests.jsonl");
    let options = || RequestLogOptions {
        now: Some(fixed(now)),
        feed_size: None,
    };
    let mut first = GatewayRequestLog::new(&file, options());
    first.load();
    let entry =
        |at: i64, upstream: Option<&str>, account: Option<&str>, cost: f64, tokens: bool| {
            ProxyRequestLog {
                at,
                status: 200,
                upstream: upstream.map(Into::into),
                account_id: account.map(Into::into),
                cost: Some(cost),
                tokens: tokens.then_some(TokenTally {
                    input: Some(1.0),
                    ..Default::default()
                }),
                ..Default::default()
            }
        };
    first.record(&entry(now - 3_600_000, Some("Alto"), None, 0.75, true));
    first.record(&entry(now - 30 * 3_600_000, Some("Alto"), None, 2.0, false));
    first.record(&entry(now - 60_000, None, Some("a"), 9.0, true));
    let mut again = GatewayRequestLog::new(&file, options());
    again.load();
    assert_eq!(spent_today(&again.overflow_costs(), now, "UTC"), 0.75);
    // In Tokyo (UTC+9) 10:00 UTC is 19:00 and yesterday 04:00 UTC was 13:00 the day before.
    assert_eq!(
        spent_today(&again.overflow_costs(), now, "Asia/Tokyo"),
        0.75
    );
    // In Honolulu (UTC-10) it is 00:00 now: an hour ago was yesterday.
    assert_eq!(
        spent_today(&again.overflow_costs(), now, "Pacific/Honolulu"),
        0.0
    );
    let (start, end) = local_day_bounds(now, "Europe/Istanbul");
    assert_eq!(start, parse("2026-11-22T21:00:00Z"));
    assert_eq!(end, parse("2026-11-23T21:00:00Z"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_key_hands_the_request_to_the_next_upstream_the_account_is_never_touched() {
    let refusing = FakeUpstream::sync(|_| {
        json_reply(
            401,
            &error_body("authentication_error", "invalid x-api-key"),
            &[],
        )
    })
    .await;
    let working =
        FakeUpstream::sync(|_| json_reply(200, &message("x", default_usage()), &[])).await;
    let mut one = upstream(ApiUpstreamPreset::Anthropic, &refusing.url);
    one.id = "one".into();
    let mut two = upstream(ApiUpstreamPreset::Glm, &working.url);
    two.id = "two".into();
    let pool = gateway(PoolOptions {
        limited: true,
        overflow: Some(settings(vec![one, two])),
        ..Default::default()
    })
    .await;
    let answer = post_messages(
        pool.gateway.port,
        json!({ "model": "claude-haiku-5-5", "messages": [] }),
    )
    .await;
    assert_eq!(answer.status, 200);
    assert_eq!(refusing.count(), 1);
    let body: Value = serde_json::from_str(&working.seen()[0].body).unwrap();
    assert_eq!(body["model"], "glm-5.3-flash");
    pool.gateway.idle().await;
    let recent = pool.gateway.recent();
    let (served, held) = (&recent[0], &recent[1]);
    assert_eq!(held.failover, Some(true));
    assert_eq!(held.error.as_deref(), Some("invalid x-api-key"));
    assert_eq!(served.upstream.as_deref(), Some("Alto glm"));
    assert_eq!(
        pool.gateway.server.router().cooldown_of("a"),
        None,
        "an upstream's answer says nothing about the account"
    );
    pool.close().await;
    refusing.close().await;
    working.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unavailable_also_overflows_a_pool_with_no_claude_account_limited_does_not() {
    let api = FakeUpstream::sync(|_| json_reply(200, &message("x", default_usage()), &[])).await;
    for trigger in [OverflowTrigger::Limited, OverflowTrigger::Unavailable] {
        let mut overflow = settings(vec![upstream(ApiUpstreamPreset::Anthropic, &api.url)]);
        overflow.trigger = Some(trigger);
        let pool = gateway(PoolOptions {
            accounts: Some(vec![]),
            overflow: Some(overflow),
            ..Default::default()
        })
        .await;
        let answer = post_messages(
            pool.gateway.port,
            json!({ "model": "claude-sonnet-5-5", "messages": [] }),
        )
        .await;
        assert_eq!(
            answer.status,
            if trigger == OverflowTrigger::Unavailable {
                200
            } else {
                503
            },
            "{trigger:?}"
        );
        pool.close().await;
    }
    assert_eq!(api.count(), 1);
    api.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn codex_routes_never_overflow_and_token_counting_is_not_a_gateway_path() {
    let api = FakeUpstream::sync(|_| json_reply(200, &message("x", default_usage()), &[])).await;
    let mut overflow = settings(vec![upstream(ApiUpstreamPreset::Anthropic, &api.url)]);
    overflow.trigger = Some(OverflowTrigger::Unavailable);
    let pool = gateway(PoolOptions {
        limited: true,
        overflow: Some(overflow),
        ..Default::default()
    })
    .await;
    let responses = post(
        pool.gateway.port,
        json!({ "model": "gpt-5-codex", "input": "x" }),
        &[],
        "/v1/responses",
    )
    .await;
    assert_eq!(responses.status, 503);
    let count = post(
        pool.gateway.port,
        json!({ "model": "claude-sonnet-5-5", "messages": [] }),
        &[],
        "/v1/messages/count_tokens",
    )
    .await;
    assert_eq!(count.status, 404);
    assert_eq!(api.count(), 0);
    pool.close().await;
    api.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_key_is_never_in_the_gateways_feed_metrics_or_log_file() {
    let dir = tempfile::tempdir().unwrap();
    let api = FakeUpstream::sync(|_| {
        json_reply(400, &error_body("invalid_request_error", "bad model"), &[])
    })
    .await;
    let file = dir.path().join("gateway-requests.jsonl");
    let mut log = GatewayRequestLog::new(&file, RequestLogOptions::default());
    log.load();
    let pool = gateway(PoolOptions {
        limited: true,
        overflow: Some(settings(vec![upstream(
            ApiUpstreamPreset::Anthropic,
            &api.url,
        )])),
        request_log: Some(log),
        ..Default::default()
    })
    .await;
    post_messages(
        pool.gateway.port,
        json!({ "model": "claude-sonnet-5-5", "messages": [] }),
    )
    .await;
    pool.gateway.idle().await;
    let seen =
        serde_json::to_string(&(pool.gateway.recent(), pool.gateway.server.metrics())).unwrap();
    assert!(!seen.contains(KEY));
    assert!(!std::fs::read_to_string(&file).unwrap().contains(KEY));
    pool.close().await;
    api.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_test_buttons_request_one_token_the_right_model_the_upstreams_own_error() {
    let api = FakeUpstream::sync(|seen| {
        if seen.header("x-api-key") == Some(KEY) {
            json_reply(200, &message("claude-haiku-5-5", default_usage()), &[])
        } else {
            json_reply(
                401,
                &error_body("authentication_error", "invalid x-api-key"),
                &[],
            )
        }
    })
    .await;
    let target = upstream(ApiUpstreamPreset::Anthropic, &api.url);
    let ok = test_overflow_upstream(&target, KEY).await;
    assert_eq!(
        serde_json::to_value(&ok).unwrap(),
        json!({ "ok": true, "model": "claude-haiku-5-5", "status": 200 })
    );
    let body: Value = serde_json::from_str(&api.seen()[0].body).unwrap();
    assert_eq!(body["max_tokens"], 1);
    let refused = test_overflow_upstream(&target, "sk-wrong-key-000").await;
    assert!(!refused.ok);
    assert_eq!(refused.status, Some(401));
    assert_eq!(refused.message.as_deref(), Some("invalid x-api-key"));
    assert!(
        !serde_json::to_string(&refused)
            .unwrap()
            .contains("sk-wrong")
    );
    api.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn openrouter_prices_are_read_at_most_once_a_day_and_kept_on_disk() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let models = FakeUpstream::sync(move |_| {
        counter.fetch_add(1, Ordering::SeqCst);
        json_reply(
            200,
            &json!({
                "data": [{
                    "id": "anthropic/claude-opus-5.5",
                    "pricing": { "prompt": "0.000005", "completion": "0.000025", "input_cache_read": "0.0000005" },
                }],
            })
            .to_string(),
            &[],
        )
    })
    .await;
    let clock = TestClock::new(parse("2026-11-23T10:00:00Z"));
    let file = dir.path().join("openrouter-prices.json");
    let options = || OpenRouterPricesOptions {
        file: Some(file.clone()),
        url: Some(format!("{}/api/v1/models", models.url)),
        now: Some(clock.clock()),
    };
    let prices = OpenRouterPrices::new(options());
    let rate = prices.rate("anthropic/claude-opus-5.5").await.unwrap();
    assert!((rate.input - 5.0).abs() < 1e-9 && (rate.output - 25.0).abs() < 1e-9);
    prices.rate("anthropic/claude-opus-5.5").await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let reopened = OpenRouterPrices::new(options());
    assert!(reopened.rate("anthropic/claude-opus-5.5").await.is_some());
    assert_eq!(calls.load(Ordering::SeqCst), 1, "the kept prices are used");
    clock.advance(25 * 3_600_000);
    reopened.rate("anthropic/claude-opus-5.5").await;
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "a day later they are read again"
    );
    assert_eq!(
        parse_open_router_models(
            &json!({ "data": [{ "id": "x", "pricing": { "prompt": "-1", "completion": "0" } }] })
        )
        .len(),
        0
    );
    models.close().await;
}

#[test]
fn saved_overflow_upstreams_https_only_http_on_this_computer_and_a_bad_one_never_costs_the_pool_order()
 {
    assert!(overflow_url_allowed("https://api.example.com/anthropic"));
    assert!(overflow_url_allowed("http://127.0.0.1:4000"));
    assert!(!overflow_url_allowed("http://example.com"));
    assert!(!overflow_url_allowed("https://user:pw@example.com"));
    assert!(!overflow_url_allowed("https://example.com/?key=1"));
    let extras = parse_proxy_extras(&json!({
        "accountOrder": ["b", "a"],
        "overflow": { "enabled": true, "upstreams": [{ "id": "x", "baseUrl": "ftp://nope" }] },
    }))
    .unwrap();
    assert_eq!(
        extras.account_order,
        Some(vec!["b".to_string(), "a".to_string()])
    );
    assert_eq!(extras.overflow, None);
    let kept = parse_proxy_extras(&json!({
        "overflow": serde_json::to_value(settings(vec![upstream(ApiUpstreamPreset::DeepSeek, "https://api.deepseek.com/anthropic")])).unwrap(),
    }))
    .unwrap();
    assert_eq!(
        kept.overflow.unwrap().upstreams[0].preset,
        ApiUpstreamPreset::DeepSeek
    );
}
