//! Codex and OpenAI requests (`codex-upstream.ts`).

use crate::anthropic_upstream::{count, usage_of};
use crate::types::TokenTally;
use crate::upstream_common::{UsageExtractor, sanitize_request_headers};
use http::{HeaderMap, HeaderValue};
use serde_json::Value;

pub const DEFAULT_CODEX_URL: &str = "https://chatgpt.com/backend-api/codex";
pub const DEFAULT_OPENAI_URL: &str = "https://api.openai.com/v1";

/// OpenAI style usage: the Responses API reports it in `response.completed`, Chat Completions
/// in the last chunk. Cached tokens are part of the prompt count there, so they are split out.
#[derive(Default)]
pub struct CodexUsageExtractor {
    tally: Option<TokenTally>,
}

impl CodexUsageExtractor {
    pub fn new() -> Self {
        Self::default()
    }
}

impl UsageExtractor for CodexUsageExtractor {
    fn on_event(&mut self, data: &Value) {
        let Some(usage) = usage_of(data, "response") else {
            return;
        };
        let total = count(usage.get("input_tokens")).or_else(|| count(usage.get("prompt_tokens")));
        let output =
            count(usage.get("output_tokens")).or_else(|| count(usage.get("completion_tokens")));
        let cached = count(
            usage
                .get("input_tokens_details")
                .and_then(|d| d.get("cached_tokens")),
        )
        .or_else(|| {
            count(
                usage
                    .get("prompt_tokens_details")
                    .and_then(|d| d.get("cached_tokens")),
            )
        })
        .unwrap_or(0.0);
        if total.is_none() && output.is_none() {
            return;
        }
        self.tally = Some(TokenTally {
            input: Some((total.unwrap_or(0.0) - cached).max(0.0)),
            output: Some(output.unwrap_or(0.0)),
            cache_read: Some(cached),
            ..Default::default()
        });
    }

    fn result(&self) -> Option<TokenTally> {
        self.tally
    }
}

/// The headers a Codex/OpenAI request goes with: the client's (sanitized), the bearer token,
/// and a ChatGPT sign-in's account id.
pub fn codex_headers(
    client: &HeaderMap,
    token: &str,
    chatgpt_account_id: Option<&str>,
) -> HeaderMap {
    let mut headers = sanitize_request_headers(client);
    if let Ok(value) = HeaderValue::from_str(&format!("Bearer {token}")) {
        headers.insert(http::header::AUTHORIZATION, value);
    }
    if let Some(Ok(value)) = chatgpt_account_id.map(HeaderValue::from_str) {
        headers.insert("chatgpt-account-id", value);
    }
    headers
}
