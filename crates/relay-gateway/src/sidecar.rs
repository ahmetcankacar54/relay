//! `relay __gateway`: the gateway as a child process of the Electron app (plan, Phase 3.1).
//! The parent and the child talk in newline-delimited JSON, one object per line, on the
//! child's stdin and stdout. Every message has a `"t"` (type) field. The child exits when stdin
//! closes (or on `stop`), stopping the gateway first.
//!
//! # Parent → child
//!
//! - `{"t":"config","config":SidecarConfig}`: the first one starts the gateway. A later one
//!   with the same host and port changes the running gateway in place (strategy, session time,
//!   key, subagent overflow, overflow, time zone); a new host or port restarts it, answering
//!   `ready` or `error` again.
//! - `{"t":"usage","accounts":[Account…],"usage":{accountId:AccountUsage…}}`: the pool (in its
//!   order, excluded accounts already left out) and the limits as the app last read them; each
//!   push replaces the last one.
//! - `{"t":"credential","id":n,"value":V}`: the answer to `need-credential`. `V` is `null` (no
//!   usable sign-in), the token as a string, `{"accessToken":"…"}`, or `{"error":"…"}` (the
//!   lookup failed; logged as such).
//! - `{"t":"overflow-key","id":n,"value":"…"|null}`: the answer to `need-overflow-key`.
//! - `{"t":"antigravity","id":n,"value":{"url":"…","key":"…"}|null}`: the answer to
//!   `need-antigravity`.
//! - `{"t":"status","id":n}`: asks for `status-reply`.
//! - `{"t":"evict","accountId":"…"}`: drops the account's sessions (the account was removed).
//! - `{"t":"stop"}`: stops the gateway and exits.
//!
//! A request the child sends (`need-*`) that gets no answer within `replyTimeoutMs` counts as
//! answered with `null`.
//!
//! # Child → parent
//!
//! - `{"t":"ready","port":p}`: listening (after a `config`).
//! - `{"t":"error","code":"EADDRINUSE"|"other","message":"…"}`: the gateway could not start,
//!   or a line could not be read.
//! - `{"t":"need-credential","id":n,"accountId":"…"}`,
//!   `{"t":"need-overflow-key","id":n,"upstreamId":"…"}`,
//!   `{"t":"need-antigravity","id":n,"accountId":"…"}`: answer with the same `id`.
//! - `{"t":"status-reply","id":n,"status":S}`: `S` is `null` before the gateway was configured,
//!   else `/status`'s body (`ok`, `state`, `metrics`) plus what the app's Proxy page needs from
//!   the running gateway: `recent` (the feed, newest first), `nextPick`, `cooldowns`
//!   (`{accountId:{"until":ms,"reason":"limit"|"auth"|"transient"}}`), `sessions` (the cache
//!   views), `alarms` and `fullAt` (`{accountId:ms}`).
//! - `{"t":"sessions","list":[ProxySessionState…]}`: the session cache, every
//!   `sessionsIntervalMs` while the gateway runs.
//! - `{"t":"live-limits","accountId":"…","live":LiveLimits}`
//! - `{"t":"credential-rejected","accountId":"…"}`
//! - `{"t":"credential-missing","accountId":"…"}`
//! - `{"t":"loop-alarm","alarm":ProxyLoopAlarm}`
//! - `{"t":"request-log","entry":ProxyRequestLog}`: for the app's `GatewayRequestLog.record`.
//! - `{"t":"request-bound","requestId":"…","accountId":"…"}`: for `GatewayRequestLog.bind`
//!   (not in the plan's list; the token table needs it as soon as the answer's headers arrive).
//!
//! # `SidecarConfig`
//!
//! `ProxyConfig`'s fields (camelCase, as `proxySettings()` returns them, `apiKey` included)
//! plus:
//! - `upstreams`: `{anthropicUrl?, codexUrl?, openaiUrl?, codexWebSocketUrl?}` stand-ins
//!   (tests, parity runs);
//! - `timeZone`: the planning time zone (the overflow cap is per day there);
//! - `openRouterPricesFile`: where OpenRouter's prices are kept (`openrouter-prices.json`);
//! - `recentRequests`: `gatewayRequests().recent()`, the feed kept across restarts;
//! - `overflowCosts`: `gatewayRequests().overflowCosts()`, `[{at,cost}]`, the cap's spend
//!   across restarts;
//! - `replyTimeoutMs` (default 30 000) and `sessionsIntervalMs` (default 5 000).

