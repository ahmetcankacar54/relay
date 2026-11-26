//! Port of tests/proxy-server.test.ts.

mod common;

use common::*;
use relay_gateway::proxy_router::CooldownReason;
use relay_gateway::{
    AccountAuth, AntigravityRoute, Provider, ProxyRunStatus, RoutingStrategy, ServerOptions,
    Upstreams, alias_codex_path,
};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;

fn anthropic(url: &str) -> Upstreams {
    Upstreams {
        anthropic_url: Some(url.into()),
        ..Default::default()
    }
}

/// One account `acc-1` ("One"); a Codex one when a Codex upstream is given.
async fn start_proxy(
    upstreams: Upstreams,
    hooks: impl FnOnce(Hooks) -> Hooks,
    provider: Option<Provider>,
) -> Gateway {
    let codex = upstreams.codex_url.is_some() || upstreams.codex_websocket_url.is_some();
    let mut one = named("acc-1", "One");
    one.provider = provider.or(codex.then_some(Provider::Codex));
    let hooks = hooks(Hooks::new(vec![one]).token("tok-1"));
    Gateway::start(config(), hooks, upstreams).await
}

async fn start_pool(
    upstreams: Upstreams,
    accounts: Vec<relay_gateway::Account>,
    change: impl FnOnce(&mut relay_gateway::ProxyConfig),
    hooks: impl FnOnce(Hooks) -> Hooks,
) -> Gateway {
    let mut config = config();
    config.routing_strategy = RoutingStrategy::StrictPriority;
    change(&mut config);
    Gateway::start(config, hooks(Hooks::new(accounts)), upstreams).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn proxy_server_starts_serves_health_and_status_and_stops_cleanly() {
    let hooks = Hooks::new(vec![named("acc-test", "Test Account")]).token("mock-token-123");
    let mut config = config();
    config.port = 18317;
    let gateway = Gateway::start(config, hooks, Upstreams::default()).await;
    assert_eq!(gateway.server.state().status, ProxyRunStatus::Running);
    assert_eq!(gateway.port, 18317);

    let health = gateway.get("/health", &[]).await;
    assert_eq!(health.status, 200);
    let health = health.json();
    assert_eq!(health["ok"], true);
    assert_eq!(health["status"], "running");
    assert!(
        health.get("state").is_none(),
        "/health says nothing about the accounts"
    );

    let status = gateway.get("/status", &[]).await;
    assert_eq!(status.status, 200);
    let status = status.json();
    assert_eq!(status["ok"], true);
    assert_eq!(status["state"]["activeSessionsCount"], 0);

    gateway.stop().await;
    assert_eq!(gateway.server.state().status, ProxyRunStatus::Stopped);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn proxy_server_swaps_the_credential_keeps_the_clients_betas_and_records_streamed_usage() {
    let events = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":4,\"cache_creation_input_tokens\":2,\"output_tokens\":1}}}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":25}}\n\n";
    let upstream = FakeUpstream::sync(move |_| {
        // Split in the middle of an event: the parser must cope with chunk boundaries.
        sse(
            vec![
                (0, events[..40].to_string()),
                (10, events[40..].to_string()),
            ],
            true,
        )
    })
    .await;
    let gateway = start_proxy(anthropic(&upstream.url), |h| h, None).await;
    let res = gateway
        .post(
            "/v1/messages?beta=true",
            &[
                ("content-type", "application/json"),
                ("authorization", "Bearer client-key"),
                ("x-api-key", "sk-client"),
                ("anthropic-beta", "claude-code-20250219"),
            ],
            r#"{"model":"m","messages":[]}"#,
        )
        .await;
    assert_eq!(res.status, 200);
    assert!(res.body.contains("message_delta"));

    let got = &upstream.seen()[0];
    assert_eq!(got.url, "/v1/messages?beta=true");
    assert_eq!(got.header("authorization"), Some("Bearer tok-1"));
    assert_eq!(got.header("x-api-key"), None);
    assert_eq!(
        got.header("anthropic-beta")
            .unwrap()
            .split(',')
            .collect::<Vec<_>>(),
        ["claude-code-20250219", "oauth-2025-04-20"]
    );
    gateway.idle().await;
    // Output is the final cumulative count, not message_start's plus message_delta's.
    let tokens = gateway.server.metrics().tokens_by_account["acc-1"];
    assert_eq!(
        (
            tokens.input,
            tokens.output,
            tokens.cache_read,
            tokens.cache_write
        ),
        (10.0, 25.0, 4.0, 2.0)
    );
    gateway.stop().await;
    upstream.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn proxy_server_never_lets_a_request_target_steer_the_token_to_another_host() {
    let upstream = FakeUpstream::sync(|_| json_reply(200, "{}", &[])).await;
    let gateway = start_proxy(anthropic(&upstream.url), |h| h, None).await;
    for path in ["//evil.example/v1/messages", "/\\evil.example/v1/messages"] {
        let res = gateway.post(path, &[], "{}").await;
        assert_eq!(res.status, 400, "{path}");
    }
    assert_eq!(upstream.count(), 0);
    gateway.stop().await;
    upstream.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn proxy_server_surfaces_429_with_retry_after_then_cools_the_account_down() {
    let upstream = FakeUpstream::sync(|_| {
        json_reply(
            429,
            r#"{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}"#,
            &[("retry-after", "42")],
        )
    })
    .await;
    let gateway = start_proxy(anthropic(&upstream.url), |h| h, None).await;
    let first = gateway.post("/v1/messages", &[], "{}").await;
    assert_eq!(first.status, 429);
    assert!(first.body.contains("slow down"));
    // The only account is cooling down: answered by the gateway, upstream not bothered again.
    let second = gateway.post("/v1/messages", &[], "{}").await;
    assert_eq!(second.status, 429);
    assert!(
        second
            .header("retry-after")
            .unwrap()
            .parse::<u64>()
            .unwrap()
            > 0
    );
    assert_eq!(upstream.count(), 1);
    gateway.stop().await;
    upstream.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn proxy_server_passes_a_401_through_answers_401_for_an_unreadable_credential_and_502_for_a_dead_upstream()
 {
    let upstream = FakeUpstream::sync(|_| json_reply(401, r#"{"error":"expired"}"#, &[])).await;
    let gateway = start_proxy(anthropic(&upstream.url), |h| h, None).await;
    let res = gateway.post("/v1/messages", &[], "{}").await;
    assert_eq!(res.status, 401);
    assert!(res.body.contains("expired"));
    gateway.stop().await;
    upstream.close().await;

    let no_token = start_proxy(
        anthropic(&upstream.url),
        |h| h.credential(|_| async { None }),
        None,
    )
    .await;
    let res = no_token.post("/v1/messages", &[], "{}").await;
    assert_eq!(res.status, 401);
    assert!(
        res.body.contains("Relay cannot use the sign-in of"),
        "names Relay, since the client's /login would not help"
    );
    no_token.stop().await;

    // upstream.url is closed now: nothing listens there.
    let dead = start_proxy(anthropic(&upstream.url), |h| h, None).await;
    let res = dead.post("/v1/messages", &[], "{}").await;
    assert_eq!(res.status, 502);
    assert!(res.body.contains("Gateway error"));
    dead.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn proxy_server_cancels_the_upstream_call_when_the_client_hangs_up() {
    let closed = Arc::new(Notify::new());
    let signal = closed.clone();
    let upstream = FakeUpstream::sync(move |_| {
        stream_reply(
            200,
            &[("content-type", "text/event-stream")],
            vec![(0, "event: ping\ndata: {}\n\n".into())],
            false,
            Some(signal.clone()),
        )
    })
    .await;
    let gateway = start_proxy(anthropic(&upstream.url), |h| h, None).await;
    let mut client = TcpStream::connect(("127.0.0.1", gateway.port))
        .await
        .unwrap();
    client
        .write_all(
            format!(
                "POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: 2\r\n\r\n{{}}",
                gateway.port
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut first = [0u8; 256];
    let read = tokio::time::timeout(Duration::from_secs(3), client.read(&mut first))
        .await
        .expect("no first chunk")
        .unwrap();
    assert!(read > 0);
    drop(client);
    tokio::time::timeout(Duration::from_secs(3), closed.notified())
        .await
        .expect("upstream socket was left open");
    gateway.stop().await;
    upstream.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn proxy_server_sends_codex_requests_under_the_upstreams_path_and_reads_responses_usage() {
    let upstream = FakeUpstream::sync(|_| {
        sse_once("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":100,\"output_tokens\":7,\"input_tokens_details\":{\"cached_tokens\":60}}}}\n\n")
    })
    .await;
    let gateway = start_proxy(
        Upstreams {
            codex_url: Some(format!("{}/backend-api/codex", upstream.url)),
            ..Default::default()
        },
        |h| h,
        None,
    )
    .await;
    // omp dials ChatGPT's own paths, `/codex/responses` and its compaction, under its base URL.
    for path in [
        "/v1/responses",
        "/responses",
        "/codex/responses",
        "/codex/responses/compact",
    ] {
        let res = gateway.post(path, &[], "{}").await;
        assert_eq!(res.status, 200, "{path}");
    }
    assert_eq!(
        upstream
            .seen()
            .iter()
            .map(|s| s.url.clone())
            .collect::<Vec<_>>(),
        [
            "/backend-api/codex/responses",
            "/backend-api/codex/responses",
            "/backend-api/codex/responses",
            "/backend-api/codex/responses/compact",
        ]
    );
    gateway.idle().await;
    let tokens = gateway.server.metrics().tokens_by_account["acc-1"];
    assert_eq!(
        (
            tokens.input,
            tokens.output,
            tokens.cache_read,
            tokens.cache_write
        ),
        (160.0, 28.0, 240.0, 0.0)
    );
    gateway.stop().await;
    upstream.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn openai_api_keys_use_the_public_openai_endpoint_not_the_codex_oauth_endpoint() {
    let upstream =
        FakeUpstream::sync(|_| json_reply(200, r#"{"id":"ok","choices":[]}"#, &[])).await;
    let gateway = start_proxy(
        Upstreams {
            openai_url: Some(format!("{}/v1", upstream.url)),
            ..Default::default()
        },
        |h| h.token("sk-test-key"),
        Some(Provider::Codex),
    )
    .await;
    let res = gateway
        .post(
            "/v1/chat/completions",
            &[],
            r#"{"model":"gpt-4.1","messages":[]}"#,
        )
        .await;
    assert_eq!(res.status, 200);
    assert_eq!(upstream.seen()[0].url, "/v1/chat/completions");
    assert_eq!(
        upstream.seen()[0].header("authorization"),
        Some("Bearer sk-test-key")
    );
    gateway.stop().await;
    upstream.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn antigravity_requests_use_the_selected_accounts_oauth_sidecar_for_all_supported_protocols()
{
    let upstream =
        FakeUpstream::sync(|_| json_reply(200, r#"{"id":"ok","choices":[]}"#, &[])).await;
    let sidecar = upstream.url.clone();
    let gateway = start_proxy(
        Upstreams {
            codex_url: Some(format!("{}/wrong", upstream.url)),
            ..Default::default()
        },
        move |h| {
            h.credential_result(|_| async {
                Err("Antigravity must not read a pasted API key".to_string())
            })
            .antigravity(move |_| {
                let url = sidecar.clone();
                async move {
                    Some(AntigravityRoute {
                        url,
                        key: "sidecar-client-key".into(),
                    })
                }
            })
        },
        Some(Provider::Antigravity),
    )
    .await;
    let chat = gateway
        .post(
            "/v1/chat/completions",
            &[],
            r#"{"model":"gemini-3.8-flash","messages":[]}"#,
        )
        .await;
    assert_eq!(chat.status, 200);
    assert_eq!(upstream.seen()[0].url, "/v1/chat/completions");
    assert_eq!(
        upstream.seen()[0].header("authorization"),
        Some("Bearer sidecar-client-key")
    );
    let responses = gateway
        .post(
            "/v1/responses",
            &[("x-relay-provider", "antigravity")],
            "{}",
        )
        .await;
    assert_eq!(responses.status, 200);
    let messages = gateway
        .post("/v1/messages", &[("x-relay-provider", "antigravity")], "{}")
        .await;
    assert_eq!(messages.status, 200);
    assert_eq!(
        upstream
            .seen()
            .iter()
            .map(|s| s.url.clone())
            .collect::<Vec<_>>(),
        ["/v1/chat/completions", "/v1/responses", "/v1/messages"]
    );
    gateway.stop().await;
    upstream.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn antigravity_cannot_be_served_without_an_oauth_sidecar_credential() {
    let gateway = start_proxy(
        Upstreams::default(),
        |h| h.token("wrong-token"),
        Some(Provider::Antigravity),
    )
    .await;
    let result = gateway
        .post(
            "/v1/chat/completions",
            &[],
            r#"{"model":"gemini-3.8-flash","messages":[]}"#,
        )
        .await;
    assert_eq!(result.status, 401);
    gateway.stop().await;
}

/// A raw WebSocket upstream: checks the credential, answers 101, then echoes.
async fn websocket_upstream() -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if socket.read(&mut byte).await.unwrap_or(0) == 0 {
                        return;
                    }
                    head.push(byte[0]);
                }
                let text = String::from_utf8_lossy(&head).to_lowercase();
                assert!(text.contains("authorization: bearer tok-1"), "{text}");
                socket
                    .write_all(b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
                    .await
                    .unwrap();
                let mut buffer = [0u8; 1024];
                while let Ok(n) = socket.read(&mut buffer).await {
                    if n == 0 {
                        break;
                    }
                    let reply = format!("echo:{}", String::from_utf8_lossy(&buffer[..n]));
                    if socket.write_all(reply.as_bytes()).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    (port, task)
}

async fn upgrade_request(port: u16) -> TcpStream {
    let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    client
        .write_all(
            format!(
                "GET /responses HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    client
}

async fn read_head(client: &mut TcpStream) -> String {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if client.read(&mut byte).await.unwrap_or(0) == 0 {
            break;
        }
        head.push(byte[0]);
    }
    String::from_utf8_lossy(&head).into_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn proxy_server_bridges_a_websocket_upgrade_and_answers_502_when_the_upstream_is_down() {
    let (upstream_port, upstream) = websocket_upstream().await;
    let ws = Upstreams {
        codex_websocket_url: Some(format!("ws://127.0.0.1:{upstream_port}/ws")),
        ..Default::default()
    };
    let gateway = start_proxy(ws.clone(), |h| h, None).await;
    let mut client = upgrade_request(gateway.port).await;
    let head = read_head(&mut client).await;
    assert!(head.starts_with("HTTP/1.1 101"), "{head}");
    client.write_all(b"hi").await.unwrap();
    let mut buffer = [0u8; 64];
    let n = tokio::time::timeout(Duration::from_secs(3), client.read(&mut buffer))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&buffer[..n], b"echo:hi");
    drop(client);
    gateway.stop().await;
    upstream.abort();
    let _ = upstream.await;

    // Nothing listens on that port any more.
    let dead = start_proxy(ws, |h| h, None).await;
    let mut client = upgrade_request(dead.port).await;
    let head = read_head(&mut client).await;
    assert!(head.starts_with("HTTP/1.1 502"), "{head}");
    dead.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn proxy_server_stop_returns_while_a_stream_is_still_open_and_a_second_start_works() {
    let upstream =
        FakeUpstream::sync(|_| sse(vec![(0, "event: ping\ndata: {}\n\n".into())], false)).await;
    let gateway = start_proxy(anthropic(&upstream.url), |h| h, None).await;
    let port = gateway.port;
    let open = tokio::spawn(async move {
        let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        client
            .write_all(format!("POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 2\r\n\r\n{{}}").as_bytes())
            .await
            .unwrap();
        let mut sink = Vec::new();
        let _ = client.read_to_end(&mut sink).await;
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    tokio::time::timeout(Duration::from_secs(5), gateway.stop())
        .await
        .expect("stop returns");
    assert_eq!(gateway.server.state().status, ProxyRunStatus::Stopped);
    let again = gateway.server.start().await.unwrap();
    assert_eq!(again.status, ProxyRunStatus::Running);
    gateway.stop().await;
    upstream.close().await;
    let _ = open.await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_limited_accounts_request_is_retried_on_the_next_account_before_anything_reaches_the_client()
 {
    let reset = (now_ms() / 1000 + 3 * 3600).to_string();
    let upstream = FakeUpstream::sync(move |seen| {
        if seen.token() == "tok-a" {
            // The 5-hour window is exhausted until this reset (epoch seconds).
            return json_reply(
                429,
                r#"{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}"#,
                &[
                    ("anthropic-ratelimit-unified-status", "rejected"),
                    ("anthropic-ratelimit-unified-reset", &reset),
                ],
            );
        }
        json_reply(200, r#"{"ok":true}"#, &[])
    })
    .await;
    let gateway = start_pool(
        anthropic(&upstream.url),
        vec![named("a", "A"), named("b", "B")],
        |_| {},
        |h| h,
    )
    .await;
    let res = gateway.post("/v1/messages", &[], "{}").await;
    assert_eq!(
        res.status, 200,
        "the client sees the second account's answer"
    );
    assert_eq!(upstream.tokens(), ["tok-a", "tok-b"]);
    // A is out until its window resets, not for a minute: the next request goes straight to B.
    let next = gateway.post("/v1/messages", &[], "{}").await;
    assert_eq!(next.status, 200);
    assert_eq!(upstream.count(), 3);
    assert_eq!(upstream.seen()[2].token(), "tok-b");
    let cooldown = gateway.server.router().cooldown_of("a").unwrap().until;
    assert!(
        cooldown - now_ms() > (2.9 * 3_600_000.0) as i64,
        "cooldown follows the reset header"
    );
    gateway.stop().await;
    upstream.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_account_without_a_readable_sign_in_is_skipped_for_the_next_one() {
    let upstream = FakeUpstream::sync(|_| json_reply(200, "{}", &[])).await;
    let gateway = start_pool(
        anthropic(&upstream.url),
        vec![named("a", "A"), named("b", "B")],
        |_| {},
        |h| h.credential(|a| async move { (a.id != "a").then(|| "tok-b".to_string()) }),
    )
    .await;
    let res = gateway.post("/v1/messages", &[], "{}").await;
    assert_eq!(res.status, 200);
    assert_eq!(upstream.tokens(), ["tok-b"]);
    gateway.stop().await;
    upstream.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_client_key_is_accepted_in_any_of_its_headers_compared_exactly_and_never_forwarded() {
    let upstream = FakeUpstream::sync(|_| json_reply(200, "{}", &[])).await;
    let key = "relay-sec-test-key";
    let gateway = start_pool(
        anthropic(&upstream.url),
        vec![named("a", "A")],
        |c| c.api_key = Some(key.into()),
        |h| h,
    )
    .await;
    let post = |extra: Vec<(&'static str, String)>| {
        let port = gateway.port;
        async move {
            let pairs: Vec<(&str, &str)> = extra.iter().map(|(n, v)| (*n, v.as_str())).collect();
            request(port, "POST", "/v1/messages", &pairs, "{}")
                .await
                .status
        }
    };
    assert_eq!(post(vec![]).await, 401);
    assert_eq!(
        post(vec![("x-api-key", "relay-sec-wrong-key".into())]).await,
        401
    );
    assert_eq!(post(vec![("x-api-key", format!("{key}x"))]).await, 401);
    assert_eq!(
        post(vec![("authorization", format!("Bearer {key}"))]).await,
        200
    );
    assert_eq!(post(vec![("x-api-key", key.into())]).await, 200);
    // A client holding its own OAuth token in Authorization still gets in with the key elsewhere.
    assert_eq!(
        post(vec![
            ("authorization", "Bearer sk-ant-oat-own".into()),
            ("x-relay-key", key.into()),
            ("x-relay-provider", "claude".into()),
        ])
        .await,
        200
    );
    for seen in upstream.seen() {
        assert_eq!(seen.header("x-relay-key"), None);
        assert_eq!(seen.header("x-relay-provider"), None);
        assert_eq!(seen.header("x-api-key"), None);
        assert_eq!(seen.header("authorization"), Some("Bearer tok-a"));
    }
    // /status needs the key; /health does not.
    assert_eq!(gateway.get("/status", &[]).await.status, 401);
    assert_eq!(
        gateway.get("/status", &[("x-api-key", key)]).await.status,
        200
    );
    assert_eq!(gateway.get("/health", &[]).await.status, 200);
    gateway.stop().await;
    upstream.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_loopback_gateway_refuses_a_foreign_host_name_dns_rebinding() {
    let gateway = start_pool(
        anthropic("http://127.0.0.1:9"),
        vec![named("a", "A")],
        |_| {},
        |h| h,
    )
    .await;
    let foreign = gateway.get("/status", &[("host", "evil.example:80")]).await;
    assert_eq!(foreign.status, 403);
    let local_host = format!("localhost:{}", gateway.port);
    let local = gateway.get("/status", &[("host", &local_host)]).await;
    assert_eq!(local.status, 200);
    gateway.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_host_check_never_stands_aside_no_host_is_refused_a_tailnet_bind_answers_only_its_own_address()
 {
    let gateway = start_pool(
        anthropic("http://127.0.0.1:9"),
        vec![named("a", "A")],
        |_| {},
        |h| h,
    )
    .await;
    let port = gateway.port;
    // HTTP/1.0 may leave Host out; the gateway does not answer such a request.
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    socket
        .write_all(b"GET /api/hello HTTP/1.0\r\n\r\n")
        .await
        .unwrap();
    let mut bare = Vec::new();
    socket.read_to_end(&mut bare).await.unwrap();
    let bare = String::from_utf8_lossy(&bare);
    assert!(
        bare.starts_with("HTTP/1.0 403") || bare.starts_with("HTTP/1.1 403"),
        "{bare}"
    );
    gateway
        .server
        .update_config(|c| c.host = "100.64.0.1".into());
    let status = |host: String| async move {
        request(port, "GET", "/api/hello", &[("host", &host)], "")
            .await
            .status
    };
    assert_eq!(status(format!("100.64.0.1:{port}")).await, 200);
    assert_eq!(status(format!("localhost:{port}")).await, 200);
    assert_eq!(status("evil.example".into()).await, 403);
    assert_eq!(status(format!("192.168.1.5:{port}")).await, 403);
    gateway.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_tailnet_bind_also_answers_its_magicdns_names_a_loopback_bind_does_not() {
    let gateway = start_pool(
        anthropic("http://127.0.0.1:9"),
        vec![named("a", "A")],
        |_| {},
        |h| h,
    )
    .await;
    let port = gateway.port;
    let status = |host: String| async move {
        request(port, "GET", "/api/hello", &[("host", &host)], "")
            .await
            .status
    };
    assert_eq!(status("mymac.tail1234.ts.net".into()).await, 403);
    assert_eq!(status(format!("mymac:{port}")).await, 403);
    gateway
        .server
        .update_config(|c| c.host = "100.101.102.103".into());
    assert_eq!(status("mymac.tail1234.ts.net".into()).await, 200);
    assert_eq!(status(format!("MyMac.Tail1234.TS.NET:{port}")).await, 200);
    assert_eq!(status("mymac".into()).await, 200);
    assert_eq!(status(format!("mymac:{port}")).await, 200);
    assert_eq!(status(format!("127.0.0.1:{port}")).await, 200);
    assert_eq!(status("ts.net".into()).await, 403);
    assert_eq!(status("evil.ts.net.example".into()).await, 403);
    assert_eq!(status("127.evil.example".into()).await, 403);
    assert_eq!(status("[fe80::1]".into()).await, 403);
    gateway.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn request_bodies_held_at_once_are_capped_across_requests_past_the_cap_the_gateway_answers_503()
 {
    let gateway = Gateway::start_with(
        config(),
        Hooks::new(vec![named("a", "A")]).token("tok"),
        anthropic("http://127.0.0.1:9"),
        ServerOptions {
            max_buffered_bytes: Some(1_000),
            ..Default::default()
        },
    )
    .await;
    let port = gateway.port;
    // A body still arriving holds its bytes.
    let mut slow = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    slow.write_all(
        format!(
            "POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: 2000\r\n\r\n{}",
            "x".repeat(600)
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    // Real sockets: nothing tells the client when the gateway has read the bytes, so it waits.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let body = serde_json::json!({ "pad": "y".repeat(600) }).to_string();
    let refused = gateway.post("/v1/messages", &[], &body).await;
    assert_eq!(refused.status, 503);
    assert_eq!(
        refused.json(),
        serde_json::json!({
            "type": "error",
            "error": { "type": "overloaded_error", "message": "Relay is holding too many request bodies at once" },
        })
    );
    assert_eq!(refused.header("retry-after"), Some("1"));
    // Once the slow client leaves, its bytes are let go and the next body is taken.
    drop(slow);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let taken = gateway.post("/v1/messages", &[], &body).await;
    assert!(!taken.body.contains("too many request bodies"));
    gateway.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_provider_without_an_account_is_a_503_not_a_cooldown() {
    let gateway = start_pool(
        anthropic("http://127.0.0.1:9"),
        vec![named("a", "A")],
        |_| {},
        |h| h,
    )
    .await;
    let res = gateway
        .post("/v1/responses", &[], r#"{"model":"gpt-5"}"#)
        .await;
    assert_eq!(res.status, 503);
    assert!(res.body.contains("No codex account"));
    gateway.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_short_429_cools_an_account_for_its_retry_after_not_until_the_windows_ordinary_reset() {
    let reset = (now_ms() / 1000 + 5 * 3600).to_string();
    let upstream = FakeUpstream::sync(move |_| {
        json_reply(
            429,
            "{}",
            &[
                ("retry-after", "10"),
                // Sent with every answer; the window itself is not exhausted.
                ("anthropic-ratelimit-unified-status", "allowed"),
                ("anthropic-ratelimit-unified-reset", &reset),
            ],
        )
    })
    .await;
    let gateway = start_pool(
        anthropic(&upstream.url),
        vec![named("a", "A")],
        |_| {},
        |h| h,
    )
    .await;
    gateway.post("/v1/messages", &[], "{}").await;
    gateway.idle().await;
    let cooldown = gateway.server.router().cooldown_of("a").unwrap().until;
    assert!(cooldown - now_ms() <= 11_000, "only the Retry-After");
    gateway.stop().await;
    upstream.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn chat_completions_skip_a_codex_chatgpt_sign_in_for_an_openai_api_key_account() {
    let openai = FakeUpstream::sync(|_| json_reply(200, "{}", &[])).await;
    let mut chatgpt = with_provider(named("chatgpt", "ChatGPT"), Provider::Codex);
    chatgpt.auth = Some(AccountAuth {
        logged_in: true,
        account_uuid: Some("33333333-3333-4333-8333-333333333333".into()),
        ..Default::default()
    });
    let key = with_provider(named("key", "Key"), Provider::Codex);
    let tokens = |h: Hooks| {
        h.credential(|a| async move {
            Some(
                if a.id == "key" {
                    "sk-test"
                } else {
                    "chatgpt-token"
                }
                .to_string(),
            )
        })
    };
    let gateway = start_pool(
        Upstreams {
            openai_url: Some(openai.url.clone()),
            codex_url: Some("http://127.0.0.1:9".into()),
            ..Default::default()
        },
        vec![chatgpt.clone(), key],
        |_| {},
        tokens,
    )
    .await;
    let res = gateway
        .post("/v1/chat/completions", &[], r#"{"model":"gpt-5"}"#)
        .await;
    assert_eq!(res.status, 200);
    assert_eq!(openai.tokens(), ["sk-test"]);
    gateway.stop().await;
    openai.close().await;
    // With only the ChatGPT sign-in, the answer says what is missing.
    let only = start_pool(
        Upstreams {
            codex_url: Some("http://127.0.0.1:9".into()),
            ..Default::default()
        },
        vec![chatgpt],
        |_| {},
        |h| h.token("chatgpt-token"),
    )
    .await;
    let res = only
        .post("/v1/chat/completions", &[], r#"{"model":"gpt-5"}"#)
        .await;
    assert_eq!(res.status, 501);
    assert!(res.body.contains("Responses API only"));
    only.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_claude_code_session_keeps_its_account_by_its_session_header_whatever_its_body_says() {
    let upstream = FakeUpstream::sync(|_| json_reply(200, r#"{"ok":true}"#, &[])).await;
    let gateway = start_pool(
        anthropic(&upstream.url),
        vec![named("a", "A"), named("b", "B")],
        |_| {},
        |h| h,
    )
    .await;
    let send = |session: &'static str, body: serde_json::Value| {
        let port = gateway.port;
        async move {
            request(
                port,
                "POST",
                "/v1/messages",
                &[("x-claude-code-session-id", session)],
                &body.to_string(),
            )
            .await
        }
    };
    send("s-1", serde_json::json!({ "messages": [{ "role": "user", "content": "The first prompt of this conversation." }] })).await;
    // A is nearly full: new sessions go to B, a session already on A stays for its cache.
    let soon = iso(now_ms() + 3_600_000);
    let mut usage = ready(
        "a",
        Some(window(97.0, Some(soon.clone()))),
        Some(window(10.0, Some(soon))),
    );
    usage.checked_at = Some(iso(now_ms()));
    gateway.hooks.update_usage(|map| {
        map.insert("a".into(), usage);
    });
    // The same session after a compaction: another first message, and a subagent's own metadata.
    send(
        "s-1",
        serde_json::json!({ "messages": [{ "role": "user", "content": "A summary that replaced the history." }], "metadata": { "user_id": "another" } }),
    )
    .await;
    send("s-2", serde_json::json!({ "messages": [{ "role": "user", "content": "The first prompt of this conversation." }] })).await;
    assert_eq!(upstream.tokens(), ["tok-a", "tok-a", "tok-b"]);
    gateway.stop().await;
    upstream.close().await;
}

/// A pool of accounts with tokens `tok-<id>`, a clock the test moves, and a reply per token.
struct Clocked {
    gateway: Gateway,
    upstream: FakeUpstream,
    clock: TestClock,
}

impl Clocked {
    async fn start(
        reply: impl Fn(&str, &Seen) -> http::Response<relay_gateway::client_res::ResponseBody>
        + Send
        + Sync
        + 'static,
        ids: &[&str],
        hooks: impl FnOnce(Hooks) -> Hooks,
        usage: relay_gateway::UsageMap,
    ) -> Clocked {
        let upstream = FakeUpstream::sync(move |seen| reply(&seen.token(), seen)).await;
        let clock = TestClock::new(now_ms());
        let accounts = ids.iter().map(|id| named(id, &id.to_uppercase())).collect();
        let mut config = config();
        config.routing_strategy = RoutingStrategy::StrictPriority;
        let gateway = Gateway::start_with(
            config,
            hooks(Hooks::new(accounts)).usage(usage),
            anthropic(&upstream.url),
            ServerOptions {
                now: Some(clock.clock()),
                ..Default::default()
            },
        )
        .await;
        Clocked {
            gateway,
            upstream,
            clock,
        }
    }

    async fn send(&self, session: &str) -> Answer {
        let answer = self
            .gateway
            .post(
                "/v1/messages",
                &[("x-claude-code-session-id", session)],
                "{}",
            )
            .await;
        self.gateway.idle().await;
        answer
    }

    fn tokens(&self) -> Vec<String> {
        self.upstream.tokens()
    }

    fn peek(&self, key: &str) -> Option<String> {
        self.gateway.server.session_cache().peek(key)
    }

    fn cooldown(&self, id: &str) -> Option<relay_gateway::proxy_router::Cooldown> {
        self.gateway.server.router().cooldown_of(id)
    }

    async fn close(&self) {
        self.gateway.stop().await;
        self.upstream.close().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_overload_on_a_sessions_account_is_served_elsewhere_once_and_the_session_comes_back_to_its_cache()
 {
    let overloaded = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = overloaded.clone();
    let pool = Clocked::start(
        move |token, _| {
            if token == "tok-a" && flag.swap(false, std::sync::atomic::Ordering::SeqCst) {
                return json_reply(529, &error_body("overloaded_error", "Overloaded"), &[]);
            }
            ok_reply()
        },
        &["a", "b"],
        |h| h,
        Default::default(),
    )
    .await;
    pool.send("s-1").await;
    overloaded.store(true, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(
        pool.send("s-1").await.status,
        200,
        "B answered in its place"
    );
    assert_eq!(
        pool.peek("hdr:s-1").as_deref(),
        Some("a"),
        "the session is still A's"
    );
    assert_eq!(
        pool.cooldown("a").map(|c| c.reason),
        Some(CooldownReason::Transient)
    );
    pool.clock.advance(11_000);
    pool.send("s-1").await;
    assert_eq!(pool.tokens(), ["tok-a", "tok-a", "tok-b", "tok-a"]);
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_sign_in_drops_the_token_and_asks_for_a_renewal_but_the_session_waits_for_its_account()
 {
    let refuse = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = refuse.clone();
    let pool = Clocked::start(
        move |token, _| {
            if token == "tok-a" && flag.load(std::sync::atomic::Ordering::SeqCst) {
                json_reply(
                    401,
                    &error_body("authentication_error", "OAuth token has expired"),
                    &[],
                )
            } else {
                ok_reply()
            }
        },
        &["a", "b"],
        |h| h,
        Default::default(),
    )
    .await;
    pool.send("x").await;
    pool.send("y").await;
    refuse.store(true, std::sync::atomic::Ordering::SeqCst);
    pool.send("x").await;
    refuse.store(false, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(*pool.gateway.hooks.rejected.lock().unwrap(), ["a"]);
    assert_eq!(pool.peek("hdr:x").as_deref(), Some("a"));
    assert_eq!(
        pool.peek("hdr:y").as_deref(),
        Some("a"),
        "the account's other sessions stay too"
    );
    pool.clock.advance(31_000);
    pool.send("y").await;
    assert_eq!(pool.tokens().last().map(String::as_str), Some("tok-a"));
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_403_about_a_model_moves_only_that_session_and_leaves_the_account_and_its_token_alone() {
    let pool = Clocked::start(
        |token, seen| {
            if token == "tok-a" && seen.header("x-claude-code-session-id") == Some("opus") {
                json_reply(
                    403,
                    &error_body(
                        "permission_error",
                        "This model is not available on your plan",
                    ),
                    &[],
                )
            } else {
                ok_reply()
            }
        },
        &["a", "b"],
        |h| h,
        Default::default(),
    )
    .await;
    pool.send("other").await;
    assert_eq!(pool.send("opus").await.status, 200);
    assert!(pool.gateway.hooks.rejected.lock().unwrap().is_empty());
    assert_eq!(pool.cooldown("a"), None);
    assert_eq!(pool.peek("hdr:opus").as_deref(), Some("b"));
    assert_eq!(pool.peek("hdr:other").as_deref(), Some("a"));
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_challenge_page_in_front_of_the_api_is_not_a_refused_sign_in() {
    let challenge = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let flag = challenge.clone();
    let pool = Clocked::start(
        move |token, _| {
            if token == "tok-a" && flag.swap(false, std::sync::atomic::Ordering::SeqCst) {
                let mut res = json_reply(403, "<html>Just a moment...</html>", &[]);
                res.headers_mut()
                    .insert("content-type", http::HeaderValue::from_static("text/html"));
                return res;
            }
            ok_reply()
        },
        &["a", "b"],
        |h| h,
        Default::default(),
    )
    .await;
    assert_eq!(pool.send("s-1").await.status, 200);
    assert!(pool.gateway.hooks.rejected.lock().unwrap().is_empty());
    assert_eq!(
        pool.cooldown("a").map(|c| c.reason),
        Some(CooldownReason::Transient)
    );
    assert_eq!(pool.peek("hdr:s-1").as_deref(), Some("a"));
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_5_hour_limit_keeps_the_account_out_until_the_5_hour_reset_not_the_weekly_one_the_overall_header_names()
 {
    let five_hours = now_ms() / 1000 + 3600;
    let week = now_ms() / 1000 + 3 * 86_400;
    let pool = Clocked::start(
        move |token, _| {
            if token != "tok-a" {
                return ok_reply();
            }
            json_reply(
                429,
                &error_body("rate_limit_error", "limit"),
                &[
                    ("anthropic-ratelimit-unified-status", "rejected"),
                    ("anthropic-ratelimit-unified-reset", &week.to_string()),
                    ("anthropic-ratelimit-unified-5h-status", "rejected"),
                    (
                        "anthropic-ratelimit-unified-5h-reset",
                        &five_hours.to_string(),
                    ),
                    ("anthropic-ratelimit-unified-7d-status", "allowed"),
                    ("anthropic-ratelimit-unified-7d-reset", &week.to_string()),
                ],
            )
        },
        &["a", "b"],
        |h| h,
        Default::default(),
    )
    .await;
    pool.send("s-1").await;
    let until = pool.cooldown("a").unwrap().until;
    assert!(
        (until - five_hours * 1000).abs() < 2_000,
        "the 5-hour window's own reset"
    );
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_account_relay_read_as_full_is_not_tried_and_a_pool_with_no_room_answers_at_once_with_the_first_reset()
 {
    let reset = iso(now_ms() + 2 * 3_600_000);
    let mut usage = relay_gateway::UsageMap::new();
    usage.insert(
        "b".into(),
        ready(
            "b",
            Some(window(0.0, None)),
            Some(window(100.0, Some(reset))),
        ),
    );
    let pool = Clocked::start(
        |token, _| {
            if token == "tok-a" {
                json_reply(
                    429,
                    &error_body("rate_limit_error", "limit"),
                    &[("retry-after", "600")],
                )
            } else {
                ok_reply()
            }
        },
        &["a", "b"],
        |h| h,
        usage,
    )
    .await;
    let first = pool.send("s-1").await;
    assert_eq!(first.status, 429);
    assert_eq!(
        pool.tokens(),
        ["tok-a"],
        "B is full until its weekly reset: no request is spent on it"
    );
    let second = pool.send("s-2").await;
    assert_eq!(second.status, 429);
    assert_eq!(pool.tokens().len(), 1, "answered by the gateway itself");
    assert!(
        second
            .header("retry-after")
            .unwrap()
            .parse::<u64>()
            .unwrap()
            >= 590
    );
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn accounts_whose_sign_in_cannot_be_read_do_not_use_up_the_tries_and_are_sent_for_renewal() {
    let upstream = FakeUpstream::sync(|_| ok_reply()).await;
    let accounts = ["a", "b", "c", "good"]
        .iter()
        .map(|id| named(id, &id.to_uppercase()))
        .collect();
    let mut config = config();
    config.routing_strategy = RoutingStrategy::StrictPriority;
    let hooks = Hooks::new(accounts)
        .credential(|a| async move { (a.id == "good").then(|| "tok-good".to_string()) });
    let gateway = Gateway::start(config, hooks, anthropic(&upstream.url)).await;
    let res = gateway.post("/v1/messages", &[], "{}").await;
    assert_eq!(res.status, 200);
    assert_eq!(*gateway.hooks.missing.lock().unwrap(), ["a", "b", "c"]);
    gateway.stop().await;
    upstream.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn when_no_sign_in_can_be_used_the_client_hears_so_not_a_rate_limit_it_would_wait_out() {
    let upstream = FakeUpstream::sync(|_| ok_reply()).await;
    let hooks = Hooks::new(vec![named("a", "Alto")]).credential(|_| async { None });
    let gateway = Gateway::start(config(), hooks, anthropic(&upstream.url)).await;
    let first = gateway.post("/v1/messages", &[], "{}").await;
    assert_eq!(first.status, 401);
    assert!(first.body.contains("sign-in of Alto"));
    let second = gateway.post("/v1/messages", &[], "{}").await;
    assert_eq!(
        second.status, 401,
        "still a sign-in problem while the account waits"
    );
    assert!(second.body.contains("Renew it in Relay"));
    gateway.stop().await;
    upstream.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_answer_billed_as_extra_usage_moves_the_accounts_sessions_and_keeps_it_out_until_its_window_resets()
 {
    let reset = iso(now_ms() + 90 * 60_000);
    let mut usage = relay_gateway::UsageMap::new();
    usage.insert(
        "a".into(),
        ready("a", Some(window(92.0, Some(reset.clone()))), None),
    );
    let pool = Clocked::start(
        |token, _| {
            if token == "tok-a" {
                json_reply(
                    200,
                    r#"{"type":"message"}"#,
                    &[("anthropic-ratelimit-unified-overage-in-use", "true")],
                )
            } else {
                ok_reply()
            }
        },
        &["a", "b"],
        |h| h,
        usage,
    )
    .await;
    pool.send("s-1").await;
    // The answer reached the client; the gateway settles its outcome right after.
    tokio::time::sleep(Duration::from_millis(50)).await;
    let cooldown = pool.cooldown("a").unwrap();
    assert_eq!(cooldown.reason, CooldownReason::Limit);
    assert!((cooldown.until - parse(&reset)).abs() < 2_000);
    assert_eq!(pool.peek("hdr:s-1"), None);
    assert_eq!(
        pool.gateway.server.metrics().extra_usage.unwrap()["a"].kind,
        relay_gateway::ExtraUsageKind::Billed
    );
    pool.send("s-1").await;
    assert_eq!(pool.tokens(), ["tok-a", "tok-b"]);
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_request_that_needs_extra_usage_moves_to_another_account_without_benching_this_one() {
    let pool = Clocked::start(
        |token, _| {
            if token == "tok-a" {
                json_reply(
                    429,
                    &error_body(
                        "rate_limit_error",
                        "Extra usage is required for long context requests.",
                    ),
                    &[],
                )
            } else {
                ok_reply()
            }
        },
        &["a", "b"],
        |h| h,
        Default::default(),
    )
    .await;
    assert_eq!(pool.send("s-1").await.status, 200);
    assert_eq!(pool.cooldown("a"), None);
    assert_eq!(pool.peek("hdr:s-1").as_deref(), Some("b"));
    assert_eq!(
        pool.gateway.server.metrics().extra_usage.unwrap()["a"].kind,
        relay_gateway::ExtraUsageKind::Required
    );
    pool.close().await;
}

#[test]
fn alias_codex_path_maps_chatgpts_codex_responses_to_responses_and_leaves_other_paths() {
    let cases = [
        ("/codex/responses", "/responses"),
        ("/codex/responses/", "/responses"),
        ("/codex/responses?stream=true", "/responses?stream=true"),
        ("/codex/responses/compact", "/responses/compact"),
        ("/codex/responses/compact?x=1", "/responses/compact?x=1"),
        ("/codex/responses/compactx", "/codex/responses/compactx"),
        ("/codex/responsesx", "/codex/responsesx"),
        ("/v1/responses", "/v1/responses"),
    ];
    for (from, to) in cases {
        assert_eq!(alias_codex_path(from), to, "{from}");
    }
}

// Not in the TypeScript file: `relay proxy status` and the app read these bytes, so their
// field names and order are pinned to what the TypeScript gateway wrote.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn status_and_health_answer_the_typescript_gateways_json_byte_for_byte() {
    let gateway = start_proxy(Upstreams::default(), |h| h, None).await;
    let port = gateway.port;
    assert_eq!(
        gateway.get("/health", &[]).await.body,
        r#"{"ok":true,"status":"running"}"#
    );
    assert_eq!(
        gateway.get("/api/hello", &[]).await.body,
        r#"{"message":"hello"}"#
    );
    assert_eq!(
        gateway.get("/status", &[]).await.body,
        format!(
            r#"{{"ok":true,"state":{{"status":"running","port":{port},"host":"127.0.0.1","endpointUrl":"http://127.0.0.1:{port}","activeSessionsCount":0,"uptimeSeconds":0}},"metrics":{{"totalRequests":0,"activeSessions":0,"requestsByAccount":{{}},"tokensByAccount":{{}},"cacheHitRatio":0,"activeRequests":1,"promptCacheHits":0}}}}"#
        )
    );
    let missing = gateway.post("/v1/nothing", &[], "{}").await;
    assert_eq!(missing.status, 404);
    assert_eq!(
        missing.body,
        r#"{"type":"error","error":{"type":"not_found","message":"Path '/v1/nothing' not supported by Relay proxy"}}"#
    );
    gateway.stop().await;
}
