//! Port of `electron/core/usage-statistics-input.ts`: the input of `relay:usage-statistics`.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::store::schema::{Schema, SchemaError, literal, strict, union, uuid};

/// A parsed `relay:usage-statistics` input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatisticsInput {
    /// 7, 30 or 90 days.
    pub range: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

/// `usageStatisticsInput`: `{ range: 7 | 30 | 90, accountId?: uuid }`, no other keys.
pub fn usage_statistics_input() -> Schema {
    strict(vec![
        (
            "range",
            union(vec![
                literal(json!(7)),
                literal(json!(30)),
                literal(json!(90)),
            ]),
        ),
        ("accountId", uuid().optional()),
    ])
}

/// `usageStatisticsInput.parse(input)`.
pub fn parse_usage_statistics_input(input: &Value) -> Result<UsageStatisticsInput, SchemaError> {
    let parsed = usage_statistics_input().parse(input)?;
    // The literals compare by value, so `30.0` is 30 as in JavaScript.
    let range = parsed["range"].as_f64().unwrap_or_default() as u32;
    let account_id = parsed
        .get("accountId")
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(UsageStatisticsInput { range, account_id })
}
