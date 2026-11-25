//! The local gateway (`proxy-server.ts`): Claude and Codex clients send their requests here,
//! and each goes to a saved account chosen by the router, with that account's sign-in.

use crate::anthropic_upstream::{AnthropicUsageExtractor, DEFAULT_ANTHROPIC_URL, anthropic_headers};
use crate::client_res::{ClientRes, ResponseBody, json_response, send_json_error};
use crate::codex_upstream::{
    CodexUsageExtractor, DEFAULT_CODEX_URL, DEFAULT_OPENAI_URL, codex_headers,
};
use crate::hub_management::{DefaultHubFetch, HUB_PREFIX, HubDeps, HubFetch, hub_management};
use crate::js::{Clock, now_ms, system_clock, timing_safe_equal};
use crate::model_prices::{ResponseUsage, response_cost};
use crate::overflow::{
    local_day_bounds, overflow_model, spent_today, system_time_zone, upstream_cost,
};
use crate::overflow_upstream::{overflow_body, overflow_headers};
use crate::proxy_insights::{AnswerFacts, GatewayInsights};
use crate::proxy_router::{
    CooldownReason, PickContext, ProxyRouter, RouterError, RouterOptions, RouterSelection,
    model_family,
};
use crate::proxy_session_cache::{ProxySessionCache, SessionCacheOptions};
use crate::proxy_stats::ProxyStats;
use crate::proxy_status::{ByModelPick, NextPick, NextPicks};
use crate::proxy_url::{is_loopback_host, is_tailscale_ipv4};
use crate::types::{
    Account, ApiUpstream, ExtraUsageKind, LiveLimits, OverflowCost, OverflowRates,
    OverflowSettings, OverflowTrigger, ProxyConfig, ProxyLoopAlarm, ProxyMetrics, ProxyPick,
    ProxyRequestLog, ProxyRunStatus, ProxyState, Provider, UsageSnapshot,
};
use crate::upstream_common::{
    EarlyAnswer, ForwardSpec, UpstreamOutcome, UpstreamPool, UsageExtractor, build_target_url,
    forward_upstream, header, parse_request_url,
};
use crate::upstream_common::FailureKind;
use crate::websocket_bridge::{WebSocketBridge, WebSocketBridgeOptions, reject_upgrade};
use async_trait::async_trait;
use bytes::{Bytes, BytesMut};
use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use http::request::Parts;
use http::{HeaderMap, Request, Response};
use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::task::JoinHandle;

/// The largest request body the gateway buffers: Anthropic itself caps requests at 32 MB.
pub const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
/// The most request body bytes held at once across all requests.
pub const MAX_BUFFERED_BYTES: u64 = 256 * 1024 * 1024;
/// A body is only parsed (session key, model) up to this size.
const MAX_PARSE_BYTES: usize = 16 * 1024 * 1024;
/// Requests answered at once; each buffers its body.
pub const MAX_CONCURRENT_REQUESTS: usize = 64;
/// How long a client may take to send its request body.
pub const BODY_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Accounts tried for one request: the first and up to two others after a limit or sign-in
/// failure.
pub const MAX_ATTEMPTS: usize = 3;
const DEFAULT_RATE_LIMIT_COOLDOWN_S: i64 = 60;
const MIN_COOLDOWN_S: i64 = 5;
/// A full weekly window: the longest an exhausted account can have to wait.
const MAX_COOLDOWN_S: i64 = 7 * 24 * 60 * 60;
const AUTH_FAILURE_COOLDOWN_S: i64 = 30;
const OVERLOADED_COOLDOWN_S: i64 = 10;
/// An account that billed extra usage, when no read limit says when its window resets.
const EXTRA_USAGE_COOLDOWN_S: i64 = 30 * 60;
/// Answers another account may succeed at: a limit, a refused sign-in, an overloaded upstream.
const RETRYABLE: [u16; 5] = [401, 403, 429, 503, 529];
/// Answers an overflow upstream may be skipped for, to the next one.
const OVERFLOW_NEXT: [u16; 9] = [401, 402, 403, 429, 500, 502, 503, 504, 529];
const CODEX_WS_URL: &str = "wss://chatgpt.com/backend-api/codex/responses";
/// The Responses API, and its remote compaction, which a Codex ChatGPT sign-in also answers.
const RESPONSES_PATHS: [&str; 4] = [
    "/v1/responses",
    "/responses",
    "/v1/responses/compact",
    "/responses/compact",
];
const ALLOWED_PATHS: [&str; 8] = [
    "/v1/messages",
    "/v1/responses",
    "/responses",
    "/v1/responses/compact",
    "/responses/compact",
    "/v1/chat/completions",
    "/chat/completions",
    "/v1/models",
];

/// A tailnet MagicDNS name: a bare machine name, or `machine.tailnet.ts.net`.
static MAGIC_DNS_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$|^[a-z0-9-]+$").unwrap());
static CLAUDE_AGENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^claude-cli/\S+(?:\s+\(([^)]*)\))?").unwrap());
static SDK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bsdk-(?:ts|py)\b").unwrap());
static CODEX_AGENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)codex").unwrap());
static PRODUCT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([A-Za-z][\w.-]{0,39})/").unwrap());
static REQUEST_CLASS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[a-z][a-z_-]{0,29}$").unwrap());
static HINT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\w.:-]{1,80}$").unwrap());
static BEARER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^Bearer\s+").unwrap());
static TRUE_FLAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(1|true)$").unwrap());

/// Who sent a request, from its user agent: "claude-code", "agent-sdk", "codex", or the
/// product it names.
pub fn client_of(headers: &HeaderMap) -> Option<String> {
    let agent = header(headers, "user-agent").unwrap_or("");
    if let Some(claude) = CLAUDE_AGENT.captures(agent) {
        let detail = claude.get(1).map_or("", |m| m.as_str());
        return Some(if SDK.is_match(detail) { "agent-sdk" } else { "claude-code" }.into());
    }
    if CODEX_AGENT.is_match(agent) {
        return Some("codex".into());
    }
    PRODUCT
        .captures(agent)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_lowercase())
}

/// Claude Code's label for a request (`CLAUDE_CODE_GATEWAY_HINT_HEADERS`): main, subagent, …
fn request_class_of(headers: &HeaderMap) -> Option<String> {
    header(headers, "x-claude-code-request-class")
        .filter(|text| REQUEST_CLASS.is_match(text))
        .map(str::to_lowercase)
}

/// Clients that speak ChatGPT's own Codex paths reach the same Responses routes:
/// `/codex/responses` and `/codex/responses/compact` become `/responses` and
/// `/responses/compact`, query kept.
pub fn alias_codex_path(url: &str) -> String {
    let Some(rest) = url.strip_prefix("/codex/responses") else {
        return url.to_string();
    };
    // `(\/compact)?\/?(?=\?|$)`, tried as the regex backtracks.
    let at_end = |tail: &str| tail.is_empty() || tail.starts_with('?');
    for compact in [true, false] {
        let after = if compact {
            match rest.strip_prefix("/compact") {
                Some(after) => after,
                None => continue,
            }
        } else {
            rest
        };
        for slash in [true, false] {
            let tail = if slash {
                match after.strip_prefix('/') {
                    Some(tail) => tail,
                    None => continue,
                }
            } else {
                after
            };
            if at_end(tail) {
                return format!("/responses{}{tail}", if compact { "/compact" } else { "" });
            }
        }
    }
    url.to_string()
}

fn url_host(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

/// Where requests go instead of the real services (tests, regional endpoints, parity runs).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Upstreams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anthropic_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openai_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_websocket_url: Option<String>,
}

/// An Antigravity account's local sidecar.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AntigravityRoute {
    pub url: String,
    pub key: String,
}

/// What the gateway asks of its host. Every method has a no-op default.
#[async_trait]
pub trait GatewayHooks: Send + Sync + 'static {
    /// The account's token as the gateway sends it; `Ok(None)` when none can be used.
    async fn credential(&self, _account: &Account) -> Result<Option<String>, String> {
        Ok(None)
    }
    /// An Antigravity account's sidecar; `Ok(None)` when it has no usable sign-in.
    async fn antigravity(&self, _account: &Account) -> Result<Option<AntigravityRoute>, String> {
        Ok(None)
    }
    /// The pool's accounts (in its order) and their limits as the host last read them.
    fn usage(&self) -> Arc<UsageSnapshot> {
        Arc::new(UsageSnapshot::default())
    }
    /// An answer reported the account's windows.
    fn on_live_limits(&self, _account_id: &str, _live: &LiveLimits) {}
    /// The upstream refused the account's token: a cached copy must be dropped.
    fn on_credential_rejected(&self, _account_id: &str) {}
    /// No usable token could be read: the host may renew it.
    fn on_credential_missing(&self, _account_id: &str) {}
    /// A prompt went past a loop bound; told once per prompt.
    fn on_loop_alarm(&self, _alarm: &ProxyLoopAlarm) {}
    /// One request for the request log (`GatewayRequestLog::record`).
    fn request_log(&self, _entry: &ProxyRequestLog) {}
    /// Which account serves a provider request id, known from the answer's headers.
    fn request_bound(&self, _request_id: &str, _account_id: &str) {}
    /// The requests a log kept before a restart (newest last), for the feed.
    fn recent_requests(&self) -> Vec<ProxyRequestLog> {
        Vec::new()
    }
    /// The overflow answers of the last days that cost something, for the daily cap across
    /// restarts; `None` when the host keeps no log (the gateway counts its own).
    fn overflow_costs(&self) -> Option<Vec<OverflowCost>> {
        None
    }
    /// An overflow upstream's API key, from the vault.
    async fn overflow_key(&self, _upstream_id: &str) -> Option<String> {
        None
    }
    /// OpenRouter's published price of a model, for its overflow answers' costs.
    async fn overflow_price(&self, _model: &str) -> Option<OverflowRates> {
        None
    }
    /// The planning time zone: the overflow cap is per day there. `None`: the system's.
    fn time_zone(&self) -> Option<String> {
        None
    }
}

