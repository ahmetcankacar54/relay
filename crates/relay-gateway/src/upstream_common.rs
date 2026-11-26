//! What the Anthropic, Codex and overflow upstreams share (`upstream-common.ts`): the request
//! target, header hygiene, reading what an answer says about its account, and forwarding one
//! buffered request with the gateway's own deadlines while the answer streams back.

use crate::client_res::{ClientRes, send_json_error};
use crate::js::{iso_string, now_ms, number, parse_date, round, slice_units};
use crate::proxy_stats::ProxyStats;
use crate::types::{LiveLimits, LiveModelWindow, LiveWindow, TokenTally};
use bytes::{Bytes, BytesMut};
use http::{HeaderMap, HeaderName, Method, Response, StatusCode};
use regex::Regex;
use reqwest::Url;
use serde_json::Value;
use std::fmt;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

/// The client sent something the gateway must not forward (HTTP 400).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BadRequestError(pub String);

impl fmt::Display for BadRequestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for BadRequestError {}

/// Collects token usage out of the parsed events (or the whole JSON body) of one response.
pub trait UsageExtractor: Send {
    fn on_event(&mut self, data: &Value);
    fn result(&self) -> Option<TokenTally>;
}

/// What a failed answer says about the account that gave it (see `upstream-common.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureKind {
    /// A usage window is spent (429).
    Limit,
    /// This request needs extra usage the plan does not cover; the account still serves others.
    ExtraUsage,
    /// The sign-in was refused.
    Auth,
    /// The account may not use what was asked (a model or a feature).
    Permission,
    /// An overload or an answer from something in front of the API.
    Transient,
    /// A 429 that no header calls a spent window and whose message is not about a limit.
    Refused,
}

impl FailureKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FailureKind::Limit => "limit",
            FailureKind::ExtraUsage => "extra-usage",
            FailureKind::Auth => "auth",
            FailureKind::Permission => "permission",
            FailureKind::Transient => "transient",
            FailureKind::Refused => "refused",
        }
    }
}

/// Whose limit a 429 spent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LimitScope {
    Model,
    Account,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct UpstreamOutcome {
    pub status_code: u16,
    pub rate_limited: bool,
    /// The upstream refused the token (401/403).
    pub unauthorized: bool,
    pub failure: Option<FailureKind>,
    /// An error answer's own message, shortened.
    pub error_message: Option<String>,
    /// The upstream reported that this answer was billed as extra usage.
    pub extra_usage: bool,
    pub retry_after_seconds: Option<u64>,
    /// When the account's exhausted limit resets (ms).
    pub limit_resets_at: Option<i64>,
    pub limit_scope: Option<LimitScope>,
    /// The answer was held back (`hold_if`) and nothing was sent to the client.
    pub held: bool,
    /// The provider's id for this request (Anthropic's `request-id`).
    pub request_id: Option<String>,
    pub tokens: Option<TokenTally>,
    pub live: Option<LiveLimits>,
}

impl UpstreamOutcome {
    fn bare(status_code: u16) -> Self {
        UpstreamOutcome {
            status_code,
            ..Default::default()
        }
    }
}

/// What an answer's head says, before its body: told to `on_answer`.
#[derive(Clone, Debug, PartialEq)]
pub struct EarlyAnswer {
    pub status_code: u16,
    pub request_id: Option<String>,
    pub live: Option<LiveLimits>,
}

const LOCAL_ORIGIN: &str = "http://relay.invalid";
/// An error answer's body is kept up to this size to tell what kind of failure it is.
const MAX_ERROR_BODY: usize = 64 * 1024;
/// An error message kept for the request log.
const MAX_ERROR_MESSAGE: usize = 160;
/// A response body is only parsed for usage up to this size; SSE is parsed incrementally.
const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_SSE_LINE: usize = 1024 * 1024;
/// Until the upstream answers at all: a long prompt can take minutes before its first byte.
pub const DEFAULT_FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Silence once the answer began.
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Opening the connection (TCP and TLS).
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Idle pooled connections close after this, as with Node's shared agent.
pub const UPSTREAM_POOL_IDLE: Duration = Duration::from_secs(5);