use crate::overflow_upstream::{OpenRouterPrices, OpenRouterPricesOptions};
use crate::proxy_server::{
    AntigravityRoute, GatewayHooks, ProxyServer, ServerOptions, StartError, Upstreams,
};
use crate::proxy_stats::REQUEST_LOG_SIZE;
use crate::types::{
    Account, AccountUsage, LiveLimits, OverflowCost, OverflowRates, ProxyConfig, ProxyLoopAlarm,
    ProxyRequestLog, UsageMap, UsageSnapshot,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};

const DEFAULT_REPLY_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_SESSIONS_INTERVAL_MS: u64 = 5_000;

/// What the parent's `config` message carries.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarConfig {
    #[serde(flatten)]
    pub proxy: ProxyConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstreams: Option<Upstreams>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_router_prices_file: Option<PathBuf>,
    #[serde(default)]
    pub recent_requests: Vec<ProxyRequestLog>,
    #[serde(default)]
    pub overflow_costs: Vec<OverflowCost>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sessions_interval_ms: Option<u64>,
}

/// Overflow answers' costs are kept this long: any time zone's current day fits inside it.
const SPEND_KEEP_MS: i64 = 2 * 86_400_000;

/// The gateway's hooks, answered by the parent over the pipe.
struct SidecarHooks {
    out: mpsc::UnboundedSender<Value>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
    snapshot: Mutex<Arc<UsageSnapshot>>,
    time_zone: Mutex<Option<String>>,
    reply_timeout: Mutex<Duration>,
    /// The newest requests (newest last), for a restarted gateway's feed.
    recent: Mutex<VecDeque<ProxyRequestLog>>,
    overflow_costs: Mutex<Vec<OverflowCost>>,
    prices: Mutex<Option<Arc<OpenRouterPrices>>>,
}

impl SidecarHooks {
    fn new(out: mpsc::UnboundedSender<Value>) -> Self {
        SidecarHooks {
            out,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            snapshot: Mutex::new(Arc::new(UsageSnapshot::default())),
            time_zone: Mutex::new(None),
            reply_timeout: Mutex::new(Duration::from_millis(DEFAULT_REPLY_TIMEOUT_MS)),
            recent: Mutex::new(VecDeque::new()),
            overflow_costs: Mutex::new(Vec::new()),
            prices: Mutex::new(None),
        }
    }

    fn send(&self, message: Value) {
        let _ = self.out.send(message);
    }

    /// Asks the parent and waits for the reply with the same id; `None` on timeout.
    async fn ask(&self, kind: &str, field: &str, value: &str) -> Option<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.send(json!({ "t": kind, "id": id, field: value }));
        let timeout = *self.reply_timeout.lock().unwrap();
        let reply = tokio::time::timeout(timeout, rx)
            .await
            .ok()
            .and_then(Result::ok);
        self.pending.lock().unwrap().remove(&id);
        reply
    }

    /// A reply from the parent; ignored when nothing waits for it any more.
    fn answer(&self, id: u64, value: Value) {
        if let Some(waiting) = self.pending.lock().unwrap().remove(&id) {
            let _ = waiting.send(value);
        }
    }

    fn configure(&self, config: &SidecarConfig, first: bool) {
        *self.time_zone.lock().unwrap() = config.time_zone.clone();
        *self.reply_timeout.lock().unwrap() =
            Duration::from_millis(config.reply_timeout_ms.unwrap_or(DEFAULT_REPLY_TIMEOUT_MS));
        if first {
            let mut recent = self.recent.lock().unwrap();
            recent.extend(config.recent_requests.iter().cloned());
            while recent.len() > REQUEST_LOG_SIZE {
                recent.pop_front();
            }
            *self.overflow_costs.lock().unwrap() = config.overflow_costs.clone();
        }
        let mut prices = self.prices.lock().unwrap();
        if prices.is_none() || first {
            *prices = Some(Arc::new(OpenRouterPrices::new(OpenRouterPricesOptions {
                file: config.open_router_prices_file.clone(),
                ..Default::default()
            })));
        }
    }
}

