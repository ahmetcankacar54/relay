//! The Rust port of `shared/desktop-account.ts`, delegating to `relay_core::shared::desktop_account`.

#![forbid(unsafe_code)]

use parity_args::arg;
use relay_core::shared::desktop_account::{self, KnownDesktop};
use relay_core::shared::types::Account;
use serde::Deserialize;
use serde_json::Value;

/// `known: { accountUuid: string; orgId?: string }`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Known {
    account_uuid: String,
    #[serde(default)]
    org_id: Option<String>,
}

/// Port of `desktopAccountFor` (`shared/desktop-account.ts:11`): the match is returned as the
/// caller's own object, as `Array.prototype.find` returns it.
pub fn desktop_account_for(known: Value, accounts: Vec<Value>) -> Result<Value, String> {
    let known: Known = arg(&known)?;
    let typed: Vec<Account> = accounts.iter().map(arg).collect::<Result<_, _>>()?;
    let known = KnownDesktop {
        account_uuid: &known.account_uuid,
        org_id: known.org_id.as_deref(),
    };
    let found = desktop_account::desktop_account_for(known, &typed)
        .and_then(|found| typed.iter().position(|a| std::ptr::eq(a, found)));
    Ok(found.map_or_else(crate::js::undefined, |i| accounts[i].clone()))
}
