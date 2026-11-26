//! Port of `electron/core/provider-usage.ts`: the usage limits of the providers other than
//! Claude, read through each account's own sign-in and answered in the shape `parse_usage`
//! gives for Claude.
//!
//! - Codex (a ChatGPT sign-in): `chatgpt.com/backend-api/wham/usage`, the request the Codex
//!   CLI's `/status` makes: primary window five hours, secondary weekly.
//! - Antigravity: Code Assist's `retrieveUserQuotaSummary` (pools with a five-hour and a weekly
//!   window), falling back to `fetchAvailableModels`.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use serde_json::{Map, Value};

use crate::clock::now_ms;
use crate::provider_credentials::{CodexCredential, CodexCredentialKind};
use crate::shared::types::js::{date_parse, iso, normalize_iso, round};
use crate::shared::types::{ModelWindow, ModelWindowPeriod, UsageIssue, UsageWindow};
use crate::usage::{
    UsageLimits, http_client, js_slice, locale_compare, network_detail, retry_time,
};
use crate::usage_credentials::{UsageError, js_len};

/// What a provider read answers: the limits and the plan it named.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ProviderUsageResult {
    pub limits: UsageLimits,
    /// The plan the provider reported, e.g. Codex's `plus`; None when it named none.
    pub plan: Option<String>,
}

const HOUR: f64 = 3_600.0;

fn percent(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).map(|v| v.clamp(0.0, 100.0))
}

/// A reset time given as unix seconds or an ISO date.
fn reset_iso(value: Option<&Value>, now: f64, after_seconds: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::Number(n)) if n.as_f64().is_some_and(|v| v > 0.0) => {
            return Some(iso(n.as_f64().unwrap_or_default() * 1000.0)).filter(|s| !s.is_empty());
        }
        Some(Value::String(s)) if date_parse(s).is_finite() => return normalize_iso(s),
        _ => {}
    }
    after_seconds
        .and_then(Value::as_f64)
        .filter(|s| *s >= 0.0)
        .map(|s| iso(now + s * 1000.0))
}

fn codex_window(raw: Option<&Value>, now: f64) -> Option<(UsageWindow, Option<f64>)> {
    let w = raw.filter(|r| r.is_object() || r.is_array())?;
    let used = percent(w.get("used_percent"))?;
    let resets_at = reset_iso(w.get("reset_at"), now, w.get("reset_after_seconds"));
    let seconds = w
        .get("limit_window_seconds")
        .and_then(Value::as_f64)
        .filter(|s| *s != 0.0);
    Some((
        UsageWindow {
            used_percent: used,
            resets_at,
            ..UsageWindow::default()
        },
        seconds,
    ))
}