/// Hooks that do nothing: a gateway with no accounts.
pub struct NoHooks;

impl GatewayHooks for NoHooks {}

/// What only tests (and parity runs) change.
#[derive(Default)]
pub struct ServerOptions {
    /// The clock for sessions, cooldowns and the traffic's times.
    pub now: Option<Clock>,
    /// The cap on request body bytes held at once.
    pub max_buffered_bytes: Option<u64>,
    /// Sends the usage dashboards' provider requests.
    pub hub_fetch: Option<Arc<dyn HubFetch>>,
    /// The upstream connection pool.
    pub pool: Option<UpstreamPool>,
}

/// Why the gateway could not start.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StartError {
    /// The port is taken (`EADDRINUSE`).
    AddrInUse(String),
    Other(String),
}

impl fmt::Display for StartError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StartError::AddrInUse(message) | StartError::Other(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for StartError {}

/// `GET /status`: whether the gateway runs and what it did.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ServerStatus {
    pub ok: bool,
    pub state: ProxyState,
    pub metrics: ProxyMetrics,
}

#[derive(Clone)]
struct Route {
    token: String,
    antigravity: Option<AntigravityRoute>,
}

type RouteRead = Shared<BoxFuture<'static, Option<Route>>>;

struct Run {
    status: ProxyRunStatus,
    started_at: Option<i64>,
    last_error: Option<String>,
    shutdown: Option<watch::Sender<bool>>,
    accept: Option<JoinHandle<()>>,
}

struct Inner {
    config: Mutex<ProxyConfig>,
    hooks: Arc<dyn GatewayHooks>,
    upstreams: Upstreams,
    now: Clock,
    router: Mutex<ProxyRouter>,
    stats: Mutex<ProxyStats>,
    insights: Mutex<GatewayInsights>,
    ws: WebSocketBridge,
    run: Mutex<Run>,
    starting: tokio::sync::Mutex<()>,
    /// Request body bytes held now, across requests.
    buffered: AtomicU64,
    max_buffered: u64,
    in_flight: AtomicUsize,
    /// Each session's last main-conversation prompt id, to tell a new turn.
    last_main_prompt: Mutex<IndexMap<String, String>>,
    /// Sign-in reads under way, by account: requests arriving together share one.
    resolving: Mutex<HashMap<String, RouteRead>>,
    /// Overflow answers' costs when the host keeps no request log.
    own_overflow_costs: Mutex<VecDeque<OverflowCost>>,
    hub_fetch: Arc<dyn HubFetch>,
    pool: Option<UpstreamPool>,
}

/// The gateway.
pub struct ProxyServer {
    inner: Arc<Inner>,
}

/// The session cache, held under the router's lock.
pub struct SessionCacheGuard<'a>(MutexGuard<'a, ProxyRouter>);

impl std::ops::Deref for SessionCacheGuard<'_> {
    type Target = ProxySessionCache;
    fn deref(&self) -> &ProxySessionCache {
        self.0.session_cache()
    }
}

impl std::ops::DerefMut for SessionCacheGuard<'_> {
    fn deref_mut(&mut self) -> &mut ProxySessionCache {
        self.0.session_cache_mut()
    }
}

/// Holds a request body's bytes against the gateway's cap until dropped.
struct Buffered {
    inner: Arc<Inner>,
    held: u64,
}

impl Buffered {
    fn hold(&mut self, bytes: u64) -> bool {
        let counter = &self.inner.buffered;
        let mut current = counter.load(Ordering::Acquire);
        loop {
            if current + bytes > self.inner.max_buffered {
                return false;
            }
            match counter.compare_exchange_weak(
                current,
                current + bytes,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    self.held += bytes;
                    return true;
                }
                Err(seen) => current = seen,
            }
        }
    }
}

impl Drop for Buffered {
    fn drop(&mut self) {
        self.inner.buffered.fetch_sub(self.held, Ordering::AcqRel);
    }
}

/// Decrements the in-flight count when a proxied request is done.
struct InFlight<'a>(&'a AtomicUsize);

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Who asked, for the request log.
#[derive(Clone, Default)]
struct About {
    client: Option<String>,
    request_class: Option<String>,
    agent_type: Option<String>,
}

impl About {
    fn onto(&self, mut entry: ProxyRequestLog) -> ProxyRequestLog {
        entry.client = self.client.clone();
        entry.request_class = self.request_class.clone();
        entry.agent_type = self.agent_type.clone();
        entry
    }
}

impl ProxyServer {
    pub fn new(config: ProxyConfig, hooks: Arc<dyn GatewayHooks>, upstreams: Upstreams) -> Self {
        Self::with_options(config, hooks, upstreams, ServerOptions::default())
    }

    pub fn with_options(
        config: ProxyConfig,
        hooks: Arc<dyn GatewayHooks>,
        upstreams: Upstreams,
        options: ServerOptions,
    ) -> Self {
        let now = options.now.clone().unwrap_or_else(system_clock);
        let session_cache = ProxySessionCache::new(SessionCacheOptions {
            ttl_seconds: Some(config.affinity_ttl_seconds),
            max_entries: None,
            now: options.now.clone(),
        });
        let router = ProxyRouter::new(RouterOptions {
            strategy: Some(config.routing_strategy),
            session_cache: Some(session_cache),
            now: options.now.clone(),
        });
        // The feed shows the requests before a restart, too.
        let stats = ProxyStats::with_recent(hooks.recent_requests());
        ProxyServer {
            inner: Arc::new(Inner {
                config: Mutex::new(config),
                hooks,
                upstreams,
                now: now.clone(),
                router: Mutex::new(router),
                stats: Mutex::new(stats),
                insights: Mutex::new(GatewayInsights::new(now)),
                ws: WebSocketBridge::new(),
                run: Mutex::new(Run {
                    status: ProxyRunStatus::Stopped,
                    started_at: None,
                    last_error: None,
                    shutdown: None,
                    accept: None,
                }),
                starting: tokio::sync::Mutex::new(()),
                buffered: AtomicU64::new(0),
                max_buffered: options.max_buffered_bytes.unwrap_or(MAX_BUFFERED_BYTES),
                in_flight: AtomicUsize::new(0),
                last_main_prompt: Mutex::new(IndexMap::new()),
                resolving: Mutex::new(HashMap::new()),
                own_overflow_costs: Mutex::new(VecDeque::new()),
                hub_fetch: options
                    .hub_fetch
                    .unwrap_or_else(|| Arc::new(DefaultHubFetch::default())),
                pool: options.pool,
            }),
        }
    }

    /// Starts listening on the configured host and port (port 0 picks a free one, which the
    /// config then keeps, so a restart reuses it).
    pub async fn start(&self) -> Result<ProxyState, StartError> {
        let inner = &self.inner;
        let _starting = inner.starting.lock().await;
        if inner.run.lock().unwrap().shutdown.is_some() {
            return Ok(self.state());
        }
        inner.run.lock().unwrap().status = ProxyRunStatus::Starting;
        let (host, port) = {
            let config = inner.config.lock().unwrap();
            (config.host.clone(), config.port)
        };
        let bind_host = host.trim_start_matches('[').trim_end_matches(']').to_string();
        let listener = match TcpListener::bind((bind_host.as_str(), port)).await {
            Ok(listener) => listener,
            Err(error) => {
                let failure = if error.kind() == std::io::ErrorKind::AddrInUse {
                    StartError::AddrInUse(format!(
                        "listen EADDRINUSE: address already in use {host}:{port}"
                    ))
                } else {
                    StartError::Other(error.to_string())
                };
                let mut run = inner.run.lock().unwrap();
                run.status = ProxyRunStatus::Error;
                run.last_error = Some(failure.to_string());
                return Err(failure);
            }
        };
        if let Ok(address) = listener.local_addr() {
            inner.config.lock().unwrap().port = address.port();
        }
        let (shutdown, signal) = watch::channel(false);
        let accept = tokio::spawn(accept_loop(inner.clone(), listener, signal));
        {
            let mut run = inner.run.lock().unwrap();
            run.shutdown = Some(shutdown);
            run.accept = Some(accept);
            run.started_at = Some(now_ms());
            run.status = ProxyRunStatus::Running;
            run.last_error = None;
        }
        Ok(self.state())
    }

    /// Stops listening and drops every connection and bridge; streams in flight are cut.
    pub async fn stop(&self) {
        let (shutdown, accept) = {
            let mut run = self.inner.run.lock().unwrap();
            let Some(shutdown) = run.shutdown.take() else {
                return;
            };
            run.started_at = None;
            run.status = ProxyRunStatus::Stopped;
            (shutdown, run.accept.take())
        };
        self.inner.ws.close_all();
        let _ = shutdown.send(true);
        if let Some(accept) = accept {
            let _ = accept.await;
        }
    }

