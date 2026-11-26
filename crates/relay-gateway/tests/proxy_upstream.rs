//! Port of tests/proxy-upstream.test.ts.

mod common;

use common::*;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use relay_gateway::anthropic_upstream::AnthropicUsageExtractor;
use relay_gateway::client_res::ClientRes;
use relay_gateway::proxy_router::{
    CooldownReason, PickContext, ProxyRouter, RouterError, RouterOptions, full_until,
};
use relay_gateway::proxy_session_cache::ProxySessionCache;
use relay_gateway::upstream_common::{
    FailureKind, ForwardSpec, UPSTREAM_POOL_IDLE, UpstreamClientOptions, UpstreamOutcome,
    classify_failure, forward_upstream, parse_limit_reset, upstream_pool,
};
use relay_gateway::{Account, RoutingStrategy, UsageMap};
use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpListener;

const NOW: i64 = 1_794_571_200_000; // Date.UTC(2026, 10, 13, 12)

fn at(hours: i64) -> String {
    (NOW / 1000 + hours * 3600).to_string()
}

#[test]
fn a_limits_reset_comes_from_the_window_that_refused_not_from_the_drifting_overall_header() {
    assert_eq!(NOW, utc(2026, 10, 13, 12, 0));
    // The 5-hour window refused; the overall reset names the weekly one, three days out.
    assert_eq!(
        parse_limit_reset(
            &headers(&[
                ("anthropic-ratelimit-unified-status", "rejected"),
                ("anthropic-ratelimit-unified-reset", &at(72)),
                ("anthropic-ratelimit-unified-5h-status", "rejected"),
                ("anthropic-ratelimit-unified-5h-reset", &at(1)),
                ("anthropic-ratelimit-unified-7d-status", "allowed"),
                ("anthropic-ratelimit-unified-7d-reset", &at(72)),
            ]),
            NOW,
        ),
        Some(NOW + 3_600_000)
    );
    // A model's own weekly window, and both: the later one.
    assert_eq!(
        parse_limit_reset(
            &headers(&[
                ("anthropic-ratelimit-unified-7d_opus-status", "rejected"),
                ("anthropic-ratelimit-unified-7d_opus-reset", &at(30)),
                ("anthropic-ratelimit-unified-5h-status", "rejected"),
                ("anthropic-ratelimit-unified-5h-reset", &at(2)),
            ]),
            NOW,
        ),
        Some(NOW + 30 * 3_600_000)
    );
    // No window named: the overall reset, capped at five hours when it says it is the 5-hour one.
    assert_eq!(
        parse_limit_reset(
            &headers(&[
                ("anthropic-ratelimit-unified-status", "rejected"),
                ("anthropic-ratelimit-unified-reset", &at(72)),
                (
                    "anthropic-ratelimit-unified-representative-claim",
                    "five_hour"
                ),
            ]),
            NOW,
        ),
        Some(NOW + 5 * 3_600_000)
    );
    assert_eq!(
        parse_limit_reset(
            &headers(&[
                ("anthropic-ratelimit-unified-status", "rejected"),
                ("anthropic-ratelimit-unified-reset", &at(30)),
            ]),
            NOW,
        ),
        Some(NOW + 30 * 3_600_000)
    );
    // Nothing refused: the reset sent with every answer says nothing.
    assert_eq!(
        parse_limit_reset(
            &headers(&[
                ("anthropic-ratelimit-unified-status", "allowed"),
                ("anthropic-ratelimit-unified-reset", &at(3)),
            ]),
            NOW,
        ),
        None
    );
}

