//! What the Proxy Gateway page shows and what it may change (`proxy-status.ts`): the status
//! shape, the pool's order, the client key, and the overflow setup's validation.

use crate::js::{parse_date, round};
use crate::model_prices::{ResponseUsage, response_cost};
use crate::proxy_insights::GatewayInsights;
use crate::proxy_router::Cooldown;
use crate::proxy_url::{GATEWAY_HOST_ERROR, gateway_host_allowed, is_loopback_host};
use crate::types::{
    Account, AccountTokenMetrics, AccountUsage, ApiUpstream, ExtraUsageKind, MoveCost,
    OverflowSettings, OverflowStatus, OverflowTrigger, OverflowUpstreamStatus, ProxyClassShare,
    ProxyConfig, ProxyLoopAlarm, ProxyMetrics, ProxyPickReason, ProxyRequestLog, ProxySessionView,
    RoutingStrategy, UsageMap, UsageWindow,
};
use base64::Engine;
use indexmap::IndexMap;
use regex::Regex;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::LazyLock;

/// The prefix every client key starts with, so a key pasted somewhere is recognised as Relay's.
pub const PROXY_KEY_PREFIX: &str = "relay-sec-";

/// A new client key: 256 random bits, URL-safe, behind the `relay-sec-` prefix.
pub fn generate_proxy_key() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the system has randomness");
    format!(
        "{PROXY_KEY_PREFIX}{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    )
}

/// Where an overflow upstream may be: an https URL, or plain http on this computer only.
/// No credentials, query or fragment.
pub fn overflow_url_allowed(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if !url.username().is_empty()
        || url.password().is_some_and(|p| !p.is_empty())
        || url.query().is_some_and(|q| !q.is_empty())
        || url.fragment().is_some_and(|f| !f.is_empty())
    {
        return false;
    }
    match url.scheme() {
        "https" => true,
        "http" => is_loopback_host(
            url.host_str()
                .unwrap_or("")
                .trim_start_matches('[')
                .trim_end_matches(']'),
        ),
        _ => false,
    }
}

static MODEL_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9._:/~@+\[\]-]+$").unwrap());
static UPSTREAM_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,64}$").unwrap());
static KEY_TEXT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\x21-\x7e]+$").unwrap());

type Checked<T> = Result<T, String>;

fn object<'a>(value: &'a Value, what: &str) -> Checked<&'a serde_json::Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| format!("{what}: expected an object"))
}

fn strict(map: &serde_json::Map<String, Value>, known: &[&str], what: &str) -> Checked<()> {
    match map.keys().find(|k| !known.contains(&k.as_str())) {
        Some(key) => Err(format!("{what}: unrecognized key '{key}'")),
        None => Ok(()),
    }
}

fn trimmed_text(value: Option<&Value>, min: usize, max: usize, what: &str) -> Checked<String> {
    let text = value
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{what}: expected a string"))?
        .trim()
        .to_string();
    let length = crate::js::units(&text);
    if length < min || length > max {
        return Err(format!("{what}: must be {min}–{max} characters"));
    }
    Ok(text)
}

fn number_in(value: Option<&Value>, min: f64, max: f64, integer: bool, what: &str) -> Checked<f64> {
    let n = value
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("{what}: expected a number"))?;
    if (integer && n.fract() != 0.0) || n < min || n > max {
        return Err(format!("{what}: out of range"));
    }
    Ok(n)
}

fn boolean(value: Option<&Value>, what: &str) -> Checked<bool> {
    value
        .and_then(Value::as_bool)
        .ok_or_else(|| format!("{what}: expected a boolean"))
}

fn model_map(value: Option<&Value>) -> Checked<Value> {
    let map = object(value.unwrap_or(&Value::Null), "modelMap")?;
    strict(map, &["opus", "sonnet", "haiku", "default"], "modelMap")?;
    let mut out = serde_json::Map::new();
    for (key, raw) in map {
        let id = trimmed_text(Some(raw), 1, 120, "modelMap")?;
        if !MODEL_ID.is_match(&id) {
            return Err(format!("modelMap.{key}: invalid model id"));
        }
        out.insert(key.clone(), Value::String(id));
    }
    Ok(Value::Object(out))
}