    /// `getState()`.
    pub fn state(&self) -> ProxyState {
        self.inner.state()
    }

    /// `getMetrics()`.
    pub fn metrics(&self) -> ProxyMetrics {
        self.inner.metrics()
    }

    /// What `GET /status` answers.
    pub fn status(&self) -> ServerStatus {
        ServerStatus {
            ok: true,
            state: self.state(),
            metrics: self.metrics(),
        }
    }

    pub fn config(&self) -> ProxyConfig {
        self.inner.config.lock().unwrap().clone()
    }

    /// Changes the running gateway's settings; a new routing strategy and session time apply
    /// at once. A new host or port takes a restart.
    pub fn update_config(&self, change: impl FnOnce(&mut ProxyConfig)) {
        let config = {
            let mut config = self.inner.config.lock().unwrap();
            change(&mut config);
            config.clone()
        };
        let mut router = self.inner.router.lock().unwrap();
        router.set_strategy(config.routing_strategy);
        router.session_cache_mut().set_ttl(config.affinity_ttl_seconds);
    }

    pub fn session_cache(&self) -> SessionCacheGuard<'_> {
        SessionCacheGuard(self.inner.router.lock().unwrap())
    }

    pub fn router(&self) -> MutexGuard<'_, ProxyRouter> {
        self.inner.router.lock().unwrap()
    }

    pub fn stats(&self) -> MutexGuard<'_, ProxyStats> {
        self.inner.stats.lock().unwrap()
    }

    pub fn insights(&self) -> MutexGuard<'_, GatewayInsights> {
        self.inner.insights.lock().unwrap()
    }

    pub fn ws_bridge(&self) -> &WebSocketBridge {
        &self.inner.ws
    }

    /// Overflow spend so far in today's day of the planning time zone, in USD.
    pub fn overflow_spent_today(&self) -> f64 {
        self.inner.overflow_spent_today()
    }

    /// The account a new session would get now, for each provider the pool has, and why.
    pub fn next_picks(&self) -> NextPicks {
        let snapshot = self.inner.hooks.usage();
        let accounts = &snapshot.accounts;
        let usage_map = &snapshot.usage_map;
        let mut out = NextPicks::new();
        let providers: HashSet<Provider> = accounts.iter().map(Account::provider).collect();
        let mut router = self.inner.router.lock().unwrap();
        for provider in [Provider::Claude, Provider::Codex, Provider::Antigravity] {
            if !providers.contains(&provider) {
                continue;
            }
            let Some(pick) = router.preview(accounts, usage_map, provider, None) else {
                continue;
            };
            // Models with a limit of their own on some account: their new sessions may go
            // elsewhere than the rest.
            let mut families: IndexMap<String, String> = IndexMap::new();
            for account in accounts.iter().filter(|a| a.provider() == provider) {
                if let Some(usage) = usage_map.get(&account.id) {
                    for window in usage.model_windows() {
                        if let Some(model) = window.model.as_deref().filter(|m| !m.is_empty()) {
                            families
                                .entry(model.to_string())
                                .or_insert_with(|| window.label.clone());
                        }
                    }
                }
            }
            let by_model: Vec<ByModelPick> = families
                .into_iter()
                .filter_map(|(model, label)| {
                    let scoped = router.preview(accounts, usage_map, provider, Some(&model));
                    if scoped.as_ref().map(|s| &s.account.id) == Some(&pick.account.id) {
                        return None;
                    }
                    Some(ByModelPick {
                        model,
                        label,
                        account_id: scoped.map(|s| s.account.id),
                    })
                })
                .collect();
            out.insert(
                provider.as_str().into(),
                NextPick {
                    account_id: pick.account.id.clone(),
                    reason: pick.reason,
                    nearly_full: pick.nearly_full.clone(),
                    by_model: (!by_model.is_empty()).then_some(by_model),
                },
            );
        }
        out
    }
}

impl Drop for ProxyServer {
    fn drop(&mut self) {
        // A dropped gateway must not keep its port: the listener and connections go with it.
        let mut run = self.inner.run.lock().unwrap();
        if let Some(shutdown) = run.shutdown.take() {
            let _ = shutdown.send(true);
        }
        if let Some(accept) = run.accept.take() {
            accept.abort();
        }
        self.inner.ws.close_all();
    }
}

async fn accept_loop(inner: Arc<Inner>, listener: TcpListener, mut signal: watch::Receiver<bool>) {
    loop {
        tokio::select! {
            _ = signal.changed() => break,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    tokio::spawn(serve_connection(inner.clone(), stream, signal.clone()));
                }
                Err(error) => {
                    // After start a failed accept must not stop the gateway.
                    inner.run.lock().unwrap().last_error = Some(error.to_string());
                    inner.stats.lock().unwrap().record_error(&error.to_string());
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            },
        }
    }
}

async fn serve_connection(
    inner: Arc<Inner>,
    stream: tokio::net::TcpStream,
    mut signal: watch::Receiver<bool>,
) {
    let _ = stream.set_nodelay(true);
    let service_signal = signal.clone();
    let service = service_fn(move |request: Request<Incoming>| {
        let inner = inner.clone();
        let signal = service_signal.clone();
        async move { handle(inner, request, signal).await }
    });
    let connection = http1::Builder::new()
        .serve_connection(TokioIo::new(stream), service)
        .with_upgrades();
    tokio::select! {
        _ = connection => {}
        // Stopping cuts every connection, streams included.
        _ = signal.changed() => {}
    }
}

/// One request: the work runs in its own task, so the answer's body can stream after its
/// head went back to hyper.
async fn handle(
    inner: Arc<Inner>,
    request: Request<Incoming>,
    mut signal: watch::Receiver<bool>,
) -> Result<Response<ResponseBody>, std::io::Error> {
    let (mut res, head) = ClientRes::new();
    tokio::spawn(async move {
        let upgrade = is_upgrade(request.headers());
        if !upgrade {
            inner.stats.lock().unwrap().request_started();
        }
        tokio::select! {
            () = process(&inner, request, &mut res, upgrade) => {}
            _ = signal.changed() => {}
        }
        if !upgrade {
            inner.stats.lock().unwrap().request_ended();
        }
        // Dropping the response ends a streamed answer cleanly.
        drop(res);
    });
    head.await
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::ConnectionAborted, "no answer"))
}

/// A request Node would hand to the `upgrade` event.
fn is_upgrade(headers: &HeaderMap) -> bool {
    headers.contains_key(http::header::UPGRADE)
        && headers
            .get_all(http::header::CONNECTION)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .any(|v| v.split(',').any(|t| t.trim().eq_ignore_ascii_case("upgrade")))
}

/// The request target as Node's `req.url` holds it.
fn raw_url(request: &Parts) -> String {
    if request.uri.scheme().is_some() {
        request.uri.to_string()
    } else {
        request
            .uri
            .path_and_query()
            .map_or_else(|| request.uri.to_string(), |p| p.as_str().to_string())
    }
}

async fn process(inner: &Arc<Inner>, request: Request<Incoming>, res: &mut ClientRes, upgrade: bool) {
    if upgrade {
        let response = inner.websocket_upgrade(request).await;
        match response {
            Some(response) => res.send(response),
            None => res.destroy(),
        }
        return;
    }
    let (parts, body) = request.into_parts();
    let url = alias_codex_path(&raw_url(&parts));
    let Ok(target) = parse_request_url(Some(&url)) else {
        send_json_error(
            res,
            400,
            "invalid_request_error",
            "Invalid request target",
            &[("connection", "close")],
        );
        return;
    };
    let pathname = target.pathname;
    if !inner.host_allowed(header(&parts.headers, "host")) {
        send_json_error(
            res,
            403,
            "forbidden",
            "Unexpected Host header",
            &[("connection", "close")],
        );
        return;
    }
    let read_only = parts.method == http::Method::GET || parts.method == http::Method::HEAD;
    let head = parts.method == http::Method::HEAD;
    // Claude Code checks it can reach its API here before it starts; Anthropic answers it
    // without a key, and so does the gateway.
    if read_only && pathname == "/api/hello" {
        res.send(json_response(
            200,
            (!head).then(|| json!({ "message": "hello" }).to_string()),
        ));
        return;
    }
    // Liveness only: it says nothing about the accounts, so it needs no key.
    if read_only && pathname == "/health" {
        let status = inner.run.lock().unwrap().status;
        res.send(json_response(
            200,
            (!head).then(|| json!({ "ok": true, "status": status }).to_string()),
        ));
        return;
    }
    if let Some((status, kind, message)) = inner.auth_failure(&parts.headers) {
        send_json_error(res, status, kind, message, &[("connection", "close")]);
        return;
    }
    if read_only && pathname == "/status" {
        let body = (!head).then(|| {
            serde_json::to_string(&ServerStatus {
                ok: true,
                state: inner.state(),
                metrics: inner.metrics(),
            })
            .unwrap_or_default()
        });
        res.send(json_response(200, body));
        return;
    }

    // CLIProxyAPI's management calls, as usage dashboards make them.
    if pathname.starts_with(HUB_PREFIX) {
        let mut parsed = None;
        if parts.method == http::Method::POST {
            let Some((raw, _held)) = inner.read_body(body, res).await else {
                return;
            };
            if !raw.is_empty() {
                match serde_json::from_slice::<Value>(&raw) {
                    Ok(value) => parsed = Some(value),
                    Err(_) => {
                        send_json_error(res, 400, "invalid_request_error", "The body is not JSON", &[]);
                        return;
                    }
                }
            }
        }
        let deps = HubBridge { inner };
        let answer = hub_management(parts.method.as_str(), &pathname, parsed.as_ref(), &deps).await;
        let Some(answer) = answer else {
            send_json_error(
                res,
                404,
                "not_found",
                &format!("Management call '{pathname}' is not supported by Relay"),
                &[],
            );
            return;
        };
        res.send(json_response(answer.status, Some(answer.body.to_string())));
        return;
    }

    if !ALLOWED_PATHS.contains(&pathname.as_str()) {
        send_json_error(
            res,
            404,
            "not_found",
            &format!("Path '{pathname}' not supported by Relay proxy"),
            &[("connection", "close")],
        );
        return;
    }
    if inner.in_flight.load(Ordering::Acquire) >= MAX_CONCURRENT_REQUESTS {
        send_json_error(
            res,
            503,
            "overloaded_error",
            "Relay is answering too many requests at once",
            &[("retry-after", "1")],
        );
        return;
    }
    inner.in_flight.fetch_add(1, Ordering::AcqRel);
    let _in_flight = InFlight(&inner.in_flight);
    inner.proxy_request(&parts, &url, body, res, &pathname).await;
}