/// The limits in a `wham/usage` answer.
pub fn parse_codex_usage(value: &Value, now: f64) -> Result<ProviderUsageResult, UsageError> {
    let Some(root) = value.as_object() else {
        return Err(UsageError::with_detail(
            UsageIssue::Unsupported,
            "codex usage: not an object",
        ));
    };
    let empty = Value::Object(Map::new());
    let limit = root
        .get("rate_limit")
        .filter(|l| l.is_object() || l.is_array())
        .unwrap_or(&empty);
    let windows: Vec<_> = [
        codex_window(limit.get("primary_window"), now),
        codex_window(limit.get("secondary_window"), now),
    ]
    .into_iter()
    .flatten()
    .collect();
    let mut five_hour: Option<UsageWindow> = None;
    let mut seven_day: Option<UsageWindow> = None;
    for (index, (window, seconds)) in windows.into_iter().enumerate() {
        // By its length when stated, else by its place: primary first.
        let long = match seconds {
            Some(s) => s > 24.0 * HOUR,
            None => index == 1,
        };
        if long {
            seven_day.get_or_insert(window);
        } else {
            five_hour.get_or_insert(window);
        }
    }
    if five_hour.is_none() && seven_day.is_none() {
        return Err(UsageError::with_detail(
            UsageIssue::Unsupported,
            "codex usage: no rate-limit windows",
        ));
    }
    // A limit the server calls reached with no full window is one of its other limits.
    let other_limit_reached = limit.get("limit_reached") == Some(&Value::Bool(true))
        && ![&five_hour, &seven_day]
            .iter()
            .any(|w| w.as_ref().is_some_and(|w| w.used_percent >= 100.0));
    let plan = root
        .get("plan_type")
        .and_then(Value::as_str)
        .filter(|p| {
            (1..=32).contains(&p.len())
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
        .map(str::to_lowercase);
    Ok(ProviderUsageResult {
        limits: UsageLimits {
            five_hour,
            seven_day,
            other_limit_reached: other_limit_reached.then_some(true),
            model_windows: None,
        },
        plan,
    })
}

/// A provider's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedResponse {
    pub status: u16,
    pub retry_after: Option<String>,
    pub body: String,
}

const MAX_BODY: usize = 512 * 1024;

/// One refused or failed answer, as the usage error it means.
fn refusal(status: u16, retry_after: Option<&str>, label: &str, now: f64) -> UsageError {
    let detail = format!("{label} {status}");
    match status {
        401 | 403 => UsageError::with_detail(UsageIssue::Expired, detail),
        429 => UsageError::with_retry(
            UsageIssue::RateLimited,
            Some(retry_time(retry_after, now)),
            Some(detail),
        ),
        _ => UsageError::with_detail(UsageIssue::Unavailable, detail),
    }
}

fn json(response: &FetchedResponse, label: &str, now: f64) -> Result<Value, UsageError> {
    if response.status != 200 {
        return Err(refusal(
            response.status,
            response.retry_after.as_deref(),
            label,
            now,
        ));
    }
    if js_len(&response.body) > MAX_BODY {
        return Err(UsageError::with_detail(
            UsageIssue::Unsupported,
            format!("{label} too large"),
        ));
    }
    serde_json::from_str(&response.body)
        .map_err(|_| UsageError::with_detail(UsageIssue::Unsupported, format!("{label} not JSON")))
}

pub const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

/// A GET with these headers; an error when no answer came.
pub type FetchFn =
    Arc<dyn Fn(&str, &[(String, String)]) -> Result<FetchedResponse, String> + Send + Sync>;

/// A blocking GET as `fetch` with `redirect: "error"` and a 15 s timeout.
pub fn default_fetch() -> FetchFn {
    Arc::new(|url: &str, headers: &[(String, String)]| {
        let mut request = http_client().get(url).timeout(Duration::from_secs(15));
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let response = request.send().map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        if (300..400).contains(&status) {
            return Err("redirect".into());
        }
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        Ok(FetchedResponse {
            status,
            retry_after,
            body: response.text().unwrap_or_default(),
        })
    })
}

/// Reads a ChatGPT sign-in's Codex limits.
pub fn read_codex_usage(
    credential: Option<&CodexCredential>,
    fetch: Option<&FetchFn>,
    now: Option<&dyn Fn() -> f64>,
) -> Result<ProviderUsageResult, UsageError> {
    let Some(credential) = credential else {
        return Err(UsageError::with_detail(
            UsageIssue::Expired,
            "codex: no usable sign-in saved",
        ));
    };
    if credential.kind == CodexCredentialKind::ApiKey {
        return Err(UsageError::with_detail(
            UsageIssue::Unsupported,
            "codex: an API key has no plan limits",
        ));
    }
    let clock = || now.map_or_else(|| now_ms() as f64, |n| n());
    let mut headers = vec![
        (
            "Authorization".to_owned(),
            format!("Bearer {}", credential.access_token),
        ),
        ("Accept".to_owned(), "application/json".to_owned()),
    ];
    if let Some(account) = &credential.account_id {
        headers.push(("ChatGPT-Account-Id".to_owned(), account.clone()));
    }
    headers.push(("User-Agent".to_owned(), "codex_cli_rs".to_owned()));
    headers.push(("originator".to_owned(), "codex_cli_rs".to_owned()));
    let fetch = fetch.cloned().unwrap_or_else(default_fetch);
    let response = fetch(CODEX_USAGE_URL, &headers)
        .map_err(|_| UsageError::with_detail(UsageIssue::Unavailable, "codex usage: no answer"))?;
    parse_codex_usage(&json(&response, "codex usage", clock())?, clock())
}

/// `/^(?:tab_|chat_|rev\d|internal)/i`: models a user does not pick.
fn hidden_model(id: &str) -> bool {
    let lower = id.to_lowercase();
    lower.starts_with("tab_")
        || lower.starts_with("chat_")
        || lower.starts_with("internal")
        || lower
            .strip_prefix("rev")
            .is_some_and(|r| r.starts_with(|c: char| c.is_ascii_digit()))
}

/// `s.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase()`.
fn slug(s: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            if gap {
                out.push('_');
            }
            gap = false;
            out.push(c);
        } else {
            gap = true;
        }
    }
    if gap {
        out.push('_');
    }
    out.trim_matches('_').to_lowercase()
}

