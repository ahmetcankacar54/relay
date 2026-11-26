//! The Rust port of `shared/browser-extension.ts`, delegating to
//! `relay_core::shared::browser_extension`.
//!
//! Arguments arrive as JSON. `chooseInstance` and `pickInstance` run on any values the way JS
//! does: an instance is matched by JS strict equality of its `app` and `profile`, so each is read
//! into relay-core's `ExtensionInstance` with both folded into `profile` (values that equal
//! nothing, objects and NaN, get a key of their own) and `usedAt` as the number `>` compares.
//! The chosen one is returned as the caller's own value.

#![forbid(unsafe_code)]

use relay_core::shared::browser_extension::{
    self as be, BrowserApp, ExtensionInstance, ExtensionMode, ExtensionTarget, InstancePicked,
};
use relay_core::shared::types::js::number_value;
use serde_json::{Value, json};

use crate::js::{is_undefined, string_units, undefined, utf16_string};

/// Port of `browserApps` (`shared/browser-extension.ts:146`).
pub fn browser_apps(platform: Option<String>) -> Result<Vec<Value>, String> {
    Ok(be::browser_apps(platform.as_deref())
        .into_iter()
        .map(|app| Value::from(app.as_str()))
        .collect())
}

/// Port of `writesBrowser` (`shared/browser-extension.ts:178`): a value that is no mode is
/// neither "restart" nor "closed".
pub fn writes_browser(mode: Value) -> Result<bool, String> {
    Ok(serde_json::from_value::<ExtensionMode>(mode).is_ok_and(be::writes_browser))
}

/// Port of `localStateProfiles` (`shared/browser-extension.ts:329`).
pub fn local_state_profiles(local_state: Value) -> Result<Vec<Value>, String> {
    Ok(be::local_state_profiles(&local_state)
        .into_iter()
        .map(|p| json!({ "profile": p.profile, "name": p.name }))
        .collect())
}

/// Port of `startupRestores` (`shared/browser-extension.ts:365`).
pub fn startup_restores(preferences: Value) -> Result<bool, String> {
    Ok(be::startup_restores(&preferences))
}

/// A JS number marker (`{"$num": "NaN"}` and friends).
fn marked_number(value: &Value) -> Option<f64> {
    let o = value.as_object().filter(|o| o.len() == 1)?;
    o.get("$num")?.as_str().map(number_value)
}

fn is_nullish(value: &Value) -> bool {
    value.is_null() || is_undefined(value)
}

/// JS truthiness.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        v if is_undefined(v) => false,
        v => marked_number(v).is_none_or(|n| n != 0.0 && !n.is_nan()),
    }
}

/// `value.key` for a value that is not null or undefined: an object's own property, else
/// `undefined`.
fn property<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(o) if marked_number(value).is_none() && string_units(value).is_none() => {
            o.get(key).filter(|v| !is_undefined(v))
        }
        _ => None,
    }
}

/// A key equal to another exactly when the values are `===`; objects and NaN equal nothing.
fn strict_key(value: Option<&Value>, unique: &mut usize) -> String {
    let mut own = || {
        *unique += 1;
        format!("o{unique}")
    };
    let number = |n: f64| {
        if n.is_nan() {
            None
        } else {
            Some(format!("n{}", n + 0.0))
        }
    };
    match value {
        None => "u".into(),
        Some(Value::Null) => "l".into(),
        Some(Value::Bool(b)) => format!("b{b}"),
        Some(Value::Number(n)) => number(n.as_f64().unwrap_or(f64::NAN)).unwrap_or_else(own),
        Some(Value::String(s)) => format!("s{s}"),
        Some(v) if is_undefined(v) => "u".into(),
        Some(v) => match (marked_number(v), string_units(v)) {
            (Some(n), _) => number(n).unwrap_or_else(own),
            (_, Some(units)) => format!("s{units:?}"),
            _ => own(),
        },
    }
}

/// `ToNumber(usedAt ?? 0)`, what `>` compares.
fn used_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => number_value(s),
        Value::Array(items) => match items.as_slice() {
            [] => 0.0,
            [one] => match one {
                Value::String(s) => number_value(s),
                Value::Number(_) | Value::Array(_) => used_number(one),
                v if is_nullish(v) => 0.0,
                v => marked_number(v).unwrap_or(f64::NAN),
            },
            _ => f64::NAN,
        },
        v => marked_number(v).unwrap_or(f64::NAN),
    }
}

