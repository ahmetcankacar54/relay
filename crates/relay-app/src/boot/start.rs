//! The last step: once the saved sign-ins are reconciled, every background service starts (port
//! of electron/main/boot/start.ts).

use relay_core::relay_paths::Platform;
use relay_core::shared::types::AutoSwitchMode;

use crate::state::STATE;

pub fn boot_start() {
    crate::services::notifications::meters_start();
    std::thread::Builder::new()
        .name("relay-start".into())
        .spawn(start_services)
        .map(drop)
        .unwrap_or_else(|error| {
            crate::services::errors::record_main_error("boot-start", &error.to_string());
        });
}

fn start_services() {
    let service = STATE.service().clone();
    service.reconcile_auth(Platform::current());
    // A profile saved in the wrong workspace of its own account, before Relay could tell.
    crate::services::desktop_support::align_all_workspaces();
    // Corroborate legacy profiles before the first quota request. Otherwise updated identity
    // fields can hide that request behind its old cooldown.
    STATE.usage().start();
    // Claude Code sign-ins end about 30 days after they were made: renew them before.
    if cfg!(target_os = "macos") {
        crate::services::sign_in_renewal::start();
    }
    // The lifetime stays as saved when this fails; the gateway starts all the same.
    let _ = crate::services::gateway::settle_proxy_affinity();
    // A gateway that cannot start (the port is taken) shows why on its page; Relay opens.
    if STATE.settings().proxy.is_some_and(|proxy| proxy.enabled) {
        std::thread::spawn(|| {
            if crate::services::gateway::start_proxy().is_err() {
                crate::events::changed();
            }
        });
    }
    STATE.auto_switch().start();
    STATE.keeper().start();
    STATE.continuation().start();
    STATE.fleet().start();
    let drafts = STATE.draft_restore().clone();
    std::thread::spawn(move || drafts.start());
    crate::events::changed();
    // An unattended switch must not wait on a Keychain consent; ask now, while Relay was just
    // opened by the user.
    if STATE.fleet().enabled()
        || STATE.continuation().snapshot().enabled
        || STATE.settings().auto_switch_mode != AutoSwitchMode::Off
    {
        let desktop = STATE.desktop().clone();
        std::thread::spawn(move || {
            let _ = desktop.verify_saved_logins();
        });
    }
}
