//! Shared test harness: local fake upstreams, a raw HTTP client, configurable hooks and a
//! clock tests move, as the TypeScript tests build them.
#![allow(dead_code)]

use bytes::{Bytes, BytesMut};
use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use http::{HeaderMap, HeaderName, HeaderValue, Response, StatusCode};
use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use relay_gateway::client_res::ResponseBody;
use relay_gateway::js::Clock;
use relay_gateway::proxy_request_log::GatewayRequestLog;
use relay_gateway::{
    Account, AccountUsage, AntigravityRoute, GatewayHooks, LiveLimits, OverflowCost, ProxyConfig,
    ProxyLoopAlarm, ProxyRequestLog, ProxyServer, ServerOptions, Upstreams, UsageMap,
    UsageSnapshot,
};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, mpsc, watch};

// ---------------------------------------------------------------- clock

#[derive(Clone)]
pub struct TestClock(pub Arc<AtomicI64>);

impl TestClock {
    pub fn new(at: i64) -> Self {
        TestClock(Arc::new(AtomicI64::new(at)))
    }
    pub fn now(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
    pub fn set(&self, at: i64) {
        self.0.store(at, Ordering::SeqCst);
    }
    pub fn advance(&self, ms: i64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
    pub fn clock(&self) -> Clock {
        let at = self.0.clone();
        Arc::new(move || at.load(Ordering::SeqCst))
    }
}

pub fn fixed(at: i64) -> Clock {
    Arc::new(move || at)
}

pub fn now_ms() -> i64 {
    relay_gateway::js::now_ms()
}

pub fn iso(ms: i64) -> String {
    relay_gateway::js::iso_string(ms)
}

/// `Date.UTC(year, monthIndex, day, hour, minute)`.
pub fn utc(year: i32, month0: u32, day: u32, hour: u32, minute: u32) -> i64 {
    use chrono::TimeZone;
    chrono::Utc
        .with_ymd_and_hms(year, month0 + 1, day, hour, minute, 0)
        .unwrap()
        .timestamp_millis()
}

pub fn parse(text: &str) -> i64 {
    relay_gateway::js::parse_date(text).unwrap()
}

// ---------------------------------------------------------------- accounts and usage

pub fn account(id: &str) -> Account {
    Account::new(id, id)
}

pub fn named(id: &str, name: &str) -> Account {
    Account::new(id, name)
}

pub fn with_provider(mut account: Account, provider: relay_gateway::Provider) -> Account {
    account.provider = Some(provider);
    account
}

pub fn window(used: f64, resets_at: Option<String>) -> relay_gateway::UsageWindow {
    relay_gateway::UsageWindow::new(used, resets_at)
}

pub fn ready(
    id: &str,
    five: Option<relay_gateway::UsageWindow>,
    week: Option<relay_gateway::UsageWindow>,
) -> AccountUsage {
    AccountUsage::ready(id, five, week)
}

pub fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (name, value) in pairs {
        map.append(
            HeaderName::from_bytes(name.as_bytes()).unwrap(),
            HeaderValue::from_str(value).unwrap(),
        );
    }
    map
}

// ---------------------------------------------------------------- hooks

type CredentialFn =
    Box<dyn Fn(Account) -> BoxFuture<'static, Result<Option<String>, String>> + Send + Sync>;
type AntigravityFn = Box<
    dyn Fn(Account) -> BoxFuture<'static, Result<Option<AntigravityRoute>, String>> + Send + Sync,
>;

/// Hooks a test configures and reads back.
pub struct Hooks {
    pub snapshot: Mutex<Arc<UsageSnapshot>>,
    pub credential: CredentialFn,
    pub antigravity: Option<AntigravityFn>,
    pub rejected: Mutex<Vec<String>>,
    pub missing: Mutex<Vec<String>>,
    pub live: Mutex<Vec<(String, LiveLimits)>>,
    pub bound: Mutex<Vec<(String, String)>>,
    pub recorded: Mutex<Vec<ProxyRequestLog>>,
    pub alarms: Mutex<Vec<ProxyLoopAlarm>>,
    pub request_log: Option<Mutex<GatewayRequestLog>>,
    pub overflow_key: Option<String>,
    pub time_zone: Option<String>,
}

impl Hooks {
    /// Every account's token is `tok-<id>`.
    pub fn new(accounts: Vec<Account>) -> Self {
        Hooks {
            snapshot: Mutex::new(Arc::new(UsageSnapshot {
                accounts,
                usage_map: UsageMap::new(),
            })),
            credential: Box::new(|a| async move { Ok(Some(format!("tok-{}", a.id))) }.boxed()),
            antigravity: None,
            rejected: Mutex::default(),
            missing: Mutex::default(),
            live: Mutex::default(),
            bound: Mutex::default(),
            recorded: Mutex::default(),
            alarms: Mutex::default(),
            request_log: None,
            overflow_key: None,
            time_zone: None,
        }
    }