fn regex(pattern: &'static str) -> regex::Regex {
    regex::Regex::new(pattern).expect("a fixed pattern")
}

/// A pool's name as Antigravity shows it: "Gemini Models" → "Gemini", "Claude and GPT models" →
/// "Claude & GPT".
pub fn pool_name(raw: &str) -> String {
    static MODELS: LazyLock<regex::Regex> = LazyLock::new(|| regex(r"(?i)\s+models?$"));
    static AND: LazyLock<regex::Regex> = LazyLock::new(|| regex(r"(?i)\s+and\s+"));
    let trimmed = raw.trim();
    let cut = MODELS.replace(trimmed, "");
    let name = js_slice(&AND.replace_all(&cut, " & "), 40);
    if name.is_empty() {
        js_slice(trimmed, 40)
    } else {
        name
    }
}

/// The pool a model's quota is counted in.
fn model_pool(id: &str, label: &str) -> String {
    let name = format!("{id} {label}").to_lowercase();
    if name.contains("gemini") {
        "Gemini".into()
    } else if name.contains("claude") || name.contains("gpt") {
        "Claude & GPT".into()
    } else {
        label.to_owned()
    }
}

/// The headline of pool windows: the pool with the most room (judged on its fuller window), as
/// its fuller window.
fn pool_headline(windows: &[ModelWindow], now: f64) -> (Option<UsageWindow>, Option<UsageWindow>) {
    let mut pools: Vec<(&str, &ModelWindow)> = Vec::new();
    for w in windows {
        match pools.iter_mut().find(|(label, _)| *label == w.label) {
            Some(seen) if w.used_percent > seen.1.used_percent => seen.1 = w,
            Some(_) => {}
            None => pools.push((&w.label, w)),
        }
    }
    let mut values: Vec<&ModelWindow> = pools.into_iter().map(|(_, w)| w).collect();
    values.sort_by(|a, b| a.used_percent.total_cmp(&b.used_percent));
    let Some(best) = values.first() else {
        return (None, None);
    };
    let headline = UsageWindow {
        used_percent: best.used_percent,
        resets_at: best.resets_at.clone(),
        ..UsageWindow::default()
    };
    let weekly = best.period == Some(ModelWindowPeriod::SevenDay)
        || (best.period.is_none()
            && best
                .resets_at
                .as_deref()
                .is_some_and(|r| date_parse(r) - now > 24.0 * HOUR * 1000.0));
    if weekly {
        (None, Some(headline))
    } else {
        (Some(headline), None)
    }
}

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// A summary bucket's window: its `window` cadence ("5h", "weekly"), else its id's or name's.
fn bucket_period(bucket: &Value) -> Option<ModelWindowPeriod> {
    static FIVE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex(r"^(?:5h|5-hour|five[_ -]?hours?)$"));
    static WEEK: LazyLock<regex::Regex> =
        LazyLock::new(|| regex(r"^(?:weekly|week|7d|seven[_ -]?days?)$"));
    static ID_FIVE: LazyLock<regex::Regex> = LazyLock::new(|| regex(r"[-_]5h$"));
    static ID_WEEK: LazyLock<regex::Regex> = LazyLock::new(|| regex(r"[-_](?:weekly|7d)$"));
    static NAME_FIVE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex(r"(?-u:\b)5[ -]?(?:h(?-u:\b)|hour)"));
    let lower = |key: &str| {
        str_field(bucket, key)
            .map(str::to_lowercase)
            .unwrap_or_default()
    };
    let window = lower("window").trim().to_owned();
    if FIVE.is_match(&window) {
        return Some(ModelWindowPeriod::FiveHour);
    }
    if WEEK.is_match(&window) {
        return Some(ModelWindowPeriod::SevenDay);
    }
    let id = lower("bucketId");
    if ID_FIVE.is_match(&id) {
        return Some(ModelWindowPeriod::FiveHour);
    }
    if ID_WEEK.is_match(&id) {
        return Some(ModelWindowPeriod::SevenDay);
    }
    let name = lower("displayName");
    if NAME_FIVE.is_match(&name) {
        return Some(ModelWindowPeriod::FiveHour);
    }
    if name.contains("week") {
        return Some(ModelWindowPeriod::SevenDay);
    }
    None
}

