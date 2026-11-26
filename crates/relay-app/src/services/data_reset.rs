//! Settings → Advanced → Remove Relay's data, the running half (port of
//! electron/main/data-reset.ts over relay_core::data_reset).

use std::path::PathBuf;

use relay_core::data_reset::{NodeFs, PortError, ResetPorts, begin_reset};
use relay_core::login_item::set_launch_at_login;
use relay_core::shared::types::RunStatus;
use relay_core::terminal_identity::{TerminalKeychain, security_keychain};
use relay_core::usage_credentials::credential_service;
use relay_core::vault_key::{VAULT_KEY_ACCOUNT, VAULT_KEY_SERVICE};

use crate::i18n::say;
use crate::services::desktop_lock::{manual_desktop_lock, pending_auth};
use crate::services::login_item::with_login_item_host;
use crate::state::STATE;

struct AppResetPorts;

fn port_error(error: impl Into<String>) -> PortError {
    error.into().into()
}

impl ResetPorts for AppResetPorts {
    fn root(&self) -> PathBuf {
        STATE.paths().data_dir()
    }

    fn busy(&self) -> Option<String> {
        if STATE
            .service()
            .runner
            .list()
            .iter()
            .any(|run| run.status == RunStatus::Running)
        {
            Some(say("dataReset.busyTerminals"))
        } else if pending_auth() {
            Some(say("dataReset.busySignIn"))
        } else {
            None
        }
    }

    fn stop_gateway(&self) -> Result<(), PortError> {
        use crate::services::gateway::{serialize_proxy, stop_proxy};
        serialize_proxy(stop_proxy).map_err(port_error)
    }

    fn unbind_clients(&self) -> Result<(), PortError> {
        crate::services::gateway::unbind_all_clients().map_err(port_error)
    }

    fn remove_login_item(&self) -> Result<(), PortError> {
        if crate::host::UNPACKAGED {
            return Ok(());
        }
        with_login_item_host(|host| set_launch_at_login(false, host)).map_err(Into::into)
    }

    /// Elsewhere the profiles' sign-ins are files in the folder and the vault key is the
    /// system's.
    fn remove_secrets(&self) -> Result<(), PortError> {
        if !cfg!(target_os = "macos") {
            return Ok(());
        }
        let tool = STATE.paths().security_tool();
        let service = STATE.service();
        for account in STATE.accounts() {
            let profile = service
                .store
                .profile(&account.id)
                .map_err(|e| port_error(e.to_string()))?;
            security_keychain(None, tool.as_deref(), Some(&credential_service(&profile)))
                .remove()
                .map_err(|e| port_error(e.to_string()))?;
        }
        security_keychain(
            Some(VAULT_KEY_ACCOUNT),
            tool.as_deref(),
            Some(VAULT_KEY_SERVICE),
        )
        .remove()
        .map_err(|e| port_error(e.to_string()))
    }

    fn relaunch(&self) {
        STATE.set_quitting(true);
        if let Some(app) = crate::state::app() {
            app.request_restart();
        }
    }
}

/// Refused during a Desktop operation, a running terminal, a sign-in or with separate Claude
/// windows open; then the gateway stops, its clients get their own settings back, the login
/// item and Relay's Keychain items go, and Relay relaunches to empty its folder before anything
/// opens it.
pub fn reset_data() -> Result<(), String> {
    if let Some(windows) = STATE.desktop_windows.get()
        && windows.any_open().map_err(|e| e.to_string())?
    {
        return Err(say("dataReset.busyWindows"));
    }
    manual_desktop_lock(|| {
        begin_reset(
            &AppResetPorts,
            &NodeFs,
            &relay_core::relay_paths::home_dir(),
            relay_core::clock::now_ms(),
        )
    })
}
