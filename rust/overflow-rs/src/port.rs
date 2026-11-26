//! The Rust port of `shared/overflow.ts`, delegating to `relay_core::shared::overflow`.

#![forbid(unsafe_code)]

use relay_core::shared::overflow::{
    self, ApiUpstreamPreset, OverflowModelMap, OverflowRates, OverflowTokens, UpstreamPrices,
};
use relay_core::shared::{planning, time_zones};
use serde_json::{Map, Value};

fn defined(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| !crate::js::is_undefined(v))
}

/// `value` as JS arithmetic reads it: a missing key or `undefined` is NaN, `null` and `false`
/// are 0, `true` is 1.
fn arith(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Object(o)) if o.len() == 1 => match o.get("$num").and_then(Value::as_str) {
            Some("Infinity") => f64::INFINITY,
            Some("-Infinity") => f64::NEG_INFINITY,
            Some("-0") => -0.0,
            _ => f64::NAN,
        },
        _ => f64::NAN,
    }
}

/// A number read with `??`: `null` and `undefined` are missing.
fn optional(value: Option<&Value>) -> Option<f64> {
    match defined(value) {
        None | Some(Value::Null) => None,
        v => Some(arith(v)),
    }
}

/// JS truthiness of a structured value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Object(_) if crate::js::is_undefined(value) => false,
        Value::Object(o) if o.len() == 1 && o.contains_key("$num") => {
            let n = arith(Some(value));
            !n.is_nan() && n != 0.0
        }
        Value::Object(_) => true,
        Value::Array(_) => true,
    }
}

/// `value.key`, as JS reads it: `null` and `undefined` throw.
fn property<'a>(value: &'a Value, key: &str) -> Result<Option<&'a Value>, String> {
    if value.is_null() || crate::js::is_undefined(value) {
        let what = if value.is_null() { "null" } else { "undefined" };
        return Err(format!(
            "TypeError: Cannot read properties of {what} (reading '{key}')"
        ));
    }
    Ok(defined(value.get(key)))
}

/// A preset id; one outside `OVERFLOW_PRESET_IDS` has no table and no list prices, which is
/// what `custom` means.
fn preset(value: Option<&Value>) -> ApiUpstreamPreset {
    value
        .and_then(Value::as_str)
        .and_then(ApiUpstreamPreset::parse)
        .unwrap_or(ApiUpstreamPreset::Custom)
}

fn number(n: f64) -> Value {
    crate::js::number(n)
}

/// An `OverflowRates` as the TS tables write it: `cacheRead`, `input`, `output`.
fn rates_to_js(rates: OverflowRates) -> Value {
    let mut out = Map::new();
    if let Some(read) = rates.cache_read {
        out.insert("cacheRead".into(), number(read));
    }
    out.insert("input".into(), number(rates.input));
    out.insert("output".into(), number(rates.output));
    if let Some(write) = rates.cache_write {
        out.insert("cacheWrite".into(), number(write));
    }
    Value::Object(out)
}

/// Port of `overflowFamily` (`shared/overflow.ts:210`).
pub fn overflow_family(model: String) -> Result<Option<String>, String> {
    Ok(overflow::overflow_family(&model)
        .and_then(|family| serde_json::to_value(family).ok())
        .and_then(|family| family.as_str().map(str::to_string)))
}

/// Port of `overflowModel` (`shared/overflow.ts:219`): `upstream.modelMap` becomes the Rust map.
/// A value JS would call `.trim()` on that is no string throws there, as the TS does.
pub fn overflow_model(upstream: Value, requested: String) -> Result<String, String> {
    let map = property(&upstream, "modelMap")?.unwrap_or(&Value::Null);
    let read = |key: &str| -> Result<Option<String>, String> {
        match property(map, key)? {
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(v) if truthy(v) || (key == "default" && !v.is_null()) => {
                Err("TypeError: mapped?.trim is not a function".into())
            }
            _ => Ok(None),
        }
    };
    let family = overflow::overflow_family(&requested);
    let family_key = family.and_then(|f| serde_json::to_value(f).ok());
    let mapped = match family_key.as_ref().and_then(Value::as_str) {
        Some(key) => read(key)?,
        None => None,
    };
    // `(family && modelMap[family]) || modelMap.default`: the default is read only when needed.
    let default = match &mapped {
        Some(m) if !m.is_empty() => None,
        _ => read("default")?,
    };
    let mut model_map = OverflowModelMap {
        default,
        ..Default::default()
    };
    match family {
        Some(overflow::OverflowFamily::Opus) => model_map.opus = mapped,
        Some(overflow::OverflowFamily::Sonnet) => model_map.sonnet = mapped,
        Some(overflow::OverflowFamily::Haiku) => model_map.haiku = mapped,
        None => {}
    }
    Ok(overflow::overflow_model(&model_map, &requested))
}

