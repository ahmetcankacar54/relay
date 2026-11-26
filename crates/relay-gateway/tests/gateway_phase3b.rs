//! Port of tests/gateway-phase3b.test.ts (the gateway's cases; limit calibration and the page's
//! wording are not the gateway's).

mod common;

use common::*;
use indexmap::IndexMap;
use relay_gateway::proxy_insights::{AnswerFacts, GatewayInsights};
use relay_gateway::proxy_status::{LimitCalibration, with_move_cost};
use relay_gateway::{
    ProxySessionView, RoutingStrategy, ServerOptions, TokenTally, Upstreams, UsageMap,
};
use std::collections::HashSet;

const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;

fn calibration(id: &str, dollars: f64, windows: u64, percent: f64, cost: f64) -> LimitCalibration {
    LimitCalibration {
        account_id: id.into(),
        dollars_per_percent: dollars,
        windows,
        percent,
        cost,
    }
}

#[test]
fn moving_a_session_costs_its_prompt_at_the_write_price_and_a_share_of_the_other_accounts_windows()
{
    let mut calibrations = IndexMap::new();
    calibrations.insert("a".to_string(), calibration("a", 2.8, 6, 200.0, 560.0));
    calibrations.insert("b".to_string(), calibration("b", 1.5, 5, 200.0, 300.0));
    calibrations.insert("c".to_string(), calibration("c", 2.0, 3, 50.0, 100.0));
    let session = ProxySessionView {
        id: "6cf63d7f".into(),
        account_id: "a".into(),
        model: Some("claude-opus-5-5".into()),
        last_at: 0,
        prefix_tokens: 200_000.0,
        ttl_ms: HOUR,
        requests: 4,
        subagents: 0,
        misses: 0,
        last_miss: None,
        move_cost: None,
    };
    let none = HashSet::new();
    let moved = with_move_cost(&session, &calibrations, &none);
    // Opus 5.5 writes an hour's cache at $8 per million tokens, five minutes' at $5.
    assert_eq!(moved.move_cost.unwrap().dollars, 1.6);
    // The median of B and C (the lower of the two middle ones): 1.5.
    assert_eq!(moved.move_cost.unwrap().percent, Some(1.07));
    let five_minutes = with_move_cost(
        &ProxySessionView {
            ttl_ms: 5 * MINUTE,
            ..session.clone()
        },
        &calibrations,
        &none,
    );
    assert_eq!(five_minutes.move_cost.unwrap().dollars, 1.0);
    assert_eq!(
        with_move_cost(&session, &IndexMap::new(), &none)
            .move_cost
            .unwrap()
            .percent,
        None,
        "no calibration, no share"
    );
    let mut own = IndexMap::new();
    own.insert("a".to_string(), calibrations["a"].clone());
    assert_eq!(
        with_move_cost(&session, &own, &none)
            .move_cost
            .unwrap()
            .percent,
        Some(0.57),
        "only its own: that one"
    );
    assert_eq!(
        with_move_cost(
            &ProxySessionView {
                model: Some("mystery-model".into()),
                ..session
            },
            &calibrations,
            &none
        )
        .move_cost,
        None
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cold_session_on_an_account_near_its_limit_moves_before_its_next_request_writes_the_cache_there()
 {
    let clock = TestClock::new(utc(2026, 10, 13, 12, 0));
    let mut usage = UsageMap::new();
    usage.insert(
        "a".into(),
        ready(
            "a",
            Some(window(50.0, Some(iso(clock.now() + 2 * HOUR)))),
            None,
        ),
    );
    usage.insert(
        "b".into(),
        ready(
            "b",
            Some(window(10.0, Some(iso(clock.now() + 4 * HOUR)))),
            None,
        ),
    );
    let upstream = FakeUpstream::sync(|_| {
        sse_once("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":2,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":40000,\"output_tokens\":3}}}\n\n")
    })
    .await;
    let mut config = config();
    config.routing_strategy = RoutingStrategy::SoonestReset;
    let gateway = Gateway::start_with(
        config,
        Hooks::new(vec![account("a"), account("b")]).usage(usage),
        Upstreams {
            anthropic_url: Some(upstream.url.clone()),
            ..Default::default()
        },
        ServerOptions {
            now: Some(clock.clock()),
            ..Default::default()
        },
    )
    .await;
    let send = || async {
        gateway
            .post(
                "/v1/messages",
                &[
                    ("x-claude-code-session-id", "s-1"),
                    ("x-claude-code-request-class", "main"),
                ],
                r#"{"model":"claude-opus-5-5"}"#,
            )
            .await;
        gateway.idle().await;
    };
    send().await;
    assert_eq!(upstream.tokens(), ["tok-a"], "A resets first");
    // Still warm, though A is now near its limit: the session stays for its cache.
    gateway.hooks.update_usage(|map| {
        map.get_mut("a")
            .unwrap()
            .five_hour
            .as_mut()
            .unwrap()
            .used_percent = 93.0;
    });
    clock.advance(2 * MINUTE);
    send().await;
    assert_eq!(upstream.tokens(), ["tok-a", "tok-a"]);
    // Six minutes of quiet: the five-minute cache is gone, and A is still near its limit.
    clock.advance(6 * MINUTE);
    send().await;
    assert_eq!(upstream.tokens(), ["tok-a", "tok-a", "tok-b"]);
    let moved = gateway.recent().remove(0);
    assert_eq!(moved.note.as_deref(), Some("cold-move"));
    assert_eq!(
        moved.miss.map(|m| m.reason),
        Some(relay_gateway::CacheMissReason::Expired),
        "the cache had expired: that, not the account, wrote it again"
    );
    gateway.stop().await;
    upstream.close().await;
}

#[test]
fn a_session_reads_as_cold_once_its_cache_has_outlived_its_lifetime() {
    let clock = TestClock::new(0);
    let mut insights = GatewayInsights::new(clock.clock());
    insights.observe_answer(&AnswerFacts {
        at: 0,
        session_key: Some("hdr:x".into()),
        account_id: "a".into(),
        model: Some("m".into()),
        request_class: Some("main".into()),
        agent_id: None,
        compacted: false,
        tokens: Some(TokenTally {
            input: Some(1.0),
            cache_write: Some(10_000.0),
            ..Default::default()
        }),
    });
    assert!(!insights.is_cold("hdr:x"));
    clock.set(5 * MINUTE + 1);
    assert!(insights.is_cold("hdr:x"));
    assert!(
        !insights.is_cold("hdr:unknown"),
        "a session Relay knows nothing of is left alone"
    );
}
