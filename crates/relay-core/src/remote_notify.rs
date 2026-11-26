//! Port of `electron/core/remote-notify.ts`: each event the local notifications tell is also
//! posted to ntfy or a webhook when a URL is saved and its event is on.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};
use std::thread::JoinHandle;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use regex::Regex;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::limit_notice::LimitWindowKind;
use crate::redact::redact;
use crate::shared::remote_notify::{remote_notify_settings, remote_notify_url};
use crate::shared::types::js::{date_parse, iso, ser_opt_num};
use crate::shared::types::{
    RemoteNotifyEvents, RemoteNotifyFailure, RemoteNotifyKind, RemoteNotifyResult,
    RemoteNotifySettings, literal_enum,
};

literal_enum!(
    /// What Relay posts; every name but "test" follows one of the event choices in
    /// `RemoteNotifyEvents`.
    RemoteEventName {
        LimitNear = "limit-near",
        LimitReady = "limit-ready",
        AutoSwitch = "auto-switch",
        SignInEnding = "sign-in-ending",
        SignInEnded = "sign-in-ended",
        Test = "test",
    }
);

/// The event choice that turns an event on; `None` for "test", which is always posted.
fn event_choice(event: RemoteEventName, events: &RemoteNotifyEvents) -> Option<bool> {
    match event {
        RemoteEventName::LimitNear => Some(events.limit),
        RemoteEventName::LimitReady => Some(events.reset),
        RemoteEventName::AutoSwitch => Some(events.auto_switch),
        RemoteEventName::SignInEnding | RemoteEventName::SignInEnded => Some(events.sign_in),
        RemoteEventName::Test => None,
    }
}

/// ntfy shows these tags as emoji before the title (https://docs.ntfy.sh/emojis/); "relay" stays
/// a word.
fn ntfy_tags(event: RemoteEventName) -> &'static str {
    match event {
        RemoteEventName::LimitNear => "warning,relay",
        RemoteEventName::LimitReady => "white_check_mark,relay",
        RemoteEventName::AutoSwitch => "twisted_rightwards_arrows,relay",
        RemoteEventName::SignInEnding | RemoteEventName::SignInEnded => "key,relay",
        RemoteEventName::Test => "bell,relay",
    }
}

/// One event as the local notification says it: the account's name and figures, the title and
/// the text. It is built from those alone, never from an Account, so a token, an email in the
/// sign-in, an account id or an org id has no way into a post.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteNotice {
    pub event: RemoteEventName,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<LimitWindowKind>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub used_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
    pub title: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebhookAccount {
    pub name: String,
}

/// The webhook body; a field an event lacks is null, so every post has the same shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookPayload {
    pub event: RemoteEventName,
    pub account: Option<WebhookAccount>,
    pub window: Option<LimitWindowKind>,
    #[serde(serialize_with = "ser_opt_num")]
    pub used_percent: Option<f64>,
    pub resets_at: Option<String>,
    pub at: String,
    pub relay_version: String,
}

pub const REMOTE_NOTIFY_TIMEOUT_MS: u64 = 5_000;
/// The one retry's wait, after a network failure, a timeout, a 429 or a 5xx; a 4xx is final.
pub const REMOTE_NOTIFY_RETRY_MS: u64 = 3_000;
/// Posts waiting at once; beyond it an event is dropped, so a dead endpoint never piles requests up.
const MAX_IN_FLIGHT: usize = 4;

static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+").expect("email pattern")
});
static UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
        .expect("uuid pattern")
});

/// Text that may leave the computer: an account named after its email reads "[email]", an id
/// "[id]", and `redact` cuts keys, JWTs and long base64 or hex runs. One line, at most `max`.
pub fn scrub_remote_text(text: &str, max: usize) -> String {
    let text = EMAIL.replace_all(text, "[email]");
    let text = UUID.replace_all(&text, "[id]");
    redact(&text, max)
}

