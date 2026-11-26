//! Port of `shared/relay-link.ts`: relay:// links, which the macOS widget opens. A link only ever
//! opens Relay or its switch review; nothing reached through one switches by itself.

use serde::{Deserialize, Serialize};
use url::Url;

use super::types::Account;

pub const RELAY_SCHEME: &str = "relay";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum RelayLink {
    Open,
    Switch { account_id: String },
}

/// Anything with an account id, as the TS takes `{ id: string }`.
pub trait LinkAccount {
    fn link_id(&self) -> &str;
}

impl LinkAccount for Account {
    fn link_id(&self) -> &str {
        &self.id
    }
}

impl LinkAccount for str {
    fn link_id(&self) -> &str {
        self
    }
}

impl LinkAccount for String {
    fn link_id(&self) -> &str {
        self
    }
}

/// `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`
fn account_id(id: &str) -> bool {
    let parts: Vec<&str> = id.split('-').collect();
    parts.len() == 5
        && parts
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(p, n)| p.len() == n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// `encodeURIComponent`: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )` as UTF-8 percent escapes.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The widget's Geç button: Relay's switch review for this account.
pub fn relay_switch_link(account_id: &str) -> String {
    format!(
        "{RELAY_SCHEME}://switch?account={}",
        encode_uri_component(account_id)
    )
}

/// Reads a relay:// link: `relay://switch?account=<id>` or `relay://open`. Anything else, a
/// malformed id, or a link carrying more than that is ignored (`None`; so is a non-string, which
/// the caller passes as `None`). With `accounts`, a switch link must also name one of them.
pub fn parse_relay_link<A: LinkAccount>(
    url: Option<&str>,
    accounts: Option<&[A]>,
) -> Option<RelayLink> {
    let url = url?;
    if url.encode_utf16().count() > 512 {
        return None;
    }
    let parsed = Url::parse(url).ok()?;
    if parsed.scheme() != RELAY_SCHEME
        || !parsed.username().is_empty()
        || parsed.password().is_some_and(|p| !p.is_empty())
        || parsed.port().is_some()
        || parsed.fragment().is_some_and(|f| !f.is_empty())
    {
        return None;
    }
    if !parsed.path().trim_matches('/').is_empty() {
        return None;
    }
    let params: Vec<(String, String)> = parsed
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let hostname = parsed.host_str().unwrap_or("");
    if hostname == "open" {
        return params.is_empty().then_some(RelayLink::Open);
    }
    if hostname != "switch" {
        return None;
    }
    let ids: Vec<&String> = params
        .iter()
        .filter(|(k, _)| k == "account")
        .map(|(_, v)| v)
        .collect();
    if params.len() != 1 || ids.len() != 1 {
        return None;
    }
    let id = ids[0];
    if !account_id(id) {
        return None;
    }
    if let Some(accounts) = accounts
        && !accounts.iter().any(|a| a.link_id() == id)
    {
        return None;
    }
    Some(RelayLink::Switch {
        account_id: id.clone(),
    })
}

/// A relay:// link among command-line arguments (Windows and Linux pass it there).
pub fn relay_link_argument<S: AsRef<str>>(argv: &[S]) -> Option<&str> {
    let prefix = format!("{RELAY_SCHEME}://");
    argv.iter()
        .map(AsRef::as_ref)
        .find(|arg| arg.to_lowercase().starts_with(&prefix))
}

/// The account a widget's switch request opens the review for: one of Relay's accounts that is not
/// already open in Claude; `None` otherwise.
pub fn linked_switch_account<'a, A: LinkAccount>(
    account_id: Option<&str>,
    accounts: &'a [A],
    active_id: Option<&str>,
) -> Option<&'a A> {
    let account_id = account_id.filter(|id| !id.is_empty())?;
    if Some(account_id) == active_id {
        return None;
    }
    accounts.iter().find(|a| a.link_id() == account_id)
}
