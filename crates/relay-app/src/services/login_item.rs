//! The app's side of the login item (port of electron/main/login-item.ts); the rules live in
//! relay_core::login_item.

use relay_core::login_item::{LoginItemHost, NoLoginItem, set_launch_at_login, system_login_item};
use relay_core::relay_paths::{Platform, home_dir};

use crate::services::errors::record_main_error;
use crate::state::STATE;

/// Runs `f` with this computer's login item host (`loginItemHost()`).
pub fn with_login_item_host<T>(f: impl FnOnce(&LoginItemHost) -> T) -> T {
    let env = relay_core::relay_cli_path::process_env();
    let exec_path = std::env::current_exe().unwrap_or_default();
    let settings = system_login_item(&exec_path).unwrap_or_else(|| Box::new(NoLoginItem));
    f(&LoginItemHost {
        platform: Platform::current(),
        env: &env,
        home: home_dir(),
        exec_path,
        settings: settings.as_ref(),
    })
}

/// Brings the system's login item in line with the saved "Open at login". A development run
/// would register the bare development binary, so only the packaged app touches it. Never
/// fails.
pub fn apply_launch_at_login() {
    if crate::host::UNPACKAGED {
        return;
    }
    let enabled = STATE.settings().launch_at_login == Some(true);
    if let Err(error) = with_login_item_host(|host| set_launch_at_login(enabled, host)) {
        record_main_error("launch-at-login", &error.to_string());
    }
}