fn prices(value: &Value) -> Checked<Value> {
    let map = object(value, "prices")?;
    strict(map, &["input", "output"], "prices")?;
    let input = number_in(map.get("input"), 0.0, 1_000.0, false, "prices.input")?;
    let output = number_in(map.get("output"), 0.0, 1_000.0, false, "prices.output")?;
    Ok(serde_json::json!({ "input": input, "output": output }))
}

fn preset(value: Option<&Value>) -> Checked<Value> {
    let preset = value.cloned().unwrap_or(Value::Null);
    serde_json::from_value::<crate::types::ApiUpstreamPreset>(preset.clone())
        .map(|_| preset)
        .map_err(|_| "preset: unknown preset".to_string())
}

fn auth_style(value: Option<&Value>) -> Checked<Value> {
    match value.and_then(Value::as_str) {
        Some(style @ ("x-api-key" | "bearer")) => Ok(Value::String(style.into())),
        _ => Err("authStyle: expected x-api-key or bearer".into()),
    }
}

fn base_url(value: Option<&Value>) -> Checked<String> {
    let url = trimmed_text(value, 0, 300, "baseUrl")?;
    if !overflow_url_allowed(&url) {
        return Err("Use an https:// URL (http:// only on this computer)".into());
    }
    Ok(url)
}

/// The fields an upstream has besides its id and order, checked and normalized.
fn upstream_body(map: &serde_json::Map<String, Value>) -> Checked<serde_json::Map<String, Value>> {
    let mut out = serde_json::Map::new();
    out.insert(
        "label".into(),
        Value::String(trimmed_text(map.get("label"), 1, 40, "label")?),
    );
    out.insert("preset".into(), preset(map.get("preset"))?);
    out.insert(
        "baseUrl".into(),
        Value::String(base_url(map.get("baseUrl"))?),
    );
    out.insert("authStyle".into(), auth_style(map.get("authStyle"))?);
    out.insert("modelMap".into(), model_map(map.get("modelMap"))?);
    out.insert(
        "enabled".into(),
        Value::Bool(boolean(map.get("enabled"), "enabled")?),
    );
    if let Some(p) = map.get("prices") {
        out.insert("prices".into(), prices(p)?);
    }
    Ok(out)
}

/// One API-key upstream as saved (`apiUpstreamSchema`); the key is never part of it.
pub fn parse_api_upstream(value: &Value) -> Checked<ApiUpstream> {
    let map = object(value, "upstream")?;
    strict(
        map,
        &[
            "id",
            "label",
            "preset",
            "baseUrl",
            "authStyle",
            "modelMap",
            "enabled",
            "order",
            "prices",
        ],
        "upstream",
    )?;
    let id = map
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| UPSTREAM_ID.is_match(id))
        .ok_or("id: invalid")?;
    let mut out = upstream_body(map)?;
    out.insert("id".into(), Value::String(id.into()));
    out.insert(
        "order".into(),
        serde_json::json!(number_in(map.get("order"), 0.0, 1_000.0, true, "order")?),
    );
    serde_json::from_value(Value::Object(out)).map_err(|e| e.to_string())
}

/// The overflow setup as proxy-pool.json keeps it (`overflowSettingsSchema`).
pub fn parse_overflow_settings(value: &Value) -> Checked<OverflowSettings> {
    let map = object(value, "overflow")?;
    strict(
        map,
        &["enabled", "trigger", "dailyCapUsd", "upstreams"],
        "overflow",
    )?;
    let enabled = boolean(map.get("enabled"), "enabled")?;
    let trigger = match map.get("trigger") {
        None => None,
        Some(t) => Some(
            serde_json::from_value(t.clone())
                .map_err(|_| "trigger: expected limited or unavailable")?,
        ),
    };
    let daily_cap_usd = match map.get("dailyCapUsd") {
        None => None,
        Some(v) => Some(number_in(Some(v), 0.01, 10_000.0, false, "dailyCapUsd")?),
    };
    let upstreams = map
        .get("upstreams")
        .and_then(Value::as_array)
        .ok_or("upstreams: expected an array")?;
    if upstreams.len() > 20 {
        return Err("upstreams: at most 20".into());
    }
    Ok(OverflowSettings {
        enabled,
        trigger,
        daily_cap_usd,
        upstreams: upstreams
            .iter()
            .map(parse_api_upstream)
            .collect::<Checked<_>>()?,
    })
}