struct HubBridge<'a> {
    inner: &'a Arc<Inner>,
}

#[async_trait]
impl HubDeps for HubBridge<'_> {
    fn accounts(&self) -> Vec<Account> {
        self.inner.hooks.usage().accounts.clone()
    }
    async fn credential(&self, account: &Account) -> Option<String> {
        self.inner.hooks.credential(account).await.ok().flatten()
    }
    fn clear_cooldown(&self, account_id: &str) {
        self.inner.router.lock().unwrap().clear_cooldown(account_id);
    }
    fn fetch(&self) -> &dyn HubFetch {
        &*self.inner.hub_fetch
    }
}

impl Inner {
    fn state(&self) -> ProxyState {
        let (status, started_at, error) = {
            let run = self.run.lock().unwrap();
            (run.status, run.started_at, run.last_error.clone())
        };
        let config = self.config.lock().unwrap().clone();
        ProxyState {
            status,
            port: config.port,
            host: config.host.clone(),
            endpoint_url: format!("http://{}:{}", url_host(&config.host), config.port),
            active_sessions_count: self.router.lock().unwrap().session_cache_mut().count(),
            uptime_seconds: started_at.map_or(0, |at| (now_ms() - at).div_euclid(1000)),
            error,
        }
    }

    fn metrics(&self) -> ProxyMetrics {
        let sessions = self.router.lock().unwrap().session_cache_mut().count();
        self.stats.lock().unwrap().metrics(sessions)
    }

    fn record_error(&self, message: &str) {
        self.stats.lock().unwrap().record_error(message);
    }

    fn record_log(&self, entry: ProxyRequestLog) {
        let kept = self.stats.lock().unwrap().record_log(entry);
        self.hooks.request_log(&kept);
    }

    fn time_zone(&self) -> String {
        self.hooks.time_zone().unwrap_or_else(system_time_zone)
    }

    fn overflow_spent_today(&self) -> f64 {
        let costs = self
            .hooks
            .overflow_costs()
            .unwrap_or_else(|| self.own_overflow_costs.lock().unwrap().iter().copied().collect());
        spent_today(&costs, (self.now)(), &self.time_zone())
    }

    /// Only Host names the gateway is reached by are answered: loopback names, the address it
    /// listens on, and on a Tailscale bind the tailnet's MagicDNS names. A request without a
    /// Host header is refused.
    fn host_allowed(&self, host: Option<&str>) -> bool {
        let Some(host) = host.filter(|h| !h.is_empty()) else {
            return false;
        };
        let Ok(url) = reqwest::Url::parse(&format!("http://{host}")) else {
            return false;
        };
        let name = url
            .host_str()
            .unwrap_or("")
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_string();
        let bind = self
            .config
            .lock()
            .unwrap()
            .host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_string();
        if is_loopback_host(&name)
            || (name.parse::<std::net::Ipv4Addr>().is_ok() && name.starts_with("127."))
            || name == bind
        {
            return true;
        }
        is_tailscale_ipv4(&bind) && MAGIC_DNS_NAME.is_match(&name)
    }

    /// Why a client may not use the gateway. With a client key, any of `Authorization:
    /// Bearer`, `x-relay-key` or `x-api-key` may carry it (compared in constant time).
    /// Without one, only a loopback bind is served.
    fn auth_failure(&self, headers: &HeaderMap) -> Option<(u16, &'static str, &'static str)> {
        let (key, host) = {
            let config = self.config.lock().unwrap();
            (config.api_key.clone(), config.host.clone())
        };
        let Some(key) = key.filter(|k| !k.is_empty()) else {
            return (!is_loopback_host(&host)).then_some((
                403,
                "forbidden",
                "Network-exposed proxy requires apiKey to be configured",
            ));
        };
        let expected = key.as_bytes();
        let matches = ["authorization", "x-relay-key", "x-api-key"]
            .into_iter()
            .flat_map(|name| headers.get_all(name).iter())
            .filter_map(|value| value.to_str().ok())
            .map(|value| BEARER.replace(value, "").trim().to_string())
            .any(|candidate| timing_safe_equal(candidate.as_bytes(), expected));
        (!matches).then_some((
            401,
            "authentication_error",
            "Invalid or missing proxy authorization",
        ))
    }

    /// Buffers the request body; `None` when the client left, timed out, or the body was too
    /// large (413) or would take the gateway past its cap on bodies held at once (503). The
    /// body stays counted while the returned guard lives.
    async fn read_body(
        self: &Arc<Self>,
        mut body: Incoming,
        res: &mut ClientRes,
    ) -> Option<(Bytes, Buffered)> {
        let mut held = Buffered {
            inner: self.clone(),
            held: 0,
        };
        let mut chunks = BytesMut::new();
        let deadline = tokio::time::Instant::now() + BODY_READ_TIMEOUT;
        loop {
            match tokio::time::timeout_at(deadline, body.frame()).await {
                Err(_) => {
                    send_json_error(
                        res,
                        408,
                        "request_timeout",
                        "Request body timed out",
                        &[("connection", "close")],
                    );
                    return None;
                }
                Ok(None) => return Some((chunks.freeze(), held)),
                // A client that leaves mid-body.
                Ok(Some(Err(_))) => return None,
                Ok(Some(Ok(frame))) => {
                    let Ok(data) = frame.into_data() else { continue };
                    if chunks.len() + data.len() > MAX_BODY_BYTES {
                        send_json_error(
                            res,
                            413,
                            "request_too_large",
                            "Request body is too large",
                            &[("connection", "close")],
                        );
                        return None;
                    }
                    if !held.hold(data.len() as u64) {
                        send_json_error(
                            res,
                            503,
                            "overloaded_error",
                            "Relay is holding too many request bodies at once",
                            &[("retry-after", "1"), ("connection", "close")],
                        );
                        return None;
                    }
                    chunks.extend_from_slice(&data);
                }
            }
        }
    }

    /// The overflow setup, when it can take this request: on, a Claude Messages request, an
    /// upstream on.
    fn overflow_for(&self, pathname: &str, provider: Provider) -> Option<OverflowSettings> {
        let config = self.config.lock().unwrap();
        let settings = config.overflow.as_ref().filter(|s| s.enabled)?;
        if provider != Provider::Claude || pathname != "/v1/messages" {
            return None;
        }
        settings
            .upstreams
            .iter()
            .any(|u| u.enabled)
            .then(|| settings.clone())
    }

