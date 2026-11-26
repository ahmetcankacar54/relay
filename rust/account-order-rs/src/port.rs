//! The Rust port of `shared/account-order.ts`, delegating to `relay_core::shared::account_order`.

#![forbid(unsafe_code)]

use relay_core::shared::account_order;

/// Port of `roomUnits` (`shared/account-order.ts:18`).
pub fn room_units(remaining_percent: f64, capacity: f64) -> Result<serde_json::Value, String> {
    Ok(crate::js::number(account_order::room_units(
        remaining_percent,
        capacity,
    )))
}

/// Port of `weekBand` (`shared/account-order.ts:25`).
pub fn week_band(week_ends: f64, earliest: f64) -> Result<serde_json::Value, String> {
    Ok(crate::js::number(account_order::week_band(
        week_ends, earliest,
    )))
}
