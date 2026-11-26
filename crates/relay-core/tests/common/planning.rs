//! Fixtures for the P4Planning ports: tests/planning-fixtures.ts and the planning tests' own
//! builders.
#![allow(dead_code)]

use relay_core::shared::capacity_plan::Forecast;
use relay_core::shared::planning::wall_time;
use relay_core::shared::tempo::{Tempo, TempoDays, TempoRates, TempoSource};
use relay_core::shared::types::js::{JsMap, date_parse, iso};
use relay_core::shared::types::{
    Account, AccountUsage, PlanningAccount, PlanningHours, PlanningSettings,
    default_planning_settings,
};
use relay_core::shared::usage_statistics::{UsageSample, usage_identity};
use serde_json::{Value, json};

pub const MINUTE: f64 = 60_000.0;
pub const HOUR: f64 = 3_600_000.0;
pub const ZONE: &str = "Europe/Istanbul";

/// `NOW` of tests/planning-fixtures.ts.
pub fn fixture_now() -> f64 {
    date_parse("2026-10-13T05:59:45Z")
}

pub fn from_json<T: serde::de::DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).expect("fixture")
}

/// `planningAccount(id, plan)`.
pub fn planning_account(id: &str, plan: &str) -> Account {
    from_json(json!({
        "id": id,
        "name": id,
        "kind": "personal",
        "group": "personal",
        "color": "olive",
        "createdAt": iso(fixture_now()),
        "planning": { "plan": plan, "capacityWeight": 1 },
        "auth": {
            "loggedIn": true,
            "accountUuid": id,
            "orgId": format!("org-{id}"),
            "subscription": "pro",
            "checkedAt": iso(fixture_now()),
        },
    }))
}

/// `planningAccount(id, "team")` with a capacity weight.
pub fn team_account(id: &str, weight: f64) -> Account {
    let mut account = planning_account(id, "team");
    account.planning.as_mut().expect("planned").capacity_weight = weight;
    account
}

/// `wallTime(date, clock, zone)!`.
pub fn wall(date: &str, clock: &str, zone: &str) -> f64 {
    wall_time(date, clock, zone).expect("a wall time")
}

pub fn hours(enabled: bool, start: &str, end: &str) -> PlanningHours {
    PlanningHours {
        enabled,
        start: start.into(),
        end: end.into(),
    }
}

pub fn planned(ids: &[&str]) -> Vec<PlanningAccount> {
    ids.iter()
        .map(|id| PlanningAccount {
            id: (*id).into(),
            first_start: None,
        })
        .collect()
}

pub fn planned_accounts(accounts: &[Account]) -> Vec<PlanningAccount> {
    planned(&accounts.iter().map(|a| a.id.as_str()).collect::<Vec<_>>())
}

/// `{ ...DEFAULT_PLANNING, timeZone, weekday, weekend, accounts }`.
pub fn planning(
    zone: &str,
    weekday: PlanningHours,
    weekend: PlanningHours,
    accounts: Vec<PlanningAccount>,
) -> PlanningSettings {
    PlanningSettings {
        time_zone: zone.into(),
        weekday,
        weekend,
        accounts,
        ..default_planning_settings()
    }
}

/// A tempo of `weekday`/`weekend` profiles, learned over 15 and 2 days.
pub fn learned(weekday: Vec<f64>, weekend: Vec<f64>, rate: (f64, f64)) -> Tempo {
    Tempo {
        source: TempoSource::Learned,
        weekday,
        weekend,
        rate: TempoRates {
            weekday: rate.0,
            weekend: rate.1,
        },
        days: TempoDays {
            weekday: 15,
            weekend: 2,
        },
    }
}

/// Every hour at `rate` Pro units.
pub fn flat_tempo(rate: f64) -> Tempo {
    learned(vec![rate; 24], vec![rate; 24], (rate, rate))
}

/// The busy Wednesday of the capacity scenario (205 outside its hours).
pub fn busy_tempo() -> Tempo {
    let busy = [
        220.0, 242.0, 242.0, 110.0, 198.0, 242.0, 242.0, 220.0, 154.0,
    ];
    let weekday = (0..24)
        .map(|h| {
            if (9..18).contains(&h) {
                busy[h - 9]
            } else {
                205.0
            }
        })
        .collect();
    learned(weekday, vec![205.0; 24], (205.0, 205.0))
}

/// A busy day's shape from 09:00 to 18:00, nothing outside, times `scale`.
pub fn busy_scaled(scale: f64) -> Tempo {
    let busy = [180.0, 230.0, 250.0, 80.0, 170.0, 240.0, 230.0, 200.0, 140.0];
    let profile: Vec<f64> = (0..24)
        .map(|h| {
            if (9..18).contains(&h) {
                busy[h - 9] * scale
            } else {
                0.0
            }
        })
        .collect();
    learned(profile.clone(), profile, (250.0 * scale, 250.0 * scale))
}

/// Usage read at `now`: the five-hour window `used` percent full, open until `resets` when
/// given, and the week `weekly` percent used, resetting in three days.
pub fn fresh_at(id: &str, now: f64, used: f64, resets: Option<f64>, weekly: f64) -> AccountUsage {
    let mut five = json!({ "usedPercent": used });
    if let Some(resets) = resets {
        five["resetsAt"] = json!(iso(resets));
    }
    from_json(json!({
        "accountId": id,
        "status": "ready",
        "stale": false,
        "checkedAt": iso(now),
        "fiveHour": five,
        "sevenDay": { "usedPercent": weekly, "resetsAt": iso(now + 3.0 * 86_400_000.0) },
    }))
}

pub fn usage_map(entries: Vec<(&str, AccountUsage)>) -> JsMap<AccountUsage> {
    entries
        .into_iter()
        .map(|(id, u)| (id.to_string(), u))
        .collect()
}

pub fn schedule(entries: &[(&str, f64)]) -> JsMap<f64> {
    entries.iter().map(|(id, t)| (id.to_string(), *t)).collect()
}

/// A usage sample of `account` at `time`.
pub fn sample(account: &Account, time: f64, used: f64, resets_at: Option<&str>) -> UsageSample {
    let mut five = json!({ "usedPercent": used });
    if let Some(resets_at) = resets_at {
        five["resetsAt"] = json!(resets_at);
    }
    from_json(json!({
        "accountId": account.id,
        "identity": usage_identity(account).expect("an identity"),
        "checkedAt": iso(time),
        "fiveHour": five,
    }))
}

/// `HH:mm` of `time` in `zone` (the tests' `Intl.DateTimeFormat` h23 clock).
pub fn clock_in(time: f64, zone: &str) -> String {
    let parts = relay_core::shared::planning::local_parts(time, zone).expect("a zone");
    format!("{:02}:{:02}", parts.hour, parts.minute)
}

/// Segments as "account from-to" in `zone`; `empty` names an outage.
pub fn lane(forecast: &Forecast, zone: &str, empty: &str) -> Vec<String> {
    forecast
        .segments
        .iter()
        .map(|s| {
            format!(
                "{} {}-{}",
                s.account_id.as_deref().unwrap_or(empty),
                clock_in(s.from, zone),
                clock_in(s.to, zone)
            )
        })
        .collect()
}

/// `new Date(t).toISOString().slice(11, 16)`.
pub fn hhmm(time: f64) -> String {
    iso(time)[11..16].to_string()
}
