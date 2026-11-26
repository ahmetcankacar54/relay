//! The Rust port of `shared/token-usage-view.ts`, delegating to
//! `relay_core::shared::token_usage_view`.
//!
//! Only argument and result conversion lives here: the JSON the bindings carry becomes the
//! relay-core types, and their results become what the TS returns.

#![forbid(unsafe_code)]

mod args;

use std::collections::HashMap;

use relay_core::shared::token_usage_view::{self, LedgerSnapshot, TokenUsageInput};
use relay_core::shared::types::Account;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use args::arg;

/// A JS `Map`, as the bindings carry it.
#[derive(Deserialize)]
struct JsMapEntries<V> {
    #[serde(rename = "$map")]
    entries: Vec<(String, V)>,
}

/// The TS `TokenUsageInput`, owned; `buildTokenToday` reads a subset of it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    ledger: LedgerSnapshot,
    accounts: Vec<Account>,
    #[serde(default)]
    range: u32,
    #[serde(default)]
    account_id: Option<String>,
    zone: String,
    now: f64,
    #[serde(default)]
    exact_since: Option<f64>,
}

/// Port of `classify` (`shared/token-usage-view.ts:134`): `Who` in the TS key order, optional
/// fields left out when absent.
pub fn classify(who: String, accounts: serde_json::Value) -> Result<serde_json::Value, String> {
    let accounts: JsMapEntries<Account> = arg(accounts)?;
    let by_key: HashMap<&str, &Account> = accounts
        .entries
        .iter()
        .map(|(k, a)| (k.as_str(), a))
        .collect();
    let who = token_usage_view::classify(&who, &by_key);
    let mut out = Map::new();
    out.insert("key".into(), json!(who.key));
    out.insert("kind".into(), json!(who.kind));
    if let Some(id) = who.account_id {
        out.insert("accountId".into(), json!(id));
    }
    if let Some(name) = who.name {
        out.insert("name".into(), json!(name));
    }
    out.insert("estimated".into(), json!(who.estimated));
    Ok(Value::Object(out))
}

/// Port of `buildTokenUsageView` (`shared/token-usage-view.ts:167`).
pub fn build_token_usage_view(input: serde_json::Value) -> Result<serde_json::Value, String> {
    let input: Input = arg(input)?;
    let view = token_usage_view::build_token_usage_view(&TokenUsageInput {
        ledger: &input.ledger,
        accounts: &input.accounts,
        range: input.range,
        account_id: input.account_id.as_deref(),
        zone: &input.zone,
        now: input.now,
        exact_since: input.exact_since,
    });
    serde_json::to_value(view).map_err(|e| e.to_string())
}

/// Port of `buildTokenToday` (`shared/token-usage-view.ts:266`).
pub fn build_token_today(input: serde_json::Value) -> Result<serde_json::Value, String> {
    let input: Input = arg(input)?;
    let today = token_usage_view::build_token_today(
        &input.ledger,
        &input.accounts,
        input.account_id.as_deref(),
        &input.zone,
        input.now,
    );
    serde_json::to_value(today).map_err(|e| e.to_string())
}
