//! API-key upstreams for overflow (`overflow-upstream.ts`): their headers and body, the Test
//! button's request, and OpenRouter's published prices.

use crate::js::{now_ms, slice_units};
use crate::overflow::overflow_model;
use crate::types::{ApiUpstream, ApiUpstreamAuth, ApiUpstreamPreset, OverflowRates};
use crate::upstream_common::{build_target_url, error_message, tls_config};
use bytes::Bytes;
use http::{HeaderMap, HeaderValue};
use indexmap::IndexMap;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

/// The client headers an API-key upstream is sent; nothing else goes.
const PASSED_HEADERS: [&str; 4] = ["content-type", "accept", "anthropic-version", "anthropic-beta"];
const MAX_TEST_MESSAGE: usize = 200;
const TEST_TIMEOUT: Duration = Duration::from_secs(20);

fn joined(source: &HeaderMap, name: &str) -> Option<String> {
    let values: Vec<&str> = source
        .get_all(name)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .collect();
    (!values.is_empty()).then(|| values.join(", "))
}

/// The headers for one upstream: the allowed client headers and the key, as the preset sends
/// it. Anthropic's API keeps the client's betas but the OAuth one; a third party gets none.
pub fn overflow_headers(
    source: &HeaderMap,
    preset: ApiUpstreamPreset,
    auth_style: ApiUpstreamAuth,
    key: &str,
) -> HeaderMap {
    let mut out = HeaderMap::new();
    let set = |out: &mut HeaderMap, name: &'static str, value: &str| {
        if let Ok(value) = HeaderValue::from_str(value) {
            out.insert(name, value);
        }
    };
    for name in PASSED_HEADERS {
        if name == "anthropic-beta" {
            continue;
        }
        if let Some(value) = joined(source, name) {
            set(&mut out, name, &value);
        }
    }
    if preset == ApiUpstreamPreset::Anthropic {
        let mut betas: Vec<String> = Vec::new();
        for value in source.get_all("anthropic-beta") {
            for beta in value.to_str().unwrap_or("").split(',') {
                let beta = beta.trim();
                // Betas only a subscription's OAuth token carries; an API key is refused with them.
                let subscription = beta.get(..6).is_some_and(|p| p.eq_ignore_ascii_case("oauth-"));
                if !beta.is_empty() && !subscription && !betas.iter().any(|b| b == beta) {
                    betas.push(beta.to_string());
                }
            }
        }
        if !betas.is_empty() {
            set(&mut out, "anthropic-beta", &betas.join(","));
        }
        if !out.contains_key("anthropic-version") {
            set(&mut out, "anthropic-version", "2023-06-01");
        }
    }
    if !out.contains_key("content-type") {
        set(&mut out, "content-type", "application/json");
    }
    match auth_style {
        ApiUpstreamAuth::Bearer => set(&mut out, "authorization", &format!("Bearer {key}")),
        ApiUpstreamAuth::XApiKey => set(&mut out, "x-api-key", key),
    }
    out
}

/// The request body with the upstream's model in it; the bytes as they came when nothing
/// changes.
pub fn overflow_body(body: &Bytes, parsed: Option<&Value>, model: &str) -> Bytes {
    let Some(Value::Object(object)) = parsed else {
        return body.clone();
    };
    if object.get("model").and_then(Value::as_str) == Some(model) {
        return body.clone();
    }
    let mut rewritten = object.clone();
    rewritten.insert("model".into(), Value::String(model.to_string()));
    Bytes::from(Value::Object(rewritten).to_string())
}

/// A one-token request's outcome from the page's Test button; never holds the key.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct OverflowTestResult {
    pub ok: bool,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

fn test_client() -> reqwest::Client {
    reqwest::Client::builder()
        .tls_backend_preconfigured(tls_config())
        .http1_only()
        .no_proxy()
        .timeout(TEST_TIMEOUT)
        .build()
        .expect("the test client builds")
}

