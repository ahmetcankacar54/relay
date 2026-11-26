//! The Rust port of `shared/account-state.ts`, delegating to `relay_core::shared::account_state`.

#![forbid(unsafe_code)]

use parity_args::{arg, opt_arg};
use relay_core::shared::account_state;
use relay_core::shared::types::{Account, AccountUsage, AuthFlow};
use serde_json::Value;

/// Port of `displayedIssue` (`shared/account-state.ts:7`).
pub fn displayed_issue(usage: Option<Value>) -> Result<Value, String> {
    let usage: Option<AccountUsage> = opt_arg(usage.as_ref())?;
    Ok(match account_state::displayed_issue(usage.as_ref()) {
        Some(issue) => serde_json::to_value(issue).map_err(|e| e.to_string())?,
        None => crate::js::undefined(),
    })
}

/// Port of `readsThroughApp` (`shared/account-state.ts:21`).
pub fn reads_through_app(account: Value, usage: Option<Value>) -> Result<Value, String> {
    let account: Account = arg(&account)?;
    let usage: Option<AccountUsage> = opt_arg(usage.as_ref())?;
    Ok(Value::Bool(account_state::reads_through_app(
        &account,
        usage.as_ref(),
    )))
}

/// Port of `cliNeedsReconnect` (`shared/account-state.ts:29`).
pub fn cli_needs_reconnect(account: Value, usage: Option<Value>) -> Result<Value, String> {
    let account: Account = arg(&account)?;
    let usage: Option<AccountUsage> = opt_arg(usage.as_ref())?;
    Ok(Value::Bool(account_state::cli_needs_reconnect(
        &account,
        usage.as_ref(),
    )))
}

/// Port of `duplicateCliAccount` (`shared/account-state.ts:40`): the match is returned as the
/// caller's own object, as `Array.prototype.find` returns it.
pub fn duplicate_cli_account(account: Value, accounts: Vec<Value>) -> Result<Value, String> {
    let account: Account = arg(&account)?;
    let typed: Vec<Account> = accounts.iter().map(arg).collect::<Result<_, _>>()?;
    let found = account_state::duplicate_cli_account(&account, &typed)
        .and_then(|found| typed.iter().position(|a| std::ptr::eq(a, found)));
    Ok(found.map_or_else(crate::js::undefined, |i| accounts[i].clone()))
}

/// Port of `desktopCliMismatch` (`shared/account-state.ts:52`).
pub fn desktop_cli_mismatch(account: Value) -> Result<Value, String> {
    let account: Account = arg(&account)?;
    Ok(Value::Bool(account_state::desktop_cli_mismatch(&account)))
}

/// Port of `desktopCliWorkspaceMismatch` (`shared/account-state.ts:67`).
pub fn desktop_cli_workspace_mismatch(account: Value) -> Result<Value, String> {
    let account: Account = arg(&account)?;
    Ok(Value::Bool(account_state::desktop_cli_workspace_mismatch(
        &account,
    )))
}

/// Port of `pendingAuth` (`shared/account-state.ts:75`).
pub fn pending_auth(flow: Option<Value>) -> Result<Value, String> {
    let flow: Option<AuthFlow> = opt_arg(flow.as_ref())?;
    Ok(Value::Bool(account_state::pending_auth(flow.as_ref())))
}