/// What proxy-pool.json holds: the parts of the gateway's setup the registry does not.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyExtras {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_order: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excluded_account_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_overflow: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub affinity_revision: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_bindings: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overflow: Option<OverflowSettings>,
}

fn string_list(value: Option<&Value>, what: &str) -> Checked<Option<Vec<String>>> {
    let Some(value) = value else { return Ok(None) };
    let items = value
        .as_array()
        .ok_or_else(|| format!("{what}: expected an array"))?;
    if items.len() > 200 {
        return Err(format!("{what}: at most 200"));
    }
    items
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("{what}: expected strings"))
        })
        .collect::<Checked<Vec<_>>>()
        .map(Some)
}

/// `proxyExtrasSchema.parse`: unknown keys stripped; an overflow setup this build cannot read
/// is left out, not the whole file, so the pool's order stays.
pub fn parse_proxy_extras(value: &Value) -> Checked<ProxyExtras> {
    let map = object(value, "proxy-pool.json")?;
    let affinity_revision = match map.get("affinityRevision") {
        None => None,
        Some(v) => Some(number_in(Some(v), 0.0, 1_000.0, true, "affinityRevision")? as u32),
    };
    let subagent_overflow = match map.get("subagentOverflow") {
        None => None,
        Some(v) => Some(boolean(Some(v), "subagentOverflow")?),
    };
    let client_bindings = match map.get("clientBindings") {
        None => None,
        Some(v) => {
            let bindings = object(v, "clientBindings")?;
            for (client, saved) in bindings {
                if !["claude-code", "codex", "omp"].contains(&client.as_str()) {
                    continue;
                }
                let saved = object(saved, "clientBindings")?;
                if saved.values().any(|v| !(v.is_string() || v.is_null())) {
                    return Err("clientBindings: expected strings or null".into());
                }
            }
            let kept: serde_json::Map<String, Value> = bindings
                .iter()
                .filter(|(k, _)| ["claude-code", "codex", "omp"].contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            Some(Value::Object(kept))
        }
    };
    Ok(ProxyExtras {
        account_order: string_list(map.get("accountOrder"), "accountOrder")?,
        excluded_account_ids: string_list(map.get("excludedAccountIds"), "excludedAccountIds")?,
        subagent_overflow,
        affinity_revision,
        client_bindings,
        overflow: map
            .get("overflow")
            .and_then(|o| parse_overflow_settings(o).ok()),
    })
}

/// What the Proxy Gateway page may change (`proxyConfigurePatch`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProxyConfigurePatch {
    pub port: Option<u16>,
    pub host: Option<String>,
    pub routing_strategy: Option<RoutingStrategy>,
    pub affinity_ttl_seconds: Option<f64>,
    pub account_order: Option<Vec<String>>,
    pub excluded_account_ids: Option<Vec<String>>,
    pub subagent_overflow: Option<bool>,
}

fn id_list(value: Option<&Value>, what: &str) -> Checked<Option<Vec<String>>> {
    let list = string_list(value, what)?;
    if list.as_ref().is_some_and(|l| {
        l.iter()
            .any(|id| id.is_empty() || crate::js::units(id) > 128)
    }) {
        return Err(format!("{what}: ids are 1–128 characters"));
    }
    Ok(list)
}