/// The JSON a webhook receives; `at` in epoch milliseconds.
pub fn webhook_payload(notice: &RemoteNotice, at: f64, relay_version: &str) -> WebhookPayload {
    let reset = date_parse(notice.resets_at.as_deref().unwrap_or(""));
    WebhookPayload {
        event: notice.event,
        account: notice
            .account_name
            .as_deref()
            .filter(|n| !n.is_empty())
            .map(|n| WebhookAccount {
                name: scrub_remote_text(n, 64),
            }),
        window: notice.window,
        // Rounded down, as every bar shows it: 99.6 reads 99, never 100.
        used_percent: notice
            .used_percent
            .filter(|u| u.is_finite())
            .map(|u| u.clamp(0.0, 100.0).floor()),
        resets_at: reset.is_finite().then(|| iso(reset)),
        at: iso(at),
        relay_version: scrub_remote_text(relay_version, 40),
    }
}

/// A header value fetch accepts: printable ASCII as it is, anything else (a Turkish or Japanese
/// title) RFC 2047 encoded, which ntfy decodes.
fn header_value(text: &str) -> String {
    if text.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
        text.to_string()
    } else {
        format!("=?UTF-8?B?{}?=", STANDARD.encode(text))
    }
}

/// A request's body and headers, the headers in the order they are sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteRequest {
    pub body: String,
    pub headers: Vec<(String, String)>,
}

impl RemoteRequest {
    /// The value of header `name`, as `headers[name]` reads it.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

/// ntfy's publish request (https://docs.ntfy.sh/publish/): the text as the body, Title and Tags
/// as headers.
pub fn ntfy_request(notice: &RemoteNotice) -> RemoteRequest {
    let title = scrub_remote_text(&notice.title, 200);
    let message = scrub_remote_text(&notice.message, 1_000);
    let mut headers = vec![
        (
            "Content-Type".to_string(),
            "text/plain; charset=utf-8".to_string(),
        ),
        ("Title".to_string(), header_value(&title)),
        ("Tags".to_string(), ntfy_tags(notice.event).to_string()),
    ];
    if notice.event == RemoteEventName::LimitNear {
        headers.push(("Priority".to_string(), "high".to_string()));
    }
    RemoteRequest {
        body: if message.is_empty() { title } else { message },
        headers,
    }
}

/// One POST as `fetch` is asked for it: redirects are refused (`redirect: "error"`) and the try
/// ends after `timeout`.
pub struct FetchRequest<'a> {
    pub url: &'a Url,
    pub request: &'a RemoteRequest,
    pub timeout: Duration,
}

/// Why a fetch threw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// The try ran past its timeout (`TimeoutError`/`AbortError`).
    Timeout,
    /// Anything else, as the text fetch's error gives: the cause's code ("ECONNREFUSED") when it
    /// has one, else the message. It may name the URL; `post_remote_notice` cuts it out.
    Failed(String),
}