#[async_trait]
impl GatewayHooks for SidecarHooks {
    async fn credential(&self, account: &Account) -> Result<Option<String>, String> {
        match self.ask("need-credential", "accountId", &account.id).await {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(token)) => Ok(Some(token)),
            Some(Value::Object(object)) => {
                if let Some(error) = object.get("error").and_then(Value::as_str) {
                    return Err(error.to_string());
                }
                Ok(object
                    .get("accessToken")
                    .or_else(|| object.get("token"))
                    .and_then(Value::as_str)
                    .map(str::to_string))
            }
            Some(_) => Ok(None),
        }
    }

    async fn antigravity(&self, account: &Account) -> Result<Option<AntigravityRoute>, String> {
        let reply = self.ask("need-antigravity", "accountId", &account.id).await;
        Ok(reply.and_then(|value| serde_json::from_value(value).ok()))
    }

    fn usage(&self) -> Arc<UsageSnapshot> {
        self.snapshot.lock().unwrap().clone()
    }

    fn on_live_limits(&self, account_id: &str, live: &LiveLimits) {
        self.send(json!({ "t": "live-limits", "accountId": account_id, "live": live }));
    }

    fn on_credential_rejected(&self, account_id: &str) {
        self.send(json!({ "t": "credential-rejected", "accountId": account_id }));
    }

    fn on_credential_missing(&self, account_id: &str) {
        self.send(json!({ "t": "credential-missing", "accountId": account_id }));
    }

    fn on_loop_alarm(&self, alarm: &ProxyLoopAlarm) {
        self.send(json!({ "t": "loop-alarm", "alarm": alarm }));
    }

    fn request_log(&self, entry: &ProxyRequestLog) {
        {
            let mut recent = self.recent.lock().unwrap();
            recent.push_back(entry.clone());
            while recent.len() > REQUEST_LOG_SIZE {
                recent.pop_front();
            }
        }
        if let (Some(_), Some(cost)) = (&entry.upstream, entry.cost) {
            if cost != 0.0 {
                let mut costs = self.overflow_costs.lock().unwrap();
                costs.push(OverflowCost { at: entry.at, cost });
                let oldest = crate::js::now_ms() - SPEND_KEEP_MS;
                costs.retain(|c| c.at >= oldest);
            }
        }
        self.send(json!({ "t": "request-log", "entry": entry }));
    }

    fn request_bound(&self, request_id: &str, account_id: &str) {
        self.send(
            json!({ "t": "request-bound", "requestId": request_id, "accountId": account_id }),
        );
    }

    fn recent_requests(&self) -> Vec<ProxyRequestLog> {
        self.recent.lock().unwrap().iter().cloned().collect()
    }

    fn overflow_costs(&self) -> Option<Vec<OverflowCost>> {
        Some(self.overflow_costs.lock().unwrap().clone())
    }

    async fn overflow_key(&self, upstream_id: &str) -> Option<String> {
        match self
            .ask("need-overflow-key", "upstreamId", upstream_id)
            .await?
        {
            Value::String(key) if !key.is_empty() => Some(key),
            _ => None,
        }
    }

    async fn overflow_price(&self, model: &str) -> Option<OverflowRates> {
        let prices = self.prices.lock().unwrap().clone()?;
        prices.rate(model).await
    }

    fn time_zone(&self) -> Option<String> {
        self.time_zone.lock().unwrap().clone()
    }
}

