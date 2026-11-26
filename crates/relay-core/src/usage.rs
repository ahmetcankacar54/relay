//! Port of `electron/core/usage.ts`: reading an account's plan limits.

use std::io::Read;
use std::sync::LazyLock;
use std::time::Duration;

use serde_json::Value;

use crate::shared::types::UsageIssue;
use crate::shared::types::js::{date_parse, normalize_iso};
use crate::shared::types::{Account, ModelWindow, UsageWindow};
use crate::usage_credentials::UsageError;

/// The OAuth API the official CLI's sign-in reads.
pub const USAGE_API_BASE: &str = "https://api.anthropic.com";
/// The largest usage or profile answer read.
const MAX_BODY: usize = 262_144;

/// Model families a limit can be scoped to, as they appear in usage keys and model ids.
const MODEL_FAMILIES: [&str; 4] = ["fable", "opus", "sonnet", "haiku"];

/// TLS through rustls with the webpki roots and the ring provider, as the gateway uses.
pub(crate) fn tls_config() -> rustls::ClientConfig {
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .expect("ring supports the default TLS versions")
    .with_root_certificates(roots)
    .with_no_client_auth()
}

/// A blocking client as `fetch` with `redirect: "error"` behaves: redirects are not followed
/// (the caller turns a 3xx into the error fetch throws), no proxy from the environment.
pub(crate) fn http_client() -> &'static reqwest::blocking::Client {
    static CLIENT: LazyLock<reqwest::blocking::Client> = LazyLock::new(|| {
        reqwest::blocking::Client::builder()
            .tls_backend_preconfigured(tls_config())
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .expect("the HTTP client builds")
    });
    &CLIENT
}

/// The usage windows a usage answer carries.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct UsageLimits {
    pub five_hour: Option<UsageWindow>,
    pub seven_day: Option<UsageWindow>,
    pub other_limit_reached: Option<bool>,
    pub model_windows: Option<Vec<ModelWindow>>,
}

fn window_key(key: &str) -> bool {
    let rest = key
        .strip_prefix("five_hour_")
        .or_else(|| key.strip_prefix("seven_day_"));
    rest.is_some_and(|r| {
        !r.is_empty()
            && r.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    })
}

fn parse_window(v: Option<&Value>) -> Result<Option<UsageWindow>, UsageError> {
    let unsupported = || UsageError::new(UsageIssue::Unsupported);
    let Some(v) = v else { return Ok(None) };
    if v.is_null() {
        return Ok(None);
    }
    let Some(w) = v.as_object() else {
        return Err(unsupported());
    };
    let utilization = match w.get("utilization") {
        None | Some(Value::Null) => return Ok(None),
        Some(u) => u.as_f64().ok_or_else(unsupported)?,
    };
    if !(0.0..=100.0).contains(&utilization) {
        return Err(unsupported());
    }
    let resets_at = match w.get("resets_at") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(normalize_iso(s).ok_or_else(unsupported)?),
        Some(_) => return Err(unsupported()),
    };
    Ok(Some(UsageWindow {
        used_percent: utilization,
        resets_at,
        ..UsageWindow::default()
    }))
}

/// `word.charAt(0).toUpperCase() + word.slice(1)`.
pub(crate) fn capitalize(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// `a.localeCompare(b)` for ASCII keys as ICU's root collation orders them: punctuation before
/// digits before letters, letters case-insensitive first, lowercase before uppercase on a tie.
pub(crate) fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    let primary = |c: char| match c {
        '0'..='9' => (1, c),
        c if c.is_alphabetic() => (2, c.to_lowercase().next().unwrap_or(c)),
        c => (0, c),
    };
    a.chars()
        .map(primary)
        .cmp(b.chars().map(primary))
        .then_with(|| {
            a.chars()
                .map(char::is_uppercase)
                .cmp(b.chars().map(char::is_uppercase))
        })
}

fn sort_windows(windows: &mut [ModelWindow]) {
    windows.sort_by(|a, b| locale_compare(&a.key, &b.key));
}

/// The limits of a usage endpoint answer.
pub fn parse_usage(value: &Value) -> Result<UsageLimits, UsageError> {
    let Some(root) = value.as_object() else {
        return Err(UsageError::new(UsageIssue::Unsupported));
    };
    let five_hour = parse_window(root.get("five_hour"))?;
    let seven_day = parse_window(root.get("seven_day"))?;
    if five_hour.is_none() && seven_day.is_none() {
        return Err(UsageError::new(UsageIssue::Unsupported));
    }
    // Model-specific windows such as `seven_day_opus` stop work on that model.
    let other_limit_reached = root.iter().any(|(key, window)| {
        window_key(key)
            && window
                .get("utilization")
                .and_then(Value::as_f64)
                .is_some_and(|u| u >= 100.0)
    });
    let mut model_windows: Vec<ModelWindow> = Vec::new();
    for (key, raw) in root.iter().filter(|(key, _)| window_key(key)) {
        // A malformed model window must not fail the whole read.
        let Ok(Some(window)) = parse_window(Some(raw)) else {
            continue;
        };
        let suffix = key
            .strip_prefix("five_hour_")
            .or_else(|| key.strip_prefix("seven_day_"))
            .unwrap_or(key);
        let label = suffix
            .split('_')
            .map(capitalize)
            .collect::<Vec<_>>()
            .join(" ");
        // `seven_day_opus` and the like name a model; `seven_day_oauth_apps` a kind of client.
        let model = MODEL_FAMILIES.contains(&suffix).then(|| suffix.to_owned());
        model_windows.push(ModelWindow {
            key: key.clone(),
            label,
            model,
            used_percent: window.used_percent,
            resets_at: window.resets_at,
            ..ModelWindow::default()
        });
    }
    sort_windows(&mut model_windows);
    // Newer answers also list the limits in `limits`; a weekly limit scoped to one model comes
    // only there.
    for scoped in scoped_limits(root) {
        if let Some(known) = model_windows.iter_mut().find(|w| w.key == scoped.key) {
            if known.model.is_none() {
                known.model = scoped.model;
            }
        } else {
            model_windows.push(scoped);
        }
    }
    sort_windows(&mut model_windows);
    let scoped_full = model_windows
        .iter()
        .any(|w| w.model.is_some() && w.used_percent >= 100.0);
    Ok(UsageLimits {
        five_hour,
        seven_day,
        other_limit_reached: (other_limit_reached || scoped_full).then_some(true),
        model_windows: (!model_windows.is_empty()).then_some(model_windows),
    })
}

/// JS `text.slice(0, n)` counted in UTF-16 units (a split pair is dropped whole).
pub(crate) fn js_slice(text: &str, n: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in text.chars() {
        units += c.len_utf16();
        if units > n {
            break;
        }
        out.push(c);
    }
    out
}