/// Posts one request; the answer's status, its body never read (it may echo the topic or the
/// body back).
pub type Fetch = Arc<dyn Fn(&FetchRequest<'_>) -> Result<u16, FetchError> + Send + Sync>;

/// Takes one redacted failure line.
pub type RemoteLog = Arc<dyn Fn(&str) + Send + Sync>;

/// The statuses `redirect: "error"` turns into a network error.
const REDIRECT: [u16; 5] = [301, 302, 303, 307, 308];

/// The fetch Relay uses: a blocking POST through the shared client, which follows no redirect.
pub fn default_fetch(req: &FetchRequest<'_>) -> Result<u16, FetchError> {
    let mut builder = crate::usage::http_client()
        .post(req.url.as_str())
        .timeout(req.timeout)
        .body(req.request.body.clone());
    for (name, value) in &req.request.headers {
        builder = builder.header(name, value);
    }
    match builder.send() {
        Ok(response) => {
            let status = response.status().as_u16();
            drop(response);
            if REDIRECT.contains(&status) {
                return Err(FetchError::Failed("fetch failed".into()));
            }
            Ok(status)
        }
        Err(error) if error.is_timeout() => Err(FetchError::Timeout),
        Err(error) => Err(FetchError::Failed(network_code(&error))),
    }
}

/// The code Node's fetch would put on its error's cause for a network failure, else its message.
fn network_code(error: &reqwest::Error) -> String {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(e) = source {
        if let Some(io) = e.downcast_ref::<std::io::Error>() {
            let code = match io.kind() {
                std::io::ErrorKind::ConnectionRefused => Some("ECONNREFUSED"),
                std::io::ErrorKind::ConnectionReset => Some("ECONNRESET"),
                std::io::ErrorKind::TimedOut => Some("ETIMEDOUT"),
                std::io::ErrorKind::HostUnreachable => Some("EHOSTUNREACH"),
                std::io::ErrorKind::NetworkUnreachable => Some("ENETUNREACH"),
                _ => None,
            };
            if let Some(code) = code {
                return code.into();
            }
        }
        if e.to_string().contains("dns error") {
            return "ENOTFOUND".into();
        }
        source = e.source();
    }
    "fetch failed".into()
}

#[derive(Clone)]
pub struct RemoteDeps {
    pub version: Arc<dyn Fn() -> String + Send + Sync>,
    /// `None`: [`default_fetch`].
    pub fetch: Option<Fetch>,
    pub now: Option<Arc<dyn Fn() -> f64 + Send + Sync>>,
    /// `None`: `std::thread::sleep`.
    pub sleep: Option<Arc<dyn Fn(u64) + Send + Sync>>,
    /// A failure, already redacted: never the URL, which may carry a private topic or a key.
    pub log: Option<RemoteLog>,
    pub timeout_ms: Option<u64>,
    pub retry_ms: Option<u64>,
}

impl RemoteDeps {
    /// Relay's version and every other dependency at its default.
    pub fn new(version: impl Fn() -> String + Send + Sync + 'static) -> Self {
        RemoteDeps {
            version: Arc::new(version),
            fetch: None,
            now: None,
            sleep: None,
            log: None,
            timeout_ms: None,
            retry_ms: None,
        }
    }
}

/// Where a post goes: a saved URL (or none) and its kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RemoteTarget<'a> {
    pub url: Option<&'a str>,
    pub kind: RemoteNotifyKind,
}

/// Why a post failed, in words that never hold the URL or a secret from the answer.
fn failure(error: &FetchError, url: &Url) -> String {
    match error {
        FetchError::Timeout => "timeout".into(),
        FetchError::Failed(text) => {
            let host = match url.port() {
                Some(port) => format!("{}:{port}", url.host_str().unwrap_or("")),
                None => url.host_str().unwrap_or("").to_string(),
            };
            let mut text = text.replace(url.as_str(), "[url]");
            if !host.is_empty() {
                text = text.replace(&host, "[host]");
            }
            scrub_remote_text(&text, 120)
        }
    }
}

fn failed(status: Option<f64>, error: Option<String>) -> RemoteNotifyResult {
    RemoteNotifyResult::Failed {
        ok: false,
        reason: RemoteNotifyFailure::Failed,
        status,
        error,
    }
}

/// Posts one event to `target`, at most twice: a network failure, a timeout, a 429 or a 5xx is
/// tried once more after `retry_ms`. Each try ends after `timeout_ms`; redirects are refused, so
/// an https URL never lands on plain http. Never fails: the outcome says what happened.
pub fn post_remote_notice(
    target: RemoteTarget<'_>,
    notice: &RemoteNotice,
    deps: &RemoteDeps,
) -> RemoteNotifyResult {
    let refused = |reason| RemoteNotifyResult::Failed {
        ok: false,
        reason,
        status: None,
        error: None,
    };
    if target
        .url
        .is_none_or(|u| crate::shared::types::js::trim(u).is_empty())
    {
        return refused(RemoteNotifyFailure::Off);
    }
    let Some(url) = remote_notify_url(target.url) else {
        return refused(RemoteNotifyFailure::InvalidUrl);
    };
    let request = match target.kind {
        RemoteNotifyKind::Ntfy => ntfy_request(notice),
        RemoteNotifyKind::Webhook => {
            let now = deps
                .now
                .as_ref()
                .map_or_else(|| crate::clock::now_ms() as f64, |now| now());
            let version = (deps.version)();
            RemoteRequest {
                body: serde_json::to_string(&webhook_payload(notice, now, &version))
                    .unwrap_or_default(),
                headers: vec![("Content-Type".into(), "application/json".into())],
            }
        }
    };
    let timeout = Duration::from_millis(deps.timeout_ms.unwrap_or(REMOTE_NOTIFY_TIMEOUT_MS));
    let mut result = failed(None, None);
    for attempt in 0..2 {
        if attempt > 0 {
            let ms = deps.retry_ms.unwrap_or(REMOTE_NOTIFY_RETRY_MS);
            match &deps.sleep {
                Some(sleep) => sleep(ms),
                None => std::thread::sleep(Duration::from_millis(ms)),
            }
        }
        let req = FetchRequest {
            url: &url,
            request: &request,
            timeout,
        };
        let answer = match &deps.fetch {
            Some(fetch) => fetch(&req),
            None => default_fetch(&req),
        };
        match answer {
            Ok(status) if (200..300).contains(&status) => {
                return RemoteNotifyResult::Ok {
                    ok: true,
                    status: f64::from(status),
                };
            }
            Ok(status) => {
                result = failed(Some(f64::from(status)), Some(format!("HTTP {status}")));
                if status < 500 && status != 429 {
                    break;
                }
            }
            Err(error) => result = failed(None, Some(failure(&error, &url))),
        }
    }
    // Only a failure is recorded: a post that arrived leaves no trace on disk.
    if let Some(log) = &deps.log {
        let error = match &result {
            RemoteNotifyResult::Failed {
                error: Some(error), ..
            } => error.as_str(),
            _ => "failed",
        };
        log(&format!(
            "{} {}: {error}",
            target.kind.as_str(),
            notice.event.as_str()
        ));
    }
    result
}

