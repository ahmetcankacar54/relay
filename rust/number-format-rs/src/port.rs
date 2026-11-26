//! The Rust port of `shared/number-format.ts`, delegating to `relay_core::shared::number_format`.

#![forbid(unsafe_code)]

use relay_core::shared::number_format;
use relay_i18n::Locale;
use serde_json::Value;

/// A `Locale` argument: one of the locale ids.
fn locale(language: &Value) -> Result<Locale, String> {
    language
        .as_str()
        .and_then(Locale::parse)
        .ok_or_else(|| format!("TypeError: not a locale: {language}"))
}

/// Port of `formatTokens` (`shared/number-format.ts:8`).
pub fn format_tokens(value: f64, language: Value) -> Result<Value, String> {
    Ok(number_format::format_tokens(value, locale(&language)?).into())
}

/// Port of `formatCost` (`shared/number-format.ts:22`).
pub fn format_cost(value: f64, language: Value) -> Result<Value, String> {
    Ok(number_format::format_cost(value, locale(&language)?).into())
}

/// Port of `formatChange` (`shared/number-format.ts:42`).
pub fn format_change(change: f64, language: Value) -> Result<Value, String> {
    Ok(number_format::format_change(change, locale(&language)?).into())
}