/// The running gateway and its session ticker.
struct Running {
    server: Arc<ProxyServer>,
    host: String,
    /// The port asked for (0 picks one; the server keeps what it got).
    port: u16,
    ticker: tokio::task::JoinHandle<()>,
}

impl Running {
    async fn stop(self) {
        self.ticker.abort();
        self.server.stop().await;
    }
}

/// Runs the protocol until stdin closes or `stop`; answers the process's exit code.
pub async fn run_sidecar<R, W>(input: R, output: W) -> i32
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send,
{
    let (out, outbox) = mpsc::unbounded_channel::<Value>();
    let (done, finished) = oneshot::channel::<()>();
    let hooks = Arc::new(SidecarHooks::new(out));
    let reader = async {
        let code = read_loop(input, hooks.clone()).await;
        let _ = done.send(());
        code
    };
    let (code, ()) = tokio::join!(reader, write_loop(outbox, finished, output));
    code
}

async fn write_loop<W: AsyncWrite + Unpin>(
    mut outbox: mpsc::UnboundedReceiver<Value>,
    mut finished: oneshot::Receiver<()>,
    mut output: W,
) {
    let write = |message: Value| {
        let mut line = message.to_string();
        line.push('\n');
        line
    };
    loop {
        tokio::select! {
            biased;
            message = outbox.recv() => match message {
                Some(message) => {
                    if output.write_all(write(message).as_bytes()).await.is_err() {
                        return;
                    }
                    let _ = output.flush().await;
                }
                None => break,
            },
            _ = &mut finished => {
                // What was said before the end still goes out.
                while let Ok(message) = outbox.try_recv() {
                    if output.write_all(write(message).as_bytes()).await.is_err() {
                        return;
                    }
                }
                break;
            }
        }
    }
    let _ = output.flush().await;
    let _ = output.shutdown().await;
}

