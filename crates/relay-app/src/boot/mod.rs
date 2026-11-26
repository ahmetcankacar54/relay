//! Relay's startup (port of electron/main/boot/*): each step in the order it runs. The core
//! steps (vault to fleet keeper) need no window, so tests run them without a shell; the shell
//! step makes the tray and the main window.

pub mod automation;
pub mod continuation;
pub mod desktop;
pub mod fleet_keeper;
pub mod shell;
pub mod start;
pub mod usage;
pub mod vault;

use tauri::AppHandle;

/// The steps before any window: registry, vault, Claude app, limits, automation,
/// continuation, fleet and keeper.
pub fn boot_core() -> Result<(), String> {
    vault::boot_vault()?;
    let host = desktop::boot_desktop()?;
    usage::boot_usage()?;
    automation::boot_automation(host)?;
    let evidence = continuation::boot_continuation()?;
    fleet_keeper::boot_fleet_keeper(evidence)?;
    Ok(())
}

/// Everything, once Tauri is ready; runs off the main thread (the Keychain, Claude's files and
/// the first reads may take a while).
pub fn boot(app: &AppHandle) -> Result<(), String> {
    // Moving restarts Relay from Applications; this copy quits.
    if cfg!(target_os = "macos")
        && !crate::host::UNPACKAGED
        && crate::services::updates::settle_install_location()
    {
        return Ok(());
    }
    boot_core()?;
    shell::boot_shell(app);
    start::boot_start();
    Ok(())
}
