//! The Rust port of `shared/lost-found.ts`, delegating to `relay_core::shared::lost_found`.
//!
//! Only argument and result conversion lives here: the JSON the bindings carry becomes the
//! relay-core types, and their results become what the TS returns.

#![forbid(unsafe_code)]

mod args;

use relay_core::shared::lost_found::{self, LostFoundInput, LostSegment};
use relay_core::shared::types::Account;
use relay_core::shared::usage_rollups::UsageRollups;
use relay_core::token_ledger::{LedgerDays, LedgerSlots};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use args::{arg, plain};

fn out(value: impl Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

/// A date relay-core worked out: `""` where `toISOString` throws.
fn thrown_if_empty(text: String) -> Result<Value, String> {
    if text.is_empty() {
        return Err("RangeError: Invalid time value".into());
    }
    Ok(json!(text))
}

/// The TS `LostFoundInput`, owned.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    #[serde(default)]
    rollups: Option<UsageRollups>,
    segments: Vec<LostSegment>,
    ledger_days: LedgerDays,
    #[serde(default)]
    ledger_slots: Option<LedgerSlots>,
    #[serde(default)]
    slots_since: Option<f64>,
    accounts: Vec<Account>,
    zone: String,
    now: f64,
    #[serde(default)]
    week_start: Option<String>,
}

impl Input {
    fn borrowed(&self) -> LostFoundInput<'_> {
        LostFoundInput {
            rollups: self.rollups.as_ref(),
            segments: &self.segments,
            ledger_days: &self.ledger_days,
            ledger_slots: self.ledger_slots.as_ref(),
            slots_since: self.slots_since,
            accounts: &self.accounts,
            zone: &self.zone,
            now: self.now,
            week_start: self.week_start.as_deref(),
        }
    }
}

/// The TS input as relay-core's types hold it. The TS reads ledger counts as its own
/// `LedgerCounts` (no `responses`; `cost` optional and read as `cost ?? 0`), where relay-core's
/// ledger types require both: they are filled as the TS reads them. Accounts the tests cast from
/// partial objects may lack `auth.checkedAt`, which nothing here reads.
fn read_input(value: Value) -> Result<Input, String> {
    let mut value = plain(value).unwrap_or(Value::Null);
    fill_counts(value.get_mut("ledgerDays"), "responses");
    fill_counts(value.get_mut("ledgerSlots"), "cost");
    if let Some(Value::Array(accounts)) = value.get_mut("accounts") {
        for account in accounts {
            if let Some(Value::Object(auth)) = account.get_mut("auth") {
                auth.entry("checkedAt").or_insert_with(|| json!(""));
            }
        }
    }
    arg(value)
}

/// Adds `key: 0` to each counts object of a date → who → model (or slot) table that lacks it.
fn fill_counts(table: Option<&mut Value>, key: &str) {
    let Some(Value::Object(dates)) = table else {
        return;
    };
    for by_who in dates.values_mut().filter_map(Value::as_object_mut) {
        for by_key in by_who.values_mut().filter_map(Value::as_object_mut) {
            for counts in by_key.values_mut().filter_map(Value::as_object_mut) {
                counts.entry(key).or_insert_with(|| json!(0));
            }
        }
    }
}

/// Port of `tierOf` (`shared/lost-found.ts:100`).
pub fn tier_of(weeks: f64) -> Result<Option<serde_json::Value>, String> {
    // `None` crosses as null; the TS answers `undefined`.
    Ok(Some(
        lost_found::tier_of(weeks).map_or_else(crate::js::undefined, |t| json!(t)),
    ))
}

/// Port of `nextTier` (`shared/lost-found.ts:107`): the `LOST_TIERS` step, `{ tier, weeks }`.
pub fn next_tier(weeks: f64) -> Result<serde_json::Value, String> {
    Ok(lost_found::next_tier(weeks).map_or_else(
        crate::js::undefined,
        |(tier, weeks)| json!({ "tier": tier, "weeks": weeks }),
    ))
}

/// Port of `modelFamily` (`shared/lost-found.ts:230`).
pub fn model_family(model: String) -> Result<Option<String>, String> {
    Ok(lost_found::model_family(&model))
}

/// Port of `addDays` (`shared/lost-found.ts:236`).
pub fn add_days(date: String, days: f64) -> Result<serde_json::Value, String> {
    thrown_if_empty(lost_found::add_days(&date, days))
}

/// Port of `mondayOf` (`shared/lost-found.ts:243`).
pub fn monday_of(date: String) -> Result<serde_json::Value, String> {
    thrown_if_empty(lost_found::monday_of(&date))
}

/// Port of `validLostItem` (`shared/lost-found.ts:259`).
pub fn valid_lost_item(value: serde_json::Value) -> Result<bool, String> {
    Ok(lost_found::valid_lost_item(
        &plain(value).unwrap_or(Value::Null),
    ))
}

/// Port of `lostFoundWeek` (`shared/lost-found.ts:330`).
pub fn lost_found_week(input: serde_json::Value) -> Result<serde_json::Value, String> {
    let input = read_input(input)?;
    out(lost_found::lost_found_week(&input.borrowed()))
}

/// Port of `lostFoundCollection` (`shared/lost-found.ts:886`).
pub fn lost_found_collection(input: serde_json::Value) -> Result<serde_json::Value, String> {
    let input = read_input(input)?;
    out(lost_found::lost_found_collection(&input.borrowed()))
}
