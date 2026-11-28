//! What the menu bar and the global shortcuts do: a confirmed switch, the panel, the window
//! (port of electron/main/tray-actions.ts).

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};

use relay_core::desktop::DesktopSwitchOptions;
use relay_core::global_shortcuts::{ShortcutSwitchInput, shortcut_switch_target};
use relay_core::host::{MessageBox, MessageKind};
use relay_core::shared::error_text::localize_error;
use relay_core::shared::types::js::JsMap;

use crate::i18n::{say, say_with};
use crate::services::desktop_lock::manual_desktop_lock;
use crate::services::notifications::{notify_extension_left, notify_switched};
use crate::state::STATE;
use crate::windows::panel::TrayPanel;

/// `traySwitch`: one native confirmation, then the normal saved-login switch. Runs on a thread
/// of its own: the confirmation blocks, and the menu bar calls this on the main thread.
pub fn tray_switch(profile_id: String) {
    std::thread::spawn(move || confirm_and_switch(&profile_id));
}

fn confirm_and_switch(profile_id: &str) {
    let Some(account) = STATE
        .accounts()
        .into_iter()
        .find(|account| account.id == profile_id)
    else {
        return;
    };
    let shell = STATE.shell();
    let answer = shell.message_box(&MessageBox {
        kind: MessageKind::Question,
        buttons: vec![
            say("electronMain.switchAndRestartTheClaudeApp"),
            say("common.cancel"),
        ],
        default_id: 0,
        cancel_id: Some(1),
        message: say_with(
            "electronMain.switchTheClaudeAppTo",
            &relay_i18n::Args::new().set("accountName", account.name.clone()),
        ),
        detail: Some(say("electronMain.theClaudeAppQuitsAndReopens")),
        ..MessageBox::default()
    });
    if answer.response != 0 {
        return;
    }
    match manual_desktop_lock(|| {
        STATE
            .desktop()
            .switch_to(profile_id, DesktopSwitchOptions::default())
    }) {
        Ok(()) => {
            notify_switched(&account.name);
            notify_extension_left(&account);
        }
        Err(error) => shell.error_box(
            &say("electronMain.switchFailed"),
            &localize_error(&error, crate::i18n::locale()),
        ),
    }
    crate::services::tray_setup::update_tray();
    crate::events::changed();
}

/// `openFromShortcut`: the "open Relay" shortcut. The menu bar panel on macOS, shown without
/// bringing Relay forward like a click on the menu bar icon (a second press closes it); the
/// main window elsewhere, or when the panel cannot open.
pub fn open_from_shortcut() {
    let bounds = crate::tray::RelayTray::current().and_then(|tray| tray.bounds());
    if let (Some(panel), Some(bounds)) = (TrayPanel::current(), bounds)
        && panel.usable()
    {
        return panel.toggle(bounds);
    }
    if let Some(app) = crate::state::app() {
        crate::windows::main::show(app, None);
    }
}

/// A shortcut's switch question is on screen: another press does not ask twice.
static SHORTCUT_SWITCH_ASKING: AtomicBool = AtomicBool::new(false);

/// `switchFromShortcut`: the "switch to the suggested account" shortcut. The account the
/// panel's badge names, through the menu bar's own confirmation, never silently. Without one,
/// Relay opens to show why.
pub fn switch_from_shortcut() {
    if SHORTCUT_SWITCH_ASKING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        suggested_switch();
        SHORTCUT_SWITCH_ASKING.store(false, Ordering::SeqCst);
    });
}

fn suggested_switch() {
    let now = relay_core::clock::now_ms() as f64;
    let windows = crate::services::desktop_support::separate_windows();
    let accounts = STATE.accounts();
    let usage: JsMap<_> = STATE.usage().snapshot().into_iter().collect();
    let settings = STATE.settings();
    let active_id = STATE
        .observed_desktop()
        .and_then(|state| state.active_profile_id);
    let in_windows: HashSet<String> = windows
        .map(|windows| {
            windows
                .open
                .into_iter()
                .map(|open| open.account_id)
                .collect()
        })
        .unwrap_or_default();
    let target = shortcut_switch_target(&ShortcutSwitchInput {
        active_id: active_id.as_deref(),
        accounts: &accounts,
        usage: &usage,
        settings: &settings,
        now,
        rate: crate::services::tokens_widget::widget_tempo_rate(now),
        in_windows: &in_windows,
    });
    let Some(target) = target else {
        return open_from_shortcut();
    };
    let target = target.id.clone();
    // From another app the question would open behind it: Relay comes forward to ask.
    #[cfg(target_os = "macos")]
    if let Some(app) = crate::state::app() {
        let _ = app.run_on_main_thread(|| {
            if let Some(mtm) = objc2::MainThreadMarker::new() {
                #[allow(deprecated)]
                objc2_app_kit::NSApplication::sharedApplication(mtm)
                    .activateIgnoringOtherApps(true);
            }
        });
    }
    confirm_and_switch(&target);
}
