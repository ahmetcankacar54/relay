//! The Rust port of `shared/time-zones.ts`, delegating to `relay_core::shared::time_zones`.

#![forbid(unsafe_code)]

mod pinned;

use parity_args::arg;
use relay_core::shared::time_zones::{self, TimeZoneOption};
use serde_json::Value;

/// A `now = Date.now()` argument: the clock when `undefined`.
fn now_arg(now: Option<Value>) -> Result<f64, String> {
    match now {
        Some(v) if !parity_args::is_undefined(&v) => arg(&v),
        _ => Ok(pinned::now_ms()),
    }
}

fn options_value(options: Vec<TimeZoneOption>) -> Result<Vec<Value>, String> {
    options
        .into_iter()
        .map(|o| serde_json::to_value(o).map_err(|e| e.to_string()))
        .collect()
}

/// Port of `validTimeZone` (`shared/time-zones.ts:57`).
pub fn valid_time_zone(zone: String) -> Result<bool, String> {
    Ok(time_zones::valid_time_zone(&zone))
}

/// Port of `timeZoneCity` (`shared/time-zones.ts:74`).
pub fn time_zone_city(zone: String) -> Result<String, String> {
    Ok(time_zones::time_zone_city(&zone))
}

/// Port of `timeZoneOffset` (`shared/time-zones.ts:79`).
pub fn time_zone_offset(zone: String, now: Option<Value>) -> Result<String, String> {
    Ok(time_zones::time_zone_offset(&zone, now_arg(now)?))
}

/// Port of `buildTimeZoneCatalog` (`shared/time-zones.ts:105`).
pub fn build_time_zone_catalog(supported: Option<Vec<String>>) -> Result<Vec<String>, String> {
    let supported: Option<Vec<&str>> = supported
        .as_ref()
        .map(|list| list.iter().map(String::as_str).collect());
    Ok(time_zones::build_time_zone_catalog(supported.as_deref()))
}

/// Port of `foldTimeZoneSearch` (`shared/time-zones.ts:130`).
pub fn fold_time_zone_search(value: String) -> Result<String, String> {
    Ok(time_zones::fold_time_zone_search(&value))
}

/// Port of `timeZoneOptions` (`shared/time-zones.ts:148`).
pub fn time_zone_options(
    current: String,
    now: Option<Value>,
    catalog: Option<Vec<String>>,
) -> Result<Vec<Value>, String> {
    options_value(time_zones::time_zone_options(
        &current,
        now_arg(now)?,
        catalog.as_deref(),
    ))
}

/// Port of `filterTimeZones` (`shared/time-zones.ts:165`).
pub fn filter_time_zones(
    options: Vec<Value>,
    query: String,
    now: Option<Value>,
) -> Result<Vec<Value>, String> {
    let options: Vec<TimeZoneOption> = options.iter().map(arg).collect::<Result<_, _>>()?;
    options_value(time_zones::filter_time_zones(
        &options,
        &query,
        now_arg(now)?,
    ))
}