static REQUEST_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,128}$").unwrap());
/// A 403 about the sign-in itself, not about what was asked.
static AUTH_403: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)oauth|token|credential|revoked|organization (?:has been )?disabled|account (?:has been )?(?:disabled|suspended)|only authorized for use with claude code").unwrap()
});
static WINDOW_STATUS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^anthropic-ratelimit-unified-(.+)-status$").unwrap());
static WINDOW_UTILIZATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^anthropic-ratelimit-unified-(.+)-utilization$").unwrap());
/// A rate-limit window named after a model family is that model's own limit.
static MODEL_NAMED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(fable|opus|sonnet|haiku)").unwrap());
static GENERAL_WINDOW: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(?:5h|7d|five_hour|seven_day)$").unwrap());
static CLIENT_WINDOW: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)oauth|cowork|omelette|design").unwrap());
static OI_WINDOW: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?:^|_)oi$").unwrap());
static WEEKLY_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^5h|five").unwrap());
static NOT_LIMIT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)limit|exceed|too many|quota|concurren").unwrap());
static EXTRA_USAGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)extra usage").unwrap());

const DROP_REQUEST_HEADERS: [&str; 18] = [
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "expect",
    "host",
    "content-length",
    // The body is read for token counts, so ask for it uncompressed.
    "accept-encoding",
    // The account's token replaces whatever credential the client holds.
    "authorization",
    "x-api-key",
    // Relay's own headers: the client key and the provider choice never leave the gateway.
    "x-relay-key",
    "x-relay-provider",
    // Set from the selected account when it is a ChatGPT sign-in, never from the client.
    "chatgpt-account-id",
];

const DROP_RESPONSE_HEADERS: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authenticate",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// The path and query of a request target on the gateway.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestTarget {
    pub pathname: String,
    /// `?…`, or empty.
    pub search: String,
}

fn local_origin() -> &'static Url {
    static ORIGIN: LazyLock<Url> = LazyLock::new(|| Url::parse(LOCAL_ORIGIN).unwrap());
    &ORIGIN
}

/// The request target as a path on the gateway. Anything that would resolve to another host
/// (`//host/x`, `/\host`, an absolute URL) is refused, so the account's token can never be
/// sent anywhere but the configured upstream.
pub fn parse_request_url(raw: Option<&str>) -> Result<RequestTarget, BadRequestError> {
    let raw = raw.unwrap_or("/");
    let invalid = || BadRequestError("Invalid request target".into());
    if !raw.starts_with('/') {
        return Err(invalid());
    }
    let parsed = local_origin().join(raw).map_err(|_| invalid())?;
    if parsed.origin() != local_origin().origin() {
        return Err(invalid());
    }
    Ok(RequestTarget {
        pathname: parsed.path().to_string(),
        search: parsed.query().map(|q| format!("?{q}")).unwrap_or_default(),
    })
}

/// The upstream URL for a client request: the base's origin and path prefix, then the
/// client's path and query. `strip_v1` drops a leading `/v1` when the base has its own path.
pub fn build_target_url(
    base: &str,
    raw: Option<&str>,
    strip_v1: bool,
) -> Result<Url, BadRequestError> {
    let client = parse_request_url(raw)?;
    let mut target = Url::parse(base).map_err(|e| BadRequestError(format!("Invalid URL: {e}")))?;
    let base_path = target.path().trim_end_matches('/').to_string();
    let mut path = client.pathname;
    if strip_v1 && !base_path.is_empty() {
        if let Some(rest) = path.strip_prefix("/v1") {
            if rest.is_empty() || rest.starts_with('/') {
                path = rest.to_string();
            }
        }
    }
    target.set_path(&format!("{base_path}{path}"));
    let query = client.search.strip_prefix('?').unwrap_or("");
    target.set_query((!query.is_empty()).then_some(query));
    Ok(target)
}