/// The model-scoped limits of a usage answer's `limits` list, as model windows keyed like the
/// older fields (`seven_day_fable`). A malformed entry is skipped, never fatal.
fn scoped_limits(root: &serde_json::Map<String, Value>) -> Vec<ModelWindow> {
    let Some(limits) = root.get("limits").and_then(Value::as_array) else {
        return Vec::new();
    };
    let shares: &[Value] = root
        .get("weekly_scoped_shares")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice);
    let mut out = Vec::new();
    for (index, entry) in limits.iter().enumerate() {
        let Some(limit) = entry.as_object() else {
            continue;
        };
        let Some(name) = limit
            .get("scope")
            .and_then(|s| s.get("model"))
            .and_then(|m| m.get("display_name"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let Some(percent) = limit.get("percent").and_then(Value::as_f64) else {
            continue;
        };
        if !(0.0..=100.0).contains(&percent) {
            continue;
        }
        let mut model = String::new();
        let mut gap = false;
        for c in name.to_lowercase().chars() {
            if c.is_ascii_lowercase() || c.is_ascii_digit() {
                if gap && !model.is_empty() {
                    model.push('_');
                }
                gap = false;
                model.push(c);
            } else {
                gap = true;
            }
        }
        // `/^_|_$/` strips one leading/trailing underscore; a trailing gap adds one.
        if gap && !model.is_empty() {
            model.push('_');
        }
        let model = model.strip_suffix('_').unwrap_or(&model);
        let model: String = model.chars().take(40).collect();
        if model.is_empty() {
            continue;
        }
        let kind = match limit.get("kind") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(s)) => s.clone(),
            Some(other) => other.to_string(),
        };
        let weekly =
            limit.get("group").and_then(Value::as_str) == Some("weekly") || kind.contains("weekly");
        let reset = limit
            .get("resets_at")
            .and_then(Value::as_str)
            .and_then(normalize_iso);
        let share = shares
            .iter()
            .find(|s| s.get("limit_index").and_then(Value::as_f64) == Some(index as f64))
            .and_then(|s| s.get("allowance_percent_of_weekly"))
            .and_then(Value::as_f64)
            .filter(|s| *s > 0.0 && *s <= 100.0);
        out.push(ModelWindow {
            key: format!("{}_{model}", if weekly { "seven_day" } else { "five_hour" }),
            label: js_slice(name, 40),
            model: Some(model),
            used_percent: percent,
            resets_at: reset,
            weekly_share: share,
            ..ModelWindow::default()
        });
    }
    out
}

/// The longest a server's Retry-After holds limit reads back: a larger one is a bad header.
const MAX_RETRY_MS: f64 = 3_600_000.0;

/// When to read again after a refusal: the server's Retry-After, between one minute and one hour.
pub fn retry_time(header: Option<&str>, now: f64) -> f64 {
    let seconds = header
        .filter(|h| {
            let (int, frac) = h.split_once('.').unwrap_or((h, "0"));
            !int.is_empty()
                && int.bytes().all(|b| b.is_ascii_digit())
                && !frac.is_empty()
                && frac.bytes().all(|b| b.is_ascii_digit())
                && (h.contains('.') || frac == "0")
        })
        .and_then(|h| h.parse::<f64>().ok());
    let wanted = match seconds {
        Some(s) if s.is_finite() => now + s * 1000.0,
        _ => match header.map(date_parse).filter(|d| d.is_finite()) {
            Some(date) => date,
            None => now + 300_000.0,
        },
    };
    (now + MAX_RETRY_MS).min((now + 60_000.0).max(wanted))
}

/// The error type and message of a refused answer.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ErrorBody {
    pub r#type: Option<String>,
    pub message: Option<String>,
}

/// The error type and message of a refused response, from at most 4 KiB of its body.
pub(crate) fn error_body(text: &str) -> ErrorBody {
    let text = js_slice(text, 4_096);
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return ErrorBody::default();
    };
    let error = value.get("error");
    ErrorBody {
        r#type: error
            .and_then(|e| e.get("type"))
            .and_then(Value::as_str)
            .filter(|t| {
                (1..=64).contains(&t.len())
                    && t.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
            })
            .map(str::to_owned),
        message: error
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .map(|m| js_slice(m, 300)),
    }
}

/// A 403 that says the token lacks a scope: Anthropic's permission_error naming a scope.
pub fn scope_refusal(error: &ErrorBody) -> bool {
    error.r#type.as_deref() == Some("permission_error")
        && error
            .message
            .as_deref()
            .unwrap_or("")
            .to_lowercase()
            .contains("scope")
}

/// What a request that never got an answer says: no network, a timeout, a refused connection.
/// `name` is the JS error's name (`TypeError`, `TimeoutError`), `code` its cause's code.
pub fn network_detail(name: Option<&str>, code: Option<&str>) -> String {
    let code = code.map(|c| format!(" {c}")).unwrap_or_default();
    js_slice(
        &format!("no answer: {}{code}", name.unwrap_or("Error")),
        120,
    )
}

/// The errno name Node's fetch puts in `cause.code` for a failed connection, when known.
pub(crate) fn transport_code(error: &reqwest::Error) -> Option<&'static str> {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(e) = source {
        if let Some(io) = e.downcast_ref::<std::io::Error>() {
            use std::io::ErrorKind as K;
            return match io.kind() {
                K::ConnectionRefused => Some("ECONNREFUSED"),
                K::ConnectionReset => Some("ECONNRESET"),
                K::TimedOut => Some("ETIMEDOUT"),
                K::HostUnreachable | K::NetworkUnreachable => Some("EHOSTUNREACH"),
                _ => None,
            };
        }
        let text = e.to_string();
        if text.contains("dns error") || text.contains("failed to lookup address") {
            return Some("ENOTFOUND");
        }
        source = e.source();
    }
    None
}

/// What a request that got no answer reports, as the TS readers turn fetch's errors.
pub(crate) fn transport_detail(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return network_detail(Some("TimeoutError"), None);
    }
    network_detail(Some("TypeError"), transport_code(error))
}

/// Reads at most `cap` bytes of `body`; None when it holds more.
pub(crate) fn read_capped(body: &mut impl Read, cap: usize) -> std::io::Result<Option<Vec<u8>>> {
    let mut data = Vec::new();
    body.take(cap as u64 + 1).read_to_end(&mut data)?;
    Ok((data.len() <= cap).then_some(data))
}

/// Which OAuth endpoint a read asks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageEndpoint {
    Profile,
    Usage,
}

impl UsageEndpoint {
    pub const fn as_str(self) -> &'static str {
        match self {
            UsageEndpoint::Profile => "profile",
            UsageEndpoint::Usage => "usage",
        }
    }
}

/// The JSON a read of the official OAuth API answers.
pub fn request_usage_json(endpoint: UsageEndpoint, token: &str) -> Result<Value, UsageError> {
    request_usage_json_at(USAGE_API_BASE, endpoint, token)
}

