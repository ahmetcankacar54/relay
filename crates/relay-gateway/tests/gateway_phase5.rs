//! Port of tests/gateway-phase5.test.ts (the gateway's case; the other two exercise
//! `relay usage` in the CLI).

mod common;

use common::*;
use relay_gateway::{ProxyConfig, RoutingStrategy, Upstreams, UsageMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const HOUR: i64 = 3_600_000;

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn requests_that_arrive_together_read_an_accounts_sign_in_once_and_report_it_missing_once() {
    let now = now_ms();
    // A resets first, so every new session picks it before B.
    let mut usage = UsageMap::new();
    usage.insert(
        "a".into(),
        ready("a", Some(window(10.0, Some(iso(now + HOUR)))), None),
    );
    usage.insert(
        "b".into(),
        ready("b", Some(window(10.0, Some(iso(now + 3 * HOUR)))), None),
    );
    let reads = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen = reads.clone();
    let upstream = FakeUpstream::sync(|_| {
        json_reply(
            200,
            r#"{"usage":{"input_tokens":1,"output_tokens":1}}"#,
            &[],
        )
    })
    .await;
    let config = ProxyConfig {
        routing_strategy: RoutingStrategy::SoonestReset,
        ..config()
    };
    // A's sign-in has expired: the read takes a moment and finds nothing usable.
    let hooks = Hooks::new(vec![account("a"), account("b")])
        .usage(usage)
        .credential(move |a| {
            let reads = seen.clone();
            async move {
                reads.lock().unwrap().push(a.id.clone());
                tokio::time::sleep(Duration::from_millis(40)).await;
                (a.id != "a").then(|| format!("tok-{}", a.id))
            }
        });
    let gateway = Gateway::start(
        config,
        hooks,
        Upstreams {
            anthropic_url: Some(upstream.url.clone()),
            ..Default::default()
        },
    )
    .await;
    let port = gateway.port;
    let sends = (0..8).map(|i| {
        tokio::spawn(async move {
            let session = format!("s-{i}");
            request(
                port,
                "POST",
                "/v1/messages",
                &[("x-claude-code-session-id", &session)],
                r#"{"model":"claude-haiku-4-5"}"#,
            )
            .await
            .status
        })
    });
    let mut statuses = Vec::new();
    for send in sends.collect::<Vec<_>>() {
        statuses.push(send.await.unwrap());
    }
    assert_eq!(statuses, vec![200; 8], "B served all eight");
    assert_eq!(
        reads.lock().unwrap().iter().filter(|id| *id == "a").count(),
        1,
        "one read of A's sign-in for the burst"
    );
    assert_eq!(
        *gateway.hooks.missing.lock().unwrap(),
        ["a"],
        "reported once, so one renewal is asked for"
    );
    gateway.idle().await;
    assert!(
        gateway
            .recent()
            .iter()
            .all(|e| e.account_id.as_deref() == Some("b"))
    );
    gateway.stop().await;
    upstream.close().await;
}