    pub fn credential<F, Fut>(mut self, f: F) -> Self
    where
        F: Fn(Account) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Option<String>> + Send + 'static,
    {
        self.credential = Box::new(move |a| f(a).map(Ok).boxed());
        self
    }

    pub fn credential_result<F, Fut>(mut self, f: F) -> Self
    where
        F: Fn(Account) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Option<String>, String>> + Send + 'static,
    {
        self.credential = Box::new(move |a| f(a).boxed());
        self
    }

    pub fn token(self, token: &'static str) -> Self {
        self.credential(move |_| async move { Some(token.to_string()) })
    }

    pub fn antigravity<F, Fut>(mut self, f: F) -> Self
    where
        F: Fn(Account) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Option<AntigravityRoute>> + Send + 'static,
    {
        self.antigravity = Some(Box::new(move |a| f(a).map(Ok).boxed()));
        self
    }

    pub fn usage(self, usage: UsageMap) -> Self {
        self.set_usage(usage);
        self
    }

    pub fn set_usage(&self, usage: UsageMap) {
        let mut snapshot = self.snapshot.lock().unwrap();
        *snapshot = Arc::new(UsageSnapshot {
            accounts: snapshot.accounts.clone(),
            usage_map: usage,
        });
    }

    pub fn update_usage(&self, change: impl FnOnce(&mut UsageMap)) {
        let mut snapshot = self.snapshot.lock().unwrap();
        let mut usage = snapshot.usage_map.clone();
        change(&mut usage);
        *snapshot = Arc::new(UsageSnapshot {
            accounts: snapshot.accounts.clone(),
            usage_map: usage,
        });
    }

