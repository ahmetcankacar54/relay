//! The Claude app's automation helper, the draft restore, and the extension and terminal
//! sign-ins (port of electron/main/boot/automation.ts).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use relay_core::browser_system::platform_browser_system;
use relay_core::cookie_store::SqliteCookieStorage;
use relay_core::desktop::{AutomationTarget, DesktopHost, DesktopManager, ExtensionPorts};
use relay_core::desktop_continuation_host::{
    DesktopAutomation, DesktopHostError, DesktopTargetPid, native_desktop_automation,
};
use relay_core::desktop_files::{identity, read_object};
use relay_core::desktop_lock::DesktopLockError;
use relay_core::desktop_watch::{SharedDesktopTarget, native_desktop_watch};
use relay_core::desktop_wipe::last_draft_wipe_at;
use relay_core::draft_diagnostics::DraftLog;
use relay_core::draft_main::{DraftScheduler, DraftSchedulerDeps};
use relay_core::draft_restorer::{DraftCounts, IDLE_MS, QUIET_MS, RestorerDeps};
use relay_core::draft_vault::{DraftRecord, DraftState};
use relay_core::extension_storage::LevelExtensionStorage;
use relay_core::relay_paths::Platform;
use relay_core::shared::proxy_types::ProxyClientId;
use relay_core::terminal_identity::{
    TerminalAdoption, linux_terminal_ports, mac_terminal_ports, scratch_sign_in_ports,
};

use crate::services::desktop_lock::DESKTOP_LOCK;
use crate::services::logs::{claude_page_booted, draft_retype, log_draft_event};
use crate::services::notifications::{
    notify_drafts, notify_extension_broken, notify_sign_in_ended,
};
use crate::state::STATE;

/// How often the extension's sign-in is looked at again after the rechecks.
const EXTENSION_HEALTH_MS: u64 = 15 * 60_000;