/// An instance for relay-core: `app` and `profile` folded into `profile`; a nullish one (whose
/// properties JS cannot read) matches nothing.
fn surrogate(value: &Value, unique: &mut usize) -> ExtensionInstance {
    let (profile, used_at) = if is_nullish(value) {
        (strict_key(Some(&json!({})), unique), None)
    } else {
        let app = strict_key(property(value, "app"), unique);
        let profile = strict_key(property(value, "profile"), unique);
        (
            format!("{app}\u{0}{profile}"),
            property(value, "usedAt").map(used_number),
        )
    };
    ExtensionInstance {
        app: BrowserApp::Chrome,
        profile,
        name: String::new(),
        opened: false,
        used_at,
    }
}

/// `instances` that is no array: JS reads `.find` (when something is chosen) and `.length`,
/// returns `instances[0]` when that is 1, and calls `.filter` otherwise, which only arrays have.
fn pick_from_other(instances: &Value, chosen: &Value) -> Result<Option<Value>, String> {
    let not_array = || Err("TypeError: instances is not an array".to_string());
    if is_nullish(instances) || truthy(chosen) {
        return not_array();
    }
    if let Some(units) = string_units(instances) {
        return match units.as_slice() {
            [one] => Ok(Some(utf16_string(&[*one]))),
            _ => not_array(),
        };
    }
    match property(instances, "length").and_then(Value::as_f64) {
        Some(1.0) => Ok(Some(
            property(instances, "0").cloned().unwrap_or_else(undefined),
        )),
        _ => not_array(),
    }
}

/// The instance picked, as the caller's value, and how; `Err` where JS reads a property of a
/// nullish instance on the way (`find` up to the match, `filter` over all).
fn pick(instances: &Value, chosen: &Value) -> Result<Option<(Value, InstancePicked)>, String> {
    let Value::Array(instances) = instances else {
        return Ok(pick_from_other(instances, chosen)?.map(|v| (v, InstancePicked::Only)));
    };
    let mut unique = 0;
    let list: Vec<ExtensionInstance> = instances
        .iter()
        .map(|v| surrogate(v, &mut unique))
        .collect();
    let target = truthy(chosen).then(|| {
        let app = strict_key(property(chosen, "app"), &mut unique);
        let profile = strict_key(property(chosen, "profile"), &mut unique);
        ExtensionTarget {
            app: BrowserApp::Chrome,
            profile: format!("{app}\u{0}{profile}"),
        }
    });
    let picked = be::pick_instance(&list, target.as_ref())
        .and_then(|(found, how)| Some((list.iter().position(|i| std::ptr::eq(i, found))?, how)));
    // `find` reads up to the match (all when none); a lone instance is returned without a read
    // when nothing was chosen; `filter` reads all.
    let read = match picked {
        Some((index, InstancePicked::Chosen)) => index + 1,
        Some((_, InstancePicked::Only)) if target.is_none() => 0,
        _ => instances.len(),
    };
    if instances[..read].iter().any(is_nullish) {
        return Err("TypeError: Cannot read properties of an instance that is not set".into());
    }
    Ok(picked.map(|(index, how)| (instances[index].clone(), how)))
}

/// Port of `chooseInstance` (`shared/browser-extension.ts:375`).
pub fn choose_instance(instances: Value, chosen: Option<Value>) -> Result<Value, String> {
    let chosen = chosen.unwrap_or(Value::Null);
    Ok(pick(&instances, &chosen)?.map_or_else(undefined, |(instance, _)| instance))
}

/// Port of `pickInstance` (`shared/browser-extension.ts:382`).
pub fn pick_instance(instances: Value, chosen: Option<Value>) -> Result<Value, String> {
    let chosen = chosen.unwrap_or(Value::Null);
    Ok(match pick(&instances, &chosen)? {
        Some((instance, picked)) => {
            let picked = match picked {
                InstancePicked::Chosen => "chosen",
                InstancePicked::Only => "only",
                InstancePicked::Recent => "recent",
            };
            json!({ "instance": instance, "picked": picked })
        }
        None => undefined(),
    })
}
