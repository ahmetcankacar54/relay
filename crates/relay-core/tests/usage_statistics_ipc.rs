//! Port of tests/usage-statistics-ipc.test.ts (`electron/core/usage-statistics-input`).

use relay_core::usage_statistics_input::{UsageStatisticsInput, parse_usage_statistics_input};
use serde_json::{Value, json};

const UUID: &str = "4f6c8a52-1d2e-4b7a-9c3f-2a1b0c9d8e7f";

#[test]
fn usage_statistics_input_accepts_7_30_90_and_an_optional_account_uuid() {
    let parsed = |value: Value| serde_json::to_value(parse_usage_statistics_input(&value).unwrap());
    assert_eq!(
        parsed(json!({ "range": 30 })).unwrap(),
        json!({ "range": 30 })
    );
    assert_eq!(
        parse_usage_statistics_input(&json!({ "range": 90, "accountId": UUID })).unwrap(),
        UsageStatisticsInput {
            range: 90,
            account_id: Some(UUID.into()),
        }
    );
    assert_eq!(
        parsed(json!({ "range": 7 })).unwrap(),
        json!({ "range": 7 })
    );
}

/// `undefined` and `null` are both `Value::Null` here.
#[test]
fn usage_statistics_input_rejects_other_ranges_ids_and_extra_keys() {
    for value in [
        json!({ "range": 14 }),
        json!({ "range": "30" }),
        json!({ "range": 30, "accountId": "x" }),
        json!({ "range": 30, "extra": 1 }),
        Value::Null,
    ] {
        assert!(parse_usage_statistics_input(&value).is_err());
    }
}
