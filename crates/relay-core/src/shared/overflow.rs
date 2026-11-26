//! Port of `shared/overflow.ts`.
//!
//! Gateway overflow: when every subscription account is at a limit, Claude Messages requests go
//! to an API-key upstream instead of failing. A daily spending cap bounds what it costs.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::model_prices::{ResponseUsage, js_trim, response_cost, strip_bracket_suffix};
use super::planning::{local_date, wall_time};
use super::types::js;

/// Where an upstream's URL, auth header and model names come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApiUpstreamPreset {
    Anthropic,
    Openrouter,
    Deepseek,
    Kimi,
    KimiCn,
    Glm,
    GlmCn,
    Custom,
}

/// `OVERFLOW_PRESET_IDS`.
pub const OVERFLOW_PRESET_IDS: [ApiUpstreamPreset; 8] = [
    ApiUpstreamPreset::Anthropic,
    ApiUpstreamPreset::Openrouter,
    ApiUpstreamPreset::Deepseek,
    ApiUpstreamPreset::Kimi,
    ApiUpstreamPreset::KimiCn,
    ApiUpstreamPreset::Glm,
    ApiUpstreamPreset::GlmCn,
    ApiUpstreamPreset::Custom,
];

impl ApiUpstreamPreset {
    pub const fn as_str(self) -> &'static str {
        match self {
            ApiUpstreamPreset::Anthropic => "anthropic",
            ApiUpstreamPreset::Openrouter => "openrouter",
            ApiUpstreamPreset::Deepseek => "deepseek",
            ApiUpstreamPreset::Kimi => "kimi",
            ApiUpstreamPreset::KimiCn => "kimi-cn",
            ApiUpstreamPreset::Glm => "glm",
            ApiUpstreamPreset::GlmCn => "glm-cn",
            ApiUpstreamPreset::Custom => "custom",
        }
    }

    pub fn parse(id: &str) -> Option<Self> {
        OVERFLOW_PRESET_IDS.into_iter().find(|p| p.as_str() == id)
    }
}

/// How the key is sent: Anthropic's `x-api-key`, or `Authorization: Bearer`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ApiUpstreamAuth {
    #[serde(rename = "x-api-key")]
    XApiKey,
    #[serde(rename = "bearer")]
    Bearer,
}

/// The Claude model families a request is mapped by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OverflowFamily {
    Opus,
    Sonnet,
    Haiku,
}

/// The upstream's model id per Claude family, and the id used for anything else.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
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

impl OverflowModelMap {
    pub fn family(&self, family: OverflowFamily) -> Option<&str> {
        match family {
            OverflowFamily::Opus => self.opus.as_deref(),
            OverflowFamily::Sonnet => self.sonnet.as_deref(),
            OverflowFamily::Haiku => self.haiku.as_deref(),
        }
    }

    fn of(opus: &str, sonnet: &str, haiku: &str, default: Option<&str>) -> Self {
        Self {
            opus: Some(opus.into()),
            sonnet: Some(sonnet.into()),
            haiku: Some(haiku.into()),
            default: default.map(Into::into),
        }
    }
}

/// USD per million tokens. Missing cache rates are charged at the input rate.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverflowRates {
    #[serde(serialize_with = "js::ser_num")]
    pub input: f64,
    #[serde(serialize_with = "js::ser_num")]
    pub output: f64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "js::ser_opt_num"
    )]
    pub cache_read: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "js::ser_opt_num"
    )]
    pub cache_write: Option<f64>,
}

/// Prices the user entered, for upstreams Relay has no table for.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct UpstreamPrices {
    #[serde(serialize_with = "js::ser_num")]
    pub input: f64,
    #[serde(serialize_with = "js::ser_num")]
    pub output: f64,
}

/// One API-key upstream; its key is sealed in the vault, never kept here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiUpstream {
    pub id: String,
    pub label: String,
    pub preset: ApiUpstreamPreset,
    /// The base URL the request's own path (`/v1/messages`) is appended to.
    pub base_url: String,
    pub auth_style: ApiUpstreamAuth,
    /// An empty map sends the requested model as it is.
    pub model_map: OverflowModelMap,
    pub enabled: bool,
    /// Upstreams are tried lowest first.
    pub order: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prices: Option<UpstreamPrices>,
}

/// When overflow takes a request: `limited` only when every subscription account is at a limit;
/// `unavailable` also when none can answer for another reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OverflowTrigger {
    #[default]
    Limited,
    Unavailable,
}