fn sanitized(source: &HeaderMap, drop: &[&str]) -> HeaderMap {
    let mut out = HeaderMap::with_capacity(source.len());
    for (name, value) in source {
        if !drop.contains(&name.as_str()) {
            out.append(name.clone(), value.clone());
        }
    }
    out
}

/// The client's headers minus hop-by-hop ones, credentials and Relay's own.
pub fn sanitize_request_headers(source: &HeaderMap) -> HeaderMap {
    sanitized(source, &DROP_REQUEST_HEADERS)
}

fn sanitize_response_headers(source: &HeaderMap) -> HeaderMap {
    sanitized(source, &DROP_RESPONSE_HEADERS)
}

/// A header's first value as text (Node's single-valued view).
pub fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

const UNIFIED: &str = "anthropic-ratelimit-unified-";
/// The longest a reset read from the overall header alone is trusted for when it names a
/// 5-hour window.
const FIVE_HOURS_MS: i64 = 5 * 60 * 60 * 1000;

fn rejected(headers: &HeaderMap, name: &str) -> bool {
    header(headers, name) == Some("rejected")
}

/// The windows whose status header says "rejected" (overage aside).
pub fn rejected_windows(headers: &HeaderMap) -> Vec<String> {
    headers
        .keys()
        .filter_map(|name| {
            let window = WINDOW_STATUS.captures(name.as_str())?.get(1)?.as_str();
            (window != "overage" && rejected(headers, &format!("{UNIFIED}{window}-status")))
                .then(|| window.to_string())
        })
        .collect()
}

/// When an exhausted limit resets, in ms: the windows that refused this request, each with its
/// own reset; else the overall reset, capped at five hours when it names that window.
pub fn parse_limit_reset(headers: &HeaderMap, now: i64) -> Option<i64> {
    let read = |name: &str| -> Option<i64> {
        let raw = header(headers, name).filter(|v| !v.is_empty())?;
        let seconds = number(raw);
        let ms = if seconds.is_finite() {
            Some((seconds * 1000.0) as i64)
        } else {
            parse_date(raw)
        }?;
        (ms > now).then_some(ms)
    };
    let windows: Vec<i64> = rejected_windows(headers)
        .iter()
        .filter_map(|w| read(&format!("{UNIFIED}{w}-reset")))
        .collect();
    if let Some(max) = windows.iter().max() {
        return Some(*max);
    }
    if !rejected(headers, &format!("{UNIFIED}status")) {
        return None;
    }
    let overall = read(&format!("{UNIFIED}reset"))?;
    let claim = header(headers, &format!("{UNIFIED}representative-claim")).unwrap_or("");
    Some(if claim == "five_hour" {
        overall.min(now + FIVE_HOURS_MS)
    } else {
        overall
    })
}

/// Whether a 429 spent one model's limit or the whole account's: "model" only when every
/// spent window (or, without any, the representative claim) names a model family.
pub fn limit_scope_of(headers: &HeaderMap) -> LimitScope {
    let windows = rejected_windows(headers);
    let general = |w: &str| GENERAL_WINDOW.is_match(w) || CLIENT_WINDOW.is_match(w);
    let model_named = |w: &str| MODEL_NAMED.is_match(w) || OI_WINDOW.is_match(w);
    if !windows.is_empty() {
        return if !windows.iter().any(|w| general(w)) && windows.iter().all(|w| model_named(w)) {
            LimitScope::Model
        } else {
            LimitScope::Account
        };
    }
    let claim = header(headers, &format!("{UNIFIED}representative-claim")).unwrap_or("");
    if MODEL_NAMED.is_match(claim) {
        LimitScope::Model
    } else {
        LimitScope::Account
    }
}

/// The `error.type` and `error.message` of a JSON error body.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ErrorInfo {
    pub kind: Option<String>,
    pub message: Option<String>,
}

