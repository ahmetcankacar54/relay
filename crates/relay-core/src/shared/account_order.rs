//! Port of `shared/account-order.ts`: the order both the gateway router and the day simulation
//! use to pick the next account. Room is counted in Pro units (a Pro window holds 100).

/// Room at or below this is low: one Pro window 80 % used.
pub const LOW_ROOM_UNITS: f64 = 20.0;
/// Room at or below this is as good as empty: one Pro window 95 % used.
pub const EMPTY_ROOM_UNITS: f64 = 5.0;
/// Accounts whose weeks end within this of each other count as ending together.
pub const DEADLINE_BAND_MS: f64 = 6.0 * 3_600_000.0;

/// Pro units left in a window that is `remaining_percent` empty on an account of `capacity`.
pub fn room_units(remaining_percent: f64, capacity: f64) -> f64 {
    remaining_percent * capacity
}

/// The deadline band of a week ending at `week_ends`, measured from the pool's earliest week.
pub fn week_band(week_ends: f64, earliest: f64) -> f64 {
    ((week_ends - earliest) / DEADLINE_BAND_MS).floor()
}