    pub fn with_log(mut self, log: GatewayRequestLog) -> Self {
        self.request_log = Some(Mutex::new(log));
        self
    }
}

#[async_trait::async_trait]
impl GatewayHooks for Hooks {
    async fn credential(&self, account: &Account) -> Result<Option<String>, String> {
        (self.credential)(account.clone()).await
    }
    async fn antigravity(&self, account: &Account) -> Result<Option<AntigravityRoute>, String> {
        match &self.antigravity {
            Some(f) => f(account.clone()).await,
            None => Ok(None),
        }
    }
    fn usage(&self) -> Arc<UsageSnapshot> {
        self.snapshot.lock().unwrap().clone()
    }
    fn on_live_limits(&self, account_id: &str, live: &LiveLimits) {
        self.live
            .lock()
            .unwrap()
            .push((account_id.to_string(), live.clone()));
    }
    fn on_credential_rejected(&self, account_id: &str) {
        self.rejected.lock().unwrap().push(account_id.to_string());
    }
    fn on_credential_missing(&self, account_id: &str) {
        self.missing.lock().unwrap().push(account_id.to_string());
    }
    fn on_loop_alarm(&self, alarm: &ProxyLoopAlarm) {
        self.alarms.lock().unwrap().push(alarm.clone());
    }
    fn request_log(&self, entry: &ProxyRequestLog) {
        self.recorded.lock().unwrap().push(entry.clone());
        if let Some(log) = &self.request_log {
            log.lock().unwrap().record(entry);
        }
    }
    fn request_bound(&self, request_id: &str, account_id: &str) {
        self.bound
            .lock()
            .unwrap()
            .push((request_id.to_string(), account_id.to_string()));
        if let Some(log) = &self.request_log {
            log.lock().unwrap().bind(request_id, account_id);
        }
    }
    fn recent_requests(&self) -> Vec<ProxyRequestLog> {
        self.request_log
            .as_ref()
            .map(|log| log.lock().unwrap().recent())
            .unwrap_or_default()
    }
    fn overflow_costs(&self) -> Option<Vec<OverflowCost>> {
        self.request_log
            .as_ref()
            .map(|log| log.lock().unwrap().overflow_costs())
    }
    async fn overflow_key(&self, _upstream_id: &str) -> Option<String> {
        self.overflow_key.clone()
    }
    fn time_zone(&self) -> Option<String> {
        self.time_zone.clone()
    }
}

// ---------------------------------------------------------------- gateway

pub fn config() -> ProxyConfig {
    ProxyConfig {
        port: 0,
        host: "127.0.0.1".into(),
        enabled: true,
        ..ProxyConfig::default()
    }
}

pub struct Gateway {
    pub server: ProxyServer,
    pub hooks: Arc<Hooks>,
    pub port: u16,
}

impl Gateway {
    pub async fn start(config: ProxyConfig, hooks: Hooks, upstreams: Upstreams) -> Gateway {
        Self::start_with(config, hooks, upstreams, ServerOptions::default()).await
    }

    pub async fn start_with(
        config: ProxyConfig,
        hooks: Hooks,
        upstreams: Upstreams,
        options: ServerOptions,
    ) -> Gateway {
        let hooks = Arc::new(hooks);
        let server = ProxyServer::with_options(config, hooks.clone(), upstreams, options);
        let state = server.start().await.expect("the gateway starts");
        Gateway {
            server,
            hooks,
            port: state.port,
        }
    }

    pub async fn post(&self, path: &str, extra: &[(&str, &str)], body: &str) -> Answer {
        request(self.port, "POST", path, extra, body).await
    }

    pub async fn get(&self, path: &str, extra: &[(&str, &str)]) -> Answer {
        request(self.port, "GET", path, extra, "").await
    }

    /// Waits until no request is being answered (the outcome is recorded after the answer).
    pub async fn idle(&self) {
        for _ in 0..1000 {
            if self.server.metrics().active_requests == 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }

    pub fn recent(&self) -> Vec<ProxyRequestLog> {
        self.server.stats().recent()
    }

    pub async fn stop(&self) {
        self.server.stop().await;
    }
}

// ---------------------------------------------------------------- raw HTTP client

#[derive(Debug)]
pub struct Answer {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: String,
}

impl Answer {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body).unwrap_or(serde_json::Value::Null)
    }
}

/// One request on its own connection. A `host` given in `extra` replaces the default one; a
/// `host` of `""` sends none.
pub async fn request(
    port: u16,
    method: &str,
    path: &str,
    extra: &[(&str, &str)],
    body: &str,
) -> Answer {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut head = format!("{method} {path} HTTP/1.1\r\n");
    let host = extra
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case("host"))
        .map(|(_, v)| v.to_string())
        .unwrap_or_else(|| format!("127.0.0.1:{port}"));
    if !host.is_empty() {
        head.push_str(&format!("Host: {host}\r\n"));
    }
    for (name, value) in extra {
        if !name.eq_ignore_ascii_case("host") {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
    }
    if method != "GET" || !body.is_empty() {
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    head.push_str("Connection: close\r\n\r\n");
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(body.as_bytes()).await.unwrap();
    read_answer(&mut stream).await
}

pub async fn read_answer(stream: &mut TcpStream) -> Answer {
    let mut raw = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(20), stream.read_to_end(&mut raw)).await;
    parse_answer(&raw)
}