    #[allow(clippy::too_many_lines)]
    async fn proxy_request(
        self: &Arc<Self>,
        parts: &Parts,
        url: &str,
        body: Incoming,
        res: &mut ClientRes,
        pathname: &str,
    ) {
        let Some((body_buffer, _held)) = self.read_body(body, res).await else {
            return;
        };
        let headers = &parts.headers;
        let is_open_ai_route = pathname.starts_with("/v1/responses")
            || pathname.starts_with("/responses")
            || pathname.starts_with("/v1/chat/completions")
            || pathname.starts_with("/chat/completions")
            || pathname == "/v1/models";

        // Parsed once, for the session key and the model.
        let parsed: Option<Value> =
            if !body_buffer.is_empty() && body_buffer.len() <= MAX_PARSE_BYTES {
                serde_json::from_slice(&body_buffer).ok()
            } else {
                None
            };
        let session_key = extract_session_key(headers, parsed.as_ref());
        let requested_model = parsed
            .as_ref()
            .and_then(|p| p.get("model"))
            .and_then(Value::as_str)
            .map(str::to_lowercase)
            .unwrap_or_default();
        let request_class = request_class_of(headers);
        let mut about = About {
            client: client_of(headers),
            request_class: request_class.clone(),
            agent_type: None,
        };
        // Claude Code's hints (CLAUDE_CODE_GATEWAY_HINT_HEADERS): which subagent, which prompt.
        let hint = |name: &str| {
            header(headers, name)
                .filter(|t| HINT.is_match(t))
                .map(str::to_string)
        };
        let agent_id = hint("x-claude-code-agent-id");
        let agent_type = hint("x-claude-code-agent-type").map(|t| t.to_lowercase());
        // What kind of subagent sent it: an "unnamed" one carries no agent id.
        if request_class.as_deref() == Some("subagent") {
            about.agent_type = Some(if agent_id.is_some() {
                agent_type.clone().unwrap_or_else(|| "agent".into())
            } else {
                "unnamed".into()
            });
        }
        let prompt_id = hint("x-claude-code-prompt-id");
        let compacted = request_class.as_deref() == Some("compaction")
            || TRUE_FLAG.is_match(header(headers, "x-claude-code-context-compacted").unwrap_or(""));
        // The main conversation's own request: not a subagent's, nor a title or classifier call.
        let main = agent_id.is_none()
            && matches!(request_class.as_deref(), None | Some("main") | Some("compaction"));
        // A turn starts at the main conversation's first request with a new prompt id.
        let mut turn_start = false;
        if let (Some(key), Some(prompt)) = (&session_key, &prompt_id) {
            if main && request_class.as_deref() != Some("compaction") {
                let mut last = self.last_main_prompt.lock().unwrap();
                turn_start = last.get(key) != Some(prompt);
                last.shift_remove(key);
                last.insert(key.clone(), prompt.clone());
                if last.len() > 2_000 {
                    last.shift_remove_index(0);
                }
            }
        }
        let alarm = self.insights.lock().unwrap().count_prompt(
            prompt_id.as_deref(),
            session_key.as_deref(),
            agent_id.as_deref(),
        );
        if let Some(alarm) = alarm {
            self.hooks.on_loop_alarm(&alarm);
        }
        // With subagent overflow on, a session's fresh subagents go to one account other than
        // the session's, and stay there. A fork shares the conversation's prompt and stays.
        let overflow = self.config.lock().unwrap().subagent_overflow == Some(true)
            && session_key.is_some()
            && agent_id.is_some()
            && request_class.as_deref() == Some("subagent")
            && agent_type.as_deref() != Some("fork");
        let route_key = if overflow {
            session_key.as_ref().map(|k| format!("{k}:sub"))
        } else {
            session_key.clone()
        };
        let avoid = if overflow {
            session_key
                .as_deref()
                .and_then(|k| self.router.lock().unwrap().session_cache().peek(k))
        } else {
            None
        };
        let model_context = || PickContext {
            main: Some(main),
            model: (!requested_model.is_empty()).then(|| requested_model.clone()),
            ..Default::default()
        };
        let pick_context = PickContext {
            cold: session_key.as_deref().is_some_and(|k| {
                agent_id.is_none() && self.insights.lock().unwrap().is_cold(k)
            }),
            turn_start,
            ..model_context()
        };
        let header_provider = header(headers, "x-relay-provider")
            .unwrap_or("")
            .to_lowercase();
        let mut target_provider = if is_open_ai_route {
            Provider::Codex
        } else {
            Provider::Claude
        };
        if header_provider == "antigravity"
            || header_provider == "gemini"
            || requested_model.starts_with("antigravity")
            || requested_model.starts_with("gemini")
        {
            target_provider = Provider::Antigravity;
        }
        if pathname == "/v1/models" && target_provider != Provider::Antigravity {
            send_json_error(
                res,
                501,
                "unsupported_endpoint",
                "Choose the Antigravity provider to list its models",
                &[],
            );
            return;
        }

        let mut tried: HashSet<String> = HashSet::new();
        let mut last_held: Option<u16> = None;
        // Set when an account was skipped because its sign-in cannot serve this route.
        let mut unsupported: Option<&str> = None;
        // Accounts whose sign-in could not be read: skipped without spending one of the tries.
        let mut unreadable: Vec<String> = Vec::new();
        let mut unreadable_ids: Vec<String> = Vec::new();
        // The account the previous try was held on, for the next try's reason.
        let mut held_on: Option<String> = None;
        let spill = self.overflow_for(pathname, target_provider);
        let to_overflow = |limited: bool| {
            spill.as_ref().is_some_and(|s| {
                limited || s.trigger == Some(OverflowTrigger::Unavailable)
            })
        };
        let log_now = |status: u16, note: &str| {
            about.onto(ProxyRequestLog {
                at: now_ms(),
                provider: Some(target_provider.as_str().into()),
                model: Some(requested_model.clone()),
                status,
                note: Some(note.into()),
                ..Default::default()
            })
        };
        let mut attempt = 1;
        while attempt <= MAX_ATTEMPTS {
            let snapshot = self.hooks.usage();
            let selection = {
                let context = if tried.is_empty() {
                    pick_context.clone()
                } else {
                    // A retry is not a move: the turn already began on the first try.
                    model_context()
                };
                self.router.lock().unwrap().select_account(
                    route_key.as_deref(),
                    &snapshot.accounts,
                    &snapshot.usage_map,
                    Some(target_provider),
                    &tried,
                    avoid.as_deref(),
                    &context,
                )
            };
            let selection = match selection {
                Ok(selection) => selection,
                Err(error) => {
                    let no_provider = matches!(error, RouterError::NoProvider { .. });
                    if no_provider && last_held.is_none() {
                        if let Some(message) = unsupported {
                            send_json_error(res, 501, "unsupported_endpoint", message, &[]);
                            return;
                        }
                    }
                    // Nothing was forwarded and the only accounts left could not be signed in with.
                    if last_held.is_none() && !unreadable.is_empty() {
                        if to_overflow(false) {
                            return self.serve_overflow_from(parts, url, res, &body_buffer, parsed.as_ref(), &requested_model, &about, spill.as_ref(), held_on.as_deref()).await;
                        }
                        self.sign_in_needed(res, target_provider, &requested_model, &unreadable, &about);
                        return;
                    }
                    if no_provider && tried.is_empty() {
                        if to_overflow(false) {
                            return self.serve_overflow_from(parts, url, res, &body_buffer, parsed.as_ref(), &requested_model, &about, spill.as_ref(), held_on.as_deref()).await;
                        }
                        self.record_log(log_now(503, "no-account"));
                        send_json_error(res, 503, "api_error", &error.to_string(), &[]);
                        return;
                    }
                    if let RouterError::NoEligible {
                        retry_after_seconds,
                        sign_in_only,
                    } = &error
                    {
                        if tried.is_empty() {
                            if *sign_in_only {
                                if to_overflow(false) {
                                    return self.serve_overflow_from(parts, url, res, &body_buffer, parsed.as_ref(), &requested_model, &about, spill.as_ref(), held_on.as_deref()).await;
                                }
                                self.sign_in_needed(res, target_provider, &requested_model, &[], &about);
                                return;
                            }
                            if to_overflow(true) {
                                return self.serve_overflow_from(parts, url, res, &body_buffer, parsed.as_ref(), &requested_model, &about, spill.as_ref(), held_on.as_deref()).await;
                            }
                            self.record_error(&error.to_string());
                            self.record_log(log_now(429, "all-limited"));
                            let retry = retry_after_seconds
                                .filter(|s| *s > 0)
                                .map(|s| s.to_string());
                            let extra: Vec<(&str, &str)> = retry
                                .as_deref()
                                .map(|r| vec![("retry-after", r)])
                                .unwrap_or_default();
                            send_json_error(res, 429, "rate_limit_error", &error.to_string(), &extra);
                            return;
                        }
                    }
                    // Every other account was tried or is cooling down: the last answer was
                    // already held.
                    if to_overflow(last_held.is_none() || last_held == Some(429)) {
                        return self.serve_overflow_from(parts, url, res, &body_buffer, parsed.as_ref(), &requested_model, &about, spill.as_ref(), held_on.as_deref()).await;
                    }
                    let status = last_held.unwrap_or(429);
                    self.record_log(log_now(status, "all-limited"));
                    send_json_error(
                        res,
                        status,
                        if status == 401 || status == 403 {
                            "authentication_error"
                        } else {
                            "rate_limit_error"
                        },
                        "Every account for this provider is limited or unavailable",
                        &[],
                    );
                    return;
                }
            };
            tried.insert(selection.account.id.clone());
            if !serves_route(&selection.account, pathname) {
                unsupported = Some(
                    "Codex ChatGPT sign-ins support the Responses API only; add an OpenAI API key account for this endpoint",
                );
                continue;
            }
            let Some(route) = self.resolve_route(&selection.account).await else {
                let account = &selection.account;
                unreadable.push(account.name.clone());
                unreadable_ids.push(account.id.clone());
                // Requests that shared the read find it out together: the first one reports it.
                let reported = {
                    let mut router = self.router.lock().unwrap();
                    let reported = router
                        .cooldown_of(&account.id)
                        .is_some_and(|c| c.reason == CooldownReason::Auth);
                    // Its sessions wait for it: a renewed sign-in brings them back to their cache.
                    router.mark_unavailable(
                        &account.id,
                        AUTH_FAILURE_COOLDOWN_S * 1000,
                        CooldownReason::Auth,
                    );
                    reported
                };
                if !reported {
                    self.record_error(&format!("No usable sign-in for {}", account.name));
                    self.hooks.on_credential_missing(&account.id);
                }
                continue;
            };
            let is_last = attempt == MAX_ATTEMPTS;
            attempt += 1;
            let account_id = selection.account.id.clone();
            let started = (self.now)();
            let hold_if = |status: u16| {
                let retryable = RETRYABLE.contains(&status);
                (!is_last
                    && retryable
                    && self.can_try_another(target_provider, &tried, pathname, &requested_model))
                    || (retryable && to_overflow(status == 429))
            };
            // Known with the headers: the token table may meet this request id before it is done.
            let on_answer = |early: &EarlyAnswer| {
                if let Some(id) = early.request_id.as_deref() {
                    self.hooks.request_bound(id, &account_id);
                }
                if let Some(live) = early.live.as_ref() {
                    self.hooks.on_live_limits(&account_id, live);
                    self.insights
                        .lock()
                        .unwrap()
                        .observe_limits(&account_id, live.five_hour.as_ref());
                }
            };
            let outcome = self
                .forward_to(&selection, &route, parts, url, res, &body_buffer, pathname, &hold_if, &on_answer)
                .await;
            let Some(outcome) = outcome else { return };
            let mut pick = ProxyPick::new(selection.reason);
            pick.nearly_full = selection.nearly_full.clone();
            pick.no_sign_in = (!unreadable_ids.is_empty()).then(|| unreadable_ids.clone());
            pick.after = held_on.clone();
            pick.overflow = overflow.then_some(true);
            pick.bound_waiting = selection.bound_waiting.clone();
            if let (Some(moved), Some(from)) = (selection.moved, selection.from.clone()) {
                pick.moved = Some(moved);
                pick.from = Some(from);
            }
            let tokens = outcome.tokens;
            let cost = tokens.and_then(|t| {
                response_cost(
                    &requested_model,
                    &ResponseUsage {
                        input: t.input.unwrap_or(0.0),
                        output: t.output.unwrap_or(0.0),
                        cache_write: t.cache_write.unwrap_or(0.0),
                        cache_read: t.cache_read.unwrap_or(0.0),
                        cache_write_1h: t.cache_write_1h,
                        ..Default::default()
                    },
                )
            });
            let miss = match tokens {
                Some(tokens) if !outcome.held && outcome.status_code < 400 => {
                    self.insights.lock().unwrap().observe_answer(&AnswerFacts {
                        at: started,
                        session_key: session_key.clone(),
                        account_id: account_id.clone(),
                        model: Some(requested_model.clone()),
                        request_class: request_class.clone(),
                        agent_id: agent_id.clone(),
                        compacted,
                        tokens: Some(tokens),
                    })
                }
                _ => None,
            };
            self.insights
                .lock()
                .unwrap()
                .prompt_served_by(prompt_id.as_deref(), &account_id);
            let note = if outcome.extra_usage {
                Some("extra-usage".to_string())
            } else if let Some(failure) = outcome.failure {
                Some(failure.as_str().to_string())
            } else {
                match selection.moved {
                    Some(moved) if moved != crate::types::ProxyMoveReason::Limit => {
                        Some(format!("{}-move", moved.as_str()))
                    }
                    _ => None,
                }
            };
            self.record_log(about.onto(ProxyRequestLog {
                at: started,
                account_id: Some(account_id.clone()),
                provider: Some(target_provider.as_str().into()),
                model: Some(requested_model.clone()),
                status: outcome.status_code,
                ms: Some((self.now)() - started),
                request_id: outcome.request_id.clone(),
                tokens,
                cost,
                miss,
                error: outcome.error_message.clone(),
                // A refusal is answered here; it does not go on to another account.
                failover: (outcome.held && outcome.failure != Some(FailureKind::Refused))
                    .then_some(true),
                affinity: selection.session_affinity_hit.then_some(true),
                pick: Some(pick),
                note,
                ..Default::default()
            }));
            self.apply_outcome(
                &account_id,
                route_key.as_deref(),
                &outcome,
                model_family(Some(&requested_model)),
            );
            if outcome.held && outcome.failure == Some(FailureKind::Refused) {
                // Every account would answer the same: tell the client, and keep the accounts in.
                let quoted = outcome
                    .error_message
                    .as_deref()
                    .map(|m| format!(" (\"{m}\")"))
                    .unwrap_or_default();
                send_json_error(
                    res,
                    429,
                    "rate_limit_error",
                    &format!(
                        "Anthropic refused this request{quoted} although none of the account's limits is spent. Requests that do not come from Claude Code are refused this way. Relay did not pause the account."
                    ),
                    &[],
                );
                return;
            }
            if !outcome.held {
                return;
            }
            last_held = Some(outcome.status_code);
            held_on = Some(account_id);
            self.record_error(&format!(
                "{} answered {}; trying another account",
                selection.account.name, outcome.status_code
            ));
        }
        // Every attempt was held: only overflow holds the last one, and takes it now.
        if last_held.is_some_and(|status| to_overflow(status == 429)) {
            return self.serve_overflow_from(parts, url, res, &body_buffer, parsed.as_ref(), &requested_model, &about, spill.as_ref(), held_on.as_deref()).await;
        }
        send_json_error(res, 502, "api_error", "No account could answer the request", &[]);
    }