/// The overflow setup, kept in proxy-pool.json beside the registry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverflowSettings {
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<OverflowTrigger>,
    /// Today's spend at which overflow stops; none means no cap.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "js::ser_opt_num"
    )]
    pub daily_cap_usd: Option<f64>,
    pub upstreams: Vec<ApiUpstream>,
}

/// The cap a new setup starts with.
pub const DEFAULT_OVERFLOW_CAP_USD: f64 = 5.0;

/// An upstream as the page sees it: no key, only its masked end.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverflowStatusUpstream {
    #[serde(flatten)]
    pub upstream: ApiUpstream,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_hint: Option<String>,
}

/// What the gateway page shows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverflowStatus {
    pub enabled: bool,
    pub trigger: OverflowTrigger,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "js::ser_opt_num"
    )]
    pub daily_cap_usd: Option<f64>,
    /// Overflow spend today in the planning time zone.
    #[serde(serialize_with = "js::ser_num")]
    pub spent_today_usd: f64,
    /// Today's spend reached the cap: overflow answers 429 until the day ends.
    pub cap_reached: bool,
    pub upstreams: Vec<OverflowStatusUpstream>,
}

/// A `number | null` that was present: `null` or the number as JSON writes it.
fn ser_cap<S: Serializer>(value: &Option<Option<f64>>, serializer: S) -> Result<S::Ok, S::Error> {
    js::ser_opt_num(&value.flatten(), serializer)
}

/// `Some(None)` for an explicit `null`, `None` for a missing key.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

/// What the page may change about overflow as a whole; a null cap removes it.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverflowConfigureInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<OverflowTrigger>,
    #[serde(
        default,
        deserialize_with = "present",
        serialize_with = "ser_cap",
        skip_serializing_if = "Option::is_none"
    )]
    pub daily_cap_usd: Option<Option<f64>>,
    /// Upstream ids, first tried first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<Vec<String>>,
}

/// An upstream added (no id; a key is needed) or changed (a key given replaces the saved one).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverflowUpstreamInput {
    pub label: String,
    pub preset: ApiUpstreamPreset,
    pub base_url: String,
    pub auth_style: ApiUpstreamAuth,
    pub model_map: OverflowModelMap,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prices: Option<UpstreamPrices>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

/// A one-token request's outcome from the page's Test button; never holds the key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverflowTestResult {
    pub ok: bool,
    /// The model the upstream was asked for.
    pub model: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "js::ser_opt_num"
    )]
    pub status: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// One preset's defaults.
#[derive(Debug, Clone, PartialEq)]
pub struct OverflowPreset {
    pub label: &'static str,
    pub base_url: &'static str,
    pub auth_style: ApiUpstreamAuth,
    pub model_map: OverflowModelMap,
}

/// `OVERFLOW_PRESETS[preset]`. Model ids and URLs from the providers' Claude Code guides (2026-11).
pub fn overflow_preset(preset: ApiUpstreamPreset) -> OverflowPreset {
    use ApiUpstreamAuth::{Bearer, XApiKey};
    let (label, base_url, auth_style, model_map) = match preset {
        // The same ids as Claude Code asks for: nothing to rewrite.
        ApiUpstreamPreset::Anthropic => (
            "Anthropic API",
            "https://api.anthropic.com",
            XApiKey,
            OverflowModelMap::default(),
        ),
        ApiUpstreamPreset::Openrouter => (
            "OpenRouter",
            "https://openrouter.ai/api",
            Bearer,
            OverflowModelMap::of(
                "anthropic/claude-opus-5.5",
                "anthropic/claude-sonnet-5.5",
                "anthropic/claude-haiku-5.5",
                None,
            ),
        ),
        ApiUpstreamPreset::Deepseek => (
            "DeepSeek",
            "https://api.deepseek.com/anthropic",
            XApiKey,
            OverflowModelMap::of(
                "deepseek-v4-pro",
                "deepseek-flash",
                "deepseek-flash",
                Some("deepseek-flash"),
            ),
        ),
        // K2 closes to new users from 2026-10-31 and retires at the end of 2026.
        ApiUpstreamPreset::Kimi => (
            "Kimi",
            "https://api.moonshot.ai/anthropic",
            Bearer,
            OverflowModelMap::of(
                "kimi-k3.1-pro",
                "kimi-k3.1-pro",
                "kimi-k3",
                Some("kimi-k3.1-pro"),
            ),
        ),
        ApiUpstreamPreset::KimiCn => (
            "Kimi (China)",
            "https://api.moonshot.cn/anthropic",
            Bearer,
            OverflowModelMap::of(
                "kimi-k3.1-pro",
                "kimi-k3.1-pro",
                "kimi-k3",
                Some("kimi-k3.1-pro"),
            ),
        ),
        ApiUpstreamPreset::Glm => (
            "Z.ai GLM",
            "https://api.z.ai/api/anthropic",
            Bearer,
            OverflowModelMap::of("glm-5.4", "glm-5.4", "glm-5.3-flash", Some("glm-5.4")),
        ),
        ApiUpstreamPreset::GlmCn => (
            "Zhipu GLM (China)",
            "https://open.bigmodel.cn/api/anthropic",
            Bearer,
            OverflowModelMap::of("glm-5.4", "glm-5.4", "glm-5.3-flash", Some("glm-5.4")),
        ),
        ApiUpstreamPreset::Custom => ("Custom", "", XApiKey, OverflowModelMap::default()),
    };
    OverflowPreset {
        label,
        base_url,
        auth_style,
        model_map,
    }
}

