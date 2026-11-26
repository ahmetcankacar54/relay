//! The Rust port of `shared/percent.ts`, delegating to `relay_core::shared::percent`.

#![forbid(unsafe_code)]

use relay_core::shared::percent;
use relay_i18n::Locale;
use serde_json::Value;

/// A `Locale` argument: one of the locale ids.
fn locale(language: &Value) -> Result<Locale, String> {
    language
        .as_str()
        .and_then(Locale::parse)
        .ok_or_else(|| format!("TypeError: not a locale: {language}"))
}

/// Port of `formatPercent` (`shared/percent.ts:12`).
pub fn format_percent(value: Option<f64>, language: Value) -> Result<Value, String> {
    Ok(percent::format_percent(value, locale(&language)?).into())
}

/// Port of `percentUsed` (`shared/percent.ts:26`).
pub fn percent_used(used_percent: Option<f64>) -> Result<Value, String> {
    Ok(percent::percent_used(used_percent).map_or_else(crate::js::undefined, crate::js::number))
}

/// Port of `usedWord` (`shared/percent.ts:33`).
pub fn used_word(language: Value) -> Result<Value, String> {
    Ok(percent::used_word(locale(&language)?).into())
}

/// Port of `formatUsed` (`shared/percent.ts:36`).
pub fn format_used(used_percent: Option<f64>, language: Value) -> Result<Value, String> {
    Ok(percent::format_used(used_percent, locale(&language)?).into())
}