    #[allow(clippy::too_many_arguments)]
    async fn serve_overflow_from(
        &self,
        parts: &Parts,
        url: &str,
        res: &mut ClientRes,
        body: &Bytes,
        parsed: Option<&Value>,
        requested: &str,
        about: &About,
        settings: Option<&OverflowSettings>,
        after: Option<&str>,
    ) {
        if let Some(settings) = settings {
            self.serve_overflow(parts, url, res, body, parsed, requested, about, settings, after)
                .await;
        }
    }

    /// Answers a request no subscription account could take from the API-key upstreams, in
    /// their order: one whose key is refused, limited or failing hands it to the next, the last
    /// one's answer goes to the client. Past the daily cap, a 429 says so until the day ends.
    #[allow(clippy::too_many_arguments)]
    async fn serve_overflow(
        &self,
        parts: &Parts,
        url: &str,
        res: &mut ClientRes,
        body: &Bytes,
        parsed: Option<&Value>,
        requested: &str,
        about: &About,
        settings: &OverflowSettings,
        after: Option<&str>,
    ) {
        let now = (self.now)();
        if let Some(cap) = settings.daily_cap_usd {
            if self.overflow_spent_today() >= cap {
                let (_, end) = local_day_bounds(now, &self.time_zone());
                self.record_log(about.onto(ProxyRequestLog {
                    at: now,
                    provider: Some("claude".into()),
                    model: Some(requested.into()),
                    status: 429,
                    note: Some("overflow-cap".into()),
                    ..Default::default()
                }));
                let shown = crate::js::number_string((cap * 100.0).round() / 100.0);
                let retry = (((end - now) as f64) / 1000.0).ceil().max(1.0) as i64;
                send_json_error(
                    res,
                    429,
                    "rate_limit_error",
                    &format!("Relay overflow daily cap of ${shown} reached"),
                    &[("retry-after", &retry.to_string())],
                );
                return;
            }
        }
        let mut enabled: Vec<&ApiUpstream> = settings.upstreams.iter().filter(|u| u.enabled).collect();
        enabled.sort_by(|a, b| a.order.partial_cmp(&b.order).unwrap_or(std::cmp::Ordering::Equal));
        let mut usable: Vec<(&ApiUpstream, String)> = Vec::new();
        for upstream in enabled {
            match self.hooks.overflow_key(&upstream.id).await.filter(|k| !k.is_empty()) {
                Some(key) => usable.push((upstream, key)),
                None => self.record_error(&format!(
                    "Overflow ({}) has no saved API key",
                    upstream.label
                )),
            }
        }
        if usable.is_empty() {
            self.record_log(about.onto(ProxyRequestLog {
                at: now,
                provider: Some("claude".into()),
                model: Some(requested.into()),
                status: 503,
                note: Some("overflow-no-key".into()),
                ..Default::default()
            }));
            send_json_error(
                res,
                503,
                "api_error",
                "Every account is limited and no overflow upstream has a saved API key",
                &[],
            );
            return;
        }
        let count = usable.len();
        for (index, (upstream, key)) in usable.into_iter().enumerate() {
            let model = overflow_model(&upstream.model_map, requested);
            let started = (self.now)();
            let account = format!("overflow:{}", upstream.id);
            self.stats.lock().unwrap().record_request(&account);
            let target = match build_target_url(&upstream.base_url, Some(url), false) {
                Ok(target) => target,
                Err(error) => {
                    self.record_error(&error.to_string());
                    send_json_error(res, 500, "api_error", &error.to_string(), &[]);
                    return;
                }
            };
            let hold = |status: u16| OVERFLOW_NEXT.contains(&status);
            let mut usage = AnthropicUsageExtractor::new();
            let outcome = forward_upstream(
                res,
                ForwardSpec {
                    method: parts.method.clone(),
                    target,
                    headers: overflow_headers(&parts.headers, upstream.preset, upstream.auth_style, &key),
                    body: overflow_body(body, parsed, &model),
                    account_id: &account,
                    stats: Some(&self.stats),
                    usage: &mut usage,
                    error_label: format!("Overflow ({})", upstream.label),
                    on_answer: None,
                    hold_if: (index < count - 1).then_some(&hold as &(dyn Fn(u16) -> bool + Sync)),
                    first_byte_timeout: None,
                    idle_timeout: None,
                    pool: self.pool.as_ref(),
                },
            )
            .await;
            let tokens = outcome.tokens;
            let mut cost = None;
            if let Some(tokens) = tokens.as_ref() {
                let fetched = if upstream.preset == crate::types::ApiUpstreamPreset::OpenRouter
                    && upstream.prices.is_none()
                {
                    self.hooks.overflow_price(&model).await
                } else {
                    None
                };
                cost = upstream_cost(upstream, &model, tokens, started, fetched);
            }
            if let Some(cost) = cost.filter(|c| *c != 0.0) {
                let mut own = self.own_overflow_costs.lock().unwrap();
                own.push_back(OverflowCost { at: started, cost });
                let oldest = (self.now)() - 2 * 86_400_000;
                while own.front().is_some_and(|c| c.at < oldest) {
                    own.pop_front();
                }
            }
            let mut pick = ProxyPick::new(crate::types::ProxyPickReason::Overflow);
            if index == 0 {
                pick.after = after.map(str::to_string);
            }
            self.record_log(about.onto(ProxyRequestLog {
                at: started,
                provider: Some("claude".into()),
                model: Some(model.clone()),
                status: outcome.status_code,
                ms: Some((self.now)() - started),
                upstream: Some(upstream.label.clone()),
                request_id: outcome.request_id.clone(),
                tokens,
                cost,
                error: outcome.error_message.clone(),
                failover: outcome.held.then_some(true),
                note: (tokens.is_some() && cost.is_none()).then(|| "unpriced".into()),
                pick: Some(pick),
                ..Default::default()
            }));
            if !outcome.held {
                return;
            }
            self.record_error(&format!(
                "Overflow ({}) answered {}; trying the next upstream",
                upstream.label, outcome.status_code
            ));
        }
    }