async fn read_loop<R: AsyncBufRead + Unpin>(input: R, hooks: Arc<SidecarHooks>) -> i32 {
    let mut lines = input.lines();
    let mut running: Option<Running> = None;
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            // Stdin closed (or broken): the parent is gone.
            Ok(None) | Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let message: Map<String, Value> = match serde_json::from_str(&line) {
            Ok(Value::Object(message)) => message,
            _ => {
                hooks.send(json!({ "t": "error", "code": "other", "message": "The line is not a JSON object" }));
                continue;
            }
        };
        let id = message.get("id").and_then(Value::as_u64);
        let value = || message.get("value").cloned().unwrap_or(Value::Null);
        match message.get("t").and_then(Value::as_str).unwrap_or("") {
            "config" => {
                let config = message
                    .get("config")
                    .cloned()
                    .map(serde_json::from_value::<SidecarConfig>);
                match config {
                    Some(Ok(config)) => running = configure(running, config, &hooks).await,
                    _ => hooks.send(json!({ "t": "error", "code": "other", "message": "The config is not valid" })),
                }
            }
            "usage" => {
                let accounts: Vec<Account> = message
                    .get("accounts")
                    .cloned()
                    .and_then(|a| serde_json::from_value(a).ok())
                    .unwrap_or_default();
                let usage_map: UsageMap = message
                    .get("usage")
                    .and_then(Value::as_object)
                    .map(|map| {
                        map.iter()
                            .filter_map(|(id, usage)| {
                                serde_json::from_value::<AccountUsage>(usage.clone())
                                    .ok()
                                    .map(|usage| (id.clone(), usage))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                *hooks.snapshot.lock().unwrap() = Arc::new(UsageSnapshot {
                    accounts,
                    usage_map,
                });
            }
            "credential" | "overflow-key" | "antigravity" => {
                if let Some(id) = id {
                    hooks.answer(id, value());
                }
            }
            "status" => {
                let status = running
                    .as_ref()
                    .map(|r| status_of(&r.server, &hooks))
                    .unwrap_or(Value::Null);
                hooks.send(json!({ "t": "status-reply", "id": id, "status": status }));
            }
            "evict" => {
                if let (Some(running), Some(account)) =
                    (&running, message.get("accountId").and_then(Value::as_str))
                {
                    running.server.session_cache().evict_account(account);
                }
            }
            "stop" => break,
            _ => {}
        }
    }
    if let Some(running) = running.take() {
        running.stop().await;
    }
    0
}

/// Starts the gateway, changes it in place, or restarts it on a new host or port.
async fn configure(
    running: Option<Running>,
    config: SidecarConfig,
    hooks: &Arc<SidecarHooks>,
) -> Option<Running> {
    hooks.configure(&config, running.is_none());
    if let Some(current) = running {
        if current.host == config.proxy.host && current.port == config.proxy.port {
            let next = config.proxy.clone();
            current.server.update_config(|c| {
                let port = c.port;
                *c = next;
                c.port = port;
            });
            return Some(current);
        }
        current.stop().await;
    }
    let server = Arc::new(ProxyServer::with_options(
        config.proxy.clone(),
        hooks.clone(),
        config.upstreams.clone().unwrap_or_default(),
        ServerOptions::default(),
    ));
    match server.start().await {
        Ok(state) => {
            hooks.send(json!({ "t": "ready", "port": state.port }));
            let interval = Duration::from_millis(
                config
                    .sessions_interval_ms
                    .unwrap_or(DEFAULT_SESSIONS_INTERVAL_MS)
                    .max(1),
            );
            let ticking = server.clone();
            let ticker_hooks = hooks.clone();
            let ticker = tokio::spawn(async move {
                let mut every = tokio::time::interval(interval);
                every.tick().await;
                loop {
                    every.tick().await;
                    let list = ticking.session_cache().list();
                    ticker_hooks.send(json!({ "t": "sessions", "list": list }));
                }
            });
            Some(Running {
                server,
                host: config.proxy.host,
                port: config.proxy.port,
                ticker,
            })
        }
        Err(error) => {
            let code = match error {
                StartError::AddrInUse(_) => "EADDRINUSE",
                StartError::Other(_) => "other",
            };
            hooks.send(json!({ "t": "error", "code": code, "message": error.to_string() }));
            None
        }
    }
}

/// `/status`'s body plus what the Proxy page reads from the running gateway.
fn status_of(server: &ProxyServer, hooks: &SidecarHooks) -> Value {
    let mut body = serde_json::to_value(server.status()).unwrap_or(Value::Null);
    let Value::Object(map) = &mut body else {
        return body;
    };
    let snapshot = hooks.usage();
    let mut cooldowns = Map::new();
    let mut full_at = Map::new();
    {
        let mut router = server.router();
        for account in &snapshot.accounts {
            if let Some(cooldown) = router.cooldown_of(&account.id) {
                cooldowns.insert(
                    account.id.clone(),
                    json!({ "until": cooldown.until, "reason": cooldown.reason.as_str() }),
                );
            }
        }
    }
    map.insert("recent".into(), json!(server.stats().recent()));
    map.insert("nextPick".into(), json!(server.next_picks()));
    map.insert("cooldowns".into(), Value::Object(cooldowns));
    let insights = server.insights();
    for account in &snapshot.accounts {
        if let Some(at) = insights.full_at(&account.id) {
            full_at.insert(account.id.clone(), json!(at));
        }
    }
    map.insert("sessions".into(), json!(insights.session_views(8)));
    map.insert("alarms".into(), json!(insights.alarms()));
    map.insert("fullAt".into(), Value::Object(full_at));
    drop(insights);
    body
}
