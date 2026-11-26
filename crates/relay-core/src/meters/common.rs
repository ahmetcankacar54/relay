//! Port of `electron/core/meters/common.ts`: what the meter readers share.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use regex::Regex;
use serde_json::Value;

use crate::clock::now_ms;
use crate::relay_paths::Platform;
use crate::shared::meters::{MeterIssue, MeterWindow};
use crate::shared::types::js::{date_parse, iso, trim};
use crate::usage::{http_client, retry_time};
use crate::usage_credentials::js_len;

/// A meter read that failed, as the issue the Overview row says. `detail` is for the private
/// log only: a step and an HTTP status, never a token or a response body.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{}", issue_text(*.issue))]
pub struct MeterError {
    pub issue: MeterIssue,
    pub retry_at: Option<f64>,
    pub detail: Option<String>,
}

/// The issue as the TS spells it (`not-signed-in`).
pub fn issue_text(issue: MeterIssue) -> String {
    serde_json::to_value(issue)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

impl MeterError {
    pub fn new(issue: MeterIssue, retry_at: Option<f64>, detail: impl Into<String>) -> Self {
        MeterError {
            issue,
            retry_at,
            detail: Some(detail.into()),
        }
    }
}

/// What a reader gives back: everything of the reading but when and where it was read.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct MeterRead {
    pub label: Option<String>,
    pub windows: Vec<MeterWindow>,
}

/// One request a reader makes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeterRequest {
    pub url: String,
    pub method: &'static str,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

/// Its answer: the status, `Retry-After`, and the body as text.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MeterResponse {
    pub status: u16,
    pub retry_after: Option<String>,
    pub body: String,
}

/// Sends a request; an error when no answer came (refused, timed out, redirected).
pub type MeterFetch = Arc<dyn Fn(&MeterRequest) -> Result<MeterResponse, String> + Send + Sync>;

/// A request with a 15 s timeout that refuses redirects (a redirect would carry the token
/// elsewhere).
pub fn default_meter_fetch() -> MeterFetch {
    Arc::new(|request: &MeterRequest| {
        let method = if request.method == "POST" {
            reqwest::Method::POST
        } else {
            reqwest::Method::GET
        };
        let mut builder = http_client()
            .request(method, &request.url)
            .timeout(Duration::from_secs(15));
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = &request.body {
            builder = builder.body(body.clone());
        }
        let response = builder.send().map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        if (300..400).contains(&status) {
            return Err("redirect".into());
        }
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        Ok(MeterResponse {
            status,
            retry_after,
            body: response.text().unwrap_or_default(),
        })
    })
}

/// What a reader reads with; every field defaults to this computer's.
#[derive(Clone, Default)]
pub struct MeterReaderOptions {
    pub fetch: Option<MeterFetch>,
    pub now: Option<Arc<dyn Fn() -> f64 + Send + Sync>>,
    /// The home folder the tools' files are found under; tests point it at a temporary folder.
    pub home: Option<PathBuf>,
    pub env: Option<BTreeMap<String, String>>,
    pub platform: Option<Platform>,
}

impl MeterReaderOptions {
    pub fn now(&self) -> f64 {
        self.now
            .as_ref()
            .map_or_else(|| now_ms() as f64, |now| now())
    }
    pub fn home(&self) -> PathBuf {
        self.home
            .clone()
            .unwrap_or_else(|| std::env::home_dir().unwrap_or_default())
    }
    pub fn env(&self) -> BTreeMap<String, String> {
        self.env
            .clone()
            .unwrap_or_else(crate::relay_cli_path::process_env)
    }
    pub fn platform(&self) -> Platform {
        self.platform.unwrap_or_else(Platform::current)
    }
}

/// A JSON object, as the readers walk it.
pub type Json = serde_json::Map<String, Value>;

const MAX_BODY: usize = 512 * 1024;

/// One refused answer, as the issue it means: a 401 or 403 is a sign-in the provider no longer
/// takes, unless the reader tells a 403 apart itself (`accept`).
fn refusal(status: u16, retry_after: Option<&str>, label: &str, now: f64) -> MeterError {
    let detail = format!("{label} {status}");
    match status {
        401 | 403 => MeterError::new(MeterIssue::Expired, None, detail),
        429 => MeterError::new(
            MeterIssue::RateLimited,
            Some(retry_time(retry_after, now)),
            detail,
        ),
        _ => MeterError::new(MeterIssue::Unavailable, None, detail),
    }
}

