//! Port of `shared/percent.ts`. Every limit percentage Relay shows is the percent USED, as on
//! Claude's own usage page: `%94 kullanıldı` in Turkish, `94% used` in English.

use relay_i18n::{Args, Locale, translate};

use super::number_format::{Decimal, body, symbols};

/// A rounded percentage in the language's style: `%45` in Turkish, `45%` in English, `45 %` in
/// German; `—` when unknown.
pub fn format_percent(value: Option<f64>, language: Locale) -> String {
    let Some(value) = value.filter(|v| v.is_finite()) else {
        return "—".into();
    };
    let symbols = symbols(language);
    let mut decimal = Decimal::from_f64(super::types::js::round(value) / 100.0);
    decimal.shift(2);
    decimal.round(0);
    let sign = if decimal.negative { "-" } else { "" };
    format!(
        "{sign}{}{}{}",
        symbols.percent_prefix,
        body(&decimal, 0, false, 1, &symbols),
        symbols.percent_suffix
    )
}

/// The percent used of a window for display: rounded down so only a full window reads 100, kept
/// between 0 and 100; `None` when unknown.
pub fn percent_used(used_percent: Option<f64>) -> Option<f64> {
    use super::types::js::{max, min};
    used_percent
        .filter(|v| v.is_finite())
        .map(|v| max([0.0, min([100.0, v])]).floor())
}

/// The word that follows a percentage used.
pub fn used_word(language: Locale) -> String {
    translate(language, "percent.usedWord", &Args::new())
}

/// `%94 kullanıldı` / `94% used` from the percent used; `—` when unknown.
pub fn format_used(used_percent: Option<f64>, language: Locale) -> String {
    match percent_used(used_percent) {
        None => "—".into(),
        Some(used) => translate(
            language,
            "percent.used",
            &Args::new().set("percent", format_percent(Some(used), language)),
        ),
    }
}
