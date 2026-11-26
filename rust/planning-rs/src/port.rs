//! The Rust port of `shared/planning.ts`, delegating to `relay_core::shared::planning`.

#![forbid(unsafe_code)]

use parity_args::arg;
use relay_core::shared::planning;
use relay_core::shared::types::Account;
use serde_json::Value;

/// A `number | undefined` result.
fn opt_number(n: Option<f64>) -> Value {
    n.map_or_else(crate::js::undefined, crate::js::number)
}

/// Port of `localDate` (`shared/planning.ts:35`).
pub fn local_date(time: f64, time_zone: String) -> Result<Value, String> {
    Ok(planning::local_date(time, &time_zone).into())
}

/// Port of `localSlot` (`shared/planning.ts:40`).
pub fn local_slot(time: f64, time_zone: String) -> Result<Value, String> {
    Ok(crate::js::number(planning::local_slot(time, &time_zone)))
}

/// Port of `localHour` (`shared/planning.ts:45`).
pub fn local_hour(time: f64, time_zone: String) -> Result<Value, String> {
    Ok(crate::js::number(planning::local_hour(time, &time_zone)))
}

/// Port of `wallTime` (`shared/planning.ts:51`).
pub fn wall_time(date: String, clock: String, time_zone: String) -> Result<Value, String> {
    Ok(opt_number(planning::wall_time(&date, &clock, &time_zone)))
}

/// Port of `wallTimeOrNext` (`shared/planning.ts:85`).
pub fn wall_time_or_next(date: String, clock: String, time_zone: String) -> Result<Value, String> {
    Ok(opt_number(planning::wall_time_or_next(
        &date, &clock, &time_zone,
    )))
}

/// Port of `systemTimeZone` (`shared/planning.ts:98`).
pub fn system_time_zone() -> Result<Value, String> {
    Ok(planning::system_time_zone().into())
}

/// Port of `defaultPlanning` (`shared/planning.ts:103`).
pub fn default_planning() -> Result<Value, String> {
    serde_json::to_value(planning::default_planning()).map_err(|e| e.to_string())
}

/// Port of `planningIdentity` (`shared/planning.ts:106`).
pub fn planning_identity(a: Value) -> Result<Value, String> {
    let a: Account = arg(&a)?;
    Ok(planning::planning_identity(&a).map_or_else(crate::js::undefined, Value::from))
}

/// Port of `planCapacity` (`shared/planning.ts:116`).
pub fn plan_capacity(a: Value) -> Result<Value, String> {
    let a: Account = arg(&a)?;
    Ok(crate::js::number(planning::plan_capacity(&a)))
}