fn period_order(w: &ModelWindow) -> u8 {
    match w.period {
        Some(ModelWindowPeriod::FiveHour) => 0,
        Some(ModelWindowPeriod::SevenDay) => 1,
        None => 2,
    }
}

/// The limits in a `retrieveUserQuotaSummary` answer: each pool's five-hour and weekly window,
/// in the order Antigravity lists them, five hours before the week. None when the answer has no
/// usable bucket, so the caller falls back to the model list.
pub fn parse_antigravity_summary(value: &Value, now: f64) -> Option<ProviderUsageResult> {
    let groups = value.get("groups")?.as_array()?;
    let mut windows: Vec<ModelWindow> = Vec::new();
    for group in groups {
        let Some(buckets) = group.get("buckets").and_then(Value::as_array) else {
            continue;
        };
        let pool = str_field(group, "displayName")
            .filter(|n| !n.trim().is_empty())
            .map(pool_name);
        let mut own: Vec<ModelWindow> = Vec::new();
        for bucket in buckets {
            if !(bucket.is_object() || bucket.is_array())
                || bucket.get("disabled") == Some(&Value::Bool(true))
            {
                continue;
            }
            let reset = bucket
                .get("resetTime")
                .filter(|r| !r.as_str().is_some_and(|s| s.trim().is_empty()));
            let resets_at = reset_iso(reset, now, None);
            let raw = match bucket.get("remainingFraction") {
                None | Some(Value::Null) => bucket
                    .get("remaining")
                    .and_then(|r| r.get("remainingFraction")),
                found => found,
            };
            let remaining = match raw.and_then(Value::as_f64) {
                Some(f) => Some(f.clamp(0.0, 1.0)),
                None => resets_at.as_ref().map(|_| 0.0),
            };
            let Some(remaining) = remaining else { continue };
            let period = bucket_period(bucket);
            let name = str_field(bucket, "displayName")
                .filter(|n| !n.trim().is_empty())
                .map(|n| js_slice(n.trim(), 40));
            let label = pool
                .clone()
                .or(name)
                .unwrap_or_else(|| "Antigravity".into());
            let id = match str_field(bucket, "bucketId")
                .map(slug)
                .filter(|s| !s.is_empty())
            {
                Some(id) => id,
                None => format!(
                    "{}_{}",
                    slug(&label),
                    period.map_or_else(|| own.len().to_string(), |p| p.as_str().to_owned())
                ),
            };
            let key = format!("antigravity_{id}");
            if windows.iter().chain(own.iter()).any(|w| w.key == key) {
                continue;
            }
            own.push(ModelWindow {
                key,
                label,
                used_percent: round((1.0 - remaining) * 1000.0) / 10.0,
                resets_at,
                period,
                ..ModelWindow::default()
            });
        }
        own.sort_by_key(period_order);
        windows.extend(own);
    }
    if windows.is_empty() {
        return None;
    }
    let (five_hour, seven_day) = pool_headline(&windows, now);
    Some(ProviderUsageResult {
        limits: UsageLimits {
            five_hour,
            seven_day,
            other_limit_reached: None,
            model_windows: Some(windows),
        },
        plan: None,
    })
}

