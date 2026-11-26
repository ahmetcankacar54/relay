//! Fixtures for the SharedA.TestsMisc ports: tests/planning-fixtures.ts and small builders.
#![allow(dead_code)]

use relay_core::shared::continuation_target_ranking::{
    ContinuationTargetCandidate, RankedContinuationTarget,
};
use relay_core::shared::types::js::{JsMap, date_parse, iso};
use relay_core::shared::types::{Account, AccountUsage};
use serde_json::{Value, json};

/// `NOW` of tests/planning-fixtures.ts.
pub fn fixture_now() -> f64 {
    date_parse("2026-10-13T05:59:45Z")
}

pub fn from_json<T: serde::de::DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).expect("fixture")
}

/// `planningAccount(id, plan)`.
pub fn planning_account(id: &str, plan: &str) -> Account {
    from_json(json!({
        "id": id,
        "name": id,
        "kind": "personal",
        "group": "personal",
        "color": "olive",
        "createdAt": iso(fixture_now()),
        "planning": { "plan": plan, "capacityWeight": 1 },
        "auth": {
            "loggedIn": true,
            "accountUuid": id,
            "orgId": format!("org-{id}"),
            "subscription": "pro",
            "checkedAt": iso(fixture_now()),
        },
    }))
}

/// `planningUsage(account, now)`.
pub fn planning_usage(account: &Account, now: f64) -> AccountUsage {
    from_json(json!({
        "accountId": account.id,
        "status": "ready",
        "stale": false,
        "checkedAt": iso(now),
        "fiveHour": { "usedPercent": 0 },
        "sevenDay": { "usedPercent": 20, "resetsAt": iso(now + 3.0 * 86_400_000.0) },
    }))
}

/// Candidates borrowing from owned `(account, usage)` pairs.
pub fn candidates(pairs: &[(Account, AccountUsage)]) -> Vec<ContinuationTargetCandidate<'_>> {
    pairs
        .iter()
        .map(|(account, usage)| ContinuationTargetCandidate {
            account,
            usage: Some(usage),
        })
        .collect()
}

/// The names in ranked order.
pub fn order<'a>(ranked: &[RankedContinuationTarget<'a>]) -> Vec<&'a str> {
    ranked.iter().map(|r| r.account.name.as_str()).collect()
}

/// A usage record keyed by account id, in insertion order.
pub fn usage_map(entries: impl IntoIterator<Item = AccountUsage>) -> JsMap<AccountUsage> {
    let mut map = JsMap::new();
    for usage in entries {
        map.insert(usage.account_id.clone(), usage);
    }
    map
}

/// A random UUID, as the TS fixtures' `randomUUID()`.
pub fn random_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}
