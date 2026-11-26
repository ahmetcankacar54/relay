//! The Rust port of `shared/relay-link.ts`, delegating to `relay_core::shared::relay_link`.

#![forbid(unsafe_code)]

use relay_core::shared::relay_link::{self, RelayLink};
use serde_json::Value;

/// The ids of `{ id }` objects; a missing or non-string id matches nothing.
fn ids(accounts: &[Value]) -> Vec<String> {
    accounts
        .iter()
        .map(|a| {
            a.get("id")
                .and_then(Value::as_str)
                .map_or_else(|| "\u{0}missing".to_string(), str::to_string)
        })
        .collect()
}

/// JavaScript truthiness, for `if (accounts && …)`.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => {
            !crate::js::is_undefined(value)
                && crate::js::as_number(value).is_none_or(|n| n != 0.0 && !n.is_nan())
        }
    }
}

/// Port of `relaySwitchLink` (`shared/relay-link.ts:13`).
pub fn relay_switch_link(account_id: String) -> Result<serde_json::Value, String> {
    Ok(relay_link::relay_switch_link(&account_id).into())
}

/// Port of `parseRelayLink` (`shared/relay-link.ts:22`): a non-string `url` is `undefined`; a
/// truthy `accounts` that is not an array throws where the TS calls `accounts.some`.
pub fn parse_relay_link(
    url: serde_json::Value,
    accounts: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let accounts = accounts.filter(truthy);
    let link = match &accounts {
        Some(Value::Array(list)) => {
            let ids = ids(list);
            relay_link::parse_relay_link(url.as_str(), Some(&ids[..]))
        }
        Some(_) => match relay_link::parse_relay_link::<String>(url.as_str(), None) {
            Some(RelayLink::Switch { .. }) => {
                return Err("TypeError: accounts.some is not a function".into());
            }
            link => link,
        },
        None => relay_link::parse_relay_link::<String>(url.as_str(), None),
    };
    match link {
        Some(link) => serde_json::to_value(link).map_err(|e| e.to_string()),
        None => Ok(crate::js::undefined()),
    }
}

/// Port of `relayLinkArgument` (`shared/relay-link.ts:56`).
pub fn relay_link_argument(argv: Vec<String>) -> Result<serde_json::Value, String> {
    Ok(relay_link::relay_link_argument(&argv).map_or_else(crate::js::undefined, Value::from))
}

/// Port of `linkedSwitchAccount` (`shared/relay-link.ts:64`): the caller's own account object.
/// A non-array `accounts` throws where the TS calls `accounts.find`.
pub fn linked_switch_account(
    account_id: Option<String>,
    accounts: serde_json::Value,
    active_id: Option<String>,
) -> Result<serde_json::Value, String> {
    if account_id.as_deref().is_none_or(str::is_empty) || account_id == active_id {
        return Ok(crate::js::undefined());
    }
    let accounts = match accounts {
        Value::Array(list) => list,
        Value::Null => {
            return Err("TypeError: Cannot read properties of null (reading 'find')".into());
        }
        _ if crate::js::is_undefined(&accounts) => {
            return Err("TypeError: Cannot read properties of undefined (reading 'find')".into());
        }
        _ => return Err("TypeError: accounts.find is not a function".into()),
    };
    let ids = ids(&accounts);
    let found =
        relay_link::linked_switch_account(account_id.as_deref(), &ids, active_id.as_deref());
    Ok(found
        .and_then(|f| ids.iter().position(|id| std::ptr::eq(id, f)))
        .map_or_else(crate::js::undefined, |i| accounts[i].clone()))
}
