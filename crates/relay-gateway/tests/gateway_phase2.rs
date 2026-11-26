//! Port of tests/gateway-phase2.test.ts (the gateway's cases; see the skipped list in the
//! crate's report for the ones about relay-core and the UI).

mod common;

use common::*;
use relay_gateway::proxy_request_log::{GatewayRequestLog, RequestLogOptions, clean_entry};
use relay_gateway::proxy_stats::ProxyStats;
use relay_gateway::upstream_common::{FailureKind, classify_failure, parse_live_limits};
use relay_gateway::{LiveLimits, LiveWindow, RoutingStrategy, TokenTally, Upstreams, client_of};
use serde_json::json;

/// The rate-limit headers of a real answer through the gateway (2026-11-13).
const ALLOWED: [(&str, &str); 12] = [
    ("anthropic-ratelimit-unified-5h-reset", "1794582600"),
    ("anthropic-ratelimit-unified-5h-status", "allowed"),
    ("anthropic-ratelimit-unified-5h-utilization", "0.0"),
    ("anthropic-ratelimit-unified-7d-reset", "1795060800"),
    ("anthropic-ratelimit-unified-7d-status", "allowed"),
    ("anthropic-ratelimit-unified-7d-utilization", "0.28"),
    ("anthropic-ratelimit-unified-fallback-percentage", "0.5"),
    (
        "anthropic-ratelimit-unified-overage-disabled-reason",
        "org_level_disabled",
    ),
    ("anthropic-ratelimit-unified-overage-status", "rejected"),
    (
        "anthropic-ratelimit-unified-representative-claim",
        "five_hour",
    ),
    ("anthropic-ratelimit-unified-reset", "1794582600"),
    ("anthropic-ratelimit-unified-status", "allowed"),
];

fn with(extra: &[(&'static str, &'static str)]) -> Vec<(&'static str, &'static str)> {
    let mut pairs: Vec<(&str, &str)> = extra.to_vec();
    pairs.extend_from_slice(&ALLOWED);
    pairs
}

/// Headers where the later pairs override the earlier ones, as an object spread does.
fn spread(pairs: &[(&str, &str)]) -> http::HeaderMap {
    let mut map = http::HeaderMap::new();
    for (name, value) in pairs {
        map.insert(
            http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
            http::HeaderValue::from_str(value).unwrap(),
        );
    }
    map
}

#[test]
fn an_answers_windows_are_read_as_percents_with_their_resets() {
    assert_eq!(
        parse_live_limits(&headers(&ALLOWED)),
        Some(LiveLimits {
            five_hour: Some(LiveWindow {
                used_percent: 0.0,
                resets_at: Some(iso(1_794_582_600_000))
            }),
            seven_day: Some(LiveWindow {
                used_percent: 28.0,
                resets_at: Some(iso(1_795_060_800_000))
            }),
            models: None,
        })
    );
    assert_eq!(
        parse_live_limits(&headers(&[("content-type", "application/json")])),
        None
    );
    assert_eq!(
        parse_live_limits(&headers(&[(
            "anthropic-ratelimit-unified-5h-utilization",
            "lots"
        )])),
        None
    );
    assert_eq!(
        parse_live_limits(&headers(&[(
            "anthropic-ratelimit-unified-5h-utilization",
            "1.2"
        )])),
        Some(LiveLimits {
            five_hour: Some(LiveWindow {
                used_percent: 100.0,
                resets_at: None
            }),
            ..Default::default()
        })
    );
    assert_eq!(
        parse_live_limits(&headers(&[(
            "anthropic-ratelimit-unified-7d-utilization",
            "0.973"
        )])),
        Some(LiveLimits {
            seven_day: Some(LiveWindow {
                used_percent: 97.3,
                resets_at: None
            }),
            ..Default::default()
        })
    );
}

