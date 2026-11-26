//! The JSON the gateway reads and writes, with the field names (and order) of
//! `shared/types.ts`, `shared/proxy-types.ts` and `shared/overflow.ts`. Inputs accept a full
//! `Account` / `AccountUsage` and keep only what the gateway uses, so callers convert through
//! `serde_json`.

use crate::js::{ser_f64, ser_opt_f64};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// `AccountProvider`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    #[default]
    Claude,
    Codex,
    Antigravity,
    Gemini,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
            Provider::Antigravity => "antigravity",
            Provider::Gemini => "gemini",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPlanning {
    #[serde(default)]
    pub plan: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_f64"
    )]
    pub capacity_weight: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountAuth {
    #[serde(default)]
    pub logged_in: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_uuid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscription: Option<String>,
}

/// The parts of `Account` the gateway reads.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<Provider>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cooldown_until: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning: Option<AccountPlanning>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_f64"
    )]
    pub switch_at_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<AccountAuth>,
}

impl Account {
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Self {
        Account {
            id: id.into(),
            name: name.into(),
            ..Default::default()
        }
    }

    /// `account.provider ?? "claude"`.
    pub fn provider(&self) -> Provider {
        self.provider.unwrap_or_default()
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    #[serde(serialize_with = "ser_f64")]
    pub used_percent: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_at: Option<String>,
}

impl UsageWindow {
    pub fn new(used_percent: f64, resets_at: Option<String>) -> Self {
        UsageWindow {
            used_percent,
            resets_at,
            ..Default::default()
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelWindow {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub label: String,
    #[serde(serialize_with = "ser_f64")]
    pub used_percent: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum UsageStatus {
    #[default]
    Idle,
    Loading,
    Ready,
    Error,
}

/// The parts of `AccountUsage` the gateway reads.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsage {
    #[serde(default)]
    pub account_id: String,
    #[serde(default)]
    pub status: UsageStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub five_hour: Option<UsageWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seven_day: Option<UsageWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_windows: Option<Vec<ModelWindow>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_at: Option<String>,
    #[serde(default)]
    pub stale: bool,
}

impl AccountUsage {
    /// A `ready`, fresh reading.
    pub fn ready(
        account_id: impl Into<String>,
        five_hour: Option<UsageWindow>,
        seven_day: Option<UsageWindow>,
    ) -> Self {
        AccountUsage {
            account_id: account_id.into(),
            status: UsageStatus::Ready,
            five_hour,
            seven_day,
            ..Default::default()
        }
    }

    pub fn model_windows(&self) -> &[ModelWindow] {
        self.model_windows.as_deref().unwrap_or(&[])
    }
}

pub type UsageMap = HashMap<String, AccountUsage>;

/// What the router weighs: the pool's accounts (in its order) and their last read limits.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    #[serde(default)]
    pub accounts: Vec<Account>,
    #[serde(default, alias = "usage")]
    pub usage_map: UsageMap,
}

/// `RoutingStrategy`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum RoutingStrategy {
    #[default]
    SoonestReset,
    Balanced,
    StrictPriority,
}

/// `ProxyStatus` (the gateway's run state).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyRunStatus {
    Stopped,
    Starting,
    Running,
    Error,
}

/// `ProxyConfig`; a missing field takes `DEFAULT_PROXY_CONFIG`'s value.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProxyConfig {
    pub enabled: bool,
    pub port: u16,
    pub host: String,
    #[serde(serialize_with = "ser_f64")]
    pub affinity_ttl_seconds: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affinity_revision: Option<u32>,
    pub routing_strategy: RoutingStrategy,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_order: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excluded_account_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subagent_overflow: Option<bool>,
    /// Kept as written: client binding is the host's business (`proxy-clients.ts`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_bindings: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overflow: Option<OverflowSettings>,
}

/// `DEFAULT_PROXY_CONFIG`.
impl Default for ProxyConfig {
    fn default() -> Self {
        ProxyConfig {
            enabled: false,
            port: 8317,
            host: "127.0.0.1".into(),
            // The lifetime of Claude Code's cache on a subscription; OpenAI's default is 30 minutes.
            affinity_ttl_seconds: 3_600.0,
            affinity_revision: None,
            routing_strategy: RoutingStrategy::SoonestReset,
            api_key: None,
            account_order: None,
            excluded_account_ids: None,
            subagent_overflow: None,
            client_bindings: None,
            overflow: None,
        }
    }
}

