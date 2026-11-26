//! Test helpers for the SharedB slice (`shared/*` ports): fixtures the TS tests build inline.
#![allow(dead_code)]

/// `randomUUID()`.
pub fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// `JSON.stringify(text)`.
pub fn json(text: &str) -> String {
    serde_json::to_string(text).unwrap()
}

/// `signInFor(accountUuid, n)` from tests/extension-world.ts.
pub fn sign_in_for(account_uuid: &str, n: u64) -> Vec<(String, String)> {
    vec![
        ("accountUuid".into(), json(account_uuid)),
        ("accessToken".into(), json(&format!("ACCESS-SECRET-{n}"))),
        ("refreshToken".into(), json(&format!("REFRESH-SECRET-{n}"))),
        ("tokenExpiry".into(), (1_900_000_000_000u64 + n).to_string()),
    ]
}

/// Entries as `(&str, &str)` pairs.
pub fn pairs(entries: &[(String, String)]) -> Vec<(&str, &str)> {
    entries
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect()
}

/// Entries as `(&str, Option<&str>)` pairs, every value present.
pub fn some_pairs(entries: &[(String, String)]) -> Vec<(&str, Option<&str>)> {
    entries
        .iter()
        .map(|(k, v)| (k.as_str(), Some(v.as_str())))
        .collect()
}

/// `[(k, v), …]` with owned strings.
pub fn owned(entries: &[(&str, &str)]) -> Vec<(String, String)> {
    entries
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect()
}

/// `Math.abs(actual - expected) < 1e-9`.
pub fn near(actual: Option<f64>, expected: f64) {
    let actual = actual.unwrap_or_else(|| panic!("undefined ≠ {expected}"));
    assert!((actual - expected).abs() < 1e-9, "{actual} ≠ {expected}");
}