/// `request_usage_json` against `base` (tests point it at a local server).
pub fn request_usage_json_at(
    base: &str,
    endpoint: UsageEndpoint,
    token: &str,
) -> Result<Value, UsageError> {
    let unavailable = |detail: String| UsageError::with_detail(UsageIssue::Unavailable, detail);
    let response = http_client()
        .get(format!("{base}/api/oauth/{}", endpoint.as_str()))
        .timeout(Duration::from_millis(15_000))
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .map_err(|e| unavailable(transport_detail(&e)))?;
    let status = response.status().as_u16();
    // `redirect: "error"`: fetch throws a TypeError on a redirect.
    if (300..400).contains(&status) {
        return Err(unavailable(network_detail(Some("TypeError"), None)));
    }
    if !(200..300).contains(&status) {
        let retry = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let error = error_body(&response.text().unwrap_or_default());
        let detail = format!(
            "{} {status}{}",
            endpoint.as_str(),
            error
                .r#type
                .as_ref()
                .map(|t| format!(" {t}"))
                .unwrap_or_default()
        );
        let issue = match status {
            401 => UsageIssue::Expired,
            // Only a refusal for the token's scopes asks for a new sign-in.
            403 if scope_refusal(&error) => UsageIssue::Scope,
            429 => {
                return Err(UsageError::with_retry(
                    UsageIssue::RateLimited,
                    Some(retry_time(retry.as_deref(), crate::clock::now_ms() as f64)),
                    Some(detail),
                ));
            }
            _ => UsageIssue::Unavailable,
        };
        return Err(UsageError::with_detail(issue, detail));
    }
    let mut response = response;
    let data = read_capped(&mut response, MAX_BODY)
        .map_err(|_| unavailable(network_detail(Some("TypeError"), None)))?
        .ok_or_else(|| UsageError::new(UsageIssue::Unsupported))?;
    serde_json::from_str(&String::from_utf8_lossy(&data))
        .map_err(|_| unavailable(network_detail(Some("SyntaxError"), None)))
}

/// `a ?? b` over a JSON object: the first of `keys` under `outer` that is neither missing nor null.
fn nullish<'a>(value: &'a Value, outer: &str, keys: &[&str]) -> Option<&'a Value> {
    let o = value.get(outer)?;
    keys.iter()
        .map(|k| o.get(*k))
        .find(|v| v.is_some_and(|v| !v.is_null()))
        .flatten()
}

fn profile_ids(value: &Value) -> (Option<&Value>, Option<&Value>, Option<&Value>) {
    (
        nullish(value, "account", &["uuid", "account_uuid"]),
        nullish(value, "organization", &["uuid", "organization_uuid"]),
        nullish(
            value,
            "account",
            &["email_address", "emailAddress", "email"],
        ),
    )
}

/// Whether a JSON value is exactly this string (`value === text`).
fn is_text(value: Option<&Value>, text: &str) -> bool {
    value.and_then(Value::as_str) == Some(text)
}

/// Refuses a profile answer for another account than the one this sign-in is saved for.
pub fn verify_identity(account: &Account, value: &Value) -> Result<(), UsageError> {
    let (uuid, org, email) = profile_ids(value);
    let auth = account.auth.as_ref();
    let saved_email = auth
        .and_then(|a| a.email.as_deref())
        .filter(|e| !e.is_empty());
    let email_matches = saved_email.is_some_and(|saved| {
        email
            .and_then(Value::as_str)
            .is_some_and(|e| e.trim().to_lowercase() == saved.trim().to_lowercase())
    });
    let account_uuid = auth
        .and_then(|a| a.account_uuid.as_deref())
        .filter(|u| !u.is_empty());
    let org_id = auth
        .and_then(|a| a.org_id.as_deref())
        .filter(|o| !o.is_empty());
    let mismatch = match account_uuid {
        Some(expected) => !is_text(uuid, expected),
        None => !email_matches,
    } || org_id.is_some_and(|expected| !is_text(org, expected))
        || account
            .desktop
            .as_ref()
            .is_some_and(|d| !is_text(uuid, &d.account_uuid) || !is_text(org, &d.org_id));
    if mismatch {
        return Err(UsageError::new(UsageIssue::IdentityMismatch));
    }
    Ok(())
}

/// Identity fields a verified profile answer can supply when the registry lacks them.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct IdentityRepair {
    pub account_uuid: Option<String>,
    pub org_id: Option<String>,
    pub org_name: Option<String>,
    pub desktop_email: Option<String>,
}

/// Identity fields a verified profile response can supply when the registry lacks them. Only
/// missing fields are returned, and only when the response matches the account's saved Desktop
/// binding, so a verified read never changes an existing identity.
pub fn missing_identity(account: &Account, value: &Value) -> Option<IdentityRepair> {
    let (uuid, org, email) = profile_ids(value);
    let org_name = value.get("organization").and_then(|o| o.get("name"));
    let auth = account.auth.as_ref().filter(|a| a.logged_in)?;
    let desktop = account.desktop.as_ref()?;
    let uuid = uuid?.as_str()?;
    let org = org?.as_str()?;
    if uuid.to_lowercase() != desktop.account_uuid.to_lowercase()
        || org.to_lowercase() != desktop.org_id.to_lowercase()
    {
        return None;
    }
    let empty = |v: &Option<String>| v.as_deref().is_none_or(str::is_empty);
    let mut repair = IdentityRepair::default();
    if empty(&auth.account_uuid) {
        repair.account_uuid = Some(uuid.to_lowercase());
    }
    if empty(&auth.org_id) {
        repair.org_id = Some(org.to_lowercase());
    }
    if empty(&auth.org_name)
        && let Some(name) = org_name.and_then(Value::as_str).map(str::trim)
        && !name.is_empty()
        && crate::usage_credentials::js_len(name) <= 150
    {
        repair.org_name = Some(name.to_owned());
    }
    if empty(&desktop.email)
        && let Some(email) = email.and_then(Value::as_str).map(str::trim)
        && !email.is_empty()
        && crate::usage_credentials::js_len(email) <= 254
        && Some(email.to_lowercase()) == auth.email.as_deref().map(|e| e.trim().to_lowercase())
    {
        repair.desktop_email = Some(email.to_owned());
    }
    (repair != IdentityRepair::default()).then_some(repair)
}

/// Asks the OAuth API one endpoint with a token (`requestUsageJson` by default).
pub type UsageRequest =
    std::sync::Arc<dyn Fn(UsageEndpoint, &str) -> Result<Value, UsageError> + Send + Sync>;

/// `request_usage_json` as a `UsageRequest`.
pub fn default_request() -> UsageRequest {
    std::sync::Arc::new(request_usage_json)
}

// --- The manager -----------------------------------------------------------------------------

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex, Weak, mpsc};

use crate::provider_usage::ProviderUsageResult;
use crate::shared::account_state::desktop_cli_mismatch;
use crate::shared::types::js::iso;
use crate::shared::types::{AccountProvider, AccountUsage, LimitSource, UsageSource, UsageStatus};
use crate::store::{Store, StoreError};
use crate::usage_credentials::UsageCredential;
use crate::usage_refresh::{RefreshUsageCredential, SIGN_IN_ENDED};

