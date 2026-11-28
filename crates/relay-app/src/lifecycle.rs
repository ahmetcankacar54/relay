//! The app's own events: activation, focus, the last window closing, and quitting (port of
//! electron/main/lifecycle.ts and the quit rule of electron/main-lifecycle.ts).
//!
//! Electron's `before-quit` maps to `RunEvent::ExitRequested` (vetoed with `prevent_exit`),
//! `will-quit` to `RunEvent::Exit`. A quit the app asks for itself (`quit`) goes through the
//! same veto.

use std::sync::Mutex;
use std::sync::atomic::Ordering;

use relay_core::host::{MessageBox, MessageKind};
use relay_core::shared::types::RunStatus;
use relay_i18n::Args;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

use crate::i18n::{say, say_with};
use crate::services::desktop_lock::DESKTOP_LOCK;
use crate::state::{STATE, lock};

/// How long a system shutdown or restart signal lifts the quit safeguards, in ms.
pub const SHUTDOWN_GRACE_MS: i64 = 30_000;

/// Whether a quit now is part of the system shutdown signalled at `shutdown_at`. A shutdown the
/// user cancelled does not lift the safeguards for later quits.
pub fn system_shutting_down(shutdown_at: Option<i64>, now: i64) -> bool {
    shutdown_at.is_some_and(|at| now - at >= 0 && now - at < SHUTDOWN_GRACE_MS)
}

/// The least often a window gaining focus retries the drafts left for want of accessibility.
const ACCESSIBILITY_RETRY_MS: i64 = 30_000;
static ACCESSIBILITY_RETRIED_AT: Mutex<Option<i64>> = Mutex::new(None);

/// Electron's `app.quit()`: asks to quit; `before_quit` may veto.
pub fn quit() {
    if let Some(app) = crate::state::app() {
        app.exit(0);
    }
}

/// Quits for good, past the veto: the work that held it up is done.
fn quit_now(app: &AppHandle) {
    STATE.set_quitting(true);
    app.exit(0);
}

