//! The Rust port of `shared/shortcuts.ts`, delegating to `relay_core::shared::shortcuts`.

#![forbid(unsafe_code)]

use relay_core::shared::shortcuts::{self, KeyPress};
use relay_core::shared::types::{ShortcutAction, ShortcutSettings};
use serde_json::Value;

/// JS truthiness of a structured value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => !crate::js::is_undefined(value) && !is_nan(value),
    }
}

fn is_nan(value: &Value) -> bool {
    value
        .as_object()
        .is_some_and(|o| o.len() == 1 && o.get("$num") == Some(&Value::from("NaN")))
}

/// Port of `shortcutFor` (`shared/shortcuts.ts:19`). `choice?.[action]` that is a string becomes
/// the Rust setting; `null` and `undefined` read as missing (`??`); any other value is what the
/// TS returns as it is. An action outside `ShortcutAction` has no default: the TS reads the
/// choice's key of that name, else `undefined`.
pub fn shortcut_for(choice: Option<Value>, action: String) -> Result<Value, String> {
    let saved = match choice.as_ref().and_then(|c| c.get(&action)) {
        None | Some(Value::Null) => None,
        Some(v) if crate::js::is_undefined(v) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => return Ok(other.clone()),
    };
    let Ok(action) = serde_json::from_value::<ShortcutAction>(Value::String(action)) else {
        return Ok(saved.map_or_else(crate::js::undefined, Value::String));
    };
    let settings = match action {
        ShortcutAction::OpenPanel => ShortcutSettings {
            open_panel: saved,
            ..Default::default()
        },
        ShortcutAction::SwitchToSuggested => ShortcutSettings {
            switch_to_suggested: saved,
            ..Default::default()
        },
    };
    Ok(Value::String(shortcuts::shortcut_for(
        Some(&settings),
        action,
    )))
}

/// Port of `normalizeAccelerator` (`shared/shortcuts.ts:103`).
pub fn normalize_accelerator(text: String) -> Result<Option<String>, String> {
    Ok(shortcuts::normalize_accelerator(&text))
}

/// Port of `acceleratorFromKeys` (`shared/shortcuts.ts:161`).
pub fn accelerator_from_keys(press: Value, platform: String) -> Result<Option<String>, String> {
    let code = match press.get("code") {
        Some(Value::String(code)) => code.clone(),
        _ => return Err("TypeError: press.code is not a string".into()),
    };
    let flag = |key: &str| press.get(key).is_some_and(truthy);
    let press = KeyPress {
        code,
        meta_key: flag("metaKey"),
        ctrl_key: flag("ctrlKey"),
        alt_key: flag("altKey"),
        shift_key: flag("shiftKey"),
    };
    Ok(shortcuts::accelerator_from_keys(&press, &platform))
}

/// Port of `formatAccelerator` (`shared/shortcuts.ts:208`).
pub fn format_accelerator(accelerator: String, platform: String) -> Result<String, String> {
    Ok(shortcuts::format_accelerator(&accelerator, &platform))
}