/// A yes/no about an account.
pub type AccountCheck = Arc<dyn Fn(&Account) -> bool + Send + Sync>;
/// Reads an account's usage through its Claude app sign-in: `(account, allow_prompt)`.
pub type DesktopRead = Arc<dyn Fn(&Account, bool) -> Result<Value, UsageError> + Send + Sync>;
/// Reads an isolated profile's CLI credential: `(profile, allow_prompt)`.
pub type CredentialRead =
    Arc<dyn Fn(&Path, bool) -> Result<UsageCredential, UsageError> + Send + Sync>;
/// Hands a verified reading to history.
pub type SampleSink = Arc<dyn Fn(&Account, &AccountUsage) + Send + Sync>;
/// Told an account's new issue and its private detail.
pub type IssueSink = Arc<dyn Fn(&Account, UsageIssue, Option<&str>) + Send + Sync>;
/// Reads a Codex or Antigravity account's limits.
pub type ProviderRead =
    Arc<dyn Fn(&Account) -> Result<ProviderUsageResult, UsageError> + Send + Sync>;

/// The second source: the account's Claude app sign-in, for an account without a Claude Code
/// sign-in. Answers with the usage endpoint's shape.
#[derive(Clone)]
pub struct DesktopUsageSource {
    pub usable: AccountCheck,
    pub read: DesktopRead,
}

/// What the manager needs; everything but `credentials` has a default.
#[derive(Clone)]
pub struct UsageManagerDeps {
    pub credentials: CredentialRead,
    pub request: UsageRequest,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub on_sample: SampleSink,
    pub refresh_credential: Option<RefreshUsageCredential>,
    pub refresh_credential_pending: Option<AccountCheck>,
    /// Told once each time an account's issue changes; never given a credential.
    pub on_issue: Option<IssueSink>,
    pub desktop_usage: Option<DesktopUsageSource>,
    /// A Codex or Antigravity account's limits, read through its own provider's sign-in.
    pub provider_usage: Option<ProviderRead>,
}

impl UsageManagerDeps {
    pub fn new(credentials: CredentialRead) -> UsageManagerDeps {
        UsageManagerDeps {
            credentials,
            request: default_request(),
            now: Arc::new(crate::clock::now_ms),
            on_sample: Arc::new(|_, _| {}),
            refresh_credential: None,
            refresh_credential_pending: None,
            on_issue: None,
            desktop_usage: None,
            provider_usage: None,
        }
    }
}

/// A model's own window as a gateway answer reported it.
#[derive(Debug, Clone, PartialEq)]
pub struct LiveModel {
    pub model: String,
    pub weekly: bool,
    pub used_percent: f64,
    pub resets_at: Option<String>,
}

/// An account's windows as an answer through the gateway reported them.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LiveLimits {
    pub five_hour: Option<UsageWindow>,
    pub seven_day: Option<UsageWindow>,
    pub models: Option<Vec<LiveModel>>,
}

/// A read under way: the reads asked meanwhile wait for its answer.
struct Job {
    result: Mutex<Option<Result<AccountUsage, String>>>,
    done: Condvar,
}

impl Job {
    fn wait(&self) -> Result<AccountUsage, String> {
        let mut result = self.result.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if let Some(r) = result.as_ref() {
                return r.clone();
            }
            result = self.done.wait(result).unwrap_or_else(|e| e.into_inner());
        }
    }
}

#[derive(Default)]
struct Inner {
    identities: HashMap<String, String>,
    cache: HashMap<String, AccountUsage>,
    inflight: HashMap<String, Arc<Job>>,
    generations: HashMap<String, u64>,
    next_attempt: HashMap<String, f64>,
    server_retry_until: HashMap<String, f64>,
    failures: HashMap<String, u32>,
    /// When each account's last read through its own sign-in finished: the poll's schedule.
    polled_at: HashMap<String, f64>,
    /// When each account's last read started, failed ones too.
    attempted_at: HashMap<String, f64>,
    /// The last sample the gateway's windows gave history, per account.
    live_samples: HashMap<String, (f64, String)>,
    active: usize,
}

/// A failed `refresh`: the account is not in the registry (any more).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct UsageRefreshFailed(pub String);

impl From<StoreError> for UsageRefreshFailed {
    fn from(error: StoreError) -> Self {
        UsageRefreshFailed(error.to_string())
    }
}

fn identity_key(a: &Account) -> String {
    let text = |v: Option<&String>| v.map_or(Value::Null, |s| Value::String(s.clone()));
    let auth = a.auth.as_ref();
    serde_json::json!([
        auth.map_or(Value::Null, |a| Value::Bool(a.logged_in)),
        auth.and_then(|a| a.email.as_ref())
            .map_or(Value::Null, |e| Value::String(e.trim().to_lowercase())),
        text(auth.and_then(|a| a.account_uuid.as_ref())),
        text(auth.and_then(|a| a.org_id.as_ref())),
        text(a.desktop.as_ref().map(|d| &d.account_uuid)),
        text(a.desktop.as_ref().map(|d| &d.org_id)),
    ])
    .to_string()
}

fn store_failure(_: StoreError) -> UsageError {
    UsageError::with_detail(UsageIssue::Unavailable, network_detail(Some("Error"), None))
}

/// A reading's windows, each marked with where it came from and when.
fn tagged(mut limits: UsageLimits, source: LimitSource, read_at: &str) -> UsageLimits {
    for w in [&mut limits.five_hour, &mut limits.seven_day]
        .into_iter()
        .flatten()
    {
        w.source = Some(source);
        w.read_at = Some(read_at.to_owned());
    }
    for w in limits.model_windows.iter_mut().flatten() {
        w.source = Some(source);
        w.read_at = Some(read_at.to_owned());
    }
    limits
}

/// Runs an injected callback as the TS's `try { … } catch {}`: a panic is its thrown error, None.
fn quietly<R>(call: impl FnOnce() -> R) -> Option<R> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(call)).ok()
}

fn is_claude(account: &Account) -> bool {
    account
        .provider
        .is_none_or(|p| p == AccountProvider::Claude)
}

/// Reads each account's plan limits through its own sign-in, two at a time, and keeps what
/// was read. Share it as `Arc<UsageManager>`.
pub struct UsageManager {
    pub store: Arc<Store>,
    deps: UsageManagerDeps,
    inner: Mutex<Inner>,
    slots: Condvar,
    timer: Mutex<Option<mpsc::Sender<()>>>,
}

