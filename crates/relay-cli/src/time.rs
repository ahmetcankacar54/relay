//! Port of `cli/src/time.ts`.

use relay_core::fs_util::parse_iso_ms;
use relay_i18n::Args;

use crate::i18n::T;

/// How long until `iso`, as "2 sa 10 dk" / "2 h 10 min", or days and hours past a day.
pub fn until_text(iso: &str, now: i64, t: T) -> String {
    let minutes = match parse_iso_ms(iso) {
        Some(at) => (((at - now) as f64) / 60_000.0).floor().max(0.0) as i64,
        // `Math.max(0, NaN)` is NaN, and every part of it NaN, so it reads as under a minute.
        None => 0,
    };
    let days = minutes / 1440;
    let hours = (minutes % 1440) / 60;
    let mins = minutes % 60;
    if days != 0 {
        return if hours != 0 {
            t.f(
                "srcTime.dH",
                Args::new().set("days", days).set("hours", hours),
            )
        } else {
            t.f("srcTime.d", Args::new().set("days", days))
        };
    }
    if hours != 0 {
        return if mins != 0 {
            t.f(
                "srcTime.hMin",
                Args::new().set("hours", hours).set("mins", mins),
            )
        } else {
            t.f("srcTime.h", Args::new().set("hours", hours))
        };
    }
    if mins != 0 {
        t.f("srcTime.min", Args::new().set("mins", mins))
    } else {
        t.t("srcTime.underAMinute")
    }
}