pub fn parse_proxy_configure_patch(value: &Value) -> Checked<ProxyConfigurePatch> {
    let map = object(value, "patch")?;
    strict(
        map,
        &[
            "port",
            "host",
            "routingStrategy",
            "affinityTtlSeconds",
            "accountOrder",
            "excludedAccountIds",
            "subagentOverflow",
        ],
        "patch",
    )?;
    let host = match map.get("host") {
        None => None,
        Some(v) => {
            let host = trimmed_text(Some(v), 0, usize::MAX, "host")?;
            if !gateway_host_allowed(&host) {
                return Err(GATEWAY_HOST_ERROR.into());
            }
            Some(host)
        }
    };
    Ok(ProxyConfigurePatch {
        port: map
            .get("port")
            .map(|v| number_in(Some(v), 1.0, 65_535.0, true, "port").map(|p| p as u16))
            .transpose()?,
        host,
        routing_strategy: map
            .get("routingStrategy")
            .map(|v| {
                serde_json::from_value(v.clone())
                    .map_err(|_| "routingStrategy: unknown".to_string())
            })
            .transpose()?,
        affinity_ttl_seconds: map
            .get("affinityTtlSeconds")
            .map(|v| number_in(Some(v), 10.0, 3_600.0, true, "affinityTtlSeconds"))
            .transpose()?,
        account_order: id_list(map.get("accountOrder"), "accountOrder")?,
        excluded_account_ids: id_list(map.get("excludedAccountIds"), "excludedAccountIds")?,
        subagent_overflow: map
            .get("subagentOverflow")
            .map(|v| boolean(Some(v), "subagentOverflow"))
            .transpose()?,
    })
}

/// What the page may change about overflow as a whole; a null cap removes it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OverflowConfigurePatch {
    pub enabled: Option<bool>,
    pub trigger: Option<crate::types::OverflowTrigger>,
    /// `Some(None)`: remove the cap.
    pub daily_cap_usd: Option<Option<f64>>,
    pub order: Option<Vec<String>>,
}

pub fn parse_overflow_configure_patch(value: &Value) -> Checked<OverflowConfigurePatch> {
    let map = object(value, "patch")?;
    strict(
        map,
        &["enabled", "trigger", "dailyCapUsd", "order"],
        "patch",
    )?;
    let order = match map.get("order") {
        None => None,
        Some(v) => {
            let items = v.as_array().ok_or("order: expected an array")?;
            if items.len() > 20 {
                return Err("order: at most 20".into());
            }
            Some(
                items
                    .iter()
                    .map(|i| {
                        i.as_str()
                            .filter(|s| crate::js::units(s) <= 64)
                            .map(str::to_string)
                            .ok_or_else(|| "order: ids of at most 64 characters".to_string())
                    })
                    .collect::<Checked<Vec<_>>>()?,
            )
        }
    };
    Ok(OverflowConfigurePatch {
        enabled: map
            .get("enabled")
            .map(|v| boolean(Some(v), "enabled"))
            .transpose()?,
        trigger: map
            .get("trigger")
            .map(|v| serde_json::from_value(v.clone()).map_err(|_| "trigger: unknown".to_string()))
            .transpose()?,
        daily_cap_usd: match map.get("dailyCapUsd") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(v) => Some(Some(number_in(
                Some(v),
                0.01,
                10_000.0,
                false,
                "dailyCapUsd",
            )?)),
        },
        order,
    })
}

/// An upstream added (no id; a key is needed) or changed (a key given replaces the saved one).
#[derive(Clone, Debug, PartialEq)]
pub struct OverflowUpstreamInput {
    pub id: Option<String>,
    pub key: Option<String>,
    /// The upstream's fields as `ApiUpstream` keeps them (no id, no order).
    pub fields: serde_json::Map<String, Value>,
}

pub fn parse_overflow_upstream_input(value: &Value) -> Checked<OverflowUpstreamInput> {
    let map = object(value, "upstream")?;
    strict(
        map,
        &[
            "id",
            "key",
            "label",
            "preset",
            "baseUrl",
            "authStyle",
            "modelMap",
            "enabled",
            "prices",
        ],
        "upstream",
    )?;
    let id = match map.get("id") {
        None => None,
        Some(v) => Some(
            v.as_str()
                .filter(|id| UPSTREAM_ID.is_match(id))
                .ok_or("id: invalid")?
                .to_string(),
        ),
    };
    let key = match map.get("key") {
        None => None,
        Some(v) => {
            let key = trimmed_text(Some(v), 8, 512, "key")?;
            if !KEY_TEXT.is_match(&key) {
                return Err("key: printable characters only".into());
            }
            Some(key)
        }
    };
    Ok(OverflowUpstreamInput {
        id,
        key,
        fields: upstream_body(map)?,
    })
}