impl UsageManager {
    pub fn new(store: Arc<Store>, deps: UsageManagerDeps) -> UsageManager {
        UsageManager {
            store,
            deps,
            inner: Mutex::new(Inner::default()),
            slots: Condvar::new(),
            timer: Mutex::new(None),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn now(&self) -> f64 {
        (self.deps.now)() as f64
    }

    /// Which sign-in a read of this account goes through; None when it has none.
    fn source(&self, account: &Account) -> Option<UsageSource> {
        if account.auth.as_ref().is_some_and(|a| a.logged_in) {
            return Some(UsageSource::Cli);
        }
        self.deps
            .desktop_usage
            .as_ref()
            .filter(|d| (d.usable)(account))
            .map(|_| UsageSource::Desktop)
    }

    pub fn invalidate(&self, id: &str) {
        let now = self.now();
        let mut inner = self.lock();
        *inner.generations.entry(id.to_owned()).or_default() += 1;
        inner.inflight.remove(id);
        inner.cache.remove(id);
        inner.identities.remove(id);
        inner.failures.remove(id);
        // A confirmed login makes old auth/transient failures obsolete, but not a server's Retry-After.
        let retry_at = inner.server_retry_until.get(id).copied().unwrap_or(0.0);
        if retry_at > now {
            inner.next_attempt.insert(id.to_owned(), retry_at);
            let mut usage = AccountUsage::new(id, UsageStatus::Error);
            usage.issue = Some(UsageIssue::RateLimited);
            usage.retry_at = Some(iso(retry_at));
            inner.cache.insert(id.to_owned(), usage);
        } else {
            inner.next_attempt.remove(id);
            inner.server_retry_until.remove(id);
        }
    }

    /// Drops everything kept for a removed account. A read still running is ignored when it ends.
    pub fn forget(&self, id: &str) {
        let mut inner = self.lock();
        *inner.generations.entry(id.to_owned()).or_default() += 1;
        inner.inflight.remove(id);
        inner.cache.remove(id);
        inner.identities.remove(id);
        inner.next_attempt.remove(id);
        inner.server_retry_until.remove(id);
        inner.failures.remove(id);
        inner.polled_at.remove(id);
        inner.attempted_at.remove(id);
        inner.live_samples.remove(id);
    }

    /// An account's windows as an answer through the gateway reported them. They are newer than
    /// any read, so they replace the read's percent and reset; what only a read knows stays as
    /// read. History gets a sample when a whole percent moved, at most once a minute.
    pub fn observe(&self, id: &str, live: &LiveLimits) {
        let Some(account) = self
            .store
            .with_state(|s| s.accounts.iter().find(|a| a.id == id).cloned())
        else {
            return;
        };
        if !is_claude(&account) || self.source(&account).is_none() {
            return;
        }
        let models = live.models.as_deref().unwrap_or(&[]);
        if live.five_hour.is_none() && live.seven_day.is_none() && models.is_empty() {
            return;
        }
        let now = self.now();
        let sample = {
            let mut inner = self.lock();
            if inner
                .identities
                .get(id)
                .is_some_and(|k| *k != identity_key(&account))
            {
                return;
            }
            let at = iso(now);
            let mut next = inner
                .cache
                .get(id)
                .cloned()
                .unwrap_or_else(|| AccountUsage::new(id, UsageStatus::Ready));
            next.account_id = id.to_owned();
            next.status = UsageStatus::Ready;
            next.stale = false;
            next.checked_at = Some(at.clone());
            next.live_at = Some(at.clone());
            let gateway = |w: &UsageWindow| UsageWindow {
                source: Some(LimitSource::Gateway),
                read_at: Some(at.clone()),
                ..w.clone()
            };
            if let Some(w) = &live.five_hour {
                next.five_hour = Some(gateway(w));
            }
            if let Some(w) = &live.seven_day {
                next.seven_day = Some(gateway(w));
            }
            // A model's own window as the answer reported it replaces the read one of that model.
            if !models.is_empty() {
                let mut windows = next.model_windows.clone().unwrap_or_default();
                for reported in models {
                    let prefix = if reported.weekly {
                        "seven_day"
                    } else {
                        "five_hour"
                    };
                    let key = format!("{prefix}_{}", reported.model);
                    let known = windows.iter().position(|w| w.key == key).or_else(|| {
                        windows.iter().position(|w| {
                            w.model.as_deref() == Some(reported.model.as_str())
                                && w.key.starts_with(prefix)
                        })
                    });
                    match known {
                        Some(i) => {
                            let w = &mut windows[i];
                            w.used_percent = reported.used_percent;
                            if reported.resets_at.is_some() {
                                w.resets_at = reported.resets_at.clone();
                            }
                            w.source = Some(LimitSource::Gateway);
                            w.read_at = Some(at.clone());
                        }
                        None => windows.push(ModelWindow {
                            key,
                            label: capitalize(&reported.model),
                            model: Some(reported.model.clone()),
                            used_percent: reported.used_percent,
                            resets_at: reported.resets_at.clone(),
                            source: Some(LimitSource::Gateway),
                            read_at: Some(at.clone()),
                            ..ModelWindow::default()
                        }),
                    }
                }
                sort_windows(&mut windows);
                next.other_limit_reached = windows
                    .iter()
                    .any(|w| w.used_percent >= 100.0)
                    .then_some(true);
                next.model_windows = Some(windows);
            }
            // Fresh windows answer what a failed read could not.
            next.issue = None;
            next.retry_at = None;
            inner
                .identities
                .insert(id.to_owned(), identity_key(&account));
            inner.cache.insert(id.to_owned(), next.clone());
            let key = [&next.five_hour, &next.seven_day]
                .iter()
                .map(|w| {
                    crate::shared::types::js::number_string(
                        w.as_ref().map_or(-1.0, |w| w.used_percent).floor(),
                    )
                })
                .collect::<Vec<_>>()
                .join(":");
            if let Some((at, last)) = inner.live_samples.get(id)
                && (*last == key || now - at < 60_000.0)
            {
                return;
            }
            inner.live_samples.insert(id.to_owned(), (now, key));
            next
        };
        quietly(|| (self.deps.on_sample)(&account, &sample));
    }

    /// Every account's usage, in registry order.
    pub fn snapshot(&self) -> indexmap::IndexMap<String, AccountUsage> {
        let accounts = self.store.with_state(|s| s.accounts.clone());
        let inner = self.lock();
        accounts
            .iter()
            .map(|a| (a.id.clone(), self.view_locked(&inner, a)))
            .collect()
    }

    fn view(&self, account: &Account) -> AccountUsage {
        let inner = self.lock();
        self.view_locked(&inner, account)
    }

    fn view_locked(&self, inner: &Inner, account: &Account) -> AccountUsage {
        let Some(source) = self.source(account) else {
            let mut usage = AccountUsage::new(&account.id, UsageStatus::Idle);
            usage.issue = Some(UsageIssue::ConnectCli);
            return usage;
        };
        if inner
            .identities
            .get(&account.id)
            .is_some_and(|k| *k != identity_key(account))
        {
            return AccountUsage::new(&account.id, UsageStatus::Idle);
        }
        let mut u = inner
            .cache
            .get(&account.id)
            .cloned()
            .unwrap_or_else(|| AccountUsage::new(&account.id, UsageStatus::Idle));
        // The source this account is read through, also before its first read.
        u.source.get_or_insert(source);
        if let Some(checked) = u.checked_at.as_deref() {
            let checked = date_parse(checked);
            let now = self.now();
            let since = inner.polled_at.get(&account.id).copied().unwrap_or(checked);
            if now - checked >= 35.0 * 60_000.0
                || [&u.five_hour, &u.seven_day].iter().any(|w| {
                    w.as_ref()
                        .and_then(|w| w.resets_at.as_deref())
                        .is_some_and(|r| date_parse(r) <= now)
                })
                // A model window that reset since the last read: its figure is old now.
                || self.reset_since(&u, since, true)
            {
                u.stale = true;
            }
        }
        u
    }

    /// Whether a window of the reading reset after `since` and by now.
    fn reset_since(&self, u: &AccountUsage, since: f64, models_only: bool) -> bool {
        if !since.is_finite() {
            return false;
        }
        let now = self.now();
        let headline = if models_only {
            Vec::new()
        } else {
            [&u.five_hour, &u.seven_day]
                .iter()
                .map(|w| w.as_ref().and_then(|w| w.resets_at.clone()))
                .collect()
        };
        headline
            .into_iter()
            .chain(
                u.model_windows
                    .iter()
                    .flatten()
                    .map(|w| w.resets_at.clone()),
            )
            .any(|reset| {
                let reset = date_parse(reset.as_deref().unwrap_or(""));
                reset.is_finite() && reset > since && reset <= now
            })
    }

    /// Ticks now and every 30 s until `stop`.
    pub fn start(self: &Arc<Self>) {
        let mut timer = self.timer.lock().unwrap_or_else(|e| e.into_inner());
        if timer.is_some() {
            return;
        }
        self.tick();
        let (stop, stopped) = mpsc::channel::<()>();
        let weak: Weak<Self> = Arc::downgrade(self);
        std::thread::spawn(move || {
            while let Err(mpsc::RecvTimeoutError::Timeout) =
                stopped.recv_timeout(std::time::Duration::from_secs(30))
            {
                match weak.upgrade() {
                    Some(manager) => manager.tick(),
                    None => return,
                }
            }
        });
        *timer = Some(stop);
    }

    pub fn stop(&self) {
        self.timer.lock().unwrap_or_else(|e| e.into_inner()).take();
    }

    /// Starts the reads that are due, each on its own thread; returns at once.
    pub fn tick(self: &Arc<Self>) {
        for id in self.due() {
            let manager = self.clone();
            std::thread::spawn(move || {
                let _ = manager.refresh(&id, false);
            });
        }
    }

    /// The accounts a tick reads now.
    pub fn due(&self) -> Vec<String> {
        let (minutes, accounts) = self
            .store
            .with_state(|s| (s.settings.usage_refresh_minutes, s.accounts.clone()));
        if minutes == 0 {
            return Vec::new();
        }
        let now = self.now();
        let mut due = Vec::new();
        for a in &accounts {
            let mut inner = self.lock();
            let cached = self.view_locked(&inner, a);
            // The gateway's windows keep `checkedAt` fresh; reads go on at their own pace.
            let read_at = inner
                .polled_at
                .get(&a.id)
                .copied()
                .or_else(|| cached.checked_at.as_deref().map(date_parse));
            // A window that reset since the last attempt is owed one read now, even while failed
            // reads back off.
            let since = inner.attempted_at.get(&a.id).copied().or(read_at);
            let source = self.source(a);
            if source.is_some()
                && let Some(since) = since
                && !inner.inflight.contains_key(&a.id)
                && now >= inner.server_retry_until.get(&a.id).copied().unwrap_or(0.0)
                && self.reset_since(&cached, since, false)
            {
                inner.next_attempt.remove(&a.id);
            }
            if source.is_some()
                && (read_at.is_none_or(|r| now - r >= f64::from(minutes) * 60_000.0 - 45_000.0)
                    || self.view_locked(&inner, a).stale)
                && now >= inner.next_attempt.get(&a.id).copied().unwrap_or(0.0)
            {
                due.push(a.id.clone());
            }
        }
        due
    }

    /// A read after a confirmed model request: a new server read rather than the success cache.
    /// Never bypasses a failure backoff, a server Retry-After, or a running read; never prompts.
    pub fn refresh_after_request(&self, id: &str) -> Result<AccountUsage, UsageRefreshFailed> {
        let account = self.store.account(id)?;
        let previous = self.view(&account);
        let now = self.now();
        {
            let mut inner = self.lock();
            if previous.status == UsageStatus::Ready
                && !inner.inflight.contains_key(id)
                && inner.server_retry_until.get(id).copied().unwrap_or(0.0) <= now
            {
                inner.next_attempt.remove(id);
            }
        }
        self.refresh(id, false)
    }

    /// Reads one account now, sharing a read already under way; returns its usage when done.
    pub fn refresh(
        &self,
        id: &str,
        allow_prompt: bool,
    ) -> Result<AccountUsage, UsageRefreshFailed> {
        let account = self.store.account(id)?;
        let now = self.now();
        let (job, previous, generation) = {
            let mut inner = self.lock();
            if let Some(existing) = inner.inflight.get(id).cloned() {
                drop(inner);
                return existing.wait().map_err(UsageRefreshFailed);
            }
            let Some(_) = self.source(&account) else {
                return Ok(self.view_locked(&inner, &account));
            };
            let previous = self.view_locked(&inner, &account);
            let reprompt = allow_prompt
                && now >= inner.server_retry_until.get(id).copied().unwrap_or(0.0)
                && (previous.connection_renewal_required == Some(true)
                    // "expired": the user asks to read through the Claude app, which may ask the Keychain.
                    || matches!(
                        previous.issue,
                        Some(UsageIssue::KeychainLocked | UsageIssue::RenewalRequired | UsageIssue::Expired)
                    ));
            if now < inner.next_attempt.get(id).copied().unwrap_or(0.0) && !reprompt {
                return Ok(previous);
            }
            inner.next_attempt.insert(id.to_owned(), now + 60_000.0);
            inner.attempted_at.insert(id.to_owned(), now);
            inner
                .identities
                .insert(id.to_owned(), identity_key(&account));
            inner.cache.insert(
                id.to_owned(),
                AccountUsage {
                    status: UsageStatus::Loading,
                    ..previous.clone()
                },
            );
            let generation = inner.generations.get(id).copied().unwrap_or(0);
            let job = Arc::new(Job {
                result: Mutex::new(None),
                done: Condvar::new(),
            });
            inner.inflight.insert(id.to_owned(), job.clone());
            (job, previous, generation)
        };
        let result = self
            .run(&account, &previous, allow_prompt, generation)
            .map_err(|e| e.0);
        {
            let mut inner = self.lock();
            // An earlier login's completion must not remove a newer read from deduplication.
            if inner.inflight.get(id).is_some_and(|j| Arc::ptr_eq(j, &job)) {
                inner.inflight.remove(id);
            }
        }
        *job.result.lock().unwrap_or_else(|e| e.into_inner()) = Some(result.clone());
        job.done.notify_all();
        result.map_err(UsageRefreshFailed)
    }

    fn generation_is(&self, id: &str, generation: u64) -> bool {
        self.lock().generations.get(id).copied().unwrap_or(0) == generation
    }

    fn take_slot(&self) {
        let mut inner = self.lock();
        while inner.active >= 2 {
            inner = self.slots.wait(inner).unwrap_or_else(|e| e.into_inner());
        }
        inner.active += 1;
    }

    fn give_slot(&self) {
        self.lock().active -= 1;
        self.slots.notify_one();
    }

    fn run(
        &self,
        account: &Account,
        previous: &AccountUsage,
        allow_prompt: bool,
        generation: u64,
    ) -> Result<AccountUsage, UsageRefreshFailed> {
        self.take_slot();
        let current = || self.generation_is(&account.id, generation);
        if current() {
            // An injected read that fails without a `UsageError` (a panic here; a thrown `Error`
            // in the TS) is an unanswered read, and must not leave the slot or the waiters hung.
            let attempted = quietly(|| self.attempt(account, allow_prompt, &current))
                .unwrap_or_else(|| {
                    Err(UsageError::with_detail(
                        UsageIssue::Unavailable,
                        network_detail(Some("Error"), None),
                    ))
                });
            if let Err(error) = attempted
                && current()
            {
                self.fail(account, previous, allow_prompt, &current, error);
            }
        }
        self.give_slot();
        Ok(self.view(&self.store.account(&account.id)?))
    }

    fn attempt(
        &self,
        account: &Account,
        allow_prompt: bool,
        current: &dyn Fn() -> bool,
    ) -> Result<(), UsageError> {
        let latest = || self.store.account(&account.id).map_err(store_failure);
        let same = |latest: &Account| {
            if identity_key(latest) != identity_key(account) {
                Err(UsageError::new(UsageIssue::IdentityMismatch))
            } else {
                Ok(())
            }
        };
        // Before any Claude sign-in is read: a Codex or Antigravity profile has none.
        if !is_claude(account) {
            // An OpenAI API key has no plan limits, and a provider without a reader has none
            // Relay can see: an invented 0% would mislead routing.
            let Some(provider) = &self.deps.provider_usage else {
                return Err(UsageError::with_detail(
                    UsageIssue::Unsupported,
                    "provider quota endpoint unavailable",
                ));
            };
            let result = provider(account)?;
            if !current() {
                return Ok(());
            }
            let stored = latest()?;
            same(&stored)?;
            // The plan the provider reports now replaces the one saved at sign-in.
            if let Some(plan) = &result.plan
                && let Some(auth) = &stored.auth
                && auth
                    .subscription
                    .as_ref()
                    .map(|s| s.to_lowercase())
                    .as_ref()
                    != Some(plan)
            {
                self.store
                    .update(|state| {
                        if let Some(auth) = state
                            .accounts
                            .iter_mut()
                            .find(|a| a.id == account.id)
                            .and_then(|a| a.auth.as_mut())
                        {
                            auth.subscription = Some(plan.clone());
                        }
                    })
                    .map_err(store_failure)?;
            }
            self.succeed(
                &latest()?,
                result.limits,
                UsageSource::Cli,
                false,
                None,
                None,
            );
            return Ok(());
        }
        if self.source(account) == Some(UsageSource::Desktop) {
            let desktop = self.deps.desktop_usage.as_ref().expect("source checked");
            let raw = (desktop.read)(account, allow_prompt)?;
            if !current() {
                return Ok(());
            }
            let limits = parse_usage(&raw)?;
            let stored = latest()?;
            same(&stored)?;
            self.succeed(&stored, limits, UsageSource::Desktop, false, None, None);
            return Ok(());
        }
        let profile = self.store.profile(&account.id).map_err(store_failure)?;
        let mut credential = (self.deps.credentials)(&profile, allow_prompt)?;
        if !current() {
            return Ok(());
        }
        let mut refreshed = false;
        let mut renewal_required = false;
        let pending_refresh = self
            .deps
            .refresh_credential_pending
            .as_ref()
            .is_some_and(|p| p(account));
        let renew = |credential: &mut UsageCredential, refreshed: &mut bool, force: bool| {
            let Some(refresh) = self
                .deps
                .refresh_credential
                .as_ref()
                .filter(|_| credential.refresh_token.is_some() || pending_refresh)
            else {
                return Err(UsageError::with_detail(
                    UsageIssue::Expired,
                    "saved sign-in has no refresh token",
                ));
            };
            *refreshed = true;
            *credential = refresh(account, credential, force, allow_prompt)?;
            Ok(())
        };
        let has_profile = |c: &UsageCredential| c.scopes.iter().any(|s| s == "user:profile");
        if !has_profile(&credential) {
            return Err(UsageError::with_detail(
                UsageIssue::Scope,
                "saved sign-in lacks user:profile",
            ));
        }
        if self.deps.refresh_credential.is_some()
            && (pending_refresh
                || (credential.refresh_token.is_some()
                    && credential
                        .expires_at
                        .is_some_and(|e| e <= self.now() + 5.0 * 60_000.0)))
        {
            let before = credential.expires_at;
            if let Err(error) = renew(&mut credential, &mut refreshed, false) {
                // macOS background reads may keep using a verified, still-valid access token
                // without allowing the CLI to open a Keychain dialog.
                if pending_refresh
                    || error.issue != UsageIssue::RenewalRequired
                    || before.is_none_or(|e| e <= self.now())
                {
                    return Err(error);
                }
                refreshed = false;
                renewal_required = true;
            }
        }
        if !current() {
            return Ok(());
        }
        if credential.expires_at.is_some_and(|e| e <= self.now()) {
            return Err(UsageError::with_detail(
                UsageIssue::Expired,
                "saved sign-in expired, not renewed",
            ));
        }
        if !has_profile(&credential) {
            return Err(UsageError::with_detail(
                UsageIssue::Scope,
                "saved sign-in lacks user:profile",
            ));
        }
        // Verify on every poll: a reconnect may have changed the account behind this profile.
        let profile_answer =
            match (self.deps.request)(UsageEndpoint::Profile, &credential.access_token) {
                Ok(answer) => answer,
                Err(error) if error.issue == UsageIssue::Expired && !refreshed => {
                    renew(&mut credential, &mut refreshed, true)?;
                    if !current() {
                        return Ok(());
                    }
                    if credential.expires_at.is_some_and(|e| e <= self.now()) {
                        return Err(UsageError::with_detail(
                            UsageIssue::Expired,
                            "renewed sign-in already expired",
                        ));
                    }
                    if !has_profile(&credential) {
                        return Err(UsageError::with_detail(
                            UsageIssue::Scope,
                            "renewed sign-in lacks user:profile",
                        ));
                    }
                    (self.deps.request)(UsageEndpoint::Profile, &credential.access_token)?
                }
                Err(error) => return Err(error),
            };
        if !current() {
            return Ok(());
        }
        verify_identity(account, &profile_answer)?;
        let raw_limits = (self.deps.request)(UsageEndpoint::Usage, &credential.access_token)?;
        if !current() {
            return Ok(());
        }
        let limits = parse_usage(&raw_limits)?;
        let stored = latest()?;
        same(&stored)?;
        let ends_at = credential
            .refresh_token_expires_at
            .filter(|e| e.is_finite())
            .map(iso);
        self.succeed(
            &stored,
            limits,
            UsageSource::Cli,
            renewal_required,
            ends_at,
            None,
        );
        if let Some(repair) = missing_identity(&stored, &profile_answer) {
            self.store
                .update(|state| {
                    let Some(stored) = state.accounts.iter_mut().find(|a| a.id == account.id)
                    else {
                        return;
                    };
                    let (Some(auth), Some(desktop)) =
                        (stored.auth.as_mut(), stored.desktop.as_mut())
                    else {
                        return;
                    };
                    if auth.account_uuid.is_none() {
                        auth.account_uuid = repair.account_uuid.clone();
                    }
                    if auth.org_id.is_none() {
                        auth.org_id = repair.org_id.clone();
                    }
                    if auth.org_name.is_none() {
                        auth.org_name = repair.org_name.clone();
                    }
                    if desktop.email.is_none() {
                        desktop.email = repair.desktop_email.clone();
                    }
                })
                .map_err(store_failure)?;
            // The repaired identity is the one this verified result belongs to.
            let repaired = identity_key(&latest()?);
            self.lock().identities.insert(account.id.clone(), repaired);
        }
        Ok(())
    }

    fn fail(
        &self,
        account: &Account,
        previous: &AccountUsage,
        allow_prompt: bool,
        current: &dyn Fn() -> bool,
        error: UsageError,
    ) {
        // The Claude Code sign-in ended (each lasts about 30 days). The Claude app's own sign-in
        // for the same account still reads the limits; the account keeps asking for a new Claude
        // Code sign-in beside them. Only that end counts.
        let ended =
            error.issue == UsageIssue::Expired && error.detail.as_deref() == Some(SIGN_IN_ENDED);
        let source = self.source(account);
        if ended
            && source == Some(UsageSource::Cli)
            && is_claude(account)
            && self.read_through_app(account, previous, allow_prompt, current, &error)
        {
            return;
        }
        let now = self.now();
        {
            let mut inner = self.lock();
            let failures = inner.failures.get(&account.id).copied().unwrap_or(0) + 1;
            inner.failures.insert(account.id.clone(), failures);
            let retry_at = error.retry_at.unwrap_or_else(|| {
                now + f64::from(30u32.min(2u32.pow(failures.min(5)))) * 60_000.0
            });
            if error.issue == UsageIssue::RateLimited {
                inner
                    .server_retry_until
                    .insert(account.id.clone(), retry_at);
            }
            inner.next_attempt.insert(account.id.clone(), retry_at);
            let retained = if matches!(
                error.issue,
                UsageIssue::IdentityMismatch
                    | UsageIssue::Expired
                    | UsageIssue::Scope
                    | UsageIssue::CredentialsMissing
            ) {
                AccountUsage::new(&account.id, UsageStatus::Idle)
            } else {
                previous.clone()
            };
            let mut usage = AccountUsage {
                status: UsageStatus::Error,
                stale: retained
                    .checked_at
                    .as_deref()
                    .is_some_and(|c| !c.is_empty()),
                issue: Some(error.issue),
                retry_at: Some(iso(retry_at)),
                ..retained
            };
            if ended {
                usage.cli_sign_in_ended = Some(true);
            }
            if source.is_some() {
                usage.source = source;
            }
            inner.cache.insert(account.id.clone(), usage);
        }
        // Only a change is worth a log line: a failing poll repeats every few minutes.
        if Some(error.issue) != previous.issue
            && let Some(on_issue) = &self.deps.on_issue
        {
            // The diagnosis log must never turn a usage failure into another one.
            quietly(|| on_issue(account, error.issue, error.detail.as_deref()));
        }
    }

    /// After the Claude Code sign-in of `account` ended: reads its limits through its Claude app
    /// sign-in. True when that answered.
    fn read_through_app(
        &self,
        account: &Account,
        previous: &AccountUsage,
        allow_prompt: bool,
        current: &dyn Fn() -> bool,
        ended: &UsageError,
    ) -> bool {
        let Some(desktop) = self
            .deps
            .desktop_usage
            .as_ref()
            .filter(|d| (d.usable)(account))
        else {
            return false;
        };
        if desktop_cli_mismatch(account) {
            return false;
        }
        let Some(Ok(raw)) = quietly(|| (desktop.read)(account, allow_prompt)) else {
            return false;
        };
        if !current() {
            return true;
        }
        let Ok(limits) = parse_usage(&raw) else {
            return false;
        };
        let Ok(latest) = self.store.account(&account.id) else {
            return false;
        };
        if identity_key(&latest) != identity_key(account) {
            return false;
        }
        self.succeed(
            &latest,
            limits,
            UsageSource::Desktop,
            false,
            None,
            Some(true),
        );
        if previous.cli_sign_in_ended != Some(true)
            && let Some(on_issue) = &self.deps.on_issue
        {
            let detail = format!(
                "{}; limits read through the Claude app",
                ended.detail.as_deref().unwrap_or("sign-in ended")
            );
            quietly(|| on_issue(account, UsageIssue::Expired, Some(&detail)));
        }
        true
    }

    fn succeed(
        &self,
        account: &Account,
        limits: UsageLimits,
        source: UsageSource,
        renewal_required: bool,
        cli_sign_in_ends_at: Option<String>,
        cli_sign_in_ended: Option<bool>,
    ) {
        let now = self.now();
        let checked_at = iso(now);
        let limits = tagged(
            limits,
            if source == UsageSource::Desktop {
                LimitSource::AppSession
            } else {
                LimitSource::Official
            },
            &checked_at,
        );
        let usage = AccountUsage {
            checked_at: Some(checked_at),
            source: Some(source),
            connection_renewal_required: renewal_required.then_some(true),
            cli_sign_in_ends_at,
            cli_sign_in_ended,
            five_hour: limits.five_hour,
            seven_day: limits.seven_day,
            other_limit_reached: limits.other_limit_reached,
            model_windows: limits.model_windows,
            ..AccountUsage::new(&account.id, UsageStatus::Ready)
        };
        {
            let mut inner = self.lock();
            inner.failures.remove(&account.id);
            inner.server_retry_until.remove(&account.id);
            inner.polled_at.insert(account.id.clone(), now);
            inner.cache.insert(account.id.clone(), usage.clone());
        }
        // History is optional: failed local persistence must not turn a verified live quota
        // response into an authentication/usage error.
        quietly(|| (self.deps.on_sample)(account, &usage));
    }
}