/// The lifetime Relay saved by default up to 0.20.0: the API's five-minute cache, not Claude Code's hour.
pub const LEGACY_AFFINITY_TTL_SECONDS: f64 = 300.0;
/// The revision of the default: a saved lifetime written under an older one may be the old default.
pub const AFFINITY_REVISION: u32 = 1;

/// A saved lifetime that equals the old default was never chosen: it moves to the new one, once.
/// A lifetime saved under the current revision is the user's and stays, five minutes included.
pub fn current_affinity_ttl(saved: Option<f64>, revision: Option<u32>) -> Option<f64> {
    let saved = saved?;
    if revision.unwrap_or(0) >= AFFINITY_REVISION {
        return Some(saved);
    }
    Some(if saved == LEGACY_AFFINITY_TTL_SECONDS {
        ProxyConfig::default().affinity_ttl_seconds
    } else {
        saved
    })
}

/// Where an upstream's URL, auth header and model names come from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ApiUpstreamPreset {
    #[serde(rename = "anthropic")]
    Anthropic,
    #[serde(rename = "openrouter")]
    OpenRouter,
    #[serde(rename = "deepseek")]
    DeepSeek,
    #[serde(rename = "kimi")]
    Kimi,
    #[serde(rename = "kimi-cn")]
    KimiCn,
    #[serde(rename = "glm")]
    Glm,
    #[serde(rename = "glm-cn")]
    GlmCn,
    #[serde(rename = "custom")]
    Custom,
}

/// `OVERFLOW_PRESET_IDS`.
pub const OVERFLOW_PRESET_IDS: [ApiUpstreamPreset; 8] = [
    ApiUpstreamPreset::Anthropic,
    ApiUpstreamPreset::OpenRouter,
    ApiUpstreamPreset::DeepSeek,
    ApiUpstreamPreset::Kimi,
    ApiUpstreamPreset::KimiCn,
    ApiUpstreamPreset::Glm,
    ApiUpstreamPreset::GlmCn,
    ApiUpstreamPreset::Custom,
];

/// How the key is sent: Anthropic's `x-api-key`, or `Authorization: Bearer`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ApiUpstreamAuth {
    #[serde(rename = "x-api-key")]
    XApiKey,
    #[serde(rename = "bearer")]
    Bearer,
}

/// The upstream's model id per Claude family; an empty map sends the requested model as it is.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OverflowModelMap {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opus: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sonnet: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub haiku: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
}

/// Prices the user entered, USD per million tokens.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserPrices {
    #[serde(serialize_with = "ser_f64")]
    pub input: f64,
    #[serde(serialize_with = "ser_f64")]
    pub output: f64,
}

/// One API-key upstream; its key is sealed in the vault, never kept here.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApiUpstream {
    pub id: String,
    pub label: String,
    pub preset: ApiUpstreamPreset,
    pub base_url: String,
    pub auth_style: ApiUpstreamAuth,
    pub model_map: OverflowModelMap,
    pub enabled: bool,
    #[serde(serialize_with = "ser_f64")]
    pub order: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prices: Option<UserPrices>,
}

/// When overflow takes a request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OverflowTrigger {
    Limited,
    Unavailable,
}

/// The overflow setup, kept in proxy-pool.json beside the registry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OverflowSettings {
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<OverflowTrigger>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_f64"
    )]
    pub daily_cap_usd: Option<f64>,
    pub upstreams: Vec<ApiUpstream>,
}

/// USD per million tokens. Missing cache rates are charged at the input rate.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverflowRates {
    #[serde(serialize_with = "ser_f64")]
    pub input: f64,
    #[serde(serialize_with = "ser_f64")]
    pub output: f64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_f64"
    )]
    pub cache_read: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_f64"
    )]
    pub cache_write: Option<f64>,
}

/// One priced overflow answer, for the daily cap.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct OverflowCost {
    pub at: i64,
    #[serde(serialize_with = "ser_f64")]
    pub cost: f64,
}

/// What the gateway page shows of the overflow: no key, only its masked end.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverflowStatus {
    pub enabled: bool,
    pub trigger: OverflowTrigger,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_f64"
    )]
    pub daily_cap_usd: Option<f64>,
    #[serde(serialize_with = "ser_f64")]
    pub spent_today_usd: f64,
    pub cap_reached: bool,
    pub upstreams: Vec<OverflowUpstreamStatus>,
}

/// An upstream as the page lists it (output only: its fields, then the masked key).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverflowUpstreamStatus {
    #[serde(flatten)]
    pub upstream: ApiUpstream,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_hint: Option<String>,
}