pub fn parse_answer(raw: &[u8]) -> Answer {
    let mut slots = [httparse::EMPTY_HEADER; 64];
    let mut response = httparse::Response::new(&mut slots);
    let length = match response.parse(raw) {
        Ok(httparse::Status::Complete(length)) => length,
        _ => {
            return Answer {
                status: 0,
                headers: HeaderMap::new(),
                body: String::from_utf8_lossy(raw).into_owned(),
            };
        }
    };
    let mut headers = HeaderMap::new();
    for h in response.headers.iter() {
        headers.append(
            HeaderName::from_bytes(h.name.as_bytes()).unwrap(),
            HeaderValue::from_bytes(h.value).unwrap(),
        );
    }
    let rest = &raw[length..];
    let chunked = headers
        .get("transfer-encoding")
        .is_some_and(|v| v.to_str().unwrap_or("").contains("chunked"));
    let body = if chunked {
        dechunk(rest)
    } else {
        rest.to_vec()
    };
    Answer {
        status: response.code.unwrap_or(0),
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
    }
}

fn dechunk(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(end) = raw[at..].windows(2).position(|w| w == b"\r\n") {
        let line = std::str::from_utf8(&raw[at..at + end]).unwrap_or("0");
        let size = usize::from_str_radix(line.split(';').next().unwrap().trim(), 16).unwrap_or(0);
        at += end + 2;
        if size == 0 || at + size > raw.len() {
            break;
        }
        out.extend_from_slice(&raw[at..at + size]);
        at += size + 2;
    }
    out
}

// ---------------------------------------------------------------- fake upstream

#[derive(Clone, Debug)]
pub struct Seen {
    pub method: String,
    pub url: String,
    pub headers: HeaderMap,
    pub body: String,
}

impl Seen {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }
    pub fn token(&self) -> String {
        self.header("authorization")
            .unwrap_or("")
            .trim_start_matches("Bearer ")
            .to_string()
    }
}

pub type Reply = Arc<dyn Fn(Seen) -> BoxFuture<'static, Response<ResponseBody>> + Send + Sync>;

pub struct FakeUpstream {
    pub seen: Arc<Mutex<Vec<Seen>>>,
    pub url: String,
    pub port: u16,
    stop: watch::Sender<bool>,
    accept: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl FakeUpstream {
    pub async fn start(reply: Reply) -> FakeUpstream {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (stop, signal) = watch::channel(false);
        let recorded = seen.clone();
        let accept = tokio::spawn(async move {
            let mut accept_signal = signal.clone();
            loop {
                tokio::select! {
                    _ = accept_signal.changed() => break,
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { continue };
                        let reply = reply.clone();
                        let recorded = recorded.clone();
                        let mut conn_signal = signal.clone();
                        tokio::spawn(async move {
                            let service = service_fn(move |request: hyper::Request<Incoming>| {
                                let reply = reply.clone();
                                let recorded = recorded.clone();
                                async move {
                                    let (parts, body) = request.into_parts();
                                    let bytes = body.collect().await.map(|b| b.to_bytes()).unwrap_or_default();
                                    let seen = Seen {
                                        method: parts.method.to_string(),
                                        url: parts.uri.path_and_query().map(|p| p.to_string()).unwrap_or_default(),
                                        headers: parts.headers,
                                        body: String::from_utf8_lossy(&bytes).into_owned(),
                                    };
                                    recorded.lock().unwrap().push(seen.clone());
                                    Ok::<_, std::convert::Infallible>(reply(seen).await)
                                }
                            });
                            let connection = http1::Builder::new().serve_connection(TokioIo::new(stream), service);
                            tokio::select! {
                                _ = connection => {}
                                _ = conn_signal.changed() => {}
                            }
                        });
                    }
                }
            }
        });
        FakeUpstream {
            seen,
            url: format!("http://127.0.0.1:{port}"),
            port,
            stop,
            accept: Mutex::new(Some(accept)),
        }
    }