#[test]
fn an_error_answer_is_read_for_what_it_says_about_the_account() {
    let body = |kind: &str, message: &str| error_body(kind, message);
    let json = headers(&[("content-type", "application/json")]);
    let classify =
        |status, h: &http::HeaderMap, b: Option<String>| classify_failure(status, h, b.as_deref());
    assert_eq!(
        classify(
            429,
            &json,
            Some(body(
                "rate_limit_error",
                "Number of requests has exceeded your rate limit"
            ))
        ),
        Some(FailureKind::Limit)
    );
    assert_eq!(
        classify(
            429,
            &json,
            Some(body(
                "rate_limit_error",
                "Extra usage is required for long context requests."
            ))
        ),
        Some(FailureKind::ExtraUsage)
    );
    assert_eq!(
        classify(
            401,
            &json,
            Some(body("authentication_error", "OAuth token has expired"))
        ),
        Some(FailureKind::Auth)
    );
    assert_eq!(
        classify(
            403,
            &json,
            Some(body(
                "permission_error",
                "OAuth authentication is currently not supported."
            ))
        ),
        Some(FailureKind::Auth)
    );
    assert_eq!(
        classify(
            403,
            &json,
            Some(body(
                "permission_error",
                "This organization has been disabled."
            ))
        ),
        Some(FailureKind::Auth)
    );
    assert_eq!(
        classify(
            403,
            &json,
            Some(body(
                "permission_error",
                "Your plan does not include access to this model."
            ))
        ),
        Some(FailureKind::Permission)
    );
    assert_eq!(
        classify(
            403,
            &headers(&[("content-type", "text/html")]),
            Some("<html>Just a moment...</html>".into())
        ),
        Some(FailureKind::Transient)
    );
    assert_eq!(
        classify(529, &json, Some(body("overloaded_error", "Overloaded"))),
        Some(FailureKind::Transient)
    );
    assert_eq!(
        classify(503, &headers(&[]), None),
        Some(FailureKind::Transient)
    );
    assert_eq!(
        classify(500, &json, Some(body("api_error", "Internal"))),
        None
    );
    assert_eq!(
        classify(400, &json, Some(body("invalid_request_error", "bad"))),
        None
    );
}

/// A gateway-side server whose one route forwards to `upstream` with the given timeouts.
struct Forwarder {
    port: u16,
    outcomes: Arc<Mutex<Vec<UpstreamOutcome>>>,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Clone, Default)]
struct Timeouts {
    first_byte: Option<Duration>,
    idle: Option<Duration>,
    pool: Option<relay_gateway::upstream_common::UpstreamPool>,
}

