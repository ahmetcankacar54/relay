//! The Rust port of `shared/terminal-identity.ts`, delegating to
//! `relay_core::shared::terminal_identity`.
//!
//! `terminalLine` stays in TypeScript for rust-anything (it takes the translate function `t`);
//! `relay_core::shared::terminal_identity::terminal_line` is its port, checked by
//! `crates/relay-core/tests/shared_terminal_identity.rs`.

#![forbid(unsafe_code)]

use relay_core::shared::terminal_identity::{self as ti, TerminalIdentity};
use serde_json::{Value, json};

use crate::js::is_undefined;

/// JS truthiness of a structured value (`undefined` crosses as a marker object).
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Object(o) => {
            !is_undefined(value) && !(o.len() == 1 && o.get("$num").is_some_and(|n| n == "NaN"))
        }
        Value::Array(_) => true,
    }
}

/// `side?.[key]`: a property of an object, else `undefined`.
fn field<'a>(side: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    side?.as_object()?.get(key).filter(|v| !is_undefined(v))
}

/// `add(accountUuid, orgId)`'s inputs: both truthy, and then strings (`toLowerCase` throws on
/// anything else).
fn pair(side: Option<&Value>) -> Result<Option<(&str, &str)>, String> {
    let (Some(uuid), Some(org)) = (field(side, "accountUuid"), field(side, "orgId")) else {
        return Ok(None);
    };
    if !truthy(uuid) || !truthy(org) {
        return Ok(None);
    }
    match (uuid.as_str(), org.as_str()) {
        (Some(uuid), Some(org)) => Ok(Some((uuid, org))),
        _ => Err("TypeError: toLowerCase is not a function".into()),
    }
}

/// Port of `terminalIdentities` (`shared/terminal-identity.ts:84`).
pub fn terminal_identities(account: Value) -> Result<Vec<Value>, String> {
    let account = match &account {
        Value::Null => return Err("TypeError: Cannot read properties of null".into()),
        v if is_undefined(v) => {
            return Err("TypeError: Cannot read properties of undefined".into());
        }
        Value::Object(o) => Some(o),
        _ => None,
    };
    let side = |key: &str| account.and_then(|o| o.get(key));
    let desktop = pair(side("desktop"))?;
    let auth = pair(side("auth"))?;
    Ok(
        ti::terminal_identities(desktop, auth.map(|(u, o)| (Some(u), Some(o))))
            .into_iter()
            .map(|id| json!({ "accountUuid": id.account_uuid, "orgId": id.org_id }))
            .collect(),
    )
}

fn identity_of(value: Value) -> Result<TerminalIdentity, String> {
    serde_json::from_value(value).map_err(|e| format!("TypeError: {e}"))
}

/// Port of `sameIdentity` (`shared/terminal-identity.ts:102`).
pub fn same_identity(a: Value, b: Value) -> Result<bool, String> {
    Ok(ti::same_identity(&identity_of(a)?, &identity_of(b)?))
}
