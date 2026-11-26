//! Port of tests/gateway-phase3.test.ts.

mod common;

use common::*;
use relay_gateway::anthropic_upstream::AnthropicUsageExtractor;
use relay_gateway::proxy_insights::{AnswerFacts, GatewayInsights, LOOP_REQUESTS, LOOP_SUBAGENTS};
use relay_gateway::proxy_request_log::{GatewayRequestLog, RequestLogOptions};
use relay_gateway::proxy_router::{PickContext, ProxyRouter, nearly_full};
use relay_gateway::upstream_common::UsageExtractor;
use relay_gateway::{
    AccountUsage, CacheMiss, CacheMissReason, LiveWindow, ProxyClassShare, ProxyConfig,
    ProxyRequestLog, RoutingStrategy, TokenTally, Upstreams, UsageMap,
};
use serde_json::json;
use std::collections::HashSet;

const MINUTE: i64 = 60_000;

fn usage(id: &str, five: f64, week: f64, reset_hours: f64) -> AccountUsage {
    let now = now_ms();
    ready(
        id,
        Some(window(
            five,
            Some(iso(now + (reset_hours * 3_600_000.0) as i64)),
        )),
        Some(window(week, Some(iso(now + 5 * 86_400_000)))),
    )
}

fn tally(input: f64, read: f64, write: f64, write_1h: Option<f64>) -> TokenTally {
    TokenTally {
        input: Some(input),
        output: None,
        cache_read: (read > 0.0).then_some(read),
        cache_write: (write > 0.0).then_some(write),
        cache_write_1h: write_1h,
    }
}

#[test]
fn the_usage_of_an_answer_says_how_much_of_its_cache_write_lasts_an_hour() {
    let mut usage = AnthropicUsageExtractor::new();
    usage.on_event(&json!({
        "type": "message_start",
        "message": { "usage": { "input_tokens": 3, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 900, "cache_creation": { "ephemeral_1h_input_tokens": 800, "ephemeral_5m_input_tokens": 100 } } },
    }));
    assert_eq!(
        usage.result(),
        Some(TokenTally {
            input: Some(3.0),
            output: None,
            cache_read: Some(100.0),
            cache_write: Some(900.0),
            cache_write_1h: Some(800.0),
        })
    );
}

#[test]
fn a_sessions_cache_a_write_again_is_a_miss_with_the_reason_it_happened() {
    let clock = TestClock::new(utc(2026, 10, 13, 12, 0));
    let mut insights = GatewayInsights::new(clock.clock());
    let mut answer =
        |account: &str, model: &str, class: &str, agent: Option<&str>, tokens: TokenTally| {
            insights.observe_answer(&AnswerFacts {
                at: clock.now(),
                session_key: Some("hdr:6cf63d7f-aaaa".into()),
                account_id: account.into(),
                model: Some(model.into()),
                request_class: Some(class.into()),
                agent_id: agent.map(Into::into),
                compacted: false,
                tokens: Some(tokens),
            })
        };
    let opus = "claude-opus-5-5";
    assert_eq!(
        answer(
            "a",
            opus,
            "main",
            None,
            tally(2.0, 0.0, 100_000.0, Some(100_000.0))
        ),
        None,
        "the first request writes, as it must"
    );
    clock.advance(2 * MINUTE);
    assert_eq!(
        answer(
            "a",
            opus,
            "main",
            None,
            tally(2.0, 100_002.0, 900.0, Some(900.0))
        ),
        None,
        "read back: no miss"
    );
    // The session moved to another account: everything is written again there.
    clock.advance(MINUTE);
    assert_eq!(
        answer(
            "b",
            opus,
            "main",
            None,
            tally(2.0, 0.0, 101_500.0, Some(101_500.0))
        ),
        Some(CacheMiss {
            reason: CacheMissReason::Account,
            tokens: 100_904.0
        })
    );
    // An hour and more of quiet: the cache lived out its time.
    clock.advance(61 * MINUTE);
    assert_eq!(
        answer(
            "b",
            opus,
            "main",
            None,
            tally(2.0, 0.0, 102_000.0, Some(102_000.0))
        )
        .map(|m| m.reason),
        Some(CacheMissReason::Expired)
    );
    clock.advance(MINUTE);
    assert_eq!(
        answer(
            "b",
            "claude-sonnet-5-5",
            "main",
            None,
            tally(2.0, 0.0, 102_500.0, None)
        )
        .map(|m| m.reason),
        Some(CacheMissReason::Model)
    );
    // A compaction writes a new prompt by design; a subagent has a cache of its own.
    clock.advance(MINUTE);
    assert_eq!(
        answer(
            "b",
            "claude-sonnet-5-5",
            "compaction",
            None,
            tally(2.0, 0.0, 20_000.0, None)
        ),
        None
    );
    clock.advance(MINUTE);
    assert_eq!(
        answer(
            "c",
            "claude-sonnet-5-5",
            "subagent",
            Some("a2919ea8825dbfc96"),
            tally(2.0, 0.0, 30_000.0, None)
        ),
        None
    );

    let view = insights.session_views(8).remove(0);
    assert_eq!(view.id, "6cf63d7f");
    assert_eq!(
        view.account_id, "b",
        "a subagent elsewhere does not move the session"
    );
    assert_eq!(view.prefix_tokens, 20_002.0);
    assert_eq!(
        view.ttl_ms,
        5 * MINUTE,
        "its last write was a five-minute one"
    );
    assert_eq!(view.misses, 3);
    assert_eq!(view.subagents, 1);
    assert_eq!(view.requests, 7);
    assert_eq!(
        view.last_miss.map(|m| m.reason),
        Some(CacheMissReason::Model)
    );
}