/// A model id without the `[1m]`-style suffix Claude Code adds for long context, lowercased.
fn bare(model: &str) -> String {
    js_trim(strip_bracket_suffix(model)).to_lowercase()
}

/// The Claude family a requested model belongs to, by name.
pub fn overflow_family(model: &str) -> Option<OverflowFamily> {
    let id = bare(model);
    if id.contains("opus") {
        Some(OverflowFamily::Opus)
    } else if id.contains("sonnet") {
        Some(OverflowFamily::Sonnet)
    } else if id.contains("haiku") {
        Some(OverflowFamily::Haiku)
    } else {
        None
    }
}

/// The model id the upstream is asked for: its family's mapping, else its default, else the
/// request's own.
pub fn overflow_model(model_map: &OverflowModelMap, requested: &str) -> String {
    let mapped = overflow_family(requested)
        .and_then(|family| model_map.family(family))
        .filter(|m| !m.is_empty())
        .or(model_map.default.as_deref());
    match mapped.map(js_trim) {
        Some(m) if !m.is_empty() => m.to_string(),
        _ => bare(requested),
    }
}

const fn rates(cache_read: f64, input: f64, output: f64) -> OverflowRates {
    OverflowRates {
        input,
        output,
        cache_read: Some(cache_read),
        cache_write: None,
    }
}

/// DeepSeek's off-peak prices; peak hours cost double.
fn deepseek_rates(id: &str) -> Option<OverflowRates> {
    match id {
        "deepseek-flash" => Some(rates(0.003, 0.15, 0.6)),
        "deepseek-v4-pro" => Some(rates(0.022, 0.66, 1.98)),
        _ => None,
    }
}

/// Z.ai's prices (GLM-5.4 is not on its page yet: enter its price by hand).
fn glm_rates(id: &str) -> Option<OverflowRates> {
    match id {
        "glm-5.3" => Some(rates(0.26, 1.4, 4.4)),
        "glm-5.3-flash" => Some(rates(0.03, 0.15, 0.5)),
        "glm-5.3-flashx" => Some(rates(0.075, 0.37, 1.25)),
        _ => None,
    }
}

/// DeepSeek's peak: 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday.
pub fn deepseek_peak(at: f64) -> bool {
    use chrono::{Datelike, Timelike};
    // `new Date(at)` truncates toward zero; beyond ±8.64e15 ms it is an Invalid Date.
    if !at.is_finite() || at.abs() > 8.64e15 {
        return false;
    }
    let Some(date) = chrono::DateTime::from_timestamp_millis(at.trunc() as i64) else {
        return false;
    };
    let day = date.weekday().num_days_from_sunday();
    let hour = date.hour();
    (1..=5).contains(&day) && ((1..4).contains(&hour) || (6..10).contains(&hour))
}

/// The table price of an upstream model at a time, for presets Relay has a table for.
pub fn preset_rates(preset: ApiUpstreamPreset, model: &str, at: f64) -> Option<OverflowRates> {
    let id = bare(model);
    match preset {
        ApiUpstreamPreset::Deepseek => {
            let base = deepseek_rates(&id)?;
            if !deepseek_peak(at) {
                return Some(base);
            }
            Some(OverflowRates {
                cache_read: base.cache_read.map(|r| r * 2.0),
                input: base.input * 2.0,
                output: base.output * 2.0,
                cache_write: None,
            })
        }
        ApiUpstreamPreset::Glm | ApiUpstreamPreset::GlmCn => glm_rates(&id),
        _ => None,
    }
}

