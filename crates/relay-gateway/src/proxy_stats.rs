//! The gateway's counters and its live request feed (`proxy-stats.ts`).

use crate::js::{now_ms, round, slice_units, units};
use crate::types::{
    AccountTokenMetrics, ExtraUsage, ExtraUsageKind, ProxyMetrics, ProxyRequestLog, TokenTally,
};
use indexmap::IndexMap;
use std::collections::VecDeque;

const MAX_ERROR_LENGTH: usize = 500;
/// How many requests the live feed keeps.
pub const REQUEST_LOG_SIZE: usize = 40;
const MAX_MODEL_LENGTH: usize = 80;

/// Counters per account id; the keys are the registry's accounts, so the maps stay small.
#[derive(Default)]
pub struct ProxyStats {
    total_requests: u64,
    requests_by_account: IndexMap<String, u64>,
    tokens_by_account: IndexMap<String, AccountTokenMetrics>,
    last_error: Option<String>,
    last_error_at: Option<i64>,
    active_requests: u64,
    prompt_cache_hits: u64,
    last_account_id: Option<String>,
    /// Newest last; trimmed to `REQUEST_LOG_SIZE`.
    log: VecDeque<ProxyRequestLog>,
    /// The latest extra-usage answer per account: billed beyond the plan, or needing it.
    extra_usage: IndexMap<String, ExtraUsage>,
}

impl ProxyStats {
    pub fn new() -> Self {
        Self::default()
    }

    /// Stats whose feed starts with the requests a log kept across a restart (newest last).
    pub fn with_recent(recent: Vec<ProxyRequestLog>) -> Self {
        let skip = recent.len().saturating_sub(REQUEST_LOG_SIZE);
        ProxyStats {
            log: recent.into_iter().skip(skip).collect(),
            ..Self::default()
        }
    }

    /// An account's answer was billed as extra usage, or a request needed extra usage it lacks.
    pub fn record_extra_usage(&mut self, account_id: &str, kind: ExtraUsageKind) {
        // A billed answer is the one to tell about: it cost money.
        if kind == ExtraUsageKind::Required
            && self
                .extra_usage
                .get(account_id)
                .is_some_and(|e| e.kind == ExtraUsageKind::Billed)
        {
            return;
        }
        self.extra_usage.insert(
            account_id.to_string(),
            ExtraUsage {
                at: now_ms(),
                kind,
            },
        );
    }

    /// One request's outcome for the live feed; answers the entry as kept (for the request log).
    pub fn record_log(&mut self, mut entry: ProxyRequestLog) -> ProxyRequestLog {
        if let Some(model) = entry.model.as_mut() {
            if units(model) > MAX_MODEL_LENGTH {
                *model = slice_units(model, MAX_MODEL_LENGTH).to_string();
            }
        }
        self.log.push_back(entry.clone());
        while self.log.len() > REQUEST_LOG_SIZE {
            self.log.pop_front();
        }
        entry
    }

    /// The feed, newest first.
    pub fn recent(&self) -> Vec<ProxyRequestLog> {
        self.log.iter().rev().cloned().collect()
    }

    /// A request came in; pair with `request_ended`.
    pub fn request_started(&mut self) {
        self.active_requests += 1;
    }

    pub fn request_ended(&mut self) {
        self.active_requests = self.active_requests.saturating_sub(1);
    }

    pub fn record_request(&mut self, account_id: &str) {
        self.last_account_id = Some(account_id.to_string());
        self.total_requests += 1;
        *self
            .requests_by_account
            .entry(account_id.to_string())
            .or_insert(0) += 1;
    }

    pub fn record_tokens(&mut self, account_id: &str, tokens: &TokenTally) {
        let count = |value: Option<f64>| match value {
            Some(v) if v.is_finite() && v > 0.0 => v,
            _ => 0.0,
        };
        let current = self
            .tokens_by_account
            .entry(account_id.to_string())
            .or_default();
        current.input += count(tokens.input);
        current.output += count(tokens.output);
        current.cache_read += count(tokens.cache_read);
        if count(tokens.cache_read) > 0.0 {
            self.prompt_cache_hits += 1;
        }
        current.cache_write += count(tokens.cache_write);
    }

    pub fn record_error(&mut self, error: &str) {
        // Only the latest error is kept, and capped, so a hostile upstream cannot grow it.
        self.last_error = Some(if units(error) > MAX_ERROR_LENGTH {
            format!("{}…", slice_units(error, MAX_ERROR_LENGTH))
        } else {
            error.to_string()
        });
        self.last_error_at = Some(now_ms());
    }

    pub fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }

    pub fn active_requests(&self) -> u64 {
        self.active_requests
    }

    pub fn metrics(&self, active_sessions_count: usize) -> ProxyMetrics {
        let mut total_prompt = 0.0;
        let mut total_cache_read = 0.0;
        for v in self.tokens_by_account.values() {
            // Everything the model was sent: read from the cache, written to it, or neither.
            total_prompt += v.input + v.cache_read + v.cache_write;
            total_cache_read += v.cache_read;
        }
        let cache_hit_ratio = if total_prompt > 0.0 {
            round(total_cache_read / total_prompt * 1000.0) / 1000.0
        } else {
            0.0
        };
        ProxyMetrics {
            total_requests: self.total_requests,
            active_sessions: active_sessions_count,
            requests_by_account: self.requests_by_account.clone(),
            tokens_by_account: self.tokens_by_account.clone(),
            cache_hit_ratio,
            active_requests: self.active_requests,
            prompt_cache_hits: self.prompt_cache_hits,
            last_account_id: self.last_account_id.clone(),
            extra_usage: (!self.extra_usage.is_empty()).then(|| self.extra_usage.clone()),
            last_error: self.last_error.clone(),
            last_error_at: self.last_error_at,
        }
    }

    pub fn reset(&mut self) {
        let active = self.active_requests;
        *self = ProxyStats {
            active_requests: active,
            ..Self::default()
        };
    }
}
