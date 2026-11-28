//! Port of electron/main/ipc/proxy.ts: the Proxy Gateway's page: on and off, its settings,
//! bound clients and the API-key overflow.

use relay_core::shared::feature_risk::{
    GatewayRiskConfig, PoolAccount, ProxyRiskConfig, ProxyRiskPatch, client_risks, gateway_risks,
    proxy_patch_risks,
};
use relay_core::shared::overflow::{
    ApiUpstream, DEFAULT_OVERFLOW_CAP_USD, OVERFLOW_PRESET_IDS, OverflowSettings, OverflowTrigger,
};
use relay_core::shared::proxy_types::{ProxyClientId, ProxyConfig};
use relay_core::shared::proxy_url::{GATEWAY_HOST_ERROR, gateway_host_allowed};
use relay_core::shared::types::Account;
use relay_core::store::schema::{
    self, NumberRule, Schema, StringRule, array, boolean, enumeration, number, strict,
};
use relay_gateway::overflow_upstream::test_overflow_upstream;
use relay_gateway::proxy_status::{generate_proxy_key, overflow_url_allowed};
use serde_json::{Map, Value};

use super::{Call, IpcResult, OrMessage, Registry, reply, require_risk, zod_message};
use crate::services::gateway::{
    self, apply_proxy_config, bind_client, clear_proxy_error, client_target, home, overflow_keys,
    proxy_settings, proxy_status, save_proxy_settings, serialize_proxy, start_proxy_now,
    stop_proxy, unbind_client,
};
use crate::state::STATE;

const CLIENT_IDS: [&str; 3] = ["claude-code", "codex", "omp"];
const NOT_THERE: &str = "This overflow upstream no longer exists.";
const KEY_FIRST: &str = "Enter this overflow upstream’s API key first.";

pub fn register(registry: &mut Registry) {
    // The windows show it; every switch, sign-in or recovery rechecks fresh in main.
    registry.handle("proxy-status", |_| Ok(proxy_status()));
    registry.handle("proxy-toggle", proxy_toggle);
    registry.handle("proxy-configure", proxy_configure);
    registry.handle("proxy-regenerate-key", proxy_regenerate_key);
    registry.handle("copy-text", copy_text);
    registry.handle("proxy-bind-client", proxy_bind_client);
    registry.handle("proxy-unbind-client", proxy_unbind_client);
    // API-key overflow (W3-1): R0, an API key is billed per token and allowed for this use.
    registry.handle("proxy-overflow-configure", proxy_overflow_configure);
    registry.handle("proxy-overflow-save-upstream", proxy_overflow_save_upstream);
    registry.handle(
        "proxy-overflow-remove-upstream",
        proxy_overflow_remove_upstream,
    );
    registry.handle("proxy-overflow-test", proxy_overflow_test);
}

fn pool(accounts: &[Account]) -> Vec<PoolAccount> {
    accounts
        .iter()
        .map(|a| PoolAccount::new(a.id.clone(), a.provider.map(|p| p.as_str())))
        .collect()
}

/// `z.string()` with the rules zod chains on it.
fn text(
    trim: bool,
    min: Option<usize>,
    max: Option<usize>,
    pattern: Option<fn(&str) -> bool>,
) -> Schema {
    schema::string(StringRule {
        trim,
        min,
        max,
        pattern,
        ..StringRule::default()
    })
}

fn num(int: bool, min: f64, max: f64) -> Schema {
    number(NumberRule {
        int,
        min: Some(min),
        max: Some(max),
    })
}

fn host_allowed(value: &Value) -> bool {
    value.as_str().is_some_and(gateway_host_allowed)
}

fn url_allowed(value: &Value) -> bool {
    value.as_str().is_some_and(overflow_url_allowed)
}