/// The `error` of a JSON error body, or `None`.
pub fn error_message(body: Option<&str>) -> Option<ErrorInfo> {
    let body = body.filter(|b| !b.is_empty())?;
    let parsed: Value = serde_json::from_str(body).ok()?;
    let error = parsed.get("error")?;
    if !(error.is_object() || error.is_array()) {
        return None;
    }
    Some(ErrorInfo {
        kind: error
            .get("type")
            .and_then(Value::as_str)
            .map(str::to_string),
        message: error
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn live_window(headers: &HeaderMap, key: &str) -> Option<(f64, Option<String>)> {
    let raw = header(headers, &format!("{UNIFIED}{key}-utilization"))?;
    let fraction = if raw.trim().is_empty() {
        f64::NAN
    } else {
        number(raw)
    };
    if !fraction.is_finite() || fraction < 0.0 {
        return None;
    }
    let reset = header(headers, &format!("{UNIFIED}{key}-reset")).map_or(f64::NAN, number);
    let used = (round(fraction * 1000.0) / 10.0).min(100.0);
    let resets_at =
        (reset.is_finite() && reset > 0.0).then(|| iso_string((reset * 1000.0).trunc() as i64));
    Some((used, resets_at))
}

/// A window's percent and reset as an answer reports them: `-5h-utilization` is a fraction
/// (0.28 is 28 %), `-5h-reset` epoch seconds. `None` when the answer carries no window.
pub fn parse_live_limits(headers: &HeaderMap) -> Option<LiveLimits> {
    let window = |key: &str| {
        live_window(headers, key).map(|(used_percent, resets_at)| LiveWindow {
            used_percent,
            resets_at,
        })
    };
    let five_hour = window("5h");
    let seven_day = window("7d");
    // Windows of one model (`7d_opus`, a Fable one): named by family.
    let models: Vec<LiveModelWindow> = headers
        .keys()
        .filter_map(|name| {
            let key = WINDOW_UTILIZATION.captures(name.as_str())?.get(1)?.as_str();
            if key == "5h" || key == "7d" {
                return None;
            }
            let model = MODEL_NAMED.captures(key)?.get(1)?.as_str().to_lowercase();
            let (used_percent, resets_at) = live_window(headers, key)?;
            Some(LiveModelWindow {
                model,
                weekly: !WEEKLY_KEY.is_match(key),
                used_percent,
                resets_at,
            })
        })
        .collect();
    if five_hour.is_none() && seven_day.is_none() && models.is_empty() {
        return None;
    }
    Some(LiveLimits {
        five_hour,
        seven_day,
        models: (!models.is_empty()).then_some(models),
    })
}

/// Whether no rate-limit header of a 429 says a window is spent.
fn no_window_spent(headers: &HeaderMap) -> bool {
    if rejected(headers, &format!("{UNIFIED}status")) {
        return false;
    }
    !headers.keys().any(|name| {
        WINDOW_STATUS
            .captures(name.as_str())
            .and_then(|c| c.get(1))
            .is_some_and(|w| w.as_str() != "overage" && rejected(headers, name.as_str()))
    })
}

/// What an error answer says about the account; `None` for answers that say nothing about it.
pub fn classify_failure(
    status_code: u16,
    headers: &HeaderMap,
    body: Option<&str>,
) -> Option<FailureKind> {
    let error = error_message(body);
    match status_code {
        429 => {
            let message = error
                .as_ref()
                .and_then(|e| e.message.as_deref())
                .unwrap_or("");
            if EXTRA_USAGE.is_match(message) {
                return Some(FailureKind::ExtraUsage);
            }
            // A burst or concurrency limit names itself or asks for a wait (Retry-After).
            Some(
                if no_window_spent(headers)
                    && !headers.contains_key("retry-after")
                    && !message.trim().is_empty()
                    && !NOT_LIMIT.is_match(message)
                {
                    FailureKind::Refused
                } else {
                    FailureKind::Limit
                },
            )
        }
        401 => Some(FailureKind::Auth),
        403 => {
            let json = header(headers, "content-type")
                .unwrap_or("")
                .contains("json")
                || error.is_some();
            // Not the API's own answer (a challenge page from a proxy or CDN in front of it).
            let Some(error) = error.filter(|_| json) else {
                return Some(FailureKind::Transient);
            };
            if AUTH_403.is_match(error.message.as_deref().unwrap_or(""))
                || error.kind.as_deref() == Some("authentication_error")
            {
                return Some(FailureKind::Auth);
            }
            Some(if error.kind.as_deref() == Some("permission_error") {
                FailureKind::Permission
            } else {
                FailureKind::Auth
            })
        }
        503 | 529 => Some(FailureKind::Transient),
        _ => None,
    }
}

/// `Retry-After` in whole seconds: a number, or an HTTP date from `now`.
pub fn parse_retry_after(value: Option<&str>, now: i64) -> Option<u64> {
    let value = value.filter(|v| !v.is_empty())?;
    let seconds = number(value);
    if seconds.is_finite() && seconds >= 0.0 {
        return Some(seconds.ceil() as u64);
    }
    let date = parse_date(value)?;
    Some((((date - now) as f64) / 1000.0).ceil().max(0.0) as u64)
}

/// Reads usage out of a response as it streams, without keeping the response in memory.
pub struct UsageTap<'a> {
    extractor: &'a mut dyn UsageExtractor,
    sse: bool,
    pending: Vec<u8>,
    json: BytesMut,
    json_bytes: usize,
    overflow: bool,
}

impl<'a> UsageTap<'a> {
    pub fn new(extractor: &'a mut dyn UsageExtractor, sse: bool) -> Self {
        UsageTap {
            extractor,
            sse,
            pending: Vec::new(),
            json: BytesMut::new(),
            json_bytes: 0,
            overflow: false,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) {
        if self.sse {
            self.pending.extend_from_slice(chunk);
            self.drain(false);
        } else if !self.overflow {
            self.json_bytes += chunk.len();
            if self.json_bytes > MAX_JSON_BYTES {
                self.overflow = true;
                self.json = BytesMut::new();
            } else {
                self.json.extend_from_slice(chunk);
            }
        }
    }

    pub fn end(&mut self) {
        if self.sse {
            self.drain(true);
        } else if !self.overflow && !self.json.is_empty() {
            // Not JSON (or cut off): no usage to read.
            let text = String::from_utf8_lossy(&self.json);
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                self.extractor.on_event(&value);
            }
        }
    }

    fn drain(&mut self, last: bool) {
        let mut start = 0;
        while let Some(offset) = self.pending[start..].iter().position(|b| *b == b'\n') {
            let end = start + offset;
            let mut line = &self.pending[start..end];
            if line.last() == Some(&b'\r') {
                line = &line[..line.len() - 1];
            }
            let text = String::from_utf8_lossy(line).into_owned();
            self.line(&text);
            start = end + 1;
        }
        self.pending.drain(..start);
        if last {
            if !self.pending.is_empty() {
                let text = String::from_utf8_lossy(&self.pending).into_owned();
                self.line(&text);
            }
            self.pending.clear();
        } else if self.pending.len() > MAX_SSE_LINE {
            self.pending.clear();
        }
    }

    fn line(&mut self, line: &str) {
        let Some(data) = line.strip_prefix("data:") else {
            return;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            return;
        }
        // Partial or non-JSON event: skipped.
        if let Ok(value) = serde_json::from_str::<Value>(data) {
            self.extractor.on_event(&value);
        }
    }
}

/// One buffered request to send upstream.
pub struct ForwardSpec<'a> {
    pub method: Method,
    pub target: Url,
    /// Already sanitized and carrying the account's credential.
    pub headers: HeaderMap,
    pub body: Bytes,
    pub account_id: &'a str,
    pub stats: Option<&'a Mutex<ProxyStats>>,
    pub usage: &'a mut dyn UsageExtractor,
    pub error_label: String,
    /// Told when the answer's headers arrive, before its body.
    pub on_answer: Option<&'a (dyn Fn(&EarlyAnswer) + Sync)>,
    /// An answer with this status is not sent to the client: its body is dropped and the
    /// outcome says `held`. Only asked before anything was sent.
    pub hold_if: Option<&'a (dyn Fn(u16) -> bool + Sync)>,
    pub first_byte_timeout: Option<Duration>,
    pub idle_timeout: Option<Duration>,
    /// The connection pool; the shared upstream pool when not given (tests pass their own).
    pub pool: Option<&'a UpstreamPool>,
}

/// Options for an upstream connection pool.
#[derive(Clone, Default)]
pub struct UpstreamClientOptions {
    pub connect_timeout: Option<Duration>,
    /// Replaces the system resolver (tests).
    pub resolver: Option<Arc<dyn reqwest::dns::Resolve>>,
}

/// TLS with the Mozilla roots Node bundles (`webpki-roots`), not the platform's store.
pub fn tls_config() -> rustls::ClientConfig {
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .expect("ring supports the default TLS versions")
        .with_root_certificates(roots)
        .with_no_client_auth()
}

/// An upstream connection pool and the connect timeout it was built with.
#[derive(Clone)]
pub struct UpstreamPool {
    pub client: reqwest::Client,
    pub connect_timeout: Duration,
}

/// An upstream connection pool as Node's agent keeps it: HTTP/1.1, keep-alive, idle sockets
/// closed after 5 s, no redirects, no retries, no proxy from the environment, no
/// decompression.
pub fn upstream_pool(options: UpstreamClientOptions) -> UpstreamPool {
    let connect_timeout = options.connect_timeout.unwrap_or(DEFAULT_CONNECT_TIMEOUT);
    let mut builder = reqwest::Client::builder()
        .tls_backend_preconfigured(tls_config())
        .http1_only()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .pool_idle_timeout(UPSTREAM_POOL_IDLE)
        .connect_timeout(connect_timeout);
    if let Some(resolver) = options.resolver {
        builder = builder.dns_resolver(resolver);
    }
    UpstreamPool {
        client: builder.build().expect("the upstream client builds"),
        connect_timeout,
    }
}

/// The shared upstream pool.
pub fn default_upstream_pool() -> &'static UpstreamPool {
    static POOL: LazyLock<UpstreamPool> =
        LazyLock::new(|| upstream_pool(UpstreamClientOptions::default()));
    &POOL
}