#[test]
fn a_prompt_past_the_loop_bounds_raises_one_alarm_which_stays_on_show_for_half_an_hour() {
    let clock = TestClock::new(utc(2026, 10, 13, 12, 0));
    let mut insights = GatewayInsights::new(clock.clock());
    let mut raised = 0;
    for _ in 0..LOOP_REQUESTS + 20 {
        if insights
            .count_prompt(Some("f5601bf9-prompt"), Some("hdr:6cf63d7f-aaaa"), None)
            .is_some()
        {
            raised += 1;
        }
    }
    assert_eq!(raised, 1);
    insights.prompt_served_by(Some("f5601bf9-prompt"), "a");
    let alarm = insights.alarms().remove(0);
    assert_eq!(
        (
            alarm.id.as_str(),
            alarm.session_id.as_deref(),
            alarm.account_id.as_deref(),
            alarm.requests
        ),
        ("f5601bf9", Some("6cf63d7f"), Some("a"), LOOP_REQUESTS + 20)
    );
    clock.advance(31 * MINUTE);
    assert!(insights.alarms().is_empty());

    // Subagents count too.
    let mut fresh = GatewayInsights::new(clock.clock());
    let mut alarm = None;
    for i in 0..LOOP_SUBAGENTS {
        alarm = fresh
            .count_prompt(Some("p2"), None, Some(&format!("agent-{i}")))
            .or(alarm);
    }
    assert_eq!(alarm.map(|a| a.subagents), Some(LOOP_SUBAGENTS as u64));
    assert_eq!(
        fresh.count_prompt(None, None, None),
        None,
        "no prompt id, nothing counted"
    );
}

#[test]
fn an_accounts_pace_says_when_its_5_hour_window_fills_only_from_a_rise_over_ten_minutes_and_before_it_resets()
 {
    let clock = TestClock::new(utc(2026, 10, 13, 12, 0));
    let mut insights = GatewayInsights::new(clock.clock());
    let reset = iso(clock.now() + 3 * 3_600_000);
    let reading = |percent: f64, reset: &str| LiveWindow {
        used_percent: percent,
        resets_at: Some(reset.into()),
    };
    insights.observe_limits("a", Some(&reading(60.0, &reset)));
    clock.advance(5 * MINUTE);
    insights.observe_limits("a", Some(&reading(62.0, &reset)));
    assert_eq!(insights.full_at("a"), None, "five minutes are too few");
    clock.advance(5 * MINUTE);
    insights.observe_limits("a", Some(&reading(64.0, &reset)));
    // 4 % in 10 minutes: the 36 % left take 90 minutes.
    assert_eq!(insights.full_at("a"), Some(clock.now() + 90 * MINUTE));
    // Slower than the reset: no warning.
    let mut slow = GatewayInsights::new(clock.clock());
    slow.observe_limits("b", Some(&reading(10.0, &reset)));
    clock.advance(10 * MINUTE);
    slow.observe_limits("b", Some(&reading(11.0, &reset)));
    assert_eq!(slow.full_at("b"), None);
    // A new window starts the pace afresh.
    insights.observe_limits("a", Some(&reading(2.0, &iso(clock.now() + 5 * 3_600_000))));
    assert_eq!(insights.full_at("a"), None);
}

