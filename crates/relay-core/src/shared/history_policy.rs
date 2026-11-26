//! Port of `shared/history-policy.ts`: who shares local Code history.

use super::types::{Account, DesktopHistoryTransfer, RelaySettings};

/// "same-group" keeps a work account's history inside its group; "all" ignores groups; a selected
/// set needs both endpoints in it.
pub fn allowed_history_pair(source: &Account, target: &Account, settings: &RelaySettings) -> bool {
    if source.id == target.id {
        return false;
    }
    match settings.desktop_history_transfer {
        DesktopHistoryTransfer::All => true,
        DesktopHistoryTransfer::Selected => {
            settings.desktop_history_accounts.contains(&source.id)
                && settings.desktop_history_accounts.contains(&target.id)
        }
        _ => source.group == target.group,
    }
}

pub fn history_sources<'a>(
    target: &Account,
    accounts: &'a [Account],
    settings: &RelaySettings,
) -> Vec<&'a Account> {
    if settings.desktop_history_transfer == DesktopHistoryTransfer::Off {
        return Vec::new();
    }
    accounts
        .iter()
        .filter(|source| source.desktop.is_some() && allowed_history_pair(source, target, settings))
        .collect()
}