/// Asks the upstream for one token of its Haiku-class model: whether the URL, key and model
/// work. The answer names the model and the upstream's own error, never the key.
pub async fn test_overflow_upstream(upstream: &ApiUpstream, key: &str) -> OverflowTestResult {
    let model = overflow_model(&upstream.model_map, "claude-haiku-5-5");
    let failed = |message: String| OverflowTestResult {
        ok: false,
        model: model.clone(),
        status: None,
        message: Some(slice_units(&message, MAX_TEST_MESSAGE).to_string()),
    };
    let Ok(target) = build_target_url(&upstream.base_url, Some("/v1/messages"), false) else {
        return failed("Invalid base URL".into());
    };
    let body = json!({
        "model": model,
        "max_tokens": 1,
        "messages": [{ "role": "user", "content": "Hi" }],
    })
    .to_string();
    let response = test_client()
        .post(target)
        .headers(overflow_headers(
            &HeaderMap::new(),
            upstream.preset,
            upstream.auth_style,
            key,
        ))
        .body(body)
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(error) => return failed(error.to_string()),
    };
    let status = response.status().as_u16();
    if response.status().is_success() {
        return OverflowTestResult {
            ok: true,
            model,
            status: Some(status),
            message: None,
        };
    }
    let text = response.text().await.unwrap_or_default();
    let message = error_message(Some(&text))
        .and_then(|e| e.message)
        .unwrap_or(text);
    let message = slice_units(message.trim(), MAX_TEST_MESSAGE).to_string();
    OverflowTestResult {
        ok: false,
        model,
        status: Some(status),
        message: (!message.is_empty()).then_some(message),
    }
}

const DAY_MS: i64 = 86_400_000;
/// After a failed read of OpenRouter's prices, the next try waits this long, not a day.
const RETRY_MS: i64 = 3_600_000;
pub const OPENROUTER_MODELS: &str = "https://openrouter.ai/api/v1/models";

/// Prices per token, as OpenRouter publishes them, become prices per million.
fn per_million(value: Option<&Value>) -> Option<f64> {
    let number = match value? {
        Value::String(text) => crate::js::number(text),
        Value::Number(n) => n.as_f64()?,
        _ => return None,
    };
    (number.is_finite() && number >= 0.0).then_some(number * 1_000_000.0)
}

/// OpenRouter's `/api/v1/models` answer as prices per million tokens, by model id.
pub fn parse_open_router_models(json: &Value) -> IndexMap<String, OverflowRates> {
    let mut out = IndexMap::new();
    let Some(data) = json.get("data").and_then(Value::as_array) else {
        return out;
    };
    for row in data {
        let Some(id) = row.get("id").and_then(Value::as_str) else {
            continue;
        };
        let pricing = row.get("pricing");
        let input = per_million(pricing.and_then(|p| p.get("prompt")));
        let output = per_million(pricing.and_then(|p| p.get("completion")));
        let (Some(input), Some(output)) = (input, output) else {
            continue;
        };
        if id.is_empty() {
            continue;
        }
        out.insert(
            id.to_string(),
            OverflowRates {
                input,
                output,
                cache_read: per_million(pricing.and_then(|p| p.get("input_cache_read"))),
                cache_write: per_million(pricing.and_then(|p| p.get("input_cache_write"))),
            },
        );
    }
    out
}

#[derive(Default)]
pub struct OpenRouterPricesOptions {
    /// Where the prices are kept between runs.
    pub file: Option<PathBuf>,
    /// Where they are read from (tests point it at a local server).
    pub url: Option<String>,
    pub now: Option<crate::js::Clock>,
}

struct PriceState {
    rates: IndexMap<String, OverflowRates>,
    fetched_at: i64,
}

/// OpenRouter's published prices, read at most once a day and kept in a file, so its overflow
/// answers have a cost. A failed read leaves the last prices in use and tries again in an hour.
pub struct OpenRouterPrices {
    options: OpenRouterPricesOptions,
    state: Mutex<PriceState>,
    /// One read at a time; callers that arrive meanwhile wait for it.
    reading: tokio::sync::Mutex<()>,
    client: reqwest::Client,
}