/// Every account in the pool's order: the saved order first, then the rest as the registry
/// lists them. Ids of removed accounts are ignored.
pub fn ordered_accounts<'a>(
    accounts: &'a [Account],
    account_order: Option<&[String]>,
) -> Vec<&'a Account> {
    let rank: IndexMap<&str, usize> = account_order
        .unwrap_or(&[])
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();
    let mut keyed: Vec<(usize, &Account)> = accounts
        .iter()
        .enumerate()
        .map(|(index, account)| {
            (
                rank.get(account.id.as_str())
                    .copied()
                    .unwrap_or(rank.len() + index),
                account,
            )
        })
        .collect();
    keyed.sort_by_key(|(key, _)| *key);
    keyed.into_iter().map(|(_, account)| account).collect()
}

/// The accounts the gateway may route to, in the pool's order.
pub fn pool_accounts(accounts: &[Account], config: &ProxyConfig) -> Vec<Account> {
    let out: HashSet<&str> = config
        .excluded_account_ids
        .iter()
        .flatten()
        .map(String::as_str)
        .collect();
    ordered_accounts(accounts, config.account_order.as_deref())
        .into_iter()
        .filter(|a| !out.contains(a.id.as_str()))
        .cloned()
        .collect()
}

fn clamp_percent(value: Option<f64>) -> Option<i64> {
    value
        .filter(|v| v.is_finite())
        .map(|v| round(v.clamp(0.0, 100.0)) as i64)
}

fn minutes_until(iso: Option<&str>, now: i64) -> Option<i64> {
    let at = iso.and_then(parse_date)?;
    (at > now).then(|| ((at - now) as f64 / 60_000.0).ceil() as i64)
}

fn windows_of(usage: Option<&AccountUsage>) -> Vec<&UsageWindow> {
    usage
        .map(|u| {
            [u.five_hour.as_ref(), u.seven_day.as_ref()]
                .into_iter()
                .flatten()
                .collect()
        })
        .unwrap_or_default()
}

/// How full the account's fuller window is, 0–100; `None` while no limit has been read.
pub fn quota_percent(usage: Option<&AccountUsage>) -> Option<i64> {
    let windows = windows_of(usage);
    if windows.is_empty() {
        return None;
    }
    let fullest = windows.iter().fold(0.0f64, |m, w| m.max(w.used_percent));
    Some(round(fullest.min(100.0)) as i64)
}

/// Whole minutes until the soonest window resets; `None` when none says when.
pub fn reset_in_minutes(usage: Option<&AccountUsage>, now: i64) -> Option<i64> {
    windows_of(usage)
        .iter()
        .filter_map(|w| w.resets_at.as_deref().and_then(parse_date))
        .filter(|at| *at > now)
        .min()
        .map(|soonest| ((soonest - now) as f64 / 60_000.0).ceil() as i64)
}

/// What one percent of an account's 5-hour window took, in API-price dollars.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitCalibration {
    pub account_id: String,
    #[serde(serialize_with = "crate::js::ser_f64")]
    pub dollars_per_percent: f64,
    pub windows: u64,
    #[serde(serialize_with = "crate::js::ser_f64")]
    pub percent: f64,
    #[serde(serialize_with = "crate::js::ser_f64")]
    pub cost: f64,
}

