//! Claude requests sent with an account's OAuth token (`anthropic-upstream.ts`).

use crate::upstream_common::UsageExtractor;
use crate::types::TokenTally;
use http::{HeaderMap, HeaderValue};
use serde_json::Value;

pub const DEFAULT_ANTHROPIC_URL: &str = "https://api.anthropic.com";
const OAUTH_BETA: &str = "oauth-2025-04-20";

/// Anthropic reports usage twice in a stream: `message_start` carries the input side and a
/// first output count, `message_delta` the running (cumulative) output count. Every figure
/// replaces the last one, so the answer is the final state, not a sum.
#[derive(Default)]
pub struct AnthropicUsageExtractor {
    tally: TokenTally,
    seen: bool,
}

impl AnthropicUsageExtractor {
    pub fn new() -> Self {
        Self::default()
    }
}

/// A finite, non-negative JSON number.
pub(crate) fn count(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite() && *v >= 0.0)
}

/// `event?.message?.usage ?? event?.usage`, when it is an object.
pub(crate) fn usage_of<'a>(event: &'a Value, nested: &str) -> Option<&'a Value> {
    let inner = event
        .get(nested)
        .and_then(|m| m.get("usage"))
        .filter(|u| !u.is_null());
    inner
        .or_else(|| event.get("usage"))
        .filter(|u| u.is_object())
}

impl UsageExtractor for AnthropicUsageExtractor {
    fn on_event(&mut self, data: &Value) {
        let Some(usage) = usage_of(data, "message") else {
            return;
        };
        let mut take = |slot: &mut Option<f64>, value: Option<&Value>| {
            if let Some(v) = count(value) {
                *slot = Some(v);
                self.seen = true;
            }
        };
        take(&mut self.tally.input, usage.get("input_tokens"));
        take(&mut self.tally.output, usage.get("output_tokens"));
        take(&mut self.tally.cache_read, usage.get("cache_read_input_tokens"));
        take(
            &mut self.tally.cache_write,
            usage.get("cache_creation_input_tokens"),
        );
        take(
            &mut self.tally.cache_write_1h,
            usage
                .get("cache_creation")
                .and_then(|c| c.get("ephemeral_1h_input_tokens")),
        );
    }

    fn result(&self) -> Option<TokenTally> {
        self.seen.then_some(self.tally)
    }
}

/// The client's own betas plus the one OAuth tokens need.
pub fn merge_betas(existing: &HeaderMap) -> String {
    let mut betas: Vec<String> = Vec::new();
    for value in existing.get_all("anthropic-beta") {
        for part in value.to_str().unwrap_or("").split(',') {
            let part = part.trim();
            if !part.is_empty() && !betas.iter().any(|b| b == part) {
                betas.push(part.to_string());
            }
        }
    }
    if !betas.iter().any(|b| b == OAUTH_BETA) {
        betas.push(OAUTH_BETA.to_string());
    }
    betas.join(",")
}

/// The headers an Anthropic request goes with: the client's (sanitized), the account's bearer
/// token, the betas plus OAuth's, and an API version when the client sent none.
pub fn anthropic_headers(client: &HeaderMap, token: &str) -> HeaderMap {
    let mut headers = crate::upstream_common::sanitize_request_headers(client);
    if let Ok(value) = HeaderValue::from_str(&format!("Bearer {token}")) {
        headers.insert(http::header::AUTHORIZATION, value);
    }
    if let Ok(value) = HeaderValue::from_str(&merge_betas(client)) {
        headers.insert("anthropic-beta", value);
    }
    if !headers.contains_key("anthropic-version") {
        headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
    }
    headers
}
