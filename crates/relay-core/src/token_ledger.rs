//! Port of `electron/core/token-ledger.ts`. Holds only the data types `shared/token-usage-view.ts`
//! imports for now; the ledger itself is ported later.

use serde::{Deserialize, Serialize};

use crate::shared::types::js::{JsMap, ser_num, ser_opt_num};

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenCounts {
    #[serde(serialize_with = "ser_num")]
    pub input: f64,
    #[serde(serialize_with = "ser_num")]
    pub output: f64,
    #[serde(serialize_with = "ser_num")]
    pub cache_write: f64,
    #[serde(serialize_with = "ser_num")]
    pub cache_read: f64,
    #[serde(serialize_with = "ser_num")]
    pub responses: f64,
    /// What these tokens would cost on the API, in USD.
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "ser_opt_num")]
    pub cost: Option<f64>,
    /// Tokens of responses whose model has no price; they add nothing to `cost`.
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "ser_opt_num")]
    pub unpriced: Option<f64>,
    /// Some of `cost` was estimated (`true` or absent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_estimated: Option<bool>,
}

/// One quarter hour of one day for one `who`: the four kinds and their cost.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotCounts {
    #[serde(serialize_with = "ser_num")]
    pub input: f64,
    #[serde(serialize_with = "ser_num")]
    pub output: f64,
    #[serde(serialize_with = "ser_num")]
    pub cache_write: f64,
    #[serde(serialize_with = "ser_num")]
    pub cache_read: f64,
    #[serde(serialize_with = "ser_num")]
    pub cost: f64,
}

/// `${date}|${who}|${model}`; who = `acct:<id>` | `est:<id>` | "terminal" | "unknown".
pub type BucketKey = String;

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerProgress {
    #[serde(serialize_with = "ser_num")]
    pub scanned_bytes: f64,
    #[serde(serialize_with = "ser_num")]
    pub total_bytes: f64,
    /// A full pass has finished since the counts were last emptied.
    pub complete: bool,
    /// The last save failed (`true` or absent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<bool>,
}

/// date → who → model → counts.
pub type LedgerDays = JsMap<JsMap<JsMap<TokenCounts>>>;
/// date → who → quarter hour (0–95) → counts.
pub type LedgerSlots = JsMap<JsMap<JsMap<SlotCounts>>>;

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerSnapshot {
    pub days: LedgerDays,
    /// The last 8 days, by quarter hour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slots: Option<LedgerSlots>,
    /// When slots began to be kept: earlier responses of those days have none.
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "ser_opt_num")]
    pub slots_since: Option<f64>,
    pub progress: LedgerProgress,
}