/// What writing a session's cache again would cost: its prompt at the model's write price,
/// and that as a share of a 5-hour window on the accounts it could move to.
pub fn with_move_cost(
    session: &ProxySessionView,
    calibrations: &IndexMap<String, LimitCalibration>,
    excluded: &HashSet<String>,
) -> ProxySessionView {
    let Some(model) = session.model.as_deref().filter(|m| !m.is_empty()) else {
        return session.clone();
    };
    if session.prefix_tokens <= 0.0 {
        return session.clone();
    }
    let hour = session.ttl_ms >= 3_600_000;
    let Some(dollars) = response_cost(
        model,
        &ResponseUsage {
            cache_write: session.prefix_tokens,
            cache_write_1h: hour.then_some(session.prefix_tokens),
            ..Default::default()
        },
    ) else {
        return session.clone();
    };
    let mut others: Vec<f64> = calibrations
        .values()
        .filter(|c| c.account_id != session.account_id && !excluded.contains(&c.account_id))
        .map(|c| c.dollars_per_percent)
        .collect();
    others.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let own = calibrations
        .get(&session.account_id)
        .map(|c| c.dollars_per_percent);
    let rate = if others.is_empty() {
        own
    } else {
        Some(others[(others.len() - 1) / 2])
    };
    let mut view = session.clone();
    view.move_cost = Some(MoveCost {
        dollars: round(dollars * 1000.0) / 1000.0,
        percent: rate
            .filter(|r| *r > 0.0)
            .map(|r| round(dollars / r * 100.0) / 100.0),
    });
    view
}

