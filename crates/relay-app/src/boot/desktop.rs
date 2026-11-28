//! The Claude app's manager on the vault, its launch choice and the separate windows; then
//! Relay's updates (port of electron/main/boot/desktop.ts).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use relay_core::desktop::{
    AnswerGuard, AutomationTarget, DesktopError, DesktopHost, DesktopManager, DesktopResult,
    LaunchChoice, LaunchOptions, OperationLock,
};
use relay_core::desktop_files::{identity, read_object};
use relay_core::desktop_host_node::{NodeDesktopHost, NodeHostOptions, node_desktop_host};
use relay_core::desktop_instances::ClaudeWindowProcess;
use relay_core::desktop_launch::{ClaudeSignOut, LaunchWatch};
use relay_core::desktop_windows::{DesktopWindows, DesktopWindowsDeps};
use relay_core::draft_transfer::{DraftJob, DraftResult};
use relay_core::shared::types::{ClaudeLaunchPatch, DesktopOperationKind};
use relay_core::switch_diagnostics::SwitchDiagnostics;
use relay_core::vault_crypto::Sealer;
use relay_core::vault_migration::VaultSealer;

use crate::services::desktop_support::{WorkspaceFit, align_desktop_workspace};
use crate::services::logs::log_draft_event;
use crate::state::{STATE, lock};

/// How often a window closed by hand gives its sign-in back to the vault.
const RECONCILE_MS: u64 = 15_000;

/// `desktopHost`: the node host, sealing with the app's vault (which may refuse, with the
/// vault's own message). Drafts are read in process, so nothing else differs from the TS.
struct AppDesktopHost {
    base: NodeDesktopHost,
    sealer: Arc<VaultSealer>,
}

impl DesktopHost for AppDesktopHost {
    fn available(&self) -> bool {
        self.base.available()
    }
    fn running(&self) -> DesktopResult<bool> {
        self.base.running()
    }
    fn seems_running(&self) -> DesktopResult<bool> {
        self.base.seems_running()
    }
    fn quit(&self, answer_guard: Option<&AnswerGuard>) -> DesktopResult<()> {
        self.base.quit(answer_guard)
    }
    fn launch(&self, options: Option<LaunchOptions>) -> DesktopResult<()> {
        self.base.launch(options)
    }
    fn seal(&self, data: &str) -> DesktopResult<Vec<u8>> {
        self.sealer
            .seal(data)
            .map_err(|e| DesktopError::new(e.to_string()))
    }
    fn unseal(&self, data: &[u8]) -> DesktopResult<String> {
        self.sealer
            .unseal(data)
            .map_err(|e| DesktopError::new(e.to_string()))
    }
    fn reads_drafts(&self) -> bool {
        self.base.reads_drafts()
    }
    fn read_drafts(&self, job: &DraftJob) -> DraftResult {
        self.base.read_drafts(job)
    }
    fn drafts_blocked(&self) -> DesktopResult<Option<String>> {
        self.base.drafts_blocked()
    }
    fn draft_scratch_dir(&self) -> Option<PathBuf> {
        self.base.draft_scratch_dir()
    }
    fn claude_uptime_ms(&self) -> Option<i64> {
        self.base.claude_uptime_ms()
    }
    fn watch_launch(&self) -> Option<Box<dyn LaunchWatch>> {
        self.base.watch_launch()
    }
    fn signed_out(&self) -> Option<bool> {
        self.base.signed_out()
    }
    fn sign_outs(&self) -> Option<Vec<ClaudeSignOut>> {
        self.base.sign_outs()
    }
    fn has_windows(&self) -> bool {
        self.base.has_windows()
    }
    fn windows(&self) -> DesktopResult<Vec<ClaudeWindowProcess>> {
        self.base.windows()
    }
    fn launch_window(&self, dir: &Path, options: Option<LaunchOptions>) -> DesktopResult<()> {
        self.base.launch_window(dir, options)
    }
    fn quit_window(&self, pid: i64) -> DesktopResult<()> {
        self.base.quit_window(pid)
    }
    fn activate_window(&self, pid: i64) -> DesktopResult<()> {
        self.base.activate_window(pid)
    }
    fn automation_target(&self) -> DesktopResult<AutomationTarget> {
        self.base.automation_target()
    }
    fn windows_seen(&self) -> usize {
        self.base.windows_seen()
    }
}

/// `desktop.operationLock`: the lock shared with Relay's other processes.
struct AppOperationLock;

impl OperationLock for AppOperationLock {
    fn ensure(&self, kind: DesktopOperationKind) -> DesktopResult<Box<dyn FnOnce() + Send>> {
        let Some(lock) = STATE.operation_lock.get().cloned() else {
            return Ok(Box::new(|| {}));
        };
        lock.try_acquire(kind.as_str())
            .map_err(|e| DesktopError::new(e.to_string()))?;
        Ok(Box::new(move || lock.release()))
    }
}

