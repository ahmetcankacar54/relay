//! IPC, the main window or a login launch, the link Relay was opened with, and the menu bar
//! (port of electron/main/boot/shell.ts).

use std::sync::atomic::{AtomicBool, Ordering};

use relay_core::login_item::launched_at_login;
use relay_core::relay_paths::Platform;
use relay_core::shared::relay_link::relay_link_argument;
use tauri::AppHandle;

use crate::state::STATE;

/// macOS's launch Apple event said "login item"; read in Tauri's `setup`, while it is current.
static OPENED_AT_LOGIN: AtomicBool = AtomicBool::new(false);

/// Reads how macOS opened Relay; call from Tauri's `setup`.
pub fn note_launch() {
    #[cfg(target_os = "macos")]
    OPENED_AT_LOGIN.store(crate::macos::launched_as_login_item(), Ordering::SeqCst);
}

pub fn boot_shell(app: &AppHandle) {
    crate::services::tokens_widget::start_token_scan();
    STATE.initialized.store(true, Ordering::SeqCst);
    crate::services::login_item::apply_launch_at_login();
    // A login launch stays in the tray; the window opens when the user asks for it.
    let argv: Vec<String> = std::env::args().collect();
    let login_launch = launched_at_login(
        &argv,
        Platform::current(),
        OPENED_AT_LOGIN.load(Ordering::SeqCst),
    );
    crate::menu::apply(app, crate::i18n::locale());
    if !login_launch {
        crate::windows::main::create(app, None);
    } else {
        #[cfg(target_os = "macos")]
        let _ = app.set_dock_visibility(false);
    }
    // A relay:// link Relay was opened with: macOS hands it over before ready, Windows and
    // Linux on the command line.
    let launch_link = crate::services::links::take_pending_relay_link().or_else(|| {
        (!cfg!(target_os = "macos"))
            .then(|| relay_link_argument(&argv).map(str::to_owned))
            .flatten()
    });
    if let Some(link) = launch_link {
        crate::services::links::open_relay_link(&link);
    }
    crate::services::tray_setup::create_tray_stack(app);
}