/// The `desktop-automation` helper: beside Relay's executable once bundled; in a development
/// run, there or else where `npm run build:native` leaves it (dist-electron).
fn automation_helper() -> PathBuf {
    let beside = STATE
        .paths()
        .exe_path()
        .parent()
        .map(|dir| dir.join("desktop-automation"))
        .unwrap_or_else(|| PathBuf::from("desktop-automation"));
    if !crate::host::UNPACKAGED || beside.is_file() {
        return beside;
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("dist-electron")
        .join("desktop-automation")
}

fn host_error(error: impl std::fmt::Display) -> DesktopHostError {
    DesktopHostError::other(error.to_string())
}

/// While separate windows run, the helper looks only at the main Claude.
fn automation_target(host: &Arc<dyn DesktopHost>) -> SharedDesktopTarget {
    let host = host.clone();
    Arc::new(move || {
        Ok(match host.automation_target().map_err(host_error)? {
            AutomationTarget::Main => DesktopTargetPid::Any,
            AutomationTarget::Pid(pid) => DesktopTargetPid::Pid(pid),
            AutomationTarget::None => DesktopTargetPid::MainNotRunning,
        })
    })
}

/// What the draft restorer reads and does through the app.
struct AppRestorer {
    host: Arc<dyn DesktopHost>,
    desktop: Arc<DesktopManager>,
    log: Box<DraftLog>,
}

impl RestorerDeps for AppRestorer {
    fn automation(&self) -> &dyn DesktopAutomation {
        STATE.automation().as_ref()
    }
    fn pending(&self) -> Result<Vec<DraftRecord>, DesktopHostError> {
        Ok(self.desktop.pending_draft_records())
    }
    fn mark(
        &self,
        id: &str,
        state: DraftState,
        reason: Option<&str>,
    ) -> Result<(), DesktopHostError> {
        self.desktop
            .mark_draft(id, state, reason.map(str::to_owned))
            .map_err(host_error)
    }
    fn remove(&self, id: &str) -> Result<(), DesktopHostError> {
        self.desktop.dismiss_draft(id).map_err(host_error)
    }
    fn current_account(&self) -> Result<Option<String>, DesktopHostError> {
        let config = read_object(&self.desktop.root, "config.json").map_err(host_error)?;
        Ok(identity(config.as_ref()))
    }
    fn running(&self) -> Result<bool, DesktopHostError> {
        self.host.running().map_err(host_error)
    }
    fn uptime_ms(&self) -> Result<Option<i64>, DesktopHostError> {
        Ok(self.desktop.claude_uptime_ms())
    }
    // Read in place from Claude's live Local Storage: one key, nothing written.
    fn wiped_at(&self) -> Result<Option<i64>, DesktopHostError> {
        let leveldb = self.desktop.root.join("Local Storage").join("leveldb");
        Ok(last_draft_wipe_at(&leveldb).map(|at| at as i64))
    }
    // From Claude's own log, macOS only: no link goes into a page still loading.
    fn page_booted(&self) -> Result<Option<bool>, DesktopHostError> {
        Ok(if cfg!(target_os = "macos") {
            claude_page_booted()
        } else {
            None
        })
    }
    fn with_lock(&self, f: &mut dyn FnMut()) -> Result<bool, DesktopHostError> {
        let desktop = &self.desktop;
        DESKTOP_LOCK
            .restore(
                || {
                    f();
                    Ok::<_, DesktopLockError>(())
                },
                || !desktop.is_busy(),
            )
            .map(|ran| ran.is_some())
            .map_err(host_error)
    }
    // The restore holds the lock as one caller: any more are waiting for it.
    fn yielding(&self) -> bool {
        DESKTOP_LOCK.callers() > 1
    }
    fn notify(&self, summary: DraftCounts) -> Result<(), DesktopHostError> {
        notify_drafts(summary);
        Ok(())
    }
    fn sleep(&self, ms: u64) -> Result<(), DesktopHostError> {
        std::thread::sleep(Duration::from_millis(ms));
        Ok(())
    }
    fn now(&self) -> i64 {
        relay_core::clock::now_ms()
    }
    fn log(&self) -> Option<&DraftLog> {
        Some(self.log.as_ref())
    }
}

/// Whether Claude Code is bound to Relay's running gateway: its requests then do not use the
/// terminal sign-in.
fn gateway_bound() -> bool {
    crate::services::gateway::is_running()
        && crate::services::gateway::proxy_settings()
            .client_bindings
            .is_some_and(|bindings| bindings.contains_key(&ProxyClientId::ClaudeCode))
}

pub fn boot_automation(host: Arc<dyn DesktopHost>) -> Result<(), String> {
    let desktop = STATE.desktop().clone();
    let helper = automation_helper();
    let target = automation_target(&host);
    let helper_target = target.clone();
    let automation: Arc<dyn DesktopAutomation> = Arc::new(native_desktop_automation(
        &helper,
        None,
        Some(Box::new(move || helper_target())),
    ));
    let _ = STATE.automation.set(automation);
    // A diagnosis aid for development; a packaged Relay never reads it.
    if cfg!(target_os = "macos")
        && crate::host::UNPACKAGED
        && std::env::var("RELAY_UI_OUTLINE").as_deref() == Ok("1")
    {
        let (helper, host) = (helper.clone(), host.clone());
        let file = STATE
            .paths()
            .data_dir()
            .join("diagnostics")
            .join("ui-outline.json");
        std::thread::spawn(move || {
            let _ = crate::services::logs::write_ui_outline(&helper, &file, || {
                host.running().unwrap_or(false)
            });
        });
    }
    let restorer = Arc::new(AppRestorer {
        host: host.clone(),
        desktop: desktop.clone(),
        log: Box::new(log_draft_event),
    });
    let drafts = desktop.clone();
    let mut deps = DraftSchedulerDeps::new(
        restorer,
        Box::new(move || Ok(drafts.pending_drafts())),
        Box::new(|| {
            crate::events::changed();
            Ok(())
        }),
        Box::new(draft_retype),
    );
    // Where the user is in Claude, while drafts wait: one long-lived helper, macOS only.
    if cfg!(target_os = "macos") {
        deps.watch = Some(native_desktop_watch(
            &helper,
            QUIET_MS,
            IDLE_MS,
            Some(target),
        ));
    }
    let _ = STATE.draft_restore.set(DraftScheduler::new(deps));
    let browser_system = platform_browser_system(if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "win32"
    });
    let extension = browser_system.is_some();
    desktop.configure(|hooks| {
        // One hook for every switch: tray, panel, automatic, continuation and fleet.
        hooks.on_switched = Some(Arc::new(|| {
            if let Some(restore) = STATE.draft_restore.get().cloned() {
                std::thread::spawn(move || restore.after_switch());
            }
        }));
        // The Claude extension's sign-in follows the account at each switch; macOS and Linux.
        if let Some(system) = browser_system {
            hooks.extension = Some(ExtensionPorts {
                system,
                storage: Arc::new(LevelExtensionStorage),
                cookies: Some(Arc::new(SqliteCookieStorage)),
            });
            hooks.on_sign_in_rejected = Some(Arc::new(|account| {
                notify_sign_in_ended(account);
                crate::events::changed();
            }));
            hooks.on_extension_broken = Some(Arc::new(|account| {
                notify_extension_broken(account);
                crate::events::changed();
            }));
            // A login put back can be refused minutes after the switch: looked at again over
            // half an hour, and every quarter hour after that, so a dropped extension sign-in
            // is told.
            hooks.extension_recheck_ms = vec![3 * 60_000, 12 * 60_000, 25 * 60_000];
        }
        // So does the terminal's Claude Code sign-in; macOS and Linux.
        hooks.terminal = mac_terminal_ports(None, Platform::current())
            .or_else(|| linux_terminal_ports(None, Platform::current()));
        // Bound to the running gateway, Claude Code's requests do not use the terminal sign-in.
        hooks.gateway_bound = Some(Arc::new(gateway_bound));
    });
    if extension {
        let desktop = desktop.clone();
        let _ = std::thread::Builder::new()
            .name("relay-extension-health".into())
            .spawn(move || {
                loop {
                    std::thread::sleep(Duration::from_millis(EXTENSION_HEALTH_MS));
                    if STATE.quitting() {
                        break;
                    }
                    desktop.extension_health();
                    crate::events::changed();
                }
            });
    }
    // A sign-in made for the terminal in a scratch folder: kept for the account, and the
    // Keychain item the CLI made for that folder goes with the folder. (The terminal sign-in
    // shares the usage sign-in's browser: boot/vault.rs.)
    let linking = desktop.clone();
    STATE
        .service()
        .set_terminal_link_fit(Some(Arc::new(move |account_id, dir| {
            if linking.hooks().terminal.is_none() {
                return Err("Terminal sign-ins are kept on macOS and Linux only.".into());
            }
            let ports = scratch_sign_in_ports(dir, Platform::current());
            let result = linking.adopt_terminal_sign_in(account_id, &ports);
            let _ = ports.keychain.remove();
            crate::events::changed();
            match result.map_err(|e| e.to_string())? {
                TerminalAdoption::Saved => Ok(()),
                TerminalAdoption::OtherAccount => Err("The approval in the browser came from another Claude account or workspace. Try again with this profile’s account.".into()),
                TerminalAdoption::SignedOut => {
                    Err("The terminal sign-in did not complete. Try again.".into())
                }
            }
        })));
    // Checked once at start, which links a terminal already signed in to one of the accounts.
    std::thread::spawn(move || {
        let _ = desktop.check_terminal();
    });
    Ok(())
}