/// A JSON answer.
#[derive(Debug, Clone, PartialEq)]
pub struct JsonAnswer {
    pub status: u16,
    /// The parsed body of a 200; Null otherwise.
    pub body: Value,
    /// The raw text of a refused answer, for readers that tell refusals apart by what they say.
    pub text: String,
}

/// One request (15 s, no redirects). Answers anything but 200 as `refusal` says unless
/// `accept` takes that status, and refuses a body that is too large or not JSON.
pub fn request_json(
    url: &str,
    method: &'static str,
    headers: &[(&str, &str)],
    body: Option<String>,
    label: &str,
    options: &MeterReaderOptions,
    accept: Option<&dyn Fn(u16) -> bool>,
) -> Result<JsonAnswer, MeterError> {
    let now = options.now();
    let fetch = options.fetch.clone().unwrap_or_else(default_meter_fetch);
    let request = MeterRequest {
        url: url.to_owned(),
        method,
        headers: headers
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect(),
        body,
    };
    let response = fetch(&request).map_err(|_| {
        MeterError::new(MeterIssue::Unavailable, None, format!("{label}: no answer"))
    })?;
    if response.status != 200 && !accept.is_some_and(|accept| accept(response.status)) {
        return Err(refusal(
            response.status,
            response.retry_after.as_deref(),
            label,
            now,
        ));
    }
    if js_len(&response.body) > MAX_BODY {
        return Err(MeterError::new(
            MeterIssue::Unsupported,
            None,
            format!("{label} too large"),
        ));
    }
    if response.status != 200 {
        return Ok(JsonAnswer {
            status: response.status,
            body: Value::Null,
            text: response.body,
        });
    }
    let body = serde_json::from_str(&response.body)
        .map_err(|_| MeterError::new(MeterIssue::Unsupported, None, format!("{label} not JSON")))?;
    Ok(JsonAnswer {
        status: 200,
        body,
        text: String::new(),
    })
}

/// A finite number, or None.
pub fn num(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite())
}

/// A share in 0–100.
pub fn clamp_percent(value: f64) -> f64 {
    value.clamp(0.0, 100.0)
}

static BARE_DATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").expect("valid regex"));

/// A date as ISO text, from ISO text or a bare `YYYY-MM-DD` (read as UTC midnight).
pub fn iso_date(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str().filter(|t| !t.is_empty())?;
    let ms = if BARE_DATE.is_match(text) {
        date_parse(&format!("{text}T00:00:00Z"))
    } else {
        date_parse(text)
    };
    ms.is_finite().then(|| iso(ms))
}

static PLAIN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[\p{L}\p{N} ._@+-]+$").expect("valid regex"));

/// A plan or login name fit to show: short and printable, else None.
pub fn plain_label(value: Option<&Value>) -> Option<String> {
    let text = trim(value?.as_str()?);
    (!text.is_empty() && js_len(text) <= 40 && PLAIN.is_match(text)).then(|| text.to_owned())
}

/// The object under `key`, when it is one.
pub(crate) fn object(value: Option<&Value>) -> Option<&Json> {
    value.and_then(Value::as_object)
}

/// `Buffer.from(text, "base64")` (and `"base64url"`): both alphabets, what is not base64
/// skipped, a dangling last character dropped, never an error.
pub(crate) fn buffer_from_base64(text: &str) -> Vec<u8> {
    use base64::Engine;
    use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_allow_trailing_bits(true)
            .with_decode_padding_mode(DecodePaddingMode::RequireNone),
    );
    let mut clean: String = text
        .split('=')
        .next()
        .unwrap_or_default()
        .chars()
        .filter_map(|c| match c {
            '-' => Some('+'),
            '_' => Some('/'),
            c if c.is_ascii_alphanumeric() || c == '+' || c == '/' => Some(c),
            _ => None,
        })
        .collect();
    if clean.len() % 4 == 1 {
        clean.pop();
    }
    LENIENT.decode(clean).unwrap_or_default()
}
