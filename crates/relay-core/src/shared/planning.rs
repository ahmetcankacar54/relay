//! Port of `shared/planning.ts`: local dates and clocks in a planning time zone, wall times
//! across DST changes, and the account facts planning reads. Times are epoch ms as `f64`.

use chrono::{Datelike, TimeZone, Timelike};
use chrono_tz::Tz;

use super::time_zones::{parse_time_zone, valid_time_zone};
use super::types::js::date_parse;
use super::types::{Account, AccountPlan, PlanningSettings, default_planning_settings};

const HOUR: f64 = 3_600_000.0;

/// The `en-CA` `h23` parts `Intl.DateTimeFormat` gives for an instant in a zone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalParts {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

impl LocalParts {
    pub fn date(&self) -> String {
        format!("{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }
}

/// The zone to read clocks in; one `Intl` would refuse reads as UTC (the TS throws there).
fn zone(time_zone: &str) -> Tz {
    parse_time_zone(time_zone).unwrap_or(Tz::UTC)
}

/// The local parts of `time` in `time_zone`; `None` for an invalid time (where `Intl` throws).
pub fn local_parts(time: f64, time_zone: &str) -> Option<LocalParts> {
    if !time.is_finite() || time.abs() > 8.64e15 {
        return None;
    }
    let at = chrono::Utc.timestamp_millis_opt(time.trunc() as i64).single()?;
    let local = at.with_timezone(&zone(time_zone));
    Some(LocalParts {
        year: local.year(),
        month: local.month(),
        day: local.day(),
        hour: local.hour(),
        minute: local.minute(),
        second: local.second(),
    })
}

/// `YYYY-MM-DD` of `time` in `time_zone`; `""` for an invalid time.
pub fn local_date(time: f64, time_zone: &str) -> String {
    local_parts(time, time_zone).map(|p| p.date()).unwrap_or_default()
}

/// The local quarter hour (0–95) of `time` in `time_zone`; a repeated DST hour shares its slots.
pub fn local_slot(time: f64, time_zone: &str) -> f64 {
    local_parts(time, time_zone).map_or(f64::NAN, |p| f64::from((p.hour * 60 + p.minute) / 15))
}

/// The local clock hour (0–23) of `time` in `time_zone`.
pub fn local_hour(time: f64, time_zone: &str) -> f64 {
    local_parts(time, time_zone).map_or(f64::NAN, |p| f64::from(p.hour))
}

fn is_date(date: &str) -> bool {
    let b = date.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// `^([01]\d|2[0-3]):[0-5]\d$`.
pub fn is_clock(clock: &str) -> bool {
    let b = clock.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && matches!((b[0], b[1]), (b'0' | b'1', b'0'..=b'9') | (b'2', b'0'..=b'3'))
        && matches!(b[3], b'0'..=b'5')
        && b[4].is_ascii_digit()
}

/// The instant of `clock` on `date` in `time_zone`, using the zone's actual offsets on either side
/// of a DST change. A skipped time is `None`; a repeated one is its first occurrence, so no
/// quota-consuming job can run twice in the repeated hour.
pub fn wall_time(date: &str, clock: &str, time_zone: &str) -> Option<f64> {
    if !is_date(date) || !is_clock(clock) {
        return None;
    }
    let nominal = date_parse(&format!("{date}T{clock}:00Z"));
    if !nominal.is_finite() {
        return None;
    }
    let mut offsets: Vec<f64> = Vec::new();
    for delta in [-36.0, -12.0, 0.0, 12.0, 36.0] {
        let probe = nominal + delta * HOUR;
        let Some(p) = local_parts(probe, time_zone) else { continue };
        let local = date_parse(&format!(
            "{}T{:02}:{:02}:{:02}Z",
            p.date(),
            p.hour,
            p.minute,
            p.second
        ));
        let offset = local - probe;
        if !offsets.iter().any(|o| o == &offset || (o.is_nan() && offset.is_nan())) {
            offsets.push(offset);
        }
    }
    let matches = offsets.into_iter().map(|offset| nominal - offset).filter(|candidate| {
        local_parts(*candidate, time_zone)
            .is_some_and(|p| p.date() == date && format!("{:02}:{:02}", p.hour, p.minute) == clock)
    });
    matches.fold(None, |min: Option<f64>, t| Some(min.map_or(t, |m| m.min(t))))
}

/// `wall_time`, or for a clock a DST change skips, the first existing quarter hour after it within
/// two hours on the same date (02:30 on a spring-forward night is 03:00); `None` when none exists.
pub fn wall_time_or_next(date: &str, clock: &str, time_zone: &str) -> Option<f64> {
    let exact = wall_time(date, clock, time_zone);
    if exact.is_some() || !is_clock(clock) {
        return exact;
    }
    let minutes = clock[..2].parse::<u32>().ok()? * 60 + clock[3..5].parse::<u32>().ok()?;
    let mut later = minutes + 15;
    while later <= minutes + 120 {
        if later >= 24 * 60 {
            return None;
        }
        let next = format!("{:02}:{:02}", later / 60, later % 60);
        if let Some(time) = wall_time(date, &next, time_zone) {
            return Some(time);
        }
        later += 15;
    }
    None
}

/// The system's time zone when it is one Relay can plan in, else UTC.
pub fn system_time_zone() -> String {
    match iana_time_zone::get_timezone() {
        Ok(zone) if valid_time_zone(&zone) => zone,
        _ => "UTC".into(),
    }
}

/// Planning settings for a new registry: the defaults in the system's time zone.
pub fn default_planning() -> PlanningSettings {
    PlanningSettings { time_zone: system_time_zone(), ..default_planning_settings() }
}

/// `uuid:org` of the account's Claude Code sign-in, when it is signed in and agrees with its
/// Claude app sign-in.
pub fn planning_identity(a: &Account) -> Option<String> {
    let auth = a.auth.as_ref().filter(|auth| auth.logged_in)?;
    let uuid = auth.account_uuid.as_deref().filter(|s| !s.is_empty())?;
    let org = auth.org_id.as_deref().filter(|s| !s.is_empty())?;
    if let Some(desktop) = &a.desktop
        && (uuid != desktop.account_uuid || org != desktop.org_id)
    {
        return None;
    }
    Some(format!("{uuid}:{org}"))
}

/// The account's capacity in Pro windows: 1, 5, 20, or its weight (1–100).
pub fn plan_capacity(a: &Account) -> f64 {
    match a.planning.as_ref().map(|p| p.plan) {
        Some(AccountPlan::Pro) => 1.0,
        Some(AccountPlan::Max5) => 5.0,
        Some(AccountPlan::Max20) => 20.0,
        _ => {
            let weight = a.planning.as_ref().map_or(1.0, |p| p.capacity_weight);
            if weight.is_finite() { weight.clamp(1.0, 100.0) } else { 1.0 }
        }
    }
}