/// `/^[A-Za-z0-9_-]{1,64}$/`.
fn upstream_id_text(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `/^[A-Za-z0-9._:/~@+[\]-]+$/`.
fn model_id_text(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:/~@+[]-".contains(&b))
}

/// `/^[\x21-\x7e]+$/`.
fn key_text(key: &str) -> bool {
    !key.is_empty() && key.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

fn upstream_id() -> Schema {
    text(false, None, None, Some(upstream_id_text))
}

/// `proxyConfigurePatch` (shared/proxy-status.ts).
fn proxy_configure_patch() -> Schema {
    let ids = || array(text(false, Some(1), Some(128), None), Some(200));
    strict(vec![
        ("port", num(true, 1.0, 65_535.0)),
        (
            "host",
            text(true, None, None, None).refine(host_allowed, GATEWAY_HOST_ERROR),
        ),
        (
            "routingStrategy",
            enumeration(["soonest-reset", "balanced", "strict-priority"]),
        ),
        ("affinityTtlSeconds", num(true, 10.0, 3_600.0)),
        ("accountOrder", ids()),
        ("excludedAccountIds", ids()),
        ("subagentOverflow", boolean()),
    ])
    .partial()
}

/// `apiUpstreamSchema`.
fn api_upstream_schema() -> Schema {
    let model = || text(true, Some(1), Some(120), Some(model_id_text));
    let price = || num(false, 0.0, 1_000.0);
    strict(vec![
        ("id", upstream_id()),
        ("label", text(true, Some(1), Some(40), None)),
        (
            "preset",
            enumeration(OVERFLOW_PRESET_IDS.iter().map(|p| p.as_str())),
        ),
        (
            "baseUrl",
            text(true, None, Some(300), None).refine(
                url_allowed,
                "Use an https:// URL (http:// only on this computer)",
            ),
        ),
        ("authStyle", enumeration(["x-api-key", "bearer"])),
        (
            "modelMap",
            strict(vec![
                ("opus", model()),
                ("sonnet", model()),
                ("haiku", model()),
                ("default", model()),
            ])
            .partial(),
        ),
        ("enabled", boolean()),
        ("order", num(true, 0.0, 1_000.0)),
        (
            "prices",
            strict(vec![("input", price()), ("output", price())]).optional(),
        ),
    ])
}

/// `overflowSettingsSchema`.
fn overflow_settings_schema() -> Schema {
    strict(vec![
        ("enabled", boolean()),
        (
            "trigger",
            enumeration(["limited", "unavailable"]).optional(),
        ),
        ("dailyCapUsd", num(false, 0.01, 10_000.0).optional()),
        ("upstreams", array(api_upstream_schema(), Some(20))),
    ])
}

/// `overflowConfigurePatch`, without `dailyCapUsd`'s `.nullable()` (handled by the caller).
fn overflow_configure_patch() -> Schema {
    strict(vec![
        ("enabled", boolean()),
        ("trigger", enumeration(["limited", "unavailable"])),
        ("dailyCapUsd", num(false, 0.01, 10_000.0)),
        ("order", array(text(false, None, Some(64), None), Some(20))),
    ])
    .partial()
}

/// `overflowUpstreamInput`.
fn overflow_upstream_input() -> Schema {
    api_upstream_schema().extend_omit(
        vec![
            ("id", upstream_id().optional()),
            (
                "key",
                text(true, Some(8), Some(512), Some(key_text)).optional(),
            ),
        ],
        &["id", "order"],
    )
}

fn parse_with(schema: &Schema, value: &Value) -> Result<Value, String> {
    schema.parse(value).map_err(|e| zod_message(&e))
}

/// `{ ...base, ...patch }` on the JSON shapes.
fn merged(config: &ProxyConfig, patch: Value) -> Result<ProxyConfig, String> {
    let mut out = serde_json::to_value(config).msg()?;
    if let (Value::Object(out), Value::Object(patch)) = (&mut out, patch) {
        for (key, value) in patch {
            out.insert(key, value);
        }
    }
    serde_json::from_value(out).msg()
}

fn proxy_toggle(call: &Call) -> IpcResult {
    serialize_proxy(|| {
        let on = call.bool(0)?;
        let config = proxy_settings();
        if on {
            let bound: Vec<ProxyClientId> = config
                .client_bindings
                .as_ref()
                .map(|b| b.keys().copied().collect())
                .unwrap_or_default();
            require_risk(&gateway_risks(
                &GatewayRiskConfig {
                    host: &config.host,
                    excluded_account_ids: config.excluded_account_ids.as_deref(),
                    bound_clients: Some(&bound),
                },
                &pool(&STATE.accounts()),
            ))?;
        }
        save_proxy_settings(ProxyConfig {
            enabled: on,
            ..config
        })?;
        if on {
            if let Err(error) = start_proxy_now() {
                // Switched back off, so the page does not claim a gateway that is not there.
                save_proxy_settings(ProxyConfig {
                    enabled: false,
                    ..proxy_settings()
                })?;
                crate::events::changed();
                return Err(error);
            }
        } else {
            stop_proxy()?;
            clear_proxy_error();
        }
        crate::events::changed();
        Ok(proxy_status())
    })
}

fn proxy_configure(call: &Call) -> IpcResult {
    serialize_proxy(|| {
        let patch = call.value(0, &proxy_configure_patch())?;
        let config = proxy_settings();
        let excluded: Option<Vec<String>> = patch
            .get("excludedAccountIds")
            .map(|v| serde_json::from_value(v.clone()))
            .transpose()
            .msg()?;
        require_risk(&proxy_patch_risks(
            &ProxyRiskConfig {
                enabled: config.enabled,
                host: &config.host,
                excluded_account_ids: config.excluded_account_ids.as_deref(),
            },
            &ProxyRiskPatch {
                host: patch.get("host").and_then(Value::as_str),
                excluded_account_ids: excluded.as_deref(),
            },
            &pool(&STATE.accounts()),
        ))?;
        apply_proxy_config(merged(&config, patch)?)?;
        crate::events::changed();
        Ok(proxy_status())
    })
}

fn proxy_regenerate_key(_call: &Call) -> IpcResult {
    serialize_proxy(|| {
        apply_proxy_config(ProxyConfig {
            api_key: Some(generate_proxy_key()),
            ..proxy_settings()
        })?;
        crate::events::changed();
        Ok(proxy_status())
    })
}

fn copy_text(call: &Call) -> IpcResult {
    let text = call.string(0, 0, 16_384)?;
    STATE.shell().write_clipboard(&text);
    super::done()
}

fn client_id(call: &Call) -> Result<ProxyClientId, String> {
    let id = call.one_of(0, &CLIENT_IDS)?;
    serde_json::from_value(Value::String(id)).msg()
}

fn proxy_bind_client(call: &Call) -> IpcResult {
    serialize_proxy(|| {
        let id = client_id(call)?;
        require_risk(&client_risks(id))?;
        let mut config = proxy_settings();
        if config.api_key.as_deref().is_none_or(str::is_empty) {
            config.api_key = Some(generate_proxy_key());
            save_proxy_settings(config.clone())?;
        }
        let target = client_target(&config).ok_or("The gateway has no client key yet.")?;
        let previous = config.client_bindings.as_ref().and_then(|b| b.get(&id));
        let saved = bind_client(id, &target, previous, &home())?;
        let mut bindings = config.client_bindings.clone().unwrap_or_default();
        bindings.insert(id, saved);
        save_proxy_settings(ProxyConfig {
            client_bindings: Some(bindings),
            ..proxy_settings()
        })?;
        crate::events::changed();
        Ok(proxy_status())
    })
}

fn proxy_unbind_client(call: &Call) -> IpcResult {
    serialize_proxy(|| {
        let id = client_id(call)?;
        let config = proxy_settings();
        let previous = config.client_bindings.as_ref().and_then(|b| b.get(&id));
        unbind_client(id, previous, &home())?;
        let mut bindings = config.client_bindings.clone().unwrap_or_default();
        bindings.shift_remove(&id);
        save_proxy_settings(ProxyConfig {
            client_bindings: Some(bindings),
            ..config
        })?;
        crate::events::changed();
        Ok(proxy_status())
    })
}

fn no_overflow() -> OverflowSettings {
    OverflowSettings {
        enabled: false,
        trigger: None,
        daily_cap_usd: None,
        upstreams: Vec::new(),
    }
}

/// Saves the overflow setup; a running gateway takes it at once, keeping its streams.
fn save_overflow(next: &OverflowSettings) -> IpcResult {
    let checked = parse_with(
        &overflow_settings_schema(),
        &serde_json::to_value(next).msg()?,
    )?;
    apply_proxy_config(ProxyConfig {
        overflow: Some(serde_json::from_value(checked).msg()?),
        ..proxy_settings()
    })?;
    crate::events::changed();
    Ok(proxy_status())
}

fn proxy_overflow_configure(call: &Call) -> IpcResult {
    serialize_proxy(|| {
        // `dailyCapUsd: null` removes the cap; any other value is read as the number it must be.
        let mut input = call.arg(0).clone();
        let clear_cap = match &mut input {
            Value::Object(map) if map.get("dailyCapUsd") == Some(&Value::Null) => {
                map.shift_remove("dailyCapUsd");
                true
            }
            _ => false,
        };
        let patch = parse_with(&overflow_configure_patch(), &input)?;
        let mut next = proxy_settings().overflow.unwrap_or_else(no_overflow);
        let enabled = patch.get("enabled").and_then(Value::as_bool);
        if let Some(enabled) = enabled {
            next.enabled = enabled;
        }
        if let Some(trigger) = patch.get("trigger") {
            next.trigger = Some(serde_json::from_value::<OverflowTrigger>(trigger.clone()).msg()?);
        }
        if clear_cap {
            next.daily_cap_usd = None;
        } else if let Some(cap) = patch.get("dailyCapUsd").and_then(Value::as_f64) {
            next.daily_cap_usd = Some(cap);
        } else if enabled == Some(true) && next.daily_cap_usd.is_none() {
            // Turned on with no cap ever chosen: the default one, so a first day cannot run away.
            next.daily_cap_usd = Some(DEFAULT_OVERFLOW_CAP_USD);
        }
        if let Some(order) = patch.get("order").and_then(Value::as_array) {
            let size = order
                .iter()
                .filter_map(Value::as_str)
                .collect::<std::collections::HashSet<_>>()
                .len() as i64;
            // A repeated id ranks where it last appears, as `new Map(entries)` keeps the last one.
            let rank = |id: &str| order.iter().rposition(|o| o.as_str() == Some(id));
            next.upstreams
                .sort_by_key(|u| rank(&u.id).map_or(size + u.order, |r| r as i64));
            for (order, upstream) in next.upstreams.iter_mut().enumerate() {
                upstream.order = order as i64;
            }
        }
        save_overflow(&next)
    })
}

fn proxy_overflow_save_upstream(call: &Call) -> IpcResult {
    serialize_proxy(|| {
        let Value::Object(mut fields) = call.value(0, &overflow_upstream_input())? else {
            return Err("Invalid upstream.".into());
        };
        let key = fields
            .shift_remove("key")
            .and_then(|k| k.as_str().map(str::to_string));
        let given = fields
            .shift_remove("id")
            .and_then(|id| id.as_str().map(str::to_string));
        let keys =
            overflow_keys().ok_or_else(|| crate::i18n::say("dataBackup.errorVaultNotReady"))?;
        let current = proxy_settings().overflow.unwrap_or_else(no_overflow);
        let existing = given
            .as_ref()
            .and_then(|id| current.upstreams.iter().find(|u| &u.id == id));
        if given.is_some() && existing.is_none() {
            return Err(NOT_THERE.into());
        }
        if existing.is_none() && key.is_none() {
            return Err(KEY_FIRST.into());
        }
        let mut shape: Map<String, Value> = fields;
        shape.insert(
            "id".into(),
            Value::String(
                existing.map_or_else(|| uuid::Uuid::new_v4().to_string(), |u| u.id.clone()),
            ),
        );
        shape.insert(
            "order".into(),
            Value::from(existing.map_or(current.upstreams.len() as i64, |u| u.order)),
        );
        let upstream: ApiUpstream =
            serde_json::from_value(parse_with(&api_upstream_schema(), &Value::Object(shape))?)
                .msg()?;
        // The key is sealed before the upstream is saved: a saved upstream always has its key.
        if let Some(key) = &key {
            keys.set(&upstream.id, key).msg()?;
        }
        let mut upstreams = current.upstreams.clone();
        match upstreams.iter_mut().find(|u| u.id == upstream.id) {
            Some(slot) => *slot = upstream,
            None => upstreams.push(upstream),
        }
        save_overflow(&OverflowSettings {
            upstreams,
            ..current
        })
    })
}

fn proxy_overflow_remove_upstream(call: &Call) -> IpcResult {
    serialize_proxy(|| {
        let id: String = call.parse(0, &upstream_id())?;
        let Some(current) = proxy_settings().overflow else {
            return Ok(proxy_status());
        };
        if let Some(keys) = overflow_keys() {
            keys.remove(&id).msg()?;
        }
        let mut upstreams: Vec<ApiUpstream> = current
            .upstreams
            .iter()
            .filter(|u| u.id != id)
            .cloned()
            .collect();
        upstreams.sort_by_key(|u| u.order);
        for (order, upstream) in upstreams.iter_mut().enumerate() {
            upstream.order = order as i64;
        }
        let enabled = current.enabled && !upstreams.is_empty();
        save_overflow(&OverflowSettings {
            enabled,
            upstreams,
            ..current
        })
    })
}

/// A one-token request with the saved key; the answer never holds the key.
fn proxy_overflow_test(call: &Call) -> IpcResult {
    let id: String = call.parse(0, &upstream_id())?;
    let upstream = proxy_settings()
        .overflow
        .and_then(|o| o.upstreams.into_iter().find(|u| u.id == id))
        .ok_or(NOT_THERE)?;
    let key = match overflow_keys() {
        Some(keys) => keys.get(&id).msg()?,
        None => None,
    }
    .ok_or(KEY_FIRST)?;
    let upstream = serde_json::from_value(serde_json::to_value(&upstream).msg()?).msg()?;
    reply(gateway::block_on(test_overflow_upstream(&upstream, &key)))
}
