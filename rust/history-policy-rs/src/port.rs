//! The Rust port of `shared/history-policy.ts`, delegating to `relay_core::shared::history_policy`.

#![forbid(unsafe_code)]

use parity_args::arg;
use relay_core::shared::history_policy;
use relay_core::shared::types::{Account, RelaySettings};
use serde_json::Value;

/// Port of `allowedHistoryPair` (`shared/history-policy.ts:7`).
pub fn allowed_history_pair(source: Value, target: Value, settings: Value) -> Result<bool, String> {
    let source: Account = arg(&source)?;
    let target: Account = arg(&target)?;
    let settings: RelaySettings = arg(&settings)?;
    Ok(history_policy::allowed_history_pair(
        &source, &target, &settings,
    ))
}

/// Port of `historySources` (`shared/history-policy.ts:20`): the sources are returned as the
/// caller's own objects, as `Array.prototype.filter` returns them.
pub fn history_sources(
    target: Value,
    accounts: Vec<Value>,
    settings: Value,
) -> Result<Vec<Value>, String> {
    let target: Account = arg(&target)?;
    let typed: Vec<Account> = accounts.iter().map(arg).collect::<Result<_, _>>()?;
    let settings: RelaySettings = arg(&settings)?;
    Ok(history_policy::history_sources(&target, &typed, &settings)
        .into_iter()
        .filter_map(|found| typed.iter().position(|a| std::ptr::eq(a, found)))
        .map(|i| accounts[i].clone())
        .collect())
}