/// The tokens an overflow answer reported.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverflowTokens {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "js::ser_opt_num"
    )]
    pub input: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "js::ser_opt_num"
    )]
    pub output: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "js::ser_opt_num"
    )]
    pub cache_read: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "js::ser_opt_num"
    )]
    pub cache_write: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "js::ser_opt_num"
    )]
    pub cache_write_1h: Option<f64>,
}

/// What one overflow answer cost, in USD; `None` when no price is known. Anthropic's own keys use
/// its list prices; others the user's prices, then the preset's table, then OpenRouter's
/// published ones (`fetched`). Missing cache rates are charged at the input rate.
pub fn overflow_cost(
    preset: ApiUpstreamPreset,
    prices: Option<&UpstreamPrices>,
    model: &str,
    tokens: &OverflowTokens,
    at: f64,
    fetched: Option<&OverflowRates>,
) -> Option<f64> {
    let input = tokens.input.unwrap_or(0.0);
    let output = tokens.output.unwrap_or(0.0);
    let cache_read = tokens.cache_read.unwrap_or(0.0);
    let cache_write = tokens.cache_write.unwrap_or(0.0);
    if preset == ApiUpstreamPreset::Anthropic {
        let usage = ResponseUsage {
            input,
            output,
            cache_write,
            cache_read,
            cache_write_1h: tokens.cache_write_1h,
            speed: None,
            geo: None,
        };
        if let Some(listed) = response_cost(model, &usage) {
            return Some(listed);
        }
    }
    let rates = prices
        .map(|p| OverflowRates {
            input: p.input,
            output: p.output,
            cache_read: None,
            cache_write: None,
        })
        .or_else(|| preset_rates(preset, model, at))
        .or(fetched.copied())?;
    Some(
        (input * rates.input
            + output * rates.output
            + cache_read * rates.cache_read.unwrap_or(rates.input)
            + cache_write * rates.cache_write.unwrap_or(rates.input))
            / 1_000_000.0,
    )
}

/// A masked key for the page: its first characters and last four, never the rest.
pub fn key_hint(key: &str) -> String {
    String::from_utf16_lossy(&key_hint_units(key))
}

/// `key_hint` as the UTF-16 code units JS makes: its last four units may split a surrogate pair,
/// which a Rust `String` cannot hold.
pub fn key_hint_units(key: &str) -> Vec<u16> {
    let trimmed = js_trim(key);
    let units: Vec<u16> = trimmed.encode_utf16().collect();
    if units.len() <= 8 {
        return "…".encode_utf16().collect();
    }
    let letters = trimmed.bytes().take_while(u8::is_ascii_alphabetic).count();
    let head = if (2..=4).contains(&letters) && trimmed.as_bytes().get(letters) == Some(&b'-') {
        &trimmed[..=letters]
    } else {
        ""
    };
    let mut out: Vec<u16> = format!("{head}…").encode_utf16().collect();
    out.extend_from_slice(&units[units.len() - 4..]);
    out
}

/// When the local day `at` falls on (in `time_zone`) started and ends, in ms.
pub fn local_day_bounds(at: f64, time_zone: &str) -> (f64, f64) {
    let today = local_date(at, time_zone);
    let start = wall_time(&today, "00:00", time_zone).unwrap_or(at - (at % 86_400_000.0));
    // Noon tomorrow in UTC terms always lands on tomorrow's local date, whatever the offset.
    let tomorrow = local_date(start + 36.0 * 3_600_000.0, time_zone);
    let end = wall_time(&tomorrow, "00:00", time_zone).unwrap_or(start + 86_400_000.0);
    (start, end)
}

/// Overflow spend in the local day `now` falls on, from the priced answers' times and costs.
pub fn spent_today(costs: &[(f64, f64)], now: f64, time_zone: &str) -> f64 {
    let (start, end) = local_day_bounds(now, time_zone);
    let sum = costs
        .iter()
        .filter(|(at, _)| *at >= start && *at < end)
        .fold(0.0, |sum, (_, cost)| sum + cost);
    js::round(sum * 1e6) / 1e6
}
