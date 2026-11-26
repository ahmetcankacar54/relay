//! The Rust port of `shared/usage-rollups.ts`, delegating to `relay_core::shared::usage_rollups`.
//!
//! Only argument and result conversion lives here: the JSON the bindings carry becomes the
//! relay-core types, and their results become what the TS returns.

#![forbid(unsafe_code)]

mod args;

use relay_core::shared::usage_rollups::{self, UsageRollups};
use relay_core::shared::usage_statistics::UsageSample;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use args::arg;

fn arg_list<T: DeserializeOwned>(values: Vec<Value>) -> Result<Vec<T>, String> {
    values.into_iter().map(arg).collect()
}

fn out(value: impl Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

/// Port of `emptyRollups` (`shared/usage-rollups.ts:39`).
pub fn empty_rollups() -> Result<serde_json::Value, String> {
    out(usage_rollups::empty_rollups())
}

/// Port of `hourKey` (`shared/usage-rollups.ts:47`): relay-core answers `""` where
/// `toISOString` throws.
pub fn hour_key(time: f64) -> Result<String, String> {
    let key = usage_rollups::hour_key(time);
    if key.is_empty() {
        return Err("RangeError: Invalid time value".into());
    }
    Ok(key)
}

/// Port of `validWindow` (`shared/usage-rollups.ts:52`).
pub fn valid_window(sample: serde_json::Value) -> Result<bool, String> {
    let sample: UsageSample = arg(sample)?;
    Ok(usage_rollups::valid_window(&sample))
}

/// Port of `sameReset` (`shared/usage-rollups.ts:60`).
pub fn same_reset(a: String, b: String) -> Result<bool, String> {
    Ok(usage_rollups::same_reset(&a, &b))
}

/// Port of `foldSample` (`shared/usage-rollups.ts:161`). The TS names the rollups `r`, which the
/// generated wire binding uses for its reader.
pub fn fold_sample(
    rollups: serde_json::Value,
    s: serde_json::Value,
    now: f64,
) -> Result<serde_json::Value, String> {
    let r: UsageRollups = arg(rollups)?;
    let s: UsageSample = arg(s)?;
    out(usage_rollups::fold_sample(&r, &s, now))
}

/// Port of `foldSamples` (`shared/usage-rollups.ts:239`).
pub fn fold_samples(
    samples: Vec<serde_json::Value>,
    now: f64,
) -> Result<serde_json::Value, String> {
    let samples: Vec<UsageSample> = arg_list(samples)?;
    out(usage_rollups::fold_samples(&samples, now))
}

/// Port of `catchUp` (`shared/usage-rollups.ts:252`).
pub fn catch_up(
    rollups: serde_json::Value,
    samples: Vec<serde_json::Value>,
    now: f64,
) -> Result<serde_json::Value, String> {
    let r: UsageRollups = arg(rollups)?;
    let samples: Vec<UsageSample> = arg_list(samples)?;
    out(usage_rollups::catch_up(&r, &samples, now))
}