impl OpenRouterPrices {
    pub fn new(options: OpenRouterPricesOptions) -> Self {
        let mut state = PriceState {
            rates: IndexMap::new(),
            fetched_at: 0,
        };
        if let Some(file) = &options.file {
            // None kept yet: read on first use.
            if let Some(saved) = std::fs::read_to_string(file)
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            {
                state.rates = parse_open_router_models(saved.get("models").unwrap_or(&Value::Null));
                if let Some(at) = saved.get("fetchedAt").and_then(Value::as_f64) {
                    if at.is_finite() {
                        state.fetched_at = at as i64;
                    }
                }
            }
        }
        OpenRouterPrices {
            options,
            state: Mutex::new(state),
            reading: tokio::sync::Mutex::new(()),
            client: reqwest::Client::builder()
                .tls_backend_preconfigured(tls_config())
                .no_proxy()
                .timeout(Duration::from_secs(15))
                .build()
                .expect("the prices client builds"),
        }
    }

    fn now(&self) -> i64 {
        self.options.now.as_ref().map_or_else(now_ms, |now| now())
    }

    fn stale(&self) -> bool {
        self.now() - self.state.lock().unwrap().fetched_at >= DAY_MS
    }

    /// The price of an OpenRouter model id; read again first when the prices are a day old.
    pub async fn rate(&self, model: &str) -> Option<OverflowRates> {
        if self.stale() {
            let _reading = self.reading.lock().await;
            // A read that finished while this one waited counts.
            if self.stale() {
                self.read().await;
            }
        }
        self.state.lock().unwrap().rates.get(model).copied()
    }

    async fn read(&self) {
        if self.fetch_and_keep().await.is_err() {
            self.state.lock().unwrap().fetched_at = self.now() - DAY_MS + RETRY_MS;
        }
    }

    async fn fetch_and_keep(&self) -> Result<(), String> {
        let url = self.options.url.as_deref().unwrap_or(OPENROUTER_MODELS);
        let response = self
            .client
            .get(url)
            .header("accept", "application/json")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status().as_u16()));
        }
        let text = response.text().await.map_err(|e| e.to_string())?;
        let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        let rates = parse_open_router_models(&json);
        if rates.is_empty() {
            return Err("No prices".into());
        }
        let fetched_at = self.now();
        if let Some(file) = &self.options.file {
            // Only the prices are kept, in OpenRouter's own shape, so the file reads back the same way.
            let data: Vec<Value> = rates
                .iter()
                .map(|(id, r)| {
                    let mut pricing = serde_json::Map::new();
                    pricing.insert("prompt".into(), json!(r.input / 1_000_000.0));
                    pricing.insert("completion".into(), json!(r.output / 1_000_000.0));
                    if let Some(read) = r.cache_read {
                        pricing.insert("input_cache_read".into(), json!(read / 1_000_000.0));
                    }
                    if let Some(write) = r.cache_write {
                        pricing.insert("input_cache_write".into(), json!(write / 1_000_000.0));
                    }
                    json!({ "id": id, "pricing": pricing })
                })
                .collect();
            let saved = json!({ "fetchedAt": fetched_at, "models": { "data": data } });
            write_private(file, &saved.to_string()).map_err(|e| e.to_string())?;
        }
        let mut state = self.state.lock().unwrap();
        state.rates = rates;
        state.fetched_at = fetched_at;
        Ok(())
    }
}

/// Writes a file only its owner can read, through a temporary file renamed into place.
pub(crate) fn write_private(file: &std::path::Path, text: &str) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        create_private_dir(dir)?;
    }
    let mut temp = file.as_os_str().to_owned();
    temp.push(".tmp");
    let temp = PathBuf::from(temp);
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut handle = options.open(&temp)?;
        std::io::Write::write_all(&mut handle, text.as_bytes())?;
    }
    std::fs::rename(&temp, file)
}

/// `mkdir -p` with mode 0700 for what it creates.
pub(crate) fn create_private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}