async fn forwarder(upstream: String, timeouts: Timeouts) -> Forwarder {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let outcomes = Arc::new(Mutex::new(Vec::new()));
    let recorded = outcomes.clone();
    let task = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let upstream = upstream.clone();
            let timeouts = timeouts.clone();
            let recorded = recorded.clone();
            tokio::spawn(async move {
                let service = service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
                    let upstream = upstream.clone();
                    let timeouts = timeouts.clone();
                    let recorded = recorded.clone();
                    async move {
                        use http_body_util::BodyExt;
                        let _ = request.into_body().collect().await;
                        let (mut res, head) = ClientRes::new();
                        tokio::spawn(async move {
                            let mut usage = AnthropicUsageExtractor::new();
                            let outcome = forward_upstream(
                                &mut res,
                                ForwardSpec {
                                    method: http::Method::POST,
                                    target: format!("{upstream}/v1/messages").parse().unwrap(),
                                    headers: http::HeaderMap::new(),
                                    body: bytes::Bytes::from_static(b"{}"),
                                    account_id: "a",
                                    stats: None,
                                    usage: &mut usage,
                                    error_label: "Gateway error".into(),
                                    on_answer: None,
                                    hold_if: None,
                                    first_byte_timeout: timeouts.first_byte,
                                    idle_timeout: timeouts.idle,
                                    pool: timeouts.pool.as_ref(),
                                },
                            )
                            .await;
                            recorded.lock().unwrap().push(outcome);
                        });
                        head.await.map_err(|_| std::io::Error::other("no answer"))
                    }
                });
                let _ = http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    Forwarder {
        port,
        outcomes,
        task,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stream_that_goes_quiet_mid_answer_is_cut_after_the_idle_time_while_a_slow_first_byte_gets_its_own_longer_wait()
 {
    let stalled = FakeUpstream::sync(|_| {
        // …and nothing more after the first event.
        sse(
            vec![(
                0,
                "event: message_start\ndata: {\"type\":\"message_start\"}\n\n".into(),
            )],
            false,
        )
    })
    .await;
    let slow = FakeUpstream::start(Arc::new(|_| {
        Box::pin(async {
            tokio::time::sleep(Duration::from_millis(250)).await;
            json_reply(200, "{}", &[])
        })
    }))
    .await;
    let quiet = forwarder(
        stalled.url.clone(),
        Timeouts {
            first_byte: Some(Duration::from_secs(5)),
            idle: Some(Duration::from_millis(150)),
            pool: None,
        },
    )
    .await;
    let patient = forwarder(
        slow.url.clone(),
        Timeouts {
            first_byte: Some(Duration::from_secs(2)),
            idle: Some(Duration::from_millis(100)),
            pool: None,
        },
    )
    .await;
    let started = std::time::Instant::now();
    let cut = request(quiet.port, "POST", "/", &[], "{}").await;
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "cut by the idle time, not the first-byte wait"
    );
    assert_eq!(cut.status, 200, "the answer had begun");
    let answer = request(patient.port, "POST", "/", &[], "{}").await;
    assert_eq!(
        answer.status, 200,
        "250 ms to the first byte is within its own wait, though longer than the idle time"
    );
    assert_eq!(quiet.outcomes.lock().unwrap()[0].status_code, 504);
    quiet.task.abort();
    patient.task.abort();
    stalled.close().await;
    slow.close().await;
}

/// A resolver that answers loopback after a delay, or never.
struct SlowResolver(Option<Duration>);

impl reqwest::dns::Resolve for SlowResolver {
    fn resolve(&self, _name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let delay = self.0;
        Box::pin(async move {
            match delay {
                Some(delay) => tokio::time::sleep(delay).await,
                None => std::future::pending::<()>().await,
            }
            let addresses: reqwest::dns::Addrs =
                Box::new(vec![SocketAddr::from(([127, 0, 0, 1], 0))].into_iter());
            Ok(addresses)
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_pools_own_short_socket_timeout_does_not_end_a_request_that_is_within_the_gateways_wait()
 {
    // Found live in Node: its pool timed sockets out while a slow connection was being opened.
    // Here opening the connection takes 200 ms through a slow lookup.
    let upstream = FakeUpstream::sync(|_| json_reply(200, "{}", &[])).await;
    let pool = upstream_pool(UpstreamClientOptions {
        connect_timeout: None,
        resolver: Some(Arc::new(SlowResolver(Some(Duration::from_millis(200))))),
    });
    let gateway = forwarder(
        format!("http://upstream.test:{}", upstream.port),
        Timeouts {
            first_byte: Some(Duration::from_secs(5)),
            idle: None,
            pool: Some(pool),
        },
    )
    .await;
    assert_eq!(
        request(gateway.port, "POST", "/", &[], "{}").await.status,
        200
    );
    assert_eq!(gateway.outcomes.lock().unwrap()[0].status_code, 200);
    gateway.task.abort();
    upstream.close().await;
    // Idle pooled connections close after 5 s, as with Node's agent; the connector races
    // a host's addresses (happy eyeballs) without dropping the slow first one.
    assert_eq!(UPSTREAM_POOL_IDLE, Duration::from_secs(5));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_connection_that_never_opens_is_given_up_after_the_connect_time_with_a_message_that_says_so()
 {
    // A lookup that never answers keeps the connection opening forever.
    let pool = upstream_pool(UpstreamClientOptions {
        connect_timeout: Some(Duration::from_millis(150)),
        resolver: Some(Arc::new(SlowResolver(None))),
    });
    let gateway = forwarder(
        "http://upstream.invalid".into(),
        Timeouts {
            first_byte: Some(Duration::from_secs(5)),
            idle: None,
            pool: Some(pool),
        },
    )
    .await;
    let started = std::time::Instant::now();
    let answer = request(gateway.port, "POST", "/", &[], "{}").await;
    assert_eq!(answer.status, 504, "{}", answer.body);
    assert!(
        answer
            .body
            .contains("could not connect to the upstream within 150 ms"),
        "{}",
        answer.body
    );
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "the connect time, not the first-byte wait"
    );
    assert_eq!(gateway.outcomes.lock().unwrap()[0].status_code, 504);
    gateway.task.abort();
}

fn account(id: &str) -> Account {
    Account::new(id, id)
}

#[test]
fn a_window_read_at_100_keeps_the_account_out_until_it_resets_and_only_while_its_reset_is_ahead() {
    let ahead = iso(NOW + 3_600_000);
    let past = iso(NOW - 60_000);
    let week = |used, reset: &str| ready("a", None, Some(window(used, Some(reset.into()))));
    assert_eq!(
        full_until(Some(&week(100.0, &ahead)), NOW, None),
        NOW + 3_600_000
    );
    assert_eq!(full_until(Some(&week(100.0, &past)), NOW, None), 0);
    assert_eq!(
        full_until(
            Some(&ready("a", Some(window(99.0, Some(ahead.clone()))), None)),
            NOW,
            None
        ),
        0
    );
    let mut router = ProxyRouter::with_strategy(RoutingStrategy::StrictPriority, Some(fixed(NOW)));
    let mut usage = UsageMap::new();
    usage.insert(
        "a".into(),
        ready("a", Some(window(100.0, Some(ahead))), None),
    );
    let picked = router
        .select_account(
            None,
            &[account("a"), account("b")],
            &usage,
            None,
            &HashSet::new(),
            None,
            &PickContext::default(),
        )
        .unwrap();
    assert_eq!(picked.account.id, "b");
}

#[test]
fn a_session_keeps_its_account_through_a_sign_in_or_overload_cooldown_and_moves_on_a_limit() {
    let clock = TestClock::new(NOW);
    let cache = ProxySessionCache::with_clock(clock.clock());
    let mut router = ProxyRouter::new(RouterOptions {
        strategy: Some(RoutingStrategy::StrictPriority),
        session_cache: Some(cache),
        now: Some(clock.clock()),
    });
    let pool = [account("a"), account("b")];
    let usage = UsageMap::new();
    let select = |router: &mut ProxyRouter| {
        router
            .select_account(
                Some("s"),
                &pool,
                &usage,
                None,
                &HashSet::new(),
                None,
                &PickContext::default(),
            )
            .unwrap()
            .account
            .id
    };
    assert_eq!(select(&mut router), "a");
    router.mark_unavailable("a", 30_000, CooldownReason::Auth);
    assert_eq!(select(&mut router), "b", "served elsewhere meanwhile");
    assert_eq!(router.session_cache().peek("s").as_deref(), Some("a"));
    clock.advance(31_000);
    assert_eq!(select(&mut router), "a");
    router.mark_unavailable("a", 10_000, CooldownReason::Transient);
    router.mark_unavailable("a", 3_600_000, CooldownReason::Limit);
    assert_eq!(
        router.cooldown_of("a").map(|c| c.reason),
        Some(CooldownReason::Limit),
        "the longer limit wins over the brief outage"
    );
    router.session_cache_mut().evict_account("a");
    assert_eq!(select(&mut router), "b");
    assert_eq!(router.session_cache().peek("s").as_deref(), Some("b"));
}

#[test]
fn a_pool_out_only_for_its_sign_ins_says_so_one_with_a_limit_among_them_does_not() {
    let mut router = ProxyRouter::new(RouterOptions {
        now: Some(fixed(NOW)),
        ..Default::default()
    });
    router.mark_unavailable("a", 30_000, CooldownReason::Auth);
    router.mark_unavailable("b", 30_000, CooldownReason::Auth);
    let pool = [account("a"), account("b")];
    let sign_in_only = |router: &mut ProxyRouter| match router.select_account(
        None,
        &pool,
        &UsageMap::new(),
        None,
        &HashSet::new(),
        None,
        &PickContext::default(),
    ) {
        Err(RouterError::NoEligible { sign_in_only, .. }) => sign_in_only,
        other => panic!("expected NoEligible, got {other:?}"),
    };
    assert!(sign_in_only(&mut router));
    router.mark_unavailable("b", 3_600_000, CooldownReason::Limit);
    assert!(!sign_in_only(&mut router));
}
