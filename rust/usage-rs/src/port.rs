//! The Rust port of `shared/usage.ts`, delegating to `relay_core::shared::usage`.
//!
//! Only argument and result conversion lives here: the JSON the bindings carry becomes the
//! relay-core types, and their results become what the TS returns. A missing `now` is
//! `Date.now()`, read from the pinned clock while rust-anything records and diffs.

#![forbid(unsafe_code)]

mod args;
mod pinned;

use relay_core::shared::types::js::JsMap;
use relay_core::shared::types::{Account, AccountUsage, RelaySettings, UsageWindow};
use relay_core::shared::usage;
use serde_json::{Value, json};

use args::{arg, opt_arg, plain};

/// `now = Date.now()`.
fn now_or_clock(now: Option<Value>) -> Result<f64, String> {
    match now.and_then(plain) {
        None => Ok(pinned::now_ms()),
        Some(n) => crate::js::as_number(&n).ok_or_else(|| format!("TypeError: now is {n}")),
    }
}

/// Port of `freshUsage` (`shared/usage.ts:13`).
pub fn fresh_usage(
    u: Option<serde_json::Value>,
    now: Option<serde_json::Value>,
) -> Result<bool, String> {
    let u: Option<AccountUsage> = opt_arg(u)?;
    Ok(usage::fresh_usage(u.as_ref(), now_or_clock(now)?))
}

/// Port of `lastKnownUsage` (`shared/usage.ts:37`).
pub fn last_known_usage(
    u: Option<serde_json::Value>,
    now: Option<serde_json::Value>,
) -> Result<bool, String> {
    let u: Option<AccountUsage> = opt_arg(u)?;
    Ok(usage::last_known_usage(u.as_ref(), now_or_clock(now)?))
}

/// Port of `windowHolds` (`shared/usage.ts:49`).
pub fn window_holds(
    window: Option<serde_json::Value>,
    now: Option<serde_json::Value>,
) -> Result<bool, String> {
    let w: Option<UsageWindow> = opt_arg(window)?;
    Ok(usage::window_holds(w.as_ref(), now_or_clock(now)?))
}

/// Port of `sourceExhausted` (`shared/usage.ts:63`).
pub fn source_exhausted(
    usage: Option<serde_json::Value>,
    now: f64,
) -> Result<serde_json::Value, String> {
    let usage: Option<AccountUsage> = opt_arg(usage)?;
    Ok(json!(usage::source_exhausted(usage.as_ref(), now)))
}

/// Port of `remaining` (`shared/usage.ts:83`).
/// (The TS names the window `w`, which the generated wire binding uses for its writer.)
pub fn remaining(window: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    let w: Option<UsageWindow> = opt_arg(window)?;
    Ok(usage::remaining(w.as_ref()).map_or_else(crate::js::undefined, crate::js::number))
}

/// Port of `suggestedAccount` (`shared/usage.ts:91`): the suggestion is the caller's own account
/// object, as the TS returns it.
pub fn suggested_account(
    active: Option<serde_json::Value>,
    accounts: Vec<serde_json::Value>,
    usage: serde_json::Value,
    settings: serde_json::Value,
    now: Option<serde_json::Value>,
    rate: Option<f64>,
) -> Result<serde_json::Value, String> {
    let active: Option<Account> = opt_arg(active)?;
    let typed = accounts
        .iter()
        .map(|a| arg(a.clone()))
        .collect::<Result<Vec<Account>, _>>()?;
    let usage: JsMap<AccountUsage> = arg(usage)?;
    let settings: RelaySettings = arg(settings)?;
    let suggested = usage::suggested_account(
        active.as_ref(),
        &typed,
        &usage,
        &settings,
        now_or_clock(now)?,
        rate,
    );
    Ok(suggested.map_or_else(crate::js::undefined, |s| {
        let at = typed
            .iter()
            .position(|a| std::ptr::eq(a, s))
            .expect("the suggestion is one of the accounts");
        accounts[at].clone()
    }))
}