/// The overflow as the page shows it (`overflowStatus` in `gateway.ts`): today's spend in the
/// planning day, and each key masked (`hints`: upstream id → `key_hint`).
pub fn overflow_status(
    overflow: &OverflowSettings,
    spent_today_usd: f64,
    hints: &std::collections::HashMap<String, String>,
) -> OverflowStatus {
    let mut upstreams = overflow.upstreams.clone();
    upstreams.sort_by(|a, b| {
        a.order
            .partial_cmp(&b.order)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    OverflowStatus {
        enabled: overflow.enabled,
        trigger: overflow.trigger.unwrap_or(OverflowTrigger::Limited),
        daily_cap_usd: overflow.daily_cap_usd,
        spent_today_usd,
        cap_reached: overflow
            .daily_cap_usd
            .is_some_and(|cap| spent_today_usd >= cap),
        upstreams: upstreams
            .into_iter()
            .map(|upstream| OverflowUpstreamStatus {
                key_hint: hints.get(&upstream.id).filter(|h| !h.is_empty()).cloned(),
                upstream,
            })
            .collect(),
    }
}

/// Percents an answer reported this recently count as live.
const LIVE_MS: i64 = 10 * 60_000;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStatusStats {
    pub total_requests: u64,
    pub active_requests: u64,
    pub prompt_cache_hits: u64,
    #[serde(serialize_with = "crate::js::ser_f64")]
    pub cache_hit_rate: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Waiting {
    pub reason: String,
    pub minutes: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtraUsageView {
    pub kind: ExtraUsageKind,
    pub minutes_ago: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PercentCost {
    #[serde(serialize_with = "crate::js::ser_f64")]
    pub dollars: f64,
    pub windows: u64,
}

/// Whether the gateway could use an account's sign-in when it last looked.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GatewaySignIn {
    Missing,
    Expired,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyAccountStatus {
    pub id: String,
    pub name: String,
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    pub active: bool,
    pub signed_in: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota_percent: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_in_minutes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub five_hour_percent: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub five_hour_reset_minutes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weekly_percent: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weekly_reset_minutes: Option<i64>,
    pub in_pool: bool,
    pub requests: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<AccountTokenMetrics>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting: Option<Waiting>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_usage: Option<ExtraUsageView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub percent_cost: Option<PercentCost>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway_sign_in: Option<GatewaySignIn>,
}

/// Where a new session of a model with its own limit goes, when that differs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ByModelPick {
    pub model: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

/// The account a new session would get now, and why.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NextPick {
    pub account_id: String,
    pub reason: ProxyPickReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nearly_full: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by_model: Option<Vec<ByModelPick>>,
}

/// By provider name (`claude`, `codex`, `antigravity`).
pub type NextPicks = IndexMap<String, NextPick>;

/// `ProxyStatus`: what the Proxy Gateway page shows.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStatus {
    pub running: bool,
    pub port: u16,
    pub host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_api_key: Option<String>,
    pub routing_strategy: RoutingStrategy,
    #[serde(serialize_with = "crate::js::ser_f64")]
    pub affinity_ttl_seconds: f64,
    pub stats: ProxyStatusStats,
    pub accounts: Vec<ProxyAccountStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recent: Option<Vec<ProxyRequestLog>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tailscale_address: Option<String>,
    /// `ProxyClientStatus[]`, computed by the host (client binding stays outside the gateway).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clients: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_overflow: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sessions: Option<Vec<ProxySessionView>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alarms: Option<Vec<ProxyLoopAlarm>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class_share: Option<Vec<ProxyClassShare>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_pick: Option<NextPicks>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overflow: Option<OverflowStatus>,
}

/// The gateway's own cooldown of an account, by id.
pub type CooldownLookup<'a> = &'a dyn Fn(&str) -> Option<Cooldown>;
/// Whether the gateway could use an account's sign-in, by id.
pub type SignInLookup<'a> = &'a dyn Fn(&str) -> Option<GatewaySignIn>;

/// Everything `build_proxy_status` reads.
pub struct StatusInput<'a> {
    pub running: bool,
    pub config: &'a ProxyConfig,
    pub metrics: Option<&'a ProxyMetrics>,
    pub accounts: &'a [Account],
    pub usage: &'a UsageMap,
    pub now: i64,
    pub error: Option<String>,
    pub recent: Option<Vec<ProxyRequestLog>>,
    pub tailscale_address: Option<String>,
    pub clients: Option<Vec<Value>>,
    /// The gateway's own cooldown of an account, when one is running.
    pub cooldown_of: Option<CooldownLookup<'a>>,
    /// What the running gateway learned from its traffic.
    pub insights: Option<&'a GatewayInsights>,
    pub class_share: Option<Vec<ProxyClassShare>>,
    pub calibrations: Option<&'a IndexMap<String, LimitCalibration>>,
    pub next_pick: Option<NextPicks>,
    pub gateway_sign_in: Option<SignInLookup<'a>>,
    pub overflow: Option<OverflowStatus>,
}

impl<'a> StatusInput<'a> {
    pub fn new(
        running: bool,
        config: &'a ProxyConfig,
        accounts: &'a [Account],
        usage: &'a UsageMap,
        now: i64,
    ) -> Self {
        StatusInput {
            running,
            config,
            metrics: None,
            accounts,
            usage,
            now,
            error: None,
            recent: None,
            tailscale_address: None,
            clients: None,
            cooldown_of: None,
            insights: None,
            class_share: None,
            calibrations: None,
            next_pick: None,
            gateway_sign_in: None,
            overflow: None,
        }
    }
}

/// What the Proxy Gateway page shows. `cacheHitRate` is a percentage (0–100) of the prompt
/// tokens the gateway's answers read from the upstream cache.
pub fn build_proxy_status(input: StatusInput<'_>) -> ProxyStatus {
    let config = input.config;
    let metrics = input.metrics;
    let excluded: HashSet<String> = config
        .excluded_account_ids
        .iter()
        .flatten()
        .cloned()
        .collect();
    let empty = IndexMap::new();
    let calibrations = input.calibrations.unwrap_or(&empty);
    let accounts = ordered_accounts(input.accounts, config.account_order.as_deref())
        .into_iter()
        .map(|account| {
            let usage = input.usage.get(&account.id);
            let cooldown = if input.running {
                input.cooldown_of.and_then(|f| f(&account.id))
            } else {
                None
            };
            let extra = metrics.and_then(|m| m.extra_usage.as_ref()?.get(&account.id));
            let calibration = calibrations.get(&account.id);
            let full_at = if input.running {
                input.insights.and_then(|i| i.full_at(&account.id))
            } else {
                None
            };
            let sign_in = if input.running && !excluded.contains(&account.id) {
                input.gateway_sign_in.and_then(|f| f(&account.id))
            } else {
                None
            };
            let live = usage
                .and_then(|u| u.live_at.as_deref())
                .and_then(parse_date)
                .is_some_and(|at| input.now - at <= LIVE_MS);
            ProxyAccountStatus {
                id: account.id.clone(),
                name: account.name.clone(),
                provider: account.provider().as_str().into(),
                email: account
                    .auth
                    .as_ref()
                    .and_then(|a| a.email.clone())
                    .filter(|e| !e.is_empty()),
                active: input.running
                    && metrics.and_then(|m| m.last_account_id.as_deref()) == Some(&account.id),
                signed_in: account.auth.as_ref().is_some_and(|a| a.logged_in),
                quota_percent: quota_percent(usage),
                reset_in_minutes: reset_in_minutes(usage, input.now),
                five_hour_percent: clamp_percent(
                    usage.and_then(|u| Some(u.five_hour.as_ref()?.used_percent)),
                ),
                five_hour_reset_minutes: minutes_until(
                    usage.and_then(|u| u.five_hour.as_ref()?.resets_at.as_deref()),
                    input.now,
                ),
                weekly_percent: clamp_percent(
                    usage.and_then(|u| Some(u.seven_day.as_ref()?.used_percent)),
                ),
                weekly_reset_minutes: minutes_until(
                    usage.and_then(|u| u.seven_day.as_ref()?.resets_at.as_deref()),
                    input.now,
                ),
                in_pool: !excluded.contains(&account.id),
                requests: metrics
                    .and_then(|m| m.requests_by_account.get(&account.id).copied())
                    .unwrap_or(0),
                tokens: metrics.and_then(|m| m.tokens_by_account.get(&account.id).copied()),
                waiting: cooldown.filter(|c| c.until > input.now).map(|c| Waiting {
                    reason: c.reason.as_str().into(),
                    minutes: ((c.until - input.now) as f64 / 60_000.0).ceil() as i64,
                }),
                extra_usage: extra.map(|e| ExtraUsageView {
                    kind: e.kind,
                    minutes_ago: ((input.now - e.at) / 60_000).max(0),
                }),
                live: live.then_some(true),
                full_at: full_at.filter(|at| *at > input.now),
                percent_cost: calibration.map(|c| PercentCost {
                    dollars: c.dollars_per_percent,
                    windows: c.windows,
                }),
                gateway_sign_in: sign_in,
            }
        })
        .collect();
    let (sessions, alarms) = match (input.running, input.insights) {
        (true, Some(insights)) => {
            let sessions: Vec<ProxySessionView> = insights
                .session_views(8)
                .iter()
                .map(|s| with_move_cost(s, calibrations, &excluded))
                .collect();
            let alarms = insights.alarms();
            (
                (!sessions.is_empty()).then_some(sessions),
                (!alarms.is_empty()).then_some(alarms),
            )
        }
        _ => (None, None),
    };
    ProxyStatus {
        running: input.running,
        port: config.port,
        host: config.host.clone(),
        client_api_key: config.api_key.clone().filter(|k| !k.is_empty()),
        routing_strategy: config.routing_strategy,
        affinity_ttl_seconds: config.affinity_ttl_seconds,
        stats: ProxyStatusStats {
            total_requests: metrics.map_or(0, |m| m.total_requests),
            active_requests: metrics.map_or(0, |m| m.active_requests),
            prompt_cache_hits: metrics.map_or(0, |m| m.prompt_cache_hits),
            cache_hit_rate: round(metrics.map_or(0.0, |m| m.cache_hit_ratio) * 1000.0) / 10.0,
        },
        accounts,
        error: input.error.filter(|e| !e.is_empty()),
        recent: input.recent,
        tailscale_address: input.tailscale_address.filter(|a| !a.is_empty()),
        clients: input.clients,
        subagent_overflow: config.subagent_overflow.filter(|on| *on),
        sessions,
        alarms,
        class_share: input.class_share.filter(|c| !c.is_empty()),
        next_pick: input.next_pick.filter(|p| input.running && !p.is_empty()),
        overflow: input.overflow,
    }
}