fn duration_text(duration: Duration) -> String {
    let ms = duration.as_millis() as f64;
    if ms >= 60_000.0 {
        format!("{} min", round(ms / 60_000.0))
    } else if ms >= 1000.0 {
        format!("{} s", round(ms / 1000.0))
    } else {
        format!("{} ms", ms as u64)
    }
}

/// A transport failure as Node words it where the tests and the log read it.
fn transport_message(error: &reqwest::Error, target: &Url) -> String {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(error);
    let mut innermost = error.to_string();
    while let Some(err) = source {
        if let Some(io) = err.downcast_ref::<std::io::Error>() {
            let host = target.host_str().unwrap_or("").trim_matches(['[', ']']);
            let port = target.port_or_known_default().unwrap_or(0);
            match io.kind() {
                std::io::ErrorKind::ConnectionRefused => {
                    return format!("connect ECONNREFUSED {host}:{port}");
                }
                std::io::ErrorKind::ConnectionReset => return "socket hang up".into(),
                _ => {}
            }
        }
        innermost = err.to_string();
        source = err.source();
    }
    innermost
}

/// The outcome so far plus what an error body says.
fn classified(
    mut outcome: UpstreamOutcome,
    headers: &HeaderMap,
    error_body: &[u8],
) -> UpstreamOutcome {
    if outcome.status_code < 400 {
        return outcome;
    }
    let body = (!error_body.is_empty()).then(|| String::from_utf8_lossy(error_body).into_owned());
    let failure = classify_failure(outcome.status_code, headers, body.as_deref());
    let message = error_message(body.as_deref())
        .and_then(|e| e.message)
        .map(|m| slice_units(m.trim(), MAX_ERROR_MESSAGE).to_string())
        .filter(|m| !m.is_empty());
    outcome.failure = failure;
    outcome.error_message = message;
    outcome.rate_limited = failure == Some(FailureKind::Limit);
    outcome.unauthorized = failure == Some(FailureKind::Auth);
    outcome
}