/// Relay's remote notifications: each event the local notifications tell is also posted when a
/// URL is saved and its event is on. A post runs on its own thread and never fails.
pub struct RemoteNotifier {
    in_flight: Arc<AtomicUsize>,
    deps: RemoteDeps,
    settings: Arc<dyn Fn() -> Option<RemoteNotifySettings> + Send + Sync>,
}

impl RemoteNotifier {
    /// `settings`: the saved `remoteNotify` group, `None` when there is none.
    pub fn new(
        deps: RemoteDeps,
        settings: impl Fn() -> Option<RemoteNotifySettings> + Send + Sync + 'static,
    ) -> Self {
        RemoteNotifier {
            in_flight: Arc::new(AtomicUsize::new(0)),
            deps,
            settings: Arc::new(settings),
        }
    }

    /// Posts `notice` in the background when its event is on. The thread is returned so a caller
    /// may wait for it (the TS returns nothing); `None` when nothing was posted.
    pub fn notify(&self, notice: RemoteNotice) -> Option<JoinHandle<()>> {
        let settings = remote_notify_settings((self.settings)().as_ref());
        let url = settings.url.as_deref().filter(|u| !u.is_empty())?;
        if !event_choice(notice.event, &settings.events)? {
            return None;
        }
        if self.in_flight.load(Ordering::SeqCst) >= MAX_IN_FLIGHT {
            if let Some(log) = &self.deps.log {
                log(&format!(
                    "{} {}: dropped, {MAX_IN_FLIGHT} posts still waiting",
                    settings.kind.as_str(),
                    notice.event.as_str()
                ));
            }
            return None;
        }
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        let url = url.to_string();
        let kind = settings.kind;
        let deps = self.deps.clone();
        let in_flight = Arc::clone(&self.in_flight);
        let handle = std::thread::Builder::new()
            .name("relay-remote-notify".into())
            .spawn(move || {
                let target = RemoteTarget {
                    url: Some(&url),
                    kind,
                };
                post_remote_notice(target, &notice, &deps);
                in_flight.fetch_sub(1, Ordering::SeqCst);
            });
        match handle {
            Ok(handle) => Some(handle),
            Err(_) => {
                self.in_flight.fetch_sub(1, Ordering::SeqCst);
                None
            }
        }
    }

    /// Posts a sample "test" event to a URL that may not be saved yet, and says how it went.
    pub fn test(
        &self,
        url: &str,
        kind: RemoteNotifyKind,
        notice: &RemoteNotice,
    ) -> RemoteNotifyResult {
        let notice = RemoteNotice {
            event: RemoteEventName::Test,
            ..notice.clone()
        };
        post_remote_notice(
            RemoteTarget {
                url: Some(url),
                kind,
            },
            &notice,
            &self.deps,
        )
    }
}
