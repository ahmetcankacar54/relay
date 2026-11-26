//! The Rust port of `shared/error-text.ts`, delegating to `relay_core::shared::error_text`.
//!
//! Recorded with every catalog registered (`original.ts`), as the app and the CLI run it.

#![forbid(unsafe_code)]

use relay_core::shared::error_text;
use relay_i18n::Locale;

/// Port of `localizeError` (`shared/error-text.ts:369`). A language that is not one of Relay's
/// has no catalog registered, so `tFor` reads it in English.
pub fn localize_error(message: String, language: serde_json::Value) -> Result<String, String> {
    let locale = language
        .as_str()
        .and_then(Locale::parse)
        .unwrap_or(Locale::En);
    Ok(error_text::localize_error(&message, locale))
}