/// The tokens an answer reported; `cache_write_1h` is the 1-hour part of `cache_write`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenTally {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_f64"
    )]
    pub input: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_f64"
    )]
    pub output: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_f64"
    )]
    pub cache_read: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_f64"
    )]
    pub cache_write: Option<f64>,
    #[serde(
        rename = "cacheWrite1h",
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_f64"
    )]
    pub cache_write_1h: Option<f64>,
}

/// `ProxyPickReason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProxyPickReason {
    Bound,
    SoonestReset,
    Balanced,
    Priority,
    Only,
    Overflow,
}

/// `ProxyMoveReason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyMoveReason {
    Limit,
    Cold,
    Drain,
    Rebalance,
}

impl ProxyMoveReason {
    pub fn as_str(self) -> &'static str {
        match self {
            ProxyMoveReason::Limit => "limit",
            ProxyMoveReason::Cold => "cold",
            ProxyMoveReason::Drain => "drain",
            ProxyMoveReason::Rebalance => "rebalance",
        }
    }
}

/// Why a request went to its account.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
        ProxyPick {
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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CacheMissReason {
    Account,
    Model,
    Expired,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct CacheMiss {
    pub reason: CacheMissReason,
    #[serde(serialize_with = "ser_f64")]
    pub tokens: f64,
}

/// One request the gateway answered (or passed on). Fields in the order the request log
/// writes them (`cleanEntry`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRequestLog {
    pub at: i64,
    pub status: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_class: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failover: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_f64"
    )]
    pub cost: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub miss: Option<CacheMiss>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub affinity: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pick: Option<ProxyPick>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<TokenTally>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct MoveCost {
    #[serde(serialize_with = "ser_f64")]
    pub dollars: f64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_f64"
    )]
    pub percent: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct LastMiss {
    pub at: i64,
    pub reason: CacheMissReason,
    #[serde(serialize_with = "ser_f64")]
    pub tokens: f64,
}

/// A session through the gateway, as its prompt cache stands.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxySessionView {
    pub id: String,
    pub account_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub last_at: i64,
    #[serde(serialize_with = "ser_f64")]
    pub prefix_tokens: f64,
    pub ttl_ms: i64,
    pub requests: u64,
    pub subagents: u64,
    pub misses: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_miss: Option<LastMiss>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub move_cost: Option<MoveCost>,
}

/// One prompt that made far more requests or subagents than a prompt usually does.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyLoopAlarm {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub since: i64,
    pub last_at: i64,
    pub requests: u64,
    pub subagents: u64,
}

/// One request class's share of today's gateway traffic.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyClassShare {
    pub request_class: String,
    pub requests: u64,
    #[serde(serialize_with = "ser_f64")]
    pub tokens: f64,
    #[serde(serialize_with = "ser_f64")]
    pub cost: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxySessionState {
    pub session_key: String,
    pub account_id: String,
    pub assigned_at: i64,
    pub last_active_at: i64,
    pub request_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moved_at: Option<i64>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountTokenMetrics {
    #[serde(serialize_with = "ser_f64")]
    pub input: f64,
    #[serde(serialize_with = "ser_f64")]
    pub output: f64,
    #[serde(serialize_with = "ser_f64")]
    pub cache_read: f64,
    #[serde(serialize_with = "ser_f64")]
    pub cache_write: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExtraUsageKind {
    Billed,
    Required,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct ExtraUsage {
    pub at: i64,
    pub kind: ExtraUsageKind,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyMetrics {
    pub total_requests: u64,
    pub active_sessions: usize,
    pub requests_by_account: IndexMap<String, u64>,
    pub tokens_by_account: IndexMap<String, AccountTokenMetrics>,
    #[serde(serialize_with = "ser_f64")]
    pub cache_hit_ratio: f64,
    pub active_requests: u64,
    pub prompt_cache_hits: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_usage: Option<IndexMap<String, ExtraUsage>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyState {
    pub status: ProxyRunStatus,
    pub port: u16,
    pub host: String,
    pub endpoint_url: String,
    pub active_sessions_count: usize,
    pub uptime_seconds: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A window an answer reported.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveWindow {
    #[serde(serialize_with = "ser_f64")]
    pub used_percent: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
}

/// A window of one model family an answer reported.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveModelWindow {
    pub model: String,
    pub weekly: bool,
    #[serde(serialize_with = "ser_f64")]
    pub used_percent: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
}

/// An account's windows as the provider reported them on an answer.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveLimits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub five_hour: Option<LiveWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seven_day: Option<LiveWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<LiveModelWindow>>,
}
