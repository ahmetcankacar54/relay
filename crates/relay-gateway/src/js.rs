//! The few JavaScript behaviors the gateway's contracts depend on: `Date.parse`,
//! `toISOString`, `Number(text)`, `Math.round`, and JSON numbers written the way
//! `JSON.stringify` writes them (`3` and not `3.0`).

use chrono::{DateTime, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use serde::Serializer;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the epoch, as a clock tests can replace.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// `Date.now()`.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The wall clock as a [`Clock`].
pub fn system_clock() -> Clock {
    Arc::new(now_ms)
}

/// `Date.parse(text)` for the forms Relay and the providers write: ISO 8601 (with or without
/// an offset; a date-time without one is local time, a bare date UTC, as in JavaScript) and
/// RFC 2822 / HTTP dates. `None` where JavaScript answers `NaN`.
pub fn parse_date(text: &str) -> Option<i64> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    if let Ok(at) = DateTime::parse_from_rfc3339(text) {
        return Some(at.timestamp_millis());
    }
    // `2026-11-13T15:00:00.000+0300` and `…Z` variants chrono's RFC 3339 parser refuses.
    for format in ["%Y-%m-%dT%H:%M:%S%.f%z", "%Y-%m-%dT%H:%M%z"] {
        if let Ok(at) = DateTime::parse_from_str(text, format) {
            return Some(at.timestamp_millis());
        }
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(text, format) {
            return chrono::Local
                .from_local_datetime(&naive)
                .earliest()
                .map(|at| at.timestamp_millis());
        }
    }
    if let Ok(date) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        return date
            .and_hms_opt(0, 0, 0)
            .map(|naive| naive.and_utc().timestamp_millis());
    }
    DateTime::parse_from_rfc2822(text)
        .ok()
        .map(|at| at.timestamp_millis())
}

/// `new Date(ms).toISOString()`: `2026-11-13T15:00:00.000Z`.
pub fn iso_string(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms)
        .single()
        .map(|at| at.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_default()
}

/// `Number(text)`: surrounding whitespace ignored, empty is 0, hex/octal/binary literals and
/// `Infinity` read, anything else that is not a decimal literal `NaN`.
pub fn number(text: &str) -> f64 {
    let t = text.trim();
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let radix = |prefix: &[&str], base: u32| -> Option<f64> {
        prefix.iter().find_map(|p| t.strip_prefix(p)).map(|digits| {
            if digits.is_empty() {
                return f64::NAN;
            }
            u128::from_str_radix(digits, base)
                .map(|v| v as f64)
                .unwrap_or(f64::NAN)
        })
    };
    if let Some(v) = radix(&["0x", "0X"], 16)
        .or_else(|| radix(&["0o", "0O"], 8))
        .or_else(|| radix(&["0b", "0B"], 2))
    {
        return v;
    }
    // Rust also reads "inf", "nan" and "infinity", which JavaScript does not.
    if t.bytes()
        .any(|b| !(b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-')))
    {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Math.round`: halves go up.
pub fn round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// A finite number with no fraction that JSON can carry exactly as an integer.
fn integral(value: f64) -> Option<i64> {
    (value.is_finite() && value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0)
        .then_some(value as i64)
}

/// `String(number)` for the values Relay prints: integers without a fraction.
pub fn number_string(value: f64) -> String {
    match integral(value) {
        Some(i) => i.to_string(),
        None if value.is_nan() => "NaN".into(),
        None if value.is_infinite() => {
            if value > 0.0 {
                "Infinity".into()
            } else {
                "-Infinity".into()
            }
        }
        None => format!("{value}"),
    }
}

/// Serializes an `f64` as `JSON.stringify` would: integers without `.0`, `NaN` as `null`.
pub fn ser_f64<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    match integral(*value) {
        Some(i) => serializer.serialize_i64(i),
        None if !value.is_finite() => serializer.serialize_unit(),
        None => serializer.serialize_f64(*value),
    }
}

/// [`ser_f64`] for an optional number (used with `skip_serializing_if = "Option::is_none"`).
pub fn ser_opt_f64<S: Serializer>(value: &Option<f64>, serializer: S) -> Result<S::Ok, S::Error> {
    match value {
        Some(v) => ser_f64(v, serializer),
        None => serializer.serialize_none(),
    }
}

/// Constant-time equality of two byte strings of the same length.
pub fn timing_safe_equal(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    std::hint::black_box(diff) == 0
}

/// The first `max` UTF-16 code units of `text`, as `text.slice(0, max)` (never splitting a
/// character in two).
pub fn slice_units(text: &str, max: usize) -> &str {
    let mut units = 0;
    for (index, ch) in text.char_indices() {
        units += ch.len_utf16();
        if units > max {
            return &text[..index];
        }
    }
    text
}

/// `text.length` in UTF-16 code units.
pub fn units(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_read_and_print_as_in_javascript() {
        assert_eq!(number(" 42 "), 42.0);
        assert_eq!(number(""), 0.0);
        assert!(number("lots").is_nan());
        assert!(number("inf").is_nan());
        assert_eq!(number("0x10"), 16.0);
        assert_eq!(number("1e3"), 1000.0);
        assert_eq!(number_string(1.0), "1");
        assert_eq!(number_string(1.5), "1.5");
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
    }

    #[test]
    fn dates_parse_and_print_as_in_javascript() {
        let ms = parse_date("2026-11-13T15:00:00Z").unwrap();
        assert_eq!(iso_string(ms), "2026-11-13T15:00:00.000Z");
        assert_eq!(parse_date("2026-11-13T15:00:00.000Z"), Some(ms));
        assert_eq!(parse_date("2026-11-13T18:00:00+03:00"), Some(ms));
        assert_eq!(parse_date("Fri, 13 Nov 2026 15:00:00 GMT"), Some(ms));
        assert_eq!(parse_date("2026-11-13"), parse_date("2026-11-13T00:00:00Z"));
        assert_eq!(parse_date("yesterday"), None);
    }
}