/// `desktop.launchChoice`: how Relay starts Claude, HTTP/3 kept off once learned.
struct AppLaunchChoice;

fn diagnostics() -> &'static Mutex<SwitchDiagnostics> {
    STATE
        .switch_diagnostics
        .get()
        .expect("switch diagnostics are made before the launch choice")
}

impl LaunchChoice for AppLaunchChoice {
    fn quic_off(&self) -> DesktopResult<bool> {
        Ok(lock(diagnostics()).current().quic_off)
    }
    fn learn_quic_off(&self) -> DesktopResult<()> {
        lock(diagnostics())
            .set(ClaudeLaunchPatch {
                quic_off: Some(true),
            })
            .map_err(|e| DesktopError::new(e.to_string()))?;
        crate::events::changed();
        Ok(())
    }
}

/// A key only to build the node host with: `AppDesktopHost` seals with the vault instead.
fn unused_sealer() -> Arc<Sealer> {
    Arc::new(Sealer::new(&[0u8; 32]).expect("32-byte key"))
}

pub fn boot_desktop() -> Result<Arc<dyn DesktopHost>, String> {
    let host: Arc<dyn DesktopHost> = Arc::new(AppDesktopHost {
        base: node_desktop_host(NodeHostOptions {
            sealer: unused_sealer(),
            apps: None,
            chosen: Some(Arc::new(|| {
                STATE
                    .service()
                    .store
                    .with_state(|state| state.claude_app.clone())
            })),
            runner: None,
        }),
        sealer: STATE.vault_sealer().clone(),
    });
    let desktop = DesktopManager::new(
        crate::host::relay_paths().claude,
        Arc::clone(&STATE.service().store),
        host.clone(),
        None,
        None,
    );
    let _ = STATE.desktop.set(desktop.clone());
    let data = STATE.paths().data_dir();
    let _ = STATE
        .switch_diagnostics
        .set(Mutex::new(SwitchDiagnostics::new(
            data.join("switch-diagnostics"),
        )));
    desktop.configure(|hooks| {
        hooks.operation_lock = Some(Arc::new(AppOperationLock));
        // The captures and the vault's reads go to the same log as the restore.
        hooks.on_draft_event = Some(Arc::new(log_draft_event));
        // How Relay starts Claude: HTTP/3 kept off once learned.
        hooks.launch_choice = Some(Arc::new(AppLaunchChoice));
    });
    // A finished usage sign-in must be the profile's Claude app account; the flow says why not.
    STATE
        .service()
        .set_sign_in_fit(Some(Arc::new(|account| match align_desktop_workspace(account) {
            Ok(WorkspaceFit::OtherAccount) => Some(
                "The browser signed in with another Claude account; this profile belongs to its Claude app account. Switch to the right account on claude.ai or use “Open in Relay window”, then renew the sign-in."
                    .into(),
            ),
            Ok(WorkspaceFit::NoWorkspace) => Some(
                "This sign-in belongs to a workspace of the account that the Claude app has not opened yet. Open Code in that workspace in the Claude app, then renew the sign-in."
                    .into(),
            ),
            Ok(_) => None,
            Err(error) => Some(error),
        })));
    if cfg!(any(target_os = "macos", target_os = "linux")) {
        boot_windows(&data, &host, &desktop);
    }
    crate::services::updates::start_app_updates();
    Ok(host)
}

/// The separate Claude windows (macOS and Linux) and their 15 s reconcile.
fn boot_windows(data: &Path, host: &Arc<dyn DesktopHost>, desktop: &Arc<DesktopManager>) {
    let (current, seed, seal) = (desktop.clone(), desktop.clone(), desktop.clone());
    let windows = Arc::new(DesktopWindows::new(DesktopWindowsDeps {
        folder: data.join("claude-windows"),
        host: host.clone(),
        current: Box::new(move || {
            let config = read_object(&current.root, "config.json")?;
            Ok(identity(config.as_ref()))
        }),
        seed: Box::new(move |account_uuid, dir| seed.seed_window(account_uuid, dir)),
        seal: Box::new(move |account_uuid, dir| seal.seal_window(account_uuid, dir)),
        quic_off: Some(Box::new(|| lock(diagnostics()).current().quic_off)),
        now: Box::new(relay_core::clock::now_ms),
        sleep: None,
        log: Some(Box::new(|event, fields| {
            log_draft_event(event, Some(fields))
        })),
    }));
    let _ = STATE.desktop_windows.set(windows.clone());
    let port = windows.clone();
    desktop.configure(|hooks| hooks.windows = Some(port));
    // A window closed by hand gives its sign-in back to the vault within seconds.
    let _ = std::thread::Builder::new()
        .name("relay-desktop-windows".into())
        .spawn(move || {
            while !STATE.quitting() {
                if windows.reconcile().is_ok_and(|sealed| !sealed.is_empty()) {
                    crate::events::changed();
                }
                std::thread::sleep(Duration::from_millis(RECONCILE_MS));
            }
        });
}
