//! Port of `shared/desktop-account.ts`.

use super::types::Account;

/// The Claude app sign-in Relay saw: its account and, when known, its organization.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KnownDesktop<'a> {
    pub account_uuid: &'a str,
    pub org_id: Option<&'a str>,
}

fn same_id(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// The Relay account whose Claude app sign-in is `known`. The organization decides only when
/// both sides know it.
pub fn desktop_account_for<'a>(known: KnownDesktop<'_>, accounts: &'a [Account]) -> Option<&'a Account> {
    accounts.iter().find(|account| {
        let Some(desktop) = &account.desktop else { return false };
        if desktop.account_uuid.is_empty() || !same_id(&desktop.account_uuid, known.account_uuid) {
            return false;
        }
        match known.org_id {
            Some(org) if !org.is_empty() && !desktop.org_id.is_empty() => same_id(&desktop.org_id, org),
            _ => true,
        }
    })
}
