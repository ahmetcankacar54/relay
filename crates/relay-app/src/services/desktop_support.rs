//! Keeping Relay's view of the Claude app current: the registry, workspaces and separate
//! windows (port of electron/main/desktop-support.ts).

use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use indexmap::IndexMap;
use relay_core::shared::account_state::desktop_cli_workspace_mismatch;
use relay_core::shared::desktop_account::{KnownDesktop, desktop_account_for};
use relay_core::shared::types::{
    Account, AccountProvider, AccountUsage, OpenWindow, SeparateWindows,
};

use crate::state::{STATE, lock};

/// `displayUsage`: the usage snapshot with each account's last known resets, for display.
pub fn display_usage() -> IndexMap<String, AccountUsage> {
    let mut current = STATE.usage().snapshot();
    let history = lock(STATE.usage_history());
    for account in STATE.accounts() {
        if let Some(usage) = current.get_mut(&account.id) {
            usage.last_known_resets = history.last_known_resets(&account);
        }
    }
    current
}

/// How often the registry file's stamp is looked at.
const REGISTRY_POLL: Duration = Duration::from_millis(250);

/// `watchRegistry`: reloads the account list when another process (the relay CLI) writes it,
/// and tells the windows and the menu bar. Relay's own writes are noticed and skipped by
/// `reload`. The TS watched the folder; here the file's stamp is polled (a stat each time,
/// `reload` reads only on a change), which needs no watch that can fail.
pub fn watch_registry() {
    let spawned = std::thread::Builder::new()
        .name("relay-registry".into())
        .spawn(|| {
            while !STATE.quitting() {
                std::thread::sleep(REGISTRY_POLL);
                // A file still being replaced is read at its next change.
                if let Ok(true) = STATE.service().store.reload() {
                    crate::events::changed();
                    crate::services::tray_setup::update_tray();
                }
            }
        });
    // Without a watch, another process's changes show after Relay restarts.
    drop(spawned);
}

/// `separateWindows`: the accounts open in a separate Claude window, for the windows; `None`
/// off macOS and Linux.
pub fn separate_windows() -> Option<SeparateWindows> {
    let windows = STATE.desktop_windows.get()?;
    let (open, others) = windows.running(2_000).unwrap_or_default();
    let accounts = STATE.accounts();
    Some(SeparateWindows {
        supported: true,
        enabled: windows.enabled(),
        open: open
            .iter()
            .filter_map(|window| {
                let known = KnownDesktop {
                    account_uuid: &window.account_uuid,
                    org_id: None,
                };
                desktop_account_for(known, &accounts).map(|account| OpenWindow {
                    account_id: account.id.clone(),
                    opened_at: window.opened_at,
                })
            })
            .collect(),
        others: others as f64,
    })
}

/// What `align_desktop_workspace` found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceFit {
    Fits,
    Moved,
    OtherAccount,
    NoWorkspace,
}

/// `alignDesktopWorkspace`: whether a profile's usage sign-in is its Claude app sign-in's
/// account and workspace. One Claude account can have several workspaces (organizations); a
/// profile saved in another one than its usage sign-in names can never be read or switched to,
/// however often the user signs in again. Where the Claude app has that workspace, the profile
/// moves to it (`Moved`).
pub fn align_desktop_workspace(account: &Account) -> Result<WorkspaceFit, String> {
    let (Some(bound), Some(auth)) = (&account.desktop, &account.auth) else {
        return Ok(WorkspaceFit::Fits);
    };
    if account
        .provider
        .is_some_and(|provider| provider != AccountProvider::Claude)
        || !auth.logged_in
    {
        return Ok(WorkspaceFit::Fits);
    }
    let same = |a: &str, b: &str| a.to_lowercase() == b.to_lowercase();
    if let Some(uuid) = &auth.account_uuid
        && !same(uuid, &bound.account_uuid)
    {
        return Ok(WorkspaceFit::OtherAccount);
    }
    let (Some(_), Some(org_id)) = (&auth.account_uuid, &auth.org_id) else {
        return Ok(WorkspaceFit::Fits);
    };
    if same(org_id, &bound.org_id) {
        return Ok(WorkspaceFit::Fits);
    }
    if !STATE
        .desktop()
        .rebind_org(&account.id, org_id)
        .map_err(|e| e.to_string())?
    {
        return Ok(WorkspaceFit::NoWorkspace);
    }
    if let Some(usage) = STATE.usage.get() {
        usage.invalidate(&account.id);
        usage.tick();
    }
    crate::services::tray_setup::update_tray();
    crate::events::changed();
    Ok(WorkspaceFit::Moved)
}

/// boot/start.ts: each saved profile moved to the workspace of its own account, when Relay
/// could not tell before (`alignDesktopWorkspace` over every account; errors ignored).
pub fn align_all_workspaces() {
    for account in STATE.accounts() {
        let _ = align_desktop_workspace(&account);
    }
}

static WORKSPACES_ALIGNED_AT: AtomicI64 = AtomicI64::new(0);

/// `alignWorkspacesLater`: a profile left in another workspace than its usage sign-in (the
/// Claude app had not opened that workspace yet) moves once the app has: looked at with the
/// tray's reading, at most twice a minute, and only for profiles that are out of step.
pub fn align_workspaces_later() {
    let now = relay_core::clock::now_ms();
    let Some(desktop) = STATE.desktop.get() else {
        return;
    };
    if now - WORKSPACES_ALIGNED_AT.load(Ordering::SeqCst) < 30_000 || desktop.is_busy() {
        return;
    }
    WORKSPACES_ALIGNED_AT.store(now, Ordering::SeqCst);
    let desktop = desktop.clone();
    std::thread::spawn(move || {
        desktop.note_sign_outs();
        desktop.note_ended_sign_ins();
        let service = STATE.service();
        for account in STATE.accounts() {
            if desktop_cli_workspace_mismatch(&account) && !service.auth.active(&account.id) {
                let _ = align_desktop_workspace(&account);
            }
        }
    });
}