    /// No account's sign-in could be used: a 401 that says so, not a 429 a client would wait
    /// out. The message names Relay, since the client's own /login would not help.
    fn sign_in_needed(
        &self,
        res: &mut ClientRes,
        provider: Provider,
        model: &str,
        names: &[String],
        about: &About,
    ) {
        self.record_log(about.onto(ProxyRequestLog {
            at: now_ms(),
            provider: Some(provider.as_str().into()),
            model: Some(model.into()),
            status: 401,
            note: Some("sign-in".into()),
            ..Default::default()
        }));
        let message = if names.is_empty() {
            "Relay cannot use the sign-in of any account in its pool right now (expired or signed out). Renew it in Relay > Accounts.".to_string()
        } else {
            format!(
                "Relay cannot use the sign-in of {} (expired or signed out). Renew it in Relay > Accounts.",
                names.join(", ")
            )
        };
        send_json_error(res, 401, "authentication_error", &message, &[]);
    }

    /// The route to an account. Requests that arrive together for one account share a single
    /// read of its sign-in, so a burst reads the Keychain once, not once per request.
    async fn resolve_route(self: &Arc<Self>, account: &Account) -> Option<Route> {
        let read = {
            let mut resolving = self.resolving.lock().unwrap();
            match resolving.get(&account.id) {
                Some(running) => running.clone(),
                None => {
                    let inner = self.clone();
                    let owned = account.clone();
                    let read = async move { inner.read_route(&owned).await }.boxed().shared();
                    resolving.insert(account.id.clone(), read.clone());
                    read
                }
            }
        };
        let route = read.clone().await;
        let mut resolving = self.resolving.lock().unwrap();
        if resolving
            .get(&account.id)
            .is_some_and(|running| running.ptr_eq(&read))
        {
            resolving.remove(&account.id);
        }
        route
    }

    async fn read_route(&self, account: &Account) -> Option<Route> {
        let result = match account.provider() {
            Provider::Antigravity => self.hooks.antigravity(account).await.map(|route| {
                route
                    .filter(|r| !r.key.is_empty())
                    .map(|r| Route {
                        token: r.key.clone(),
                        antigravity: Some(r),
                    })
            }),
            // Gemini API key accounts are refused when forwarded, with a reason.
            Provider::Gemini => Ok(Some(Route {
                token: String::new(),
                antigravity: None,
            })),
            _ => self.hooks.credential(account).await.map(|token| {
                token.filter(|t| !t.is_empty()).map(|token| Route {
                    token,
                    antigravity: None,
                })
            }),
        };
        result.unwrap_or_else(|message| {
            self.record_error(&format!("Credential lookup failed: {message}"));
            None
        })
    }

    /// Whether an account not yet tried for this request could take it.
    fn can_try_another(
        &self,
        provider: Provider,
        tried: &HashSet<String>,
        pathname: &str,
        model: &str,
    ) -> bool {
        let snapshot = self.hooks.usage();
        let usable: Vec<Account> = snapshot
            .accounts
            .iter()
            .filter(|a| serves_route(a, pathname))
            .cloned()
            .collect();
        let context = if model.is_empty() {
            PickContext::default()
        } else {
            PickContext::model(model)
        };
        self.router
            .lock()
            .unwrap()
            .select_account(None, &usable, &snapshot.usage_map, Some(provider), tried, None, &context)
            .is_ok()
    }

    /// Sends the request to one account. `None` when the gateway already answered the client
    /// (an unsupported route); otherwise the upstream's outcome.
    #[allow(clippy::too_many_arguments)]
    async fn forward_to(
        &self,
        selection: &RouterSelection,
        route: &Route,
        parts: &Parts,
        url: &str,
        res: &mut ClientRes,
        body: &Bytes,
        pathname: &str,
        hold_if: &(dyn Fn(u16) -> bool + Sync),
        on_answer: &(dyn Fn(&EarlyAnswer) + Sync),
    ) -> Option<UpstreamOutcome> {
        let account = &selection.account;
        let provider = account.provider();
        if provider == Provider::Gemini {
            send_json_error(
                res,
                501,
                "unsupported_provider",
                "Gemini API key accounts are not supported by this gateway",
                &[],
            );
            return None;
        }
        let token = route.token.as_str();
        let api_key = provider == Provider::Codex && token.starts_with("sk-");
        if provider == Provider::Codex && !api_key && !RESPONSES_PATHS.contains(&pathname) {
            send_json_error(
                res,
                501,
                "unsupported_endpoint",
                "Codex OAuth accounts support the Responses API only",
                &[],
            );
            return None;
        }
        self.stats.lock().unwrap().record_request(&account.id);
        let (target, headers, label, mut extractor): (_, _, &str, Box<dyn UsageExtractor>) =
            if provider == Provider::Claude {
                (
                    build_target_url(
                        self.upstreams.anthropic_url.as_deref().unwrap_or(DEFAULT_ANTHROPIC_URL),
                        Some(url),
                        false,
                    ),
                    anthropic_headers(&parts.headers, token),
                    "Gateway error",
                    Box::new(AnthropicUsageExtractor::new()),
                )
            } else {
                let chatgpt = if provider == Provider::Codex && !api_key {
                    account
                        .auth
                        .as_ref()
                        .and_then(|a| a.account_uuid.as_deref())
                        .filter(|u| !u.is_empty())
                } else {
                    None
                };
                let base = if provider == Provider::Antigravity {
                    route
                        .antigravity
                        .as_ref()
                        .map_or("", |r| r.url.as_str())
                } else if api_key {
                    self.upstreams.openai_url.as_deref().unwrap_or(DEFAULT_OPENAI_URL)
                } else {
                    self.upstreams.codex_url.as_deref().unwrap_or(DEFAULT_CODEX_URL)
                };
                (
                    build_target_url(base, Some(url), true),
                    codex_headers(&parts.headers, token, chatgpt),
                    "Codex upstream error",
                    Box::new(CodexUsageExtractor::new()),
                )
            };
        let target = match target {
            Ok(target) => target,
            Err(error) => {
                self.record_error(&error.to_string());
                send_json_error(res, 500, "api_error", &error.to_string(), &[]);
                return None;
            }
        };
        Some(
            forward_upstream(
                res,
                ForwardSpec {
                    method: parts.method.clone(),
                    target,
                    headers,
                    body: body.clone(),
                    account_id: &account.id,
                    stats: Some(&self.stats),
                    usage: extractor.as_mut(),
                    error_label: label.into(),
                    on_answer: Some(on_answer),
                    hold_if: Some(hold_if),
                    first_byte_timeout: None,
                    idle_timeout: None,
                    pool: self.pool.as_ref(),
                },
            )
            .await,
        )
    }

