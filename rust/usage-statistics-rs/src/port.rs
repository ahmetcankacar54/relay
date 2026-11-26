//! The Rust port of `shared/usage-statistics.ts`, delegating to `relay_core::shared::usage_statistics`.
//!
//! Only argument and result conversion lives here: the JSON the bindings carry becomes the
//! relay-core types, and their results become what the TS returns. `identityOwners` stays in
//! TypeScript here: it returns a `Map`, which the binary wire carries as a plain object; its port,
//! `usage_statistics::identity_owners`, is checked by the ported unit tests.

#![forbid(unsafe_code)]

mod args;

use relay_core::shared::types::{Account, AccountUsage};
use relay_core::shared::usage_statistics;
use serde_json::{Value, json};

use args::{arg, plain};

/// An account as relay-core's type holds it. Test fixtures cast from partial objects may lack
/// `kind`, which nothing here reads.
fn account_arg(account: Value) -> Result<Account, String> {
    let mut account = plain(account).unwrap_or(Value::Null);
    if let Value::Object(fields) = &mut account {
        fields.entry("kind").or_insert_with(|| json!("personal"));
    }
    arg(account)
}

/// Port of `usageIdentity` (`shared/usage-statistics.ts:18`).
pub fn usage_identity(account: serde_json::Value) -> Result<Option<String>, String> {
    let account = account_arg(account)?;
    Ok(usage_statistics::usage_identity(&account))
}

/// Port of `historyIdentity` (`shared/usage-statistics.ts:32`).
pub fn history_identity(account: serde_json::Value) -> Result<Option<String>, String> {
    let account = account_arg(account)?;
    Ok(usage_statistics::history_identity(&account))
}

/// Port of `usageSample` (`shared/usage-statistics.ts:79`).
pub fn usage_sample(
    account: serde_json::Value,
    usage: serde_json::Value,
) -> Result<Option<serde_json::Value>, String> {
    let account = account_arg(account)?;
    let usage: AccountUsage = arg(usage)?;
    usage_statistics::usage_sample(&account, &usage)
        .map(|s| serde_json::to_value(s).map_err(|e| e.to_string()))
        .transpose()
}