/// The limits in a `fetchAvailableModels` answer, the fallback for accounts the summary refuses:
/// each model's share folded into its pool, the fullest model standing for the pool.
pub fn parse_antigravity_quota(value: &Value) -> Result<ProviderUsageResult, UsageError> {
    let unsupported = |d: &str| UsageError::with_detail(UsageIssue::Unsupported, d);
    let models = value
        .get("models")
        .filter(|m| m.is_object() || m.is_array())
        .ok_or_else(|| unsupported("antigravity quota: no models"))?;
    let list: Vec<(String, &Value)> = match models {
        Value::Array(items) => items
            .iter()
            .map(|m| {
                let pick = |k: &str| match m.get(k) {
                    None | Some(Value::Null) => None,
                    Some(Value::String(s)) => Some(s.clone()),
                    Some(other) => Some(other.to_string()),
                };
                (
                    pick("model")
                        .or_else(|| pick("id"))
                        .or_else(|| pick("name"))
                        .unwrap_or_default(),
                    m,
                )
            })
            .collect(),
        Value::Object(map) => map.iter().map(|(k, v)| (k.clone(), v)).collect(),
        _ => Vec::new(),
    };
    let now = now_ms() as f64;
    let mut entries: Vec<(String, String, f64, Option<String>)> = Vec::new();
    for (id, model) in list {
        if id.is_empty() || hidden_model(&id) || !(model.is_object() || model.is_array()) {
            continue;
        }
        let Some(quota) = model
            .get("quotaInfo")
            .filter(|q| !q.is_null())
            .or_else(|| model.get("quota_info"))
            .filter(|q| q.is_object() || q.is_array())
        else {
            continue;
        };
        let pick = |a: &str, b: &str| match quota.get(a) {
            None | Some(Value::Null) => quota.get(b),
            found => found,
        };
        let resets_at = reset_iso(pick("resetTime", "reset_time"), now, None);
        let remaining =
            match pick("remainingFraction", "remaining_fraction").and_then(Value::as_f64) {
                Some(f) => Some(f.clamp(0.0, 1.0)),
                None => resets_at.as_ref().map(|_| 0.0),
            };
        let Some(remaining) = remaining else { continue };
        let label = str_field(model, "displayName")
            .filter(|n| !n.trim().is_empty())
            .map_or_else(|| id.clone(), |n| js_slice(n.trim(), 60));
        entries.push((
            id,
            label,
            round((1.0 - remaining) * 1000.0) / 10.0,
            resets_at,
        ));
    }
    if entries.is_empty() {
        return Err(unsupported("antigravity quota: no model quotas"));
    }
    // The models of one pool share its quota: one line per pool, its fullest model.
    let mut order: Vec<String> = Vec::new();
    let mut by_pool: HashMap<String, ModelWindow> = HashMap::new();
    for (id, label, used, resets_at) in entries {
        let pool = model_pool(&id, &label);
        let replace = by_pool
            .get(&pool)
            .is_none_or(|seen| used > seen.used_percent);
        if replace {
            if !by_pool.contains_key(&pool) {
                order.push(pool.clone());
            }
            by_pool.insert(
                pool.clone(),
                ModelWindow {
                    key: format!("antigravity_{}", slug(&pool)),
                    label: pool,
                    used_percent: used,
                    resets_at,
                    ..ModelWindow::default()
                },
            );
        }
    }
    let mut model_windows: Vec<ModelWindow> = order
        .into_iter()
        .filter_map(|p| by_pool.remove(&p))
        .collect();
    model_windows.sort_by(|a, b| {
        (b.label == "Gemini")
            .cmp(&(a.label == "Gemini"))
            .then_with(|| locale_compare(&a.label, &b.label))
    });
    // No `otherLimitReached`: a spent pool leaves the others usable.
    let (five_hour, seven_day) = pool_headline(&model_windows, now);
    Ok(ProviderUsageResult {
        limits: UsageLimits {
            five_hour,
            seven_day,
            other_limit_reached: None,
            model_windows: Some(model_windows),
        },
        plan: None,
    })
}