    /// What an answer means for its account and the session that sent it.
    fn apply_outcome(
        &self,
        account_id: &str,
        session_key: Option<&str>,
        outcome: &UpstreamOutcome,
        family: Option<&str>,
    ) {
        let clamp = |seconds: i64| seconds.clamp(MIN_COOLDOWN_S, MAX_COOLDOWN_S) * 1000;
        let cool = |seconds: i64, reason: CooldownReason| {
            self.router
                .lock()
                .unwrap()
                .mark_unavailable(account_id, clamp(seconds), reason);
        };
        match outcome.failure {
            Some(FailureKind::Limit) => {
                // A full window's reset time beats a short Retry-After.
                let until_reset = outcome
                    .limit_resets_at
                    .map(|at| ((at - now_ms()) as f64 / 1000.0).ceil() as i64);
                let fallback = if until_reset.is_some_and(|s| s != 0) {
                    0
                } else {
                    DEFAULT_RATE_LIMIT_COOLDOWN_S
                };
                let seconds = until_reset.unwrap_or(0).max(
                    outcome
                        .retry_after_seconds
                        .map_or(fallback, |s| s as i64),
                );
                if outcome.limit_scope == Some(crate::upstream_common::LimitScope::Model) {
                    if let Some(family) = family {
                        // Only this model's own limit is spent: the account's other models keep
                        // serving, and only this session, which asks for the model, moves.
                        self.router
                            .lock()
                            .unwrap()
                            .mark_model_unavailable(account_id, family, clamp(seconds));
                        return self.extra_usage_after(account_id, outcome);
                    }
                }
                cool(seconds, CooldownReason::Limit);
                self.router
                    .lock()
                    .unwrap()
                    .session_cache_mut()
                    .evict_account(account_id);
            }
            Some(FailureKind::Auth) => {
                cool(AUTH_FAILURE_COOLDOWN_S, CooldownReason::Auth);
                // A cached token the upstream refused is read again next time, not reused.
                self.hooks.on_credential_rejected(account_id);
            }
            Some(FailureKind::Transient) => {
                if outcome.held || outcome.status_code == 529 || outcome.status_code == 503 {
                    cool(OVERLOADED_COOLDOWN_S, CooldownReason::Transient);
                }
            }
            Some(FailureKind::ExtraUsage) => {
                self.stats
                    .lock()
                    .unwrap()
                    .record_extra_usage(account_id, ExtraUsageKind::Required);
                if let Some(key) = session_key {
                    self.router.lock().unwrap().session_cache_mut().evict_session(key);
                }
            }
            Some(FailureKind::Permission) => {
                if let Some(key) = session_key {
                    self.router.lock().unwrap().session_cache_mut().evict_session(key);
                }
            }
            Some(FailureKind::Refused) | None => {}
        }
        self.extra_usage_after(account_id, outcome);
    }

    /// An answer billed as extra usage: the plan no longer covers this account's requests.
    fn extra_usage_after(&self, account_id: &str, outcome: &UpstreamOutcome) {
        if !outcome.extra_usage {
            return;
        }
        self.stats
            .lock()
            .unwrap()
            .record_extra_usage(account_id, ExtraUsageKind::Billed);
        let seconds = self
            .until_window_reset(account_id)
            .unwrap_or(EXTRA_USAGE_COOLDOWN_S);
        let mut router = self.router.lock().unwrap();
        router.mark_unavailable(
            account_id,
            seconds.clamp(MIN_COOLDOWN_S, MAX_COOLDOWN_S) * 1000,
            CooldownReason::Limit,
        );
        router.session_cache_mut().evict_account(account_id);
    }

    /// Seconds until the account's fullest read window resets, when Relay knows.
    fn until_window_reset(&self, account_id: &str) -> Option<i64> {
        let snapshot = self.hooks.usage();
        let usage = snapshot.usage_map.get(account_id)?;
        let now = now_ms();
        [usage.five_hour.as_ref(), usage.seven_day.as_ref()]
            .into_iter()
            .flatten()
            .filter(|w| w.used_percent >= 90.0)
            .filter_map(|w| w.resets_at.as_deref().and_then(crate::js::parse_date))
            .filter(|at| *at > now)
            .min()
            .map(|soonest| ((soonest - now) as f64 / 1000.0).ceil() as i64)
    }

    async fn websocket_upgrade(self: &Arc<Self>, request: Request<Incoming>) -> Option<Response<ResponseBody>> {
        if !self.host_allowed(header(request.headers(), "host")) {
            return Some(reject_upgrade(403, "Forbidden"));
        }
        if let Some((status, _, _)) = self.auth_failure(request.headers()) {
            return Some(reject_upgrade(
                status,
                if status == 401 { "Unauthorized" } else { "Forbidden" },
            ));
        }
        let (mut parts, body) = request.into_parts();
        let url = alias_codex_path(&raw_url(&parts));
        match parse_request_url(Some(&url)) {
            Ok(target) if target.pathname == "/responses" || target.pathname == "/v1/responses" => {}
            Ok(_) => return Some(reject_upgrade(404, "Not Found")),
            Err(_) => return Some(reject_upgrade(400, "Bad Request")),
        }
        if let Ok(uri) = url.parse() {
            parts.uri = uri;
        }
        let request = Request::from_parts(parts, body);
        // The Responses WebSocket is ChatGPT's: an OpenAI API key account cannot serve it, so
        // such accounts, and any without a readable sign-in, are skipped.
        let mut tried = HashSet::new();
        loop {
            let snapshot = self.hooks.usage();
            let selection = self.router.lock().unwrap().select_account(
                None,
                &snapshot.accounts,
                &snapshot.usage_map,
                Some(Provider::Codex),
                &tried,
                None,
                &PickContext::default(),
            );
            let selection = match selection {
                Ok(selection) => selection,
                Err(RouterError::NoEligible { .. }) => {
                    return Some(reject_upgrade(429, "Too Many Requests"));
                }
                Err(RouterError::NoProvider { .. }) => {
                    return Some(reject_upgrade(503, "Service Unavailable"));
                }
            };
            tried.insert(selection.account.id.clone());
            let token = match self.hooks.credential(&selection.account).await {
                Ok(token) => token,
                Err(message) => {
                    self.record_error(&format!("WebSocket upgrade failed: {message}"));
                    return Some(reject_upgrade(502, "Bad Gateway"));
                }
            };
            let Some(token) = token.filter(|t| !t.is_empty() && !t.starts_with("sk-")) else {
                continue;
            };
            let account_id = selection.account.id.clone();
            self.stats.lock().unwrap().record_request(&account_id);
            self.record_log(ProxyRequestLog {
                at: now_ms(),
                account_id: Some(account_id),
                provider: Some("codex".into()),
                model: Some("websocket".into()),
                status: 101,
                ..Default::default()
            });
            return self
                .ws
                .handle_upgrade(
                    request,
                    WebSocketBridgeOptions {
                        upstream_url: self
                            .upstreams
                            .codex_websocket_url
                            .clone()
                            .unwrap_or_else(|| CODEX_WS_URL.into()),
                        token: Some(token),
                        chatgpt_account_id: selection
                            .account
                            .auth
                            .as_ref()
                            .and_then(|a| a.account_uuid.clone())
                            .filter(|u| !u.is_empty()),
                    },
                )
                .await;
        }
    }
}

/// A Codex ChatGPT sign-in (one with a ChatGPT account id) only answers the Responses API.
fn serves_route(account: &Account, pathname: &str) -> bool {
    let chatgpt = account
        .auth
        .as_ref()
        .and_then(|a| a.account_uuid.as_deref())
        .is_some_and(|u| !u.is_empty());
    if account.provider != Some(Provider::Codex) || !chatgpt {
        return true;
    }
    RESPONSES_PATHS.contains(&pathname)
}

/// Session keys come from clients: long ones are hashed so the cache stays small.
fn bounded_key(key: String) -> String {
    if crate::js::units(&key) <= 128 {
        return key;
    }
    let digest = Sha256::digest(key.as_bytes());
    format!("h:{}", &hex(&digest)[..32])
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `String(value)` for the JSON values a session id may be given as.
fn js_string(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Bool(false) => None,
        Value::String(s) if s.is_empty() => None,
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => {
            let f = n.as_f64()?;
            (f != 0.0 && !f.is_nan()).then(|| crate::js::number_string(f))
        }
        Value::Bool(true) => Some("true".into()),
        Value::Array(_) => Some(
            value
                .as_array()?
                .iter()
                .map(|v| match v {
                    Value::Null => String::new(),
                    Value::String(s) => s.clone(),
                    other => js_string(other).unwrap_or_default(),
                })
                .collect::<Vec<_>>()
                .join(","),
        ),
        Value::Object(_) => Some("[object Object]".into()),
    }
}

fn extract_session_key(headers: &HeaderMap, parsed: Option<&Value>) -> Option<String> {
    // Explicit headers first. Claude Code names its session in x-claude-code-session-id on
    // every request, subagents' included, so a whole session keeps one account and one cache.
    for name in [
        "x-claude-code-session-id",
        "x-session-id",
        "x-conversation-id",
        "session_id",
        "conversation_id",
    ] {
        if let Some(value) = header(headers, name).filter(|v| !v.is_empty()) {
            return Some(bounded_key(format!("hdr:{value}")));
        }
    }
    let parsed = parsed.filter(|p| p.is_object() || p.is_array())?;
    let metadata = parsed.get("metadata");
    if let Some(user) = metadata.and_then(|m| m.get("user_id")).and_then(js_string) {
        return Some(bounded_key(format!("user:{user}")));
    }
    if let Some(conversation) = metadata
        .and_then(|m| m.get("conversation_id"))
        .and_then(js_string)
    {
        return Some(bounded_key(format!("conv:{conversation}")));
    }
    // The Responses API names the conversation for its own prompt cache.
    if let Some(key) = parsed
        .get("prompt_cache_key")
        .and_then(Value::as_str)
        .filter(|k| !k.is_empty())
    {
        return Some(bounded_key(format!("cache:{key}")));
    }
    // The first message as the conversation's fingerprint.
    let first = parsed.get("messages")?.as_array()?.first()?;
    let text = message_text(first.get("content"));
    if crate::js::units(&text) > 20 {
        let head = crate::js::slice_units(&text, 200);
        let digest = Sha256::digest(head.as_bytes());
        return Some(format!("msg_hash:{}", &hex(&digest)[..16]));
    }
    None
}

/// The text of a message whose content is a string or a list of content blocks.
fn message_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .map(|block| {
                if block.get("type").and_then(Value::as_str) == Some("text") {
                    block.get("text").and_then(Value::as_str).unwrap_or("")
                } else {
                    ""
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}
