//! The Rust port of `shared/limit-calibration.ts`, delegating to
//! `relay_core::shared::limit_calibration`.
//!
//! Only argument and result conversion lives here: the JSON the bindings carry becomes the
//! relay-core types, and their results become what the TS returns.

#![forbid(unsafe_code)]

use relay_core::shared::limit_calibration::{self, CalibrationInput, CostSlots, SlotStarts};
use relay_core::shared::usage_statistics::UsageSample;
use serde::Deserialize;

use crate::args::arg;

/// The TS `calibrateLimits` argument, owned.
#[derive(Deserialize)]
struct Input {
    samples: Vec<UsageSample>,
    slots: CostSlots,
    zone: String,
    now: f64,
    #[serde(default)]
    days: Option<f64>,
}

/// Port of `slotCostBetween` (`shared/limit-calibration.ts:37`). `starts` is a cache of slot
/// start times the function fills; a fresh one gives the same cost.
pub fn slot_cost_between(
    slots: serde_json::Value,
    who: Vec<String>,
    from: f64,
    to: f64,
    zone: String,
    starts: Option<serde_json::Value>,
) -> Result<f64, String> {
    let _ = starts;
    let slots: CostSlots = arg(slots)?;
    let who: Vec<&str> = who.iter().map(String::as_str).collect();
    Ok(limit_calibration::slot_cost_between(
        &slots,
        &who,
        from,
        to,
        &zone,
        &mut SlotStarts::new(),
    ))
}

/// Port of `calibrateLimits` (`shared/limit-calibration.ts:80`).
pub fn calibrate_limits(input: serde_json::Value) -> Result<serde_json::Value, String> {
    let input: Input = arg(input)?;
    let out = limit_calibration::calibrate_limits(CalibrationInput {
        samples: &input.samples,
        slots: &input.slots,
        zone: &input.zone,
        now: input.now,
        days: input.days,
    });
    serde_json::to_value(out).map_err(|e| e.to_string())
}