/// Antigravity 2.x's quota summary, the daily host first: it is the one the app is metered on.
pub const ANTIGRAVITY_SUMMARY_URLS: [&str; 2] = [
    "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
];

/// The summary answers only a 2.x Antigravity client.
pub const ANTIGRAVITY_SUMMARY_AGENT: &str = "antigravity/2.24.0 Darwin/arm64";

/// Code Assist's hosts, the one CLIProxyAPI uses first.
pub const ANTIGRAVITY_QUOTA_URLS: [&str; 2] = [
    "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
];

/// Code Assist's account setup call: it names the Google plan (tier) the sign-in is on.
pub const ANTIGRAVITY_TIER_URLS: [&str; 2] = [
    "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
];

/// Google's tier ids, as the short plan Relay stores.
const GOOGLE_TIERS: [(&str, &str); 5] = [
    ("g1-ultra-tier", "ultra"),
    ("g1-pro-tier", "pro"),
    ("standard-tier", "standard"),
    ("free-tier", "free"),
    ("legacy-tier", "legacy"),
];

/// The plan a `loadCodeAssist` answer names: the paid tier when there is one, else the current
/// tier. None when it names none Relay can read.
pub fn parse_antigravity_tier(value: &Value) -> Option<String> {
    let root = value.as_object()?;
    for tier in [root.get("paidTier"), root.get("currentTier")] {
        let id = tier
            .and_then(|t| t.get("id"))
            .and_then(Value::as_str)
            .map(str::to_lowercase)
            .unwrap_or_default();
        if let Some((_, plan)) = GOOGLE_TIERS.iter().find(|(k, _)| *k == id) {
            return Some((*plan).to_owned());
        }
        if (1..=40).contains(&id.len())
            && id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Some(id.strip_suffix("-tier").unwrap_or(&id).to_owned());
        }
    }
    None
}

/// One call through the Antigravity sidecar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AntigravityRequest {
    pub url: String,
    pub body: String,
    pub user_agent: Option<String>,
}

/// Calls through the sidecar; an error message when no answer came. Borrowed for the read only,
/// so it may capture locals.
pub type AntigravityCall<'a> =
    dyn Fn(&AntigravityRequest) -> Result<FetchedResponse, String> + Send + Sync + 'a;

/// The Google plan of an Antigravity sign-in, or None when it cannot be read now.
pub fn read_antigravity_tier(
    call: &AntigravityCall<'_>,
    project_id: Option<&str>,
) -> Option<String> {
    let mut body = Map::new();
    if let Some(project) = project_id {
        body.insert("cloudaicompanionProject".into(), project.into());
    }
    let mut metadata = Map::new();
    metadata.insert("ideType".into(), "ANTIGRAVITY".into());
    metadata.insert("platform".into(), "PLATFORM_UNSPECIFIED".into());
    metadata.insert("pluginType".into(), "GEMINI".into());
    if let Some(project) = project_id {
        metadata.insert("duetProject".into(), project.into());
    }
    body.insert("metadata".into(), Value::Object(metadata));
    let body = Value::Object(body).to_string();
    for url in ANTIGRAVITY_TIER_URLS {
        // The plan is a label: a failed read leaves the saved one.
        let Ok(response) = call(&AntigravityRequest {
            url: url.into(),
            body: body.clone(),
            user_agent: None,
        }) else {
            continue;
        };
        if response.status != 200 || js_len(&response.body) > MAX_BODY {
            continue;
        }
        if let Some(tier) = serde_json::from_str::<Value>(&response.body)
            .ok()
            .and_then(|v| parse_antigravity_tier(&v))
        {
            return Some(tier);
        }
    }
    None
}

