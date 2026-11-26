//! Fixtures for the usage statistics, token usage and lost-and-found view tests.
#![allow(dead_code)]

use relay_core::shared::types::Account;
use serde::Serialize;
use serde_json::{Value, json};

/// `tests/planning-fixtures.ts` `planningAccount(id, plan)`.
pub fn planning_account(id: &str, plan: &str) -> Account {
    serde_json::from_value(json!({
        "id": id,
        "name": id,
        "kind": "personal",
        "group": "personal",
        "color": "olive",
        "createdAt": "2026-10-13T05:59:45.000Z",
        "planning": { "plan": plan, "capacityWeight": 1 },
        "auth": {
            "loggedIn": true,
            "accountUuid": id,
            "orgId": format!("org-{id}"),
            "subscription": "pro",
            "checkedAt": "2026-10-13T05:59:45.000Z",
        },
    }))
    .expect("planning account")
}

/// `{ ...planningAccount(id, plan), name }`.
pub fn named(id: &str, name: &str, plan: &str) -> Account {
    Account {
        name: name.into(),
        ..planning_account(id, plan)
    }
}

/// `{ ...account, ...patch }` on the account's JSON shape.
pub fn with(account: &Account, patch: Value) -> Account {
    let mut value = serde_json::to_value(account).expect("account serializes");
    let (Value::Object(base), Value::Object(patch)) = (&mut value, patch) else {
        panic!("objects")
    };
    for (k, v) in patch {
        if v.is_null() {
            base.shift_remove(&k);
        } else {
            base.insert(k, v);
        }
    }
    serde_json::from_value(value).expect("patched account")
}

/// What `JSON.stringify` would see.
pub fn to_json<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("serializes")
}

pub fn from_json<T: serde::de::DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).expect("deserializes")
}
