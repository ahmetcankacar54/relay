//! The Rust port of `shared/model-prices.ts`, delegating to `relay_core::shared::model_prices`.

#![forbid(unsafe_code)]

use relay_core::shared::model_prices::{self, ResponseUsage, TokenCounts};
use serde_json::Value;

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

/// `value ?? fallback` for a number: `null` and `undefined` read as missing.
fn optional(value: Option<&Value>) -> Option<f64> {
    match value {
        None | Some(Value::Null) => None,
        Some(v) if crate::js::is_undefined(v) => None,
        v => Some(arith(v)),
    }
}

fn text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
}

fn cost(cost: Option<f64>) -> Value {
    cost.map_or_else(crate::js::undefined, crate::js::number)
}

/// Port of `priceKey` (`shared/model-prices.ts:109`).
pub fn price_key(model: String) -> Result<Option<String>, String> {
    Ok(model_prices::price_key(&model))
}

/// Port of `responseCost` (`shared/model-prices.ts:129`).
pub fn response_cost(model: String, usage: Value) -> Result<Value, String> {
    let usage = ResponseUsage {
        input: arith(usage.get("input")),
        output: arith(usage.get("output")),
        cache_write: arith(usage.get("cacheWrite")),
        cache_read: arith(usage.get("cacheRead")),
        cache_write_1h: optional(usage.get("cacheWrite1h")),
        speed: text(usage.get("speed")),
        geo: text(usage.get("geo")),
    };
    Ok(cost(model_prices::response_cost(&model, &usage)))
}

/// Port of `estimateCost` (`shared/model-prices.ts:160`).
pub fn estimate_cost(model: String, counts: Value) -> Result<Value, String> {
    let counts = TokenCounts {
        input: arith(counts.get("input")),
        output: arith(counts.get("output")),
        cache_write: arith(counts.get("cacheWrite")),
        cache_read: arith(counts.get("cacheRead")),
    };
    Ok(cost(model_prices::estimate_cost(&model, &counts)))
}
