//! The Rust port of `shared/usage-statistics-view.ts`, delegating to
//! `relay_core::shared::usage_statistics_view`.
//!
//! Only argument and result conversion lives here: the JSON the bindings carry becomes the
//! relay-core types, and their results become what the TS returns.

#![forbid(unsafe_code)]

mod args;

use relay_core::shared::types::Account;
use relay_core::shared::usage_rollups::UsageRollups;
use relay_core::shared::usage_statistics_view::{self, StatisticsHours, StatisticsInput};
use serde::Deserialize;

use args::arg;

/// A whole number the relay-core signature holds as `u32` (weekday 0–6, hour 0–23, range).
fn whole(name: &str, value: f64) -> Result<u32, String> {
    if value.fract() == 0.0 && (0.0..=f64::from(u32::MAX)).contains(&value) {
        Ok(value as u32)
    } else {
        Err(format!("TypeError: {name} {value} is not a whole number"))
    }
}

/// The TS `StatisticsInput`, owned.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    #[serde(default)]
    rollups: Option<UsageRollups>,
    available: bool,
    accounts: Vec<Account>,
    range: u32,
    #[serde(default)]
    account_id: Option<String>,
    zone: String,
    now: f64,
    #[serde(default)]
    hours: Option<StatisticsHours>,
}

/// Port of `inWorkHours` (`shared/usage-statistics-view.ts:81`).
pub fn in_work_hours(weekday: f64, hour: f64, hours: serde_json::Value) -> Result<bool, String> {
    let hours: Option<StatisticsHours> = arg(hours)?;
    Ok(usage_statistics_view::in_work_hours(
        whole("weekday", weekday)?,
        whole("hour", hour)?,
        hours.as_ref(),
    ))
}

/// Port of `buildStatisticsView` (`shared/usage-statistics-view.ts:185`).
pub fn build_statistics_view(input: serde_json::Value) -> Result<serde_json::Value, String> {
    let input: Input = arg(input)?;
    let view = usage_statistics_view::build_statistics_view(&StatisticsInput {
        rollups: input.rollups.as_ref(),
        available: input.available,
        accounts: &input.accounts,
        range: input.range,
        account_id: input.account_id.as_deref(),
        zone: &input.zone,
        now: input.now,
        hours: input.hours.as_ref(),
    });
    serde_json::to_value(view).map_err(|e| e.to_string())
}