#[test]
fn a_429_is_a_limit_when_a_window_says_so_or_its_message_names_a_limit_anthropics_bare_refusal_is_not()
 {
    let body = |kind: &str, message: &str| Some(error_body(kind, message));
    let classify = |h: &http::HeaderMap, b: Option<String>| classify_failure(429, h, b.as_deref());
    let json = [("content-type", "application/json")];
    // What Anthropic answers a request that does not come from Claude Code (2026-11-13): no
    // rate-limit header at all, no Retry-After, the message "Error".
    let bare = spread(&[
        ("content-type", "application/json"),
        ("x-should-retry", "true"),
    ]);
    assert_eq!(
        classify(&bare, body("rate_limit_error", "Error")),
        Some(FailureKind::Refused)
    );
    let allowed = spread(&with(&json));
    assert_eq!(
        classify(&allowed, body("rate_limit_error", "Error")),
        Some(FailureKind::Refused)
    );
    // A spent window says so: a limit, whatever the message.
    let mut spent = with(&json);
    spent.push(("anthropic-ratelimit-unified-5h-status", "rejected"));
    assert_eq!(
        classify(&spread(&spent), body("rate_limit_error", "Error")),
        Some(FailureKind::Limit)
    );
    let mut overall = with(&json);
    overall.push(("anthropic-ratelimit-unified-status", "rejected"));
    assert_eq!(
        classify(&spread(&overall), body("rate_limit_error", "Error")),
        Some(FailureKind::Limit)
    );
    // Without a message it may be a short limit: wait out its Retry-After, as before.
    assert_eq!(
        classify(&allowed, Some("{}".into())),
        Some(FailureKind::Limit)
    );
    assert_eq!(classify(&bare, None), Some(FailureKind::Limit));
    // A Retry-After asks for a wait: honoured as a limit.
    let retry = spread(&[
        ("content-type", "application/json"),
        ("x-should-retry", "true"),
        ("retry-after", "42"),
    ]);
    assert_eq!(
        classify(&retry, body("rate_limit_error", "slow down")),
        Some(FailureKind::Limit)
    );
    // A message about a limit: another account may take the request.
    for message in [
        "Number of requests has exceeded your rate limit",
        "This request would exceed your account's rate limit. Please try again later.",
        "You've hit your weekly limit",
    ] {
        assert_eq!(
            classify(&bare, body("rate_limit_error", message)),
            Some(FailureKind::Limit),
            "{message}"
        );
    }
    assert_eq!(
        classify(
            &allowed,
            body(
                "rate_limit_error",
                "Extra usage is required for long context requests."
            )
        ),
        Some(FailureKind::ExtraUsage)
    );
}

