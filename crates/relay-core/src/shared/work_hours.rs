//! Port of `shared/work-hours.ts`: the work interval of a planned day.

use serde::{Deserialize, Serialize};

use super::planning::{wall_time, wall_time_or_next};
use super::types::PlanningSettings;
use super::types::js::{date_parse, iso, ser_num};

/// A Claude usage window lasts five hours from its first message.
pub const WINDOW_MS: f64 = 5.0 * 60.0 * 60_000.0;
const DAY_MS: f64 = 24.0 * 60.0 * 60_000.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkInterval {
    pub date: String,
    #[serde(serialize_with = "ser_num")]
    pub start: f64,
    #[serde(serialize_with = "ser_num")]
    pub end: f64,
    pub weekend: bool,
}

/// The date `delta` days from `date` (`YYYY-MM-DD`); `""` for a date that does not parse (where
/// the TS throws).
pub fn shift_date(date: &str, delta: f64) -> String {
    let at = date_parse(&format!("{date}T12:00:00Z")) + delta * DAY_MS;
    let text = iso(at);
    text.get(..10).unwrap_or("").to_string()
}

/// Saturday or Sunday.
pub fn is_weekend(date: &str) -> bool {
    let at = date_parse(&format!("{date}T12:00:00Z"));
    if !at.is_finite() {
        return false;
    }
    // 1970-01-01 was a Thursday.
    let day = ((at / DAY_MS).floor() as i64 + 4).rem_euclid(7);
    day == 0 || day == 6
}

/// Work hours that start on `date`; an end at or before the start is the next day. A start or end
/// a DST change skips moves to the first time after it.
pub fn work_interval(date: &str, settings: &PlanningSettings) -> Option<WorkInterval> {
    let weekend = is_weekend(date);
    let hours = if weekend { &settings.weekend } else { &settings.weekday };
    if !hours.enabled {
        return None;
    }
    let start = wall_time_or_next(date, &hours.start, &settings.time_zone)?;
    let end_date = if hours.end <= hours.start { shift_date(date, 1.0) } else { date.to_string() };
    let end = wall_time_or_next(&end_date, &hours.end, &settings.time_zone)?;
    if end <= start {
        return None;
    }
    Some(WorkInterval { date: date.to_string(), start, end, weekend })
}

/// The first existing instant of a calendar day; DST can skip midnight.
pub fn day_start(date: &str, zone: &str) -> f64 {
    for clock in ["00:00", "00:30", "01:00"] {
        if let Some(time) = wall_time(date, clock, zone) {
            return time;
        }
    }
    date_parse(&format!("{date}T00:00:00Z"))
}