    /// An upstream whose every request gets `reply(seen)` at once.
    pub async fn sync(
        reply: impl Fn(&Seen) -> Response<ResponseBody> + Send + Sync + 'static,
    ) -> FakeUpstream {
        let reply = Arc::new(reply);
        Self::start(Arc::new(move |seen| {
            let response = reply(&seen);
            async move { response }.boxed()
        }))
        .await
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    pub fn count(&self) -> usize {
        self.seen.lock().unwrap().len()
    }

    pub fn tokens(&self) -> Vec<String> {
        self.seen().iter().map(Seen::token).collect()
    }

    pub async fn close(&self) {
        let _ = self.stop.send(true);
        let accept = self.accept.lock().unwrap().take();
        if let Some(accept) = accept {
            let _ = accept.await;
        }
    }
}

pub fn json_reply(status: u16, body: &str, extra: &[(&str, &str)]) -> Response<ResponseBody> {
    let mut response = Response::new(ResponseBody::full(Bytes::from(body.to_string())));
    *response.status_mut() = StatusCode::from_u16(status).unwrap();
    response
        .headers_mut()
        .insert("content-type", HeaderValue::from_static("application/json"));
    for (name, value) in extra {
        response.headers_mut().insert(
            HeaderName::from_bytes(name.as_bytes()).unwrap(),
            HeaderValue::from_str(value).unwrap(),
        );
    }
    response
}

pub fn ok_reply() -> Response<ResponseBody> {
    json_reply(200, r#"{"type":"message"}"#, &[])
}

pub fn error_body(kind: &str, message: &str) -> String {
    serde_json::json!({ "type": "error", "error": { "type": kind, "message": message } })
        .to_string()
}

/// A streamed answer: each part after its delay; with `end` false the stream stays open,
/// and `closed` (when given) is told once the gateway hangs up on it.
pub fn stream_reply(
    status: u16,
    extra: &[(&str, &str)],
    parts: Vec<(u64, String)>,
    end: bool,
    closed: Option<Arc<Notify>>,
) -> Response<ResponseBody> {
    let (tx, rx) = mpsc::channel::<Bytes>(16);
    tokio::spawn(async move {
        for (delay, part) in parts {
            if delay > 0 {
                tokio::time::sleep(Duration::from_millis(delay)).await;
            }
            if tx.send(Bytes::from(part)).await.is_err() {
                break;
            }
        }
        if !end {
            tx.closed().await;
            if let Some(closed) = closed {
                closed.notify_one();
            }
        }
    });
    let mut response = Response::new(ResponseBody::Stream { rx, abort: None });
    *response.status_mut() = StatusCode::from_u16(status).unwrap();
    for (name, value) in extra {
        response.headers_mut().insert(
            HeaderName::from_bytes(name.as_bytes()).unwrap(),
            HeaderValue::from_str(value).unwrap(),
        );
    }
    response
}

pub fn sse(parts: Vec<(u64, String)>, end: bool) -> Response<ResponseBody> {
    stream_reply(
        200,
        &[("content-type", "text/event-stream")],
        parts,
        end,
        None,
    )
}

/// A one-event SSE answer.
pub fn sse_once(event: &str) -> Response<ResponseBody> {
    sse(vec![(0, event.to_string())], true)
}

pub fn bytes_of(parts: &[&str]) -> Bytes {
    let mut out = BytesMut::new();
    for p in parts {
        out.extend_from_slice(p.as_bytes());
    }
    out.freeze()
}
