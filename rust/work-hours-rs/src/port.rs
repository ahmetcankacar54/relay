//! The Rust port of `shared/work-hours.ts`, delegating to `relay_core::shared::work_hours`.

#![forbid(unsafe_code)]

use parity_args::arg;
use relay_core::shared::types::PlanningSettings;
use relay_core::shared::work_hours;
use serde_json::Value;

/// Port of `shiftDate` (`shared/work-hours.ts:15`).
pub fn shift_date(date: String, delta: f64) -> Result<Value, String> {
    Ok(work_hours::shift_date(&date, delta).into())
}

/// Port of `isWeekend` (`shared/work-hours.ts:20`).
pub fn is_weekend(date: String) -> Result<Value, String> {
    Ok(work_hours::is_weekend(&date).into())
}

/// Port of `workInterval` (`shared/work-hours.ts:28`).
pub fn work_interval(date: String, settings: Value) -> Result<Value, String> {
    let settings: PlanningSettings = arg(&settings)?;
    match work_hours::work_interval(&date, &settings) {
        Some(interval) => serde_json::to_value(interval).map_err(|e| e.to_string()),
        None => Ok(crate::js::undefined()),
    }
}

/// Port of `dayStart` (`shared/work-hours.ts:45`).
pub fn day_start(date: String, zone: String) -> Result<Value, String> {
    Ok(crate::js::number(work_hours::day_start(&date, &zone)))
}
