//! Port of `shared/proxy-types.ts`.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use super::overflow::OverflowSettings;
use super::types::js::{self, JsMap, Num};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyStatus {
    Stopped,
    Starting,
    Running,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RoutingStrategy {
    #[default]
    SoonestReset,
    Balanced,
    StrictPriority,
}

/// The clients Relay can point at the gateway by writing their settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProxyClientId {
    ClaudeCode,
    Codex,
    Omp,
}

impl ProxyClientId {
    pub const fn as_str(self) -> &'static str {
        match self {
            ProxyClientId::ClaudeCode => "claude-code",
            ProxyClientId::Codex => "codex",
            ProxyClientId::Omp => "omp",
        }
    }
}

/// A bound client's saved values: `None` means the key was not there (`null` in JSON).
pub type ClientBindings = IndexMap<ProxyClientId, JsMap<Option<String>>>;

fn default_affinity_ttl() -> i64 {
    DEFAULT_AFFINITY_TTL_SECONDS
}

/// The gateway's settings. The first six fields are `settings.proxy` in state.json, in the order
/// of `proxyConfigSchema` (electron/core/store.ts); the rest live in proxy-pool.json.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    pub enabled: bool,
    pub port: i64,
    pub host: String,
    /// How long an idle session stays on its account (the prompt cache belongs to the account).
    #[serde(default = "default_affinity_ttl")]
    pub affinity_ttl_seconds: i64,
    #[serde(default)]
    pub routing_strategy: RoutingStrategy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// Which default the saved lifetime was written under; kept in proxy-pool.json.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub affinity_revision: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_order: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excluded_account_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_overflow: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_bindings: Option<ClientBindings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overflow: Option<OverflowSettings>,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        default_proxy_config()
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyTokens {
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "js::ser_opt_num")]
    pub input: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "js::ser_opt_num")]
    pub output: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "js::ser_opt_num")]
    pub cache_read: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "js::ser_opt_num")]
    pub cache_write: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "js::ser_opt_num")]
    pub cache_write_1h: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CacheMiss {
    pub reason: CacheMissReason,
    #[serde(serialize_with = "js::ser_num")]
    pub tokens: f64,
}

/// One request the gateway answered (or passed on), newest first in the status.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRequestLog {
    #[serde(serialize_with = "js::ser_num")]
    pub at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(serialize_with = "js::ser_num")]
    pub status: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failover: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub affinity: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "js::ser_opt_num")]
    pub ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_class: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<ProxyTokens>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "js::ser_opt_num")]
    pub cost: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub miss: Option<CacheMiss>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pick: Option<ProxyPick>,
}

/// How the gateway chose an account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProxyPickReason {
    Bound,
    SoonestReset,
    Balanced,
    Priority,
    Only,
    Overflow,
}

/// Why a session left its account on purpose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyMoveReason {
    Limit,
    Cold,
    Drain,
    Rebalance,
}

/// Why a request went to its account.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyPick {
    pub reason: ProxyPickReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nearly_full: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_sign_in: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overflow: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_waiting: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moved: Option<ProxyMoveReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

impl ProxyPick {
    pub fn new(reason: ProxyPickReason) -> Self {
        Self {
            reason,
            nearly_full: None,
            no_sign_in: None,
            after: None,
            overflow: None,
            bound_waiting: None,
            moved: None,
            from: None,
        }
    }
}

/// Why a session's cached prompt was written again instead of read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CacheMissReason {
    Account,
    Model,
    Expired,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LastMiss {
    #[serde(serialize_with = "js::ser_num")]
    pub at: f64,
    pub reason: CacheMissReason,
    #[serde(serialize_with = "js::ser_num")]
    pub tokens: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MoveCost {
    #[serde(serialize_with = "js::ser_num")]
    pub dollars: f64,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "js::ser_opt_num")]
    pub percent: Option<f64>,
}

/// A session through the gateway, as its prompt cache stands.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxySessionView {
    pub id: String,
    pub account_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(serialize_with = "js::ser_num")]
    pub last_at: f64,
    #[serde(serialize_with = "js::ser_num")]
    pub prefix_tokens: f64,
    #[serde(serialize_with = "js::ser_num")]
    pub ttl_ms: f64,
    #[serde(serialize_with = "js::ser_num")]
    pub requests: f64,
    #[serde(serialize_with = "js::ser_num")]
    pub subagents: f64,
    #[serde(serialize_with = "js::ser_num")]
    pub misses: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_miss: Option<LastMiss>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub move_cost: Option<MoveCost>,
}