#[test]
fn a_new_session_skips_an_account_close_to_its_limit_while_another_has_room_a_running_one_keeps_its_account()
 {
    let mut router = ProxyRouter::with_strategy(RoutingStrategy::SoonestReset, None);
    let pool = [account("a"), account("b")];
    let none = HashSet::new();
    let ctx = PickContext::default();
    // A resets sooner, so soonest-reset would choose it, but it is at 92 %.
    let mut map = UsageMap::new();
    map.insert("a".into(), usage("a", 92.0, 10.0, 1.0));
    map.insert("b".into(), usage("b", 40.0, 10.0, 4.0));
    assert!(nearly_full(map.get("a"), None, now_ms()));
    assert!(
        nearly_full(Some(&usage("x", 50.0, 98.0, 2.0)), None, now_ms()),
        "a week at 98 % too"
    );
    let pick = |router: &mut ProxyRouter,
                key: &str,
                pool: &[relay_gateway::Account],
                map: &UsageMap,
                avoid: Option<&str>| {
        router
            .select_account(Some(key), pool, map, None, &none, avoid, &ctx)
            .unwrap()
            .account
            .id
    };
    assert_eq!(pick(&mut router, "new", &pool, &map, None), "b");
    router.session_cache_mut().set("running", "a");
    assert_eq!(
        pick(&mut router, "running", &pool, &map, None),
        "a",
        "its cache is on A"
    );
    // When every account is that close, the strategy picks among them all.
    let mut close = UsageMap::new();
    close.insert("a".into(), map["a"].clone());
    close.insert("b".into(), usage("b", 95.0, 10.0, 4.0));
    assert_eq!(pick(&mut router, "other", &pool, &close, None), "a");
    // Strict priority keeps its order.
    let mut strict = ProxyRouter::with_strategy(RoutingStrategy::StrictPriority, None);
    assert_eq!(pick(&mut strict, "new", &pool, &map, None), "a");
    // `avoid` leaves an account out of a new pick while another can take it.
    let mut fresh = UsageMap::new();
    fresh.insert("a".into(), usage("a", 10.0, 10.0, 1.0));
    fresh.insert("b".into(), usage("b", 10.0, 10.0, 4.0));
    assert_eq!(pick(&mut router, "sub", &pool, &fresh, Some("a")), "b");
    assert_eq!(
        pick(
            &mut router,
            "solo",
            &[account("a")],
            &UsageMap::new(),
            Some("a")
        ),
        "a",
        "alone, it is used all the same"
    );
}

async fn overflow_pool(ids: &[&str], overflow: bool) -> (Gateway, FakeUpstream) {
    let upstream = FakeUpstream::sync(|_| {
        sse_once("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":2,\"cache_read_input_tokens\":1000,\"cache_creation_input_tokens\":0,\"output_tokens\":3}}}\n\n")
    })
    .await;
    let config = ProxyConfig {
        routing_strategy: RoutingStrategy::StrictPriority,
        subagent_overflow: Some(overflow),
        ..config()
    };
    let gateway = Gateway::start(
        config,
        Hooks::new(ids.iter().map(|id| account(id)).collect()),
        Upstreams {
            anthropic_url: Some(upstream.url.clone()),
            ..Default::default()
        },
    )
    .await;
    (gateway, upstream)
}

