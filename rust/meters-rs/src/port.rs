//! The Rust port of `shared/meters.ts`, delegating to `relay_core::shared::meters`.

#![forbid(unsafe_code)]

use relay_core::shared::meters::{self, METER_PROVIDERS, MeterProvider};
use serde_json::Value;

/// `settings.meters` read as JS reads it for `settings.meters?.includes(provider)`: the providers
/// that call answers `true` for, or the `TypeError` JS throws.
fn meter_list(settings: &Value) -> Result<Option<Vec<MeterProvider>>, String> {
    let meters = match settings {
        Value::Null => {
            return Err("TypeError: Cannot read properties of null (reading 'meters')".into());
        }
        _ if crate::js::is_undefined(settings) => {
            return Err("TypeError: Cannot read properties of undefined (reading 'meters')".into());
        }
        Value::Object(o) => o.get("meters"),
        _ => None,
    };
    match meters {
        None | Some(Value::Null) => Ok(None),
        Some(m) if crate::js::is_undefined(m) => Ok(None),
        // `Array.prototype.includes`: unknown entries never match a provider.
        Some(Value::Array(items)) => Ok(Some(
            items
                .iter()
                .filter_map(|item| item.as_str().and_then(MeterProvider::parse))
                .collect(),
        )),
        // `String.prototype.includes`: a substring test.
        Some(Value::String(text)) => Ok(Some(
            METER_PROVIDERS
                .into_iter()
                .filter(|p| text.contains(p.as_str()))
                .collect(),
        )),
        // A string with lone surrogates, as `index.cjs` sends it.
        Some(m @ Value::Object(o)) if o.contains_key("$utf16") => {
            let text = crate::js::string_units(m).map(|units| String::from_utf16_lossy(&units));
            Ok(Some(
                METER_PROVIDERS
                    .into_iter()
                    .filter(|p| text.as_deref().is_some_and(|t| t.contains(p.as_str())))
                    .collect(),
            ))
        }
        Some(_) => Err("TypeError: settings.meters?.includes is not a function".into()),
    }
}

/// Port of `enabledMeters` (`shared/meters.ts:104`).
pub fn enabled_meters(settings: Value) -> Result<Vec<Value>, String> {
    let list = meter_list(&settings)?;
    Ok(meters::enabled_meters(list.as_deref())
        .into_iter()
        .map(|p| Value::from(p.as_str()))
        .collect())
}
