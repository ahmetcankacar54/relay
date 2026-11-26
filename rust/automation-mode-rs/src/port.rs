//! The Rust port of `shared/automation-mode.ts`, delegating to
//! `relay_core::shared::automation_mode`.

#![forbid(unsafe_code)]

use relay_core::shared::automation_mode::{self, AutomationMode};
use relay_core::shared::types::AutoSwitchMode;
use serde_json::Value;

/// Port of `automationMode` (`shared/automation-mode.ts:11`): any `autoSwitchMode` but
/// "after-exit" reads as off, and only a truthy `fleet.enabled` as the fleet.
pub fn automation_mode(
    settings: serde_json::Value,
    fleet: Option<serde_json::Value>,
) -> Result<String, String> {
    let mode = match settings.get("autoSwitchMode").and_then(Value::as_str) {
        Some("after-exit") => AutoSwitchMode::AfterExit,
        _ => AutoSwitchMode::Off,
    };
    let enabled = fleet.as_ref().and_then(|f| f.get("enabled")).map(truthy);
    Ok(automation_mode::automation_mode(mode, enabled)
        .as_str()
        .into())
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Object(_) => {
            !parity_args::is_undefined(value)
                && crate::js::as_number(value).is_none_or(|n| n != 0.0 && !n.is_nan())
        }
        Value::Array(_) => true,
    }
}

/// Port of `automationModeWrites` (`shared/automation-mode.ts:20`).
pub fn automation_mode_writes(mode: String) -> Result<serde_json::Value, String> {
    let mode: AutomationMode =
        serde_json::from_value(Value::from(mode)).map_err(|e| format!("TypeError: {e}"))?;
    serde_json::to_value(automation_mode::automation_mode_writes(mode)).map_err(|e| e.to_string())
}