#[test]
fn the_client_is_told_apart_by_its_user_agent() {
    let of = |agent: &str| client_of(&headers(&[("user-agent", agent)]));
    assert_eq!(
        of("claude-cli/2.1.322 (external, cli)").as_deref(),
        Some("claude-code")
    );
    assert_eq!(
        of("claude-cli/2.1.322 (external, sdk-cli)").as_deref(),
        Some("claude-code")
    );
    assert_eq!(
        of("claude-cli/2.1.322 (external, sdk-ts, agent-sdk/0.2.1)").as_deref(),
        Some("agent-sdk")
    );
    assert_eq!(
        of("codex_cli_rs/0.80.0 (Mac OS 26.5.0; arm64)").as_deref(),
        Some("codex")
    );
    assert_eq!(of("curl/8.7.1").as_deref(), Some("curl"));
    assert_eq!(client_of(&headers(&[])), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn each_answer_reports_its_windows_and_request_id_as_its_headers_arrive_and_the_log_keeps_who_asked_how_long_and_the_tokens()
 {
    let upstream = FakeUpstream::sync(|_| {
        let mut extra = vec![("content-type", "text/event-stream"), ("request-id", "req_011CgzTest")];
        extra.extend_from_slice(&ALLOWED);
        stream_reply(
            200,
            &extra,
            vec![
                (0, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":3,\"cache_read_input_tokens\":900,\"cache_creation_input_tokens\":40,\"output_tokens\":1}}}\n\n".into()),
                (0, "event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":7}}\n\n".into()),
            ],
            true,
            None,
        )
    })
    .await;
    let gateway = Gateway::start(
        config(),
        Hooks::new(vec![account("a")]).token("tok"),
        Upstreams {
            anthropic_url: Some(upstream.url.clone()),
            ..Default::default()
        },
    )
    .await;
    let answer = gateway
        .post(
            "/v1/messages",
            &[
                ("user-agent", "claude-cli/2.1.322 (external, cli)"),
                ("x-claude-code-request-class", "subagent"),
            ],
            "{}",
        )
        .await;
    assert_eq!(answer.status, 200);
    gateway.idle().await;
    assert_eq!(
        *gateway.hooks.bound.lock().unwrap(),
        [("req_011CgzTest".to_string(), "a".to_string())]
    );
    assert_eq!(
        *gateway.hooks.live.lock().unwrap(),
        [(
            "a".to_string(),
            parse_live_limits(&headers(&ALLOWED)).unwrap()
        )]
    );
    let recorded = gateway.hooks.recorded.lock().unwrap().clone();
    assert_eq!(recorded.len(), 1);
    let entry = &recorded[0];
    assert_eq!(entry.account_id.as_deref(), Some("a"));
    assert_eq!(entry.request_id.as_deref(), Some("req_011CgzTest"));
    assert_eq!(entry.client.as_deref(), Some("claude-code"));
    assert_eq!(entry.request_class.as_deref(), Some("subagent"));
    assert_eq!(
        entry.tokens,
        Some(TokenTally {
            input: Some(3.0),
            output: Some(7.0),
            cache_read: Some(900.0),
            cache_write: Some(40.0),
            cache_write_1h: None,
        })
    );
    assert!(entry.ms.is_some());
    // Claude Code's start-up check needs no key, as with Anthropic.
    assert_eq!(gateway.get("/api/hello", &[]).await.status, 200);
    gateway.stop().await;
    upstream.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn anthropics_bare_429_goes_back_to_the_client_at_once_no_account_is_paused_none_other_is_tried()
 {
    let upstream = FakeUpstream::sync(|_| {
        // As Anthropic answers it: no rate-limit header, no Retry-After.
        json_reply(
            429,
            &error_body("rate_limit_error", "Error"),
            &[("x-should-retry", "true")],
        )
    })
    .await;
    let mut config = config();
    config.routing_strategy = RoutingStrategy::StrictPriority;
    let gateway = Gateway::start(
        config,
        Hooks::new(vec![named("a", "A"), named("b", "B")]),
        Upstreams {
            anthropic_url: Some(upstream.url.clone()),
            ..Default::default()
        },
    )
    .await;
    let answer = gateway
        .post("/v1/messages", &[("user-agent", "curl/8.7.1")], "{}")
        .await;
    assert_eq!(answer.status, 429);
    assert!(
        answer
            .body
            .contains("none of the account's limits is spent")
    );
    assert!(answer.body.contains("did not pause the account"));
    assert_eq!(upstream.count(), 1, "the other account was not tried");
    assert_eq!(gateway.server.router().cooldown_of("a"), None);
    let entry = gateway.recent().remove(0);
    assert_eq!(entry.note.as_deref(), Some("refused"));
    assert_eq!(entry.failover, None, "it did not go on to the next account");
    assert_eq!(entry.error.as_deref(), Some("Error"));
    assert_eq!(entry.client.as_deref(), Some("curl"));
    // The next request goes out as usual.
    gateway.post("/v1/messages", &[], "{}").await;
    assert_eq!(upstream.count(), 2);
    gateway.stop().await;
    upstream.close().await;
}

#[test]
fn the_request_log_keeps_35_days_across_restarts_answers_which_account_served_a_request_id_and_reads_back_only_what_it_wrote()
 {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("gateway-requests.jsonl");
    let now = utc(2026, 10, 13, 12, 0);
    let day = 86_400_000;
    let old =
        json!({ "at": now - 40 * day, "status": 200, "accountId": "a", "requestId": "req_old" });
    std::fs::write(
        &file,
        format!(
            "{old}\nnot json\n{}\n",
            json!({ "at": "yesterday", "status": 200 })
        ),
    )
    .unwrap();
    let mut log = GatewayRequestLog::new(
        &file,
        RequestLogOptions {
            now: Some(fixed(now)),
            feed_size: Some(2),
        },
    );
    assert!(log.load().is_empty());
    assert_eq!(log.account_for("req_old"), None, "older than 35 days");
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "",
        "the file was rewritten without what it dropped"
    );

    log.bind("req_early", "b");
    assert_eq!(
        log.account_for("req_early"),
        Some("b"),
        "known from the headers, before the request is recorded"
    );
    for (i, id) in ["req_1", "req_2", "req_3"].iter().enumerate() {
        log.record(&relay_gateway::ProxyRequestLog {
            at: now + i as i64,
            status: 200,
            account_id: Some("a".into()),
            request_id: Some(id.to_string()),
            model: Some("m".repeat(200)),
            client: Some("claude-code".into()),
            ..Default::default()
        });
    }
    let recent = log.recent();
    assert_eq!(
        recent
            .iter()
            .map(|e| e.request_id.clone().unwrap())
            .collect::<Vec<_>>(),
        ["req_2", "req_3"]
    );
    assert_eq!(recent[0].model.as_ref().unwrap().len(), 80);
    // Windows keeps no POSIX mode bits.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    let mut again = GatewayRequestLog::new(
        &file,
        RequestLogOptions {
            now: Some(fixed(now + day)),
            feed_size: Some(2),
        },
    );
    assert_eq!(
        again
            .load()
            .iter()
            .map(|e| e.request_id.clone().unwrap())
            .collect::<Vec<_>>(),
        ["req_2", "req_3"]
    );
    assert_eq!(again.account_for("req_1"), Some("a"));

    assert_eq!(
        clean_entry(&json!({ "at": 1, "status": 200, "prompt": "secret", "tokens": { "input": -4, "output": 9 } }))
            .and_then(|e| e.tokens)
            .and_then(|t| t.output),
        Some(9.0)
    );
    let cleaned = serde_json::to_value(
        clean_entry(&json!({ "at": 1, "status": 200, "prompt": "secret" })).unwrap(),
    )
    .unwrap();
    assert!(cleaned.get("prompt").is_none());
    assert_eq!(clean_entry(&json!({ "at": 1, "status": 2000 })), None);

    // The gateway's feed starts from what the log kept.
    let stats = ProxyStats::with_recent(again.recent());
    assert_eq!(
        stats
            .recent()
            .iter()
            .map(|e| e.request_id.clone().unwrap())
            .collect::<Vec<_>>(),
        ["req_3", "req_2"]
    );
}
