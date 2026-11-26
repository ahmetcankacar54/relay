//! The Rust port of `shared/routine-failure.ts`, delegating to
//! `relay_core::shared::routine_failure`.

#![forbid(unsafe_code)]

use relay_core::shared::routine_failure;
use relay_i18n::Locale;
use serde_json::Value;

/// The `Locale` argument: one of the locale ids; anything else reads as English, as `tFor` falls
/// back to the English catalog for a language it does not know.
fn locale(language: &Value) -> Locale {
    language
        .as_str()
        .and_then(Locale::parse)
        .unwrap_or(Locale::En)
}

/// Port of `routineFailure` (`shared/routine-failure.ts:20`).
pub fn routine_failure(reason: Option<String>) -> Result<serde_json::Value, String> {
    Ok(routine_failure::routine_failure(reason.as_deref())
        .map_or_else(crate::js::undefined, Value::from))
}

/// Port of `routineFailureNotice` (`shared/routine-failure.ts:26`).
pub fn routine_failure_notice(
    name: String,
    reason: String,
    language: serde_json::Value,
) -> Result<String, String> {
    Ok(routine_failure::routine_failure_notice(
        &name,
        &reason,
        locale(&language),
    ))
}