async fn send(gateway: &Gateway, extra: &[(&str, &str)]) {
    let mut pairs = vec![("x-claude-code-session-id", "s-1")];
    pairs.extend_from_slice(extra);
    gateway
        .post("/v1/messages", &pairs, r#"{"model":"claude-opus-5-5"}"#)
        .await;
    gateway.idle().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn with_overflow_on_a_sessions_fresh_subagents_go_to_one_other_account_and_stay_there_forks_stay_with_the_session()
 {
    let (on, upstream) = overflow_pool(&["a", "b", "c"], true).await;
    send(&on, &[("x-claude-code-request-class", "main")]).await;
    let sub = [
        ("x-claude-code-request-class", "subagent"),
        ("x-claude-code-agent-type", "Explore"),
    ];
    send(&on, &[sub[0], sub[1], ("x-claude-code-agent-id", "agent1")]).await;
    send(&on, &[sub[0], sub[1], ("x-claude-code-agent-id", "agent2")]).await;
    send(
        &on,
        &[
            ("x-claude-code-request-class", "subagent"),
            ("x-claude-code-agent-type", "fork"),
            ("x-claude-code-agent-id", "agent3"),
        ],
    )
    .await;
    send(&on, &[("x-claude-code-request-class", "main")]).await;
    assert_eq!(
        upstream.tokens(),
        ["tok-a", "tok-b", "tok-b", "tok-a", "tok-a"]
    );
    // The subagents' answers do not touch the session's cache view.
    let view = on.server.insights().session_views(8).remove(0);
    assert_eq!(view.account_id, "a");
    assert_eq!(view.subagents, 3, "the fork is a subagent too");
    // The feed prices each answer.
    let last = on.recent().remove(0);
    assert!(last.cost.is_some_and(|c| c > 0.0));
    on.stop().await;
    upstream.close().await;

    let (off, upstream) = overflow_pool(&["a", "b"], false).await;
    send(&off, &[("x-claude-code-request-class", "main")]).await;
    send(
        &off,
        &[
            ("x-claude-code-request-class", "subagent"),
            ("x-claude-code-agent-type", "Explore"),
            ("x-claude-code-agent-id", "agent1"),
        ],
    )
    .await;
    assert_eq!(
        upstream.tokens(),
        ["tok-a", "tok-a"],
        "off: the session's account, as before"
    );
    off.stop().await;
    upstream.close().await;
}

#[test]
fn the_request_log_adds_up_todays_answers_by_request_class_the_costliest_first() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("gateway-requests.jsonl");
    let now = now_ms();
    let options = || RequestLogOptions {
        now: Some(fixed(now)),
        feed_size: None,
    };
    let mut log = GatewayRequestLog::new(&file, options());
    log.load();
    let entry = |at: i64,
                 status: u16,
                 class: &str,
                 tokens: Option<serde_json::Value>,
                 cost: Option<f64>| {
        let mut value = json!({ "at": at, "status": status, "requestClass": class });
        if let Some(tokens) = tokens {
            value["tokens"] = tokens;
        }
        if let Some(cost) = cost {
            value["cost"] = json!(cost);
        }
        serde_json::from_value::<ProxyRequestLog>(value).unwrap()
    };
    log.record(&entry(
        now,
        200,
        "main",
        Some(json!({ "input": 2, "cacheRead": 1000, "output": 10 })),
        Some(0.02),
    ));
    log.record(&entry(
        now,
        200,
        "subagent",
        Some(json!({ "input": 5, "cacheWrite": 30_000, "output": 400 })),
        Some(0.31),
    ));
    log.record(&entry(
        now,
        200,
        "subagent",
        Some(json!({ "input": 5, "cacheWrite": 20_000, "output": 100 })),
        Some(0.2),
    ));
    log.record(&entry(now, 429, "main", None, None));
    log.record(&entry(
        now - 2 * 86_400_000,
        200,
        "main",
        Some(json!({ "input": 1 })),
        Some(9.0),
    ));
    assert_eq!(
        log.today_by_class(),
        [
            ProxyClassShare {
                request_class: "subagent".into(),
                requests: 2,
                tokens: 50_510.0,
                cost: 0.51
            },
            ProxyClassShare {
                request_class: "main".into(),
                requests: 1,
                tokens: 1012.0,
                cost: 0.02
            },
        ]
    );
    // Read back after a restart.
    let mut again = GatewayRequestLog::new(&file, options());
    again.load();
    assert_eq!(
        again
            .today_by_class()
            .into_iter()
            .map(|s| s.request_class)
            .collect::<Vec<_>>(),
        ["subagent", "main"]
    );
}

#[test]
fn background_requests_and_a_shortened_conversation_are_not_cache_misses() {
    let clock = TestClock::new(utc(2026, 10, 13, 12, 0));
    let mut insights = GatewayInsights::new(clock.clock());
    let key = "hdr:1d3cf2c3-bbbb";
    let facts = |at: i64, model: &str, class: &str, tokens: TokenTally| AnswerFacts {
        at,
        session_key: Some(key.into()),
        account_id: "a".into(),
        model: Some(model.into()),
        request_class: Some(class.into()),
        agent_id: None,
        compacted: false,
        tokens: Some(tokens),
    };
    insights.observe_answer(&facts(
        clock.now(),
        "claude-opus-5-5",
        "main",
        tally(2.0, 0.0, 150_000.0, Some(150_000.0)),
    ));
    clock.advance(MINUTE);
    // A title or classifier: the session's id, a short prompt of its own.
    assert_eq!(
        insights.observe_answer(&facts(
            clock.now(),
            "claude-haiku-5-5",
            "auxiliary",
            tally(300.0, 0.0, 2_500.0, None)
        )),
        None
    );
    assert_eq!(
        insights.session_views(8)[0].prefix_tokens,
        150_002.0,
        "the conversation's cache is unchanged"
    );
    clock.advance(MINUTE);
    assert_eq!(
        insights.observe_answer(&facts(
            clock.now(),
            "claude-opus-5-5",
            "main",
            tally(2.0, 150_002.0, 700.0, Some(700.0))
        )),
        None
    );
    // Cleared or compacted without the hint: a much shorter prompt is written by design.
    clock.advance(MINUTE);
    assert_eq!(
        insights.observe_answer(&facts(
            clock.now(),
            "claude-opus-5-5",
            "main",
            tally(2.0, 14_000.0, 9_000.0, Some(9_000.0))
        )),
        None
    );
    assert_eq!(insights.session_views(8)[0].misses, 0);
}