/// One prompt that made far more requests or subagents than a prompt usually does.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyLoopAlarm {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(serialize_with = "js::ser_num")]
    pub since: f64,
    #[serde(serialize_with = "js::ser_num")]
    pub last_at: f64,
    #[serde(serialize_with = "js::ser_num")]
    pub requests: f64,
    #[serde(serialize_with = "js::ser_num")]
    pub subagents: f64,
}

/// One request class's share of today's gateway traffic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyClassShare {
    pub request_class: String,
    #[serde(serialize_with = "js::ser_num")]
    pub requests: f64,
    #[serde(serialize_with = "js::ser_num")]
    pub tokens: f64,
    #[serde(serialize_with = "js::ser_num")]
    pub cost: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxySessionState {
    pub session_key: String,
    pub account_id: String,
    #[serde(serialize_with = "js::ser_num")]
    pub assigned_at: f64,
    #[serde(serialize_with = "js::ser_num")]
    pub last_active_at: f64,
    #[serde(serialize_with = "js::ser_num")]
    pub request_count: f64,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "js::ser_opt_num")]
    pub moved_at: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountTokenMetrics {
    #[serde(serialize_with = "js::ser_num")]
    pub input: f64,
    #[serde(serialize_with = "js::ser_num")]
    pub output: f64,
    #[serde(serialize_with = "js::ser_num")]
    pub cache_read: f64,
    #[serde(serialize_with = "js::ser_num")]
    pub cache_write: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExtraUsageKind {
    Billed,
    Required,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtraUsage {
    #[serde(serialize_with = "js::ser_num")]
    pub at: f64,
    pub kind: ExtraUsageKind,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyMetrics {
    #[serde(serialize_with = "js::ser_num")]
    pub total_requests: f64,
    #[serde(serialize_with = "js::ser_num")]
    pub active_sessions: f64,
    pub requests_by_account: JsMap<Num>,
    pub tokens_by_account: JsMap<AccountTokenMetrics>,
    #[serde(serialize_with = "js::ser_num")]
    pub cache_hit_ratio: f64,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "js::ser_opt_num")]
    pub active_requests: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "js::ser_opt_num")]
    pub prompt_cache_hits: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_usage: Option<JsMap<ExtraUsage>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "js::ser_opt_num")]
    pub last_error_at: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyState {
    pub status: ProxyStatus,
    #[serde(serialize_with = "js::ser_num")]
    pub port: f64,
    pub host: String,
    pub endpoint_url: String,
    #[serde(serialize_with = "js::ser_num")]
    pub active_sessions_count: f64,
    #[serde(serialize_with = "js::ser_num")]
    pub uptime_seconds: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `DEFAULT_PROXY_CONFIG.port`.
pub const DEFAULT_PROXY_PORT: i64 = 8317;
/// `DEFAULT_PROXY_CONFIG.host`.
pub const DEFAULT_PROXY_HOST: &str = "127.0.0.1";
/// The lifetime of Claude Code's cache on a subscription; OpenAI's default is 30 minutes.
pub const DEFAULT_AFFINITY_TTL_SECONDS: i64 = 3_600;

/// `DEFAULT_PROXY_CONFIG`.
pub fn default_proxy_config() -> ProxyConfig {
    ProxyConfig {
        enabled: false,
        port: DEFAULT_PROXY_PORT,
        host: DEFAULT_PROXY_HOST.to_string(),
        affinity_ttl_seconds: DEFAULT_AFFINITY_TTL_SECONDS,
        routing_strategy: RoutingStrategy::SoonestReset,
        api_key: None,
        affinity_revision: None,
        account_order: None,
        excluded_account_ids: None,
        subagent_overflow: None,
        client_bindings: None,
        overflow: None,
    }
}

/// The lifetime Relay saved by default up to 0.20.0: the API's five-minute cache.
pub const LEGACY_AFFINITY_TTL_SECONDS: i64 = 300;
/// The revision of the default: a saved lifetime written under an older one may be the old default.
pub const AFFINITY_REVISION: i64 = 1;

/// A saved lifetime that equals the old default was never chosen: it moves to the new one, once.
pub fn current_affinity_ttl(saved: Option<i64>, revision: Option<i64>) -> Option<i64> {
    let saved = saved?;
    if revision.unwrap_or(0) >= AFFINITY_REVISION {
        return Some(saved);
    }
    Some(if saved == LEGACY_AFFINITY_TTL_SECONDS {
        DEFAULT_AFFINITY_TTL_SECONDS
    } else {
        saved
    })
}