pub fn on_event(app: &AppHandle, event: RunEvent) {
    match event {
        RunEvent::ExitRequested { code, api, .. } => {
            // The last window closed (the main window was released): with a menu bar item, or
            // on macOS, Relay stays.
            if code.is_none() && app.webview_windows().is_empty() {
                if STATE.has_tray() || cfg!(target_os = "macos") {
                    api.prevent_exit();
                }
                return;
            }
            if !before_quit(app) {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => will_quit(),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => crate::windows::main::show(app, None),
        RunEvent::WindowEvent {
            event: WindowEvent::Focused(true),
            ..
        } => retry_drafts_on_focus(),
        _ => {}
    }
}

/// Someone who grants accessibility in System Settings comes back to Relay's window or panel:
/// look, never asking, and once it is granted retry the drafts left for Copy for want of it,
/// each at most once while Relay runs. Looking is cheap, so every focus looks; only a retry
/// waits 30 s for the next.
fn retry_drafts_on_focus() {
    if !cfg!(target_os = "macos") || !STATE.initialized() {
        return;
    }
    if !accessibility_trusted() {
        return;
    }
    let now = relay_core::clock::now_ms();
    {
        let mut retried = lock(&ACCESSIBILITY_RETRIED_AT);
        if retried.is_some_and(|at| now - at < ACCESSIBILITY_RETRY_MS) {
            return;
        }
        *retried = Some(now);
    }
    if let Some(drafts) = STATE.draft_restore.get() {
        let drafts = drafts.clone();
        std::thread::spawn(move || drafts.retry_accessibility(true));
    }
}

/// `systemPreferences.isTrustedAccessibilityClient(false)`: looks, never asks.
#[cfg(target_os = "macos")]
pub fn accessibility_trusted() -> bool {
    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }
    // SAFETY: no arguments; reads this process's accessibility permission.
    unsafe { AXIsProcessTrusted() }
}

#[cfg(not(target_os = "macos"))]
pub fn accessibility_trusted() -> bool {
    false
}

/// Electron's `before-quit`: true lets Relay quit now.
fn before_quit(app: &AppHandle) -> bool {
    let Some(service) = STATE.service.get() else {
        return true;
    };
    // The system is going down: nothing may hold it up; running work ends with Relay.
    if system_shutting_down(
        *lock(&STATE.system_shutdown_at),
        relay_core::clock::now_ms(),
    ) {
        STATE.set_quitting(true);
        return true;
    }
    if STATE
        .usage_credential_refresher
        .get()
        .is_some_and(|refresher| refresher.any_active())
    {
        crate::windows::main::show(app, None);
        std::thread::spawn(|| {
            STATE.shell().message_box(&MessageBox {
                kind: MessageKind::Info,
                message: say("electronMain.aUsageSignInRenewalIs"),
                detail: Some(say("electronMain.relayStaysOpenUntilTheRenewal")),
                buttons: vec![say("electronMain.ok")],
                ..MessageBox::default()
            });
        });
        return false;
    }
    if STATE.quitting() {
        return true;
    }
    if STATE.desktop.get().is_some_and(|desktop| desktop.is_busy()) || DESKTOP_LOCK.busy() {
        return false;
    }
    let active: Vec<String> = service
        .runner
        .list()
        .into_iter()
        .filter(|run| run.status == RunStatus::Running)
        .map(|run| run.id)
        .collect();
    if active.is_empty() {
        if STATE.auth_busy() {
            let app = app.clone();
            let service = service.clone();
            std::thread::spawn(move || {
                service.auth.dispose();
                quit_now(&app);
            });
            return false;
        }
        STATE.set_quitting(true);
        return true;
    }
    let app = app.clone();
    let service = service.clone();
    std::thread::spawn(move || {
        let answer = STATE.shell().message_box(&MessageBox {
            kind: MessageKind::Question,
            buttons: vec![
                say("electronMain.backToRelay"),
                say("electronMain.stopAndQuit"),
            ],
            default_id: 0,
            cancel_id: Some(0),
            message: say_with(
                "electronMain.terminalsRunning",
                &Args::new().set("count", active.len() as f64),
            ),
            ..MessageBox::default()
        });
        if answer.response != 1 {
            return;
        }
        let stopped: Result<(), String> = active
            .iter()
            .try_for_each(|id| service.runner.stop(id).map_err(|e| e.to_string()));
        match stopped {
            Ok(()) => {
                service.auth.dispose();
                quit_now(&app);
            }
            Err(error) => STATE
                .shell()
                .error_box(&say("electronMain.quitDidNotFinish"), &error),
        }
    });
    false
}

/// Electron's `will-quit`. Here, not in `before_quit`: that one can still be vetoed (a busy
/// switch, a running terminal), which would leave Relay open with its gateway down.
fn will_quit() {
    // Without the gateway a client still pointed at it cannot answer at all; the next start
    // points it back.
    crate::services::gateway::shutdown();
    crate::services::antigravity::stop_bridges();
    crate::services::updates::stop();
    if let Some(shortcuts) = STATE.global_shortcuts.get() {
        lock(shortcuts).dispose();
    }
    crate::services::notifications::meters_stop();
    STATE.keeper_abort.store(true, Ordering::SeqCst);
    crate::services::tokens_widget::stop_token_scan();
    crate::services::tray_setup::destroy();
    if let Some(usage) = STATE.usage.get() {
        usage.stop();
    }
    if let Some(auto_switch) = STATE.auto_switch.get() {
        auto_switch.stop();
    }
    if let Some(keeper) = STATE.keeper.get() {
        keeper.stop();
    }
    if let Some(continuation) = STATE.continuation.get() {
        continuation.stop();
    }
    if let Some(fleet) = STATE.fleet.get() {
        fleet.stop();
    }
    if let Some(drafts) = STATE.draft_restore.get() {
        drafts.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_shutdown_signal_lifts_the_quit_safeguards_for_30_s_only() {
        assert!(!system_shutting_down(None, 0));
        assert!(system_shutting_down(Some(1_000), 1_000));
        assert!(system_shutting_down(
            Some(1_000),
            1_000 + SHUTDOWN_GRACE_MS - 1
        ));
        // A logout or shutdown the user cancelled does not let a later quit skip the safeguards.
        assert!(!system_shutting_down(
            Some(1_000),
            1_000 + SHUTDOWN_GRACE_MS
        ));
        // A clock set back does not count as shutting down.
        assert!(!system_shutting_down(Some(10_000), 5_000));
    }
}