/// Why the sidecar gave no answer, for the usage issue log: the bridge's own messages name the
/// step and carry no secret; anything else is described by its kind only.
fn sidecar_detail(message: &str) -> String {
    let own = message
        .strip_prefix("Antigravity OAuth service returned ")
        .is_some_and(|r| r.len() == 3 && r.bytes().all(|b| b.is_ascii_digit()))
        || message == "No Antigravity credential in the sidecar"
        || message.strip_prefix("CLIProxyAPI ").is_some_and(|r| {
            (1..=80).contains(&r.len())
                && r.bytes().all(|b| {
                    b.is_ascii_alphanumeric() || matches!(b, b'_' | b' ' | b'/' | b'.' | b'-')
                })
        });
    if own {
        format!("no answer: {message}")
    } else {
        network_detail(Some("Error"), None)
    }
}

/// How long one read may go on asking: past it no further address is tried.
pub const ANTIGRAVITY_READ_MS: f64 = 60_000.0;

/// Reads an Antigravity account's model quotas through its CLIProxyAPI sidecar, which holds the
/// Google sign-in and renews it: Relay never handles the token itself.
pub fn read_antigravity_usage(
    call: &AntigravityCall<'_>,
    project_id: Option<&str>,
    now: Option<&dyn Fn() -> f64>,
) -> Result<ProviderUsageResult, UsageError> {
    let clock = || now.map_or_else(|| now_ms() as f64, |n| n());
    let mut body = Map::new();
    if let Some(project) = project_id {
        body.insert("project".into(), project.into());
    }
    let body = Value::Object(body).to_string();
    let started = clock();
    let late = || clock() - started >= ANTIGRAVITY_READ_MS;
    // A refused sign-in stops here; anything else moves on, in the end to the model list.
    for url in ANTIGRAVITY_SUMMARY_URLS {
        if late() {
            break;
        }
        let Ok(response) = call(&AntigravityRequest {
            url: url.into(),
            body: body.clone(),
            user_agent: Some(ANTIGRAVITY_SUMMARY_AGENT.into()),
        }) else {
            continue;
        };
        if response.status == 401 {
            return Err(refusal(
                401,
                response.retry_after.as_deref(),
                "antigravity quota summary",
                clock(),
            ));
        }
        if response.status != 200 || js_len(&response.body) > MAX_BODY {
            continue;
        }
        if let Some(summary) = serde_json::from_str::<Value>(&response.body)
            .ok()
            .and_then(|v| parse_antigravity_summary(&v, clock()))
        {
            return Ok(summary);
        }
    }
    let mut last: Option<UsageError> = None;
    for url in ANTIGRAVITY_QUOTA_URLS {
        if late() {
            last.get_or_insert_with(|| {
                UsageError::with_detail(
                    UsageIssue::Unavailable,
                    "antigravity quota: no answer in time",
                )
            });
            break;
        }
        let response = match call(&AntigravityRequest {
            url: url.into(),
            body: body.clone(),
            user_agent: None,
        }) {
            Ok(response) => response,
            Err(message) => {
                last = Some(UsageError::with_detail(
                    UsageIssue::Unavailable,
                    format!("antigravity quota: {}", sidecar_detail(&message)),
                ));
                continue;
            }
        };
        // A refusal of the sign-in is the same on both hosts; only an outage is worth a second try.
        if response.status != 200 && response.status < 500 {
            return Err(refusal(
                response.status,
                response.retry_after.as_deref(),
                "antigravity quota",
                clock(),
            ));
        }
        if response.status != 200 {
            last = Some(refusal(
                response.status,
                response.retry_after.as_deref(),
                "antigravity quota",
                clock(),
            ));
            continue;
        }
        return parse_antigravity_quota(&json(&response, "antigravity quota", clock())?);
    }
    Err(last.unwrap_or_else(|| {
        UsageError::with_detail(UsageIssue::Unavailable, "antigravity quota: no answer")
    }))
}