fn keep_error_body(kept: &mut Vec<u8>, chunk: &[u8]) {
    if kept.len() < MAX_ERROR_BODY {
        let room = MAX_ERROR_BODY - kept.len();
        kept.extend_from_slice(&chunk[..chunk.len().min(room)]);
    }
}

/// Sends one buffered request upstream and streams the answer back. Never fails: a transport
/// failure becomes a 502/504 for the client (or a cut stream when the answer already began).
/// A client that hangs up cancels the upstream call. A successful stream is left open: the
/// caller records the outcome first, then lets the answer end (dropping or ending `res`).
pub async fn forward_upstream(res: &mut ClientRes, spec: ForwardSpec<'_>) -> UpstreamOutcome {
    if res.destroyed() || res.ended() {
        return UpstreamOutcome::bare(499);
    }
    let first_byte = spec
        .first_byte_timeout
        .unwrap_or(DEFAULT_FIRST_BYTE_TIMEOUT);
    let idle = spec.idle_timeout.unwrap_or(DEFAULT_IDLE_TIMEOUT);
    let pool = spec.pool.unwrap_or_else(|| default_upstream_pool());
    let client = &pool.client;
    let label = spec.error_label.as_str();

    // A transport failure: the client is owed an error answer, or a cut stream.
    let fail = |res: &mut ClientRes, message: String, timed_out: bool| {
        if let Some(stats) = spec.stats {
            stats
                .lock()
                .unwrap()
                .record_error(&format!("{label}: {message}"));
        }
        let status = if timed_out { 504 } else { 502 };
        if !res.headers_sent() && !res.destroyed() {
            send_json_error(
                res,
                status,
                "api_error",
                &format!("{label}: {message}"),
                &[],
            );
        } else if !res.ended() {
            // The answer had begun: cut it, so the client sees a failure instead of a clean end.
            res.destroy();
        }
        UpstreamOutcome::bare(status)
    };

    let request = client
        .request(spec.method.clone(), spec.target.clone())
        .headers(spec.headers)
        .body(spec.body);
    let sent = tokio::select! {
        biased;
        () = res.closed() => return UpstreamOutcome::bare(499),
        sent = tokio::time::timeout(first_byte, request.send()) => sent,
    };
    let mut upstream = match sent {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            let connect_timeout = error.is_connect() && error.is_timeout();
            let message = if connect_timeout {
                let limit = pool.connect_timeout;
                format!(
                    "could not connect to the upstream within {}",
                    duration_text(limit)
                )
            } else {
                transport_message(&error, &spec.target)
            };
            return fail(res, message, connect_timeout);
        }
        Err(_) => {
            return fail(
                res,
                format!(
                    "the upstream did not answer within {}",
                    duration_text(first_byte)
                ),
                true,
            );
        }
    };

    let status_code = upstream.status().as_u16();
    let headers = upstream.headers().clone();
    let mut outcome = UpstreamOutcome {
        status_code,
        rate_limited: status_code == 429,
        unauthorized: status_code == 401 || status_code == 403,
        ..Default::default()
    };
    if header(&headers, &format!("{UNIFIED}overage-in-use")) == Some("true") {
        outcome.extra_usage = true;
    }
    if status_code == 429 {
        outcome.retry_after_seconds = parse_retry_after(header(&headers, "retry-after"), now_ms());
        outcome.limit_resets_at = parse_limit_reset(&headers, now_ms());
        outcome.limit_scope = Some(limit_scope_of(&headers));
    }
    if let Some(id) = header(&headers, "request-id").filter(|id| REQUEST_ID.is_match(id)) {
        outcome.request_id = Some(id.to_string());
    }
    outcome.live = parse_live_limits(&headers);
    // Before the answer streams: Claude Code saves the request id as soon as text arrives.
    if let Some(on_answer) = spec.on_answer {
        on_answer(&EarlyAnswer {
            status_code,
            request_id: outcome.request_id.clone(),
            live: outcome.live.clone(),
        });
    }

    // An error answer is small: its start is kept to tell what kind of failure it is.
    let mut error_body = Vec::new();
    let is_error = status_code >= 400;

    if res.destroyed() {
        return classified(outcome, &headers, &error_body);
    }
    if !res.headers_sent() && spec.hold_if.is_some_and(|hold| hold(status_code)) {
        // Read to the end, so the connection can be reused and the body classified.
        loop {
            let next = tokio::select! {
                biased;
                () = res.closed() => return UpstreamOutcome::bare(499),
                next = tokio::time::timeout(idle, upstream.chunk()) => next,
            };
            match next {
                Ok(Ok(Some(chunk))) => {
                    if is_error {
                        keep_error_body(&mut error_body, &chunk);
                    }
                }
                Ok(Ok(None)) | Ok(Err(_)) => break,
                Err(_) => {
                    return fail(
                        res,
                        format!(
                            "the upstream sent nothing for {} in the middle of its answer",
                            duration_text(idle)
                        ),
                        true,
                    );
                }
            }
        }
        outcome.held = true;
        return classified(outcome, &headers, &error_body);
    }

    let content_type = header(&headers, "content-type").unwrap_or("").to_string();
    let tapping = spec.stats.is_some() && !is_error;
    let mut tap = UsageTap::new(spec.usage, content_type.contains("text/event-stream"));

    let mut head = Response::new(());
    *head.status_mut() = StatusCode::from_u16(status_code).unwrap_or(StatusCode::BAD_GATEWAY);
    *head.headers_mut() = sanitize_response_headers(&headers);
    if let Some(reason) = upstream.extensions().get::<hyper::ext::ReasonPhrase>() {
        head.extensions_mut().insert(reason.clone());
    }
    if !res.start(head) {
        return UpstreamOutcome::bare(499);
    }

    loop {
        let next = tokio::select! {
            biased;
            () = res.closed() => return UpstreamOutcome::bare(499),
            next = tokio::time::timeout(idle, upstream.chunk()) => next,
        };
        match next {
            Ok(Ok(Some(chunk))) => {
                if is_error {
                    keep_error_body(&mut error_body, &chunk);
                }
                if tapping {
                    tap.push(&chunk);
                }
                if !res.write(chunk).await {
                    return UpstreamOutcome::bare(499);
                }
            }
            Ok(Ok(None)) => {
                let tokens = finish_tap(tapping, &mut tap, spec.stats, spec.account_id);
                outcome.tokens = tokens;
                return classified(outcome, &headers, &error_body);
            }
            Ok(Err(error)) => {
                // The answer broke off: the client sees a cut stream.
                res.destroy();
                let tokens = finish_tap(tapping, &mut tap, spec.stats, spec.account_id);
                if let Some(stats) = spec.stats {
                    stats.lock().unwrap().record_error(&format!(
                        "{label}: {}",
                        transport_message(&error, &spec.target)
                    ));
                }
                outcome.tokens = tokens;
                return classified(outcome, &headers, &error_body);
            }
            Err(_) => {
                return fail(
                    res,
                    format!(
                        "the upstream sent nothing for {} in the middle of its answer",
                        duration_text(idle)
                    ),
                    true,
                );
            }
        }
    }
}

fn finish_tap(
    tapping: bool,
    tap: &mut UsageTap<'_>,
    stats: Option<&Mutex<ProxyStats>>,
    account_id: &str,
) -> Option<TokenTally> {
    if !tapping {
        return None;
    }
    tap.end();
    let tokens = tap.extractor.result()?;
    if let Some(stats) = stats {
        stats.lock().unwrap().record_tokens(account_id, &tokens);
    }
    Some(tokens)
}

/// Header names as `HeaderName`s (for building maps in callers and tests).
pub fn header_name(name: &str) -> HeaderName {
    HeaderName::from_bytes(name.as_bytes()).expect("a valid header name")
}