/// Port of `deepseekPeak` (`shared/overflow.ts:242`).
pub fn deepseek_peak(at: f64) -> Result<bool, String> {
    Ok(overflow::deepseek_peak(at))
}

/// Port of `presetRates` (`shared/overflow.ts:254`).
pub fn preset_rates(preset_id: Value, model: String, at: f64) -> Result<Value, String> {
    Ok(overflow::preset_rates(preset(Some(&preset_id)), &model, at)
        .map_or_else(crate::js::undefined, rates_to_js))
}

/// Port of `overflowCost` (`shared/overflow.ts:287`): the Rust function takes the upstream's
/// preset and prices apart.
pub fn overflow_cost(
    upstream: Value,
    model: String,
    tokens: Value,
    at: f64,
    fetched: Option<Value>,
) -> Result<Value, String> {
    let token = |key: &str| property(&tokens, key).map(optional);
    let tokens = OverflowTokens {
        input: token("input")?,
        output: token("output")?,
        cache_read: token("cacheRead")?,
        cache_write: token("cacheWrite")?,
        cache_write_1h: token("cacheWrite1h")?,
    };
    let preset = preset(property(&upstream, "preset")?);
    let prices = property(&upstream, "prices")?;
    // `prices ?? presetRates(…) ?? fetched` stops at a falsy non-null value, then `!rates` says
    // no price: only Anthropic's list prices are left, which `custom` with no rates gives.
    if prices.is_some_and(|p| !p.is_null() && !truthy(p)) {
        let listed_only = match preset {
            ApiUpstreamPreset::Anthropic => ApiUpstreamPreset::Anthropic,
            _ => ApiUpstreamPreset::Custom,
        };
        let cost = overflow::overflow_cost(listed_only, None, &model, &tokens, at, None);
        return Ok(cost.map_or_else(crate::js::undefined, number));
    }
    let prices = prices.filter(|p| !p.is_null()).map(|p| UpstreamPrices {
        input: arith(defined(p.get("input"))),
        output: arith(defined(p.get("output"))),
    });
    // A falsy `fetched` is no price, as `!rates` reads it.
    let fetched = defined(fetched.as_ref())
        .filter(|f| truthy(f))
        .map(|f| OverflowRates {
            input: arith(defined(f.get("input"))),
            output: arith(defined(f.get("output"))),
            cache_read: optional(f.get("cacheRead")),
            cache_write: optional(f.get("cacheWrite")),
        });
    let cost = overflow::overflow_cost(
        preset,
        prices.as_ref(),
        &model,
        &tokens,
        at,
        fetched.as_ref(),
    );
    Ok(cost.map_or_else(crate::js::undefined, number))
}

/// Port of `keyHint` (`shared/overflow.ts:322`): the hint's last four UTF-16 units may split a
/// surrogate pair, as in JS.
pub fn key_hint(key: String) -> Result<Value, String> {
    Ok(crate::js::utf16_string(&overflow::key_hint_units(&key)))
}

/// `overflow::local_day_bounds`, throwing where the TS does: `Intl` refuses the zone, or a time
/// it reads (`at`, and noon tomorrow) is an Invalid Date. Relay-core reads those as UTC or a
/// fallback instead; `local_parts` is `None` exactly for an Invalid Date.
fn day_bounds(at: f64, time_zone: &str) -> Result<(f64, f64), String> {
    if !time_zones::valid_time_zone(time_zone) {
        return Err(format!(
            "RangeError: Invalid time zone specified: {time_zone}"
        ));
    }
    let invalid = |time: f64| planning::local_parts(time, time_zone).is_none();
    if invalid(at) {
        return Err("RangeError: Invalid time value".into());
    }
    let (start, end) = overflow::local_day_bounds(at, time_zone);
    if invalid(start + 36.0 * 3_600_000.0) {
        return Err("RangeError: Invalid time value".into());
    }
    Ok((start, end))
}

/// Port of `localDayBounds` (`shared/overflow.ts:330`).
pub fn local_day_bounds(at: f64, time_zone: String) -> Result<Value, String> {
    let (start, end) = day_bounds(at, &time_zone)?;
    let mut out = Map::new();
    out.insert("start".into(), number(start));
    out.insert("end".into(), number(end));
    Ok(Value::Object(out))
}

/// Port of `spentToday` (`shared/overflow.ts:343`): each `{ at, cost }` becomes a pair.
pub fn spent_today(costs: Vec<Value>, now: f64, time_zone: String) -> Result<Value, String> {
    day_bounds(now, &time_zone)?;
    let costs = costs
        .iter()
        .map(|c| Ok((arith(property(c, "at")?), arith(property(c, "cost")?))))
        .collect::<Result<Vec<_>, String>>()?;
    Ok(number(overflow::spent_today(&costs, now, &time_zone)))
}
