//! Relay's Tauri shell: windows, tray and the IPC bridge over relay-core.

pub mod boot;
pub mod events;
pub mod host;
pub mod i18n;
pub mod ipc;
pub mod lifecycle;
pub mod services;
#[cfg(feature = "smoke")]
pub mod smoke;
pub mod state;

// Shell's modules
pub mod legacy_storage;
#[cfg(target_os = "macos")]
pub mod macos;
pub mod menu;
pub mod notify;
pub mod shutdown;
pub mod tray;
pub mod windows;

use relay_core::data_reset::{NodeFs, finish_pending_reset};
use relay_core::shared::relay_link::relay_link_argument;

use crate::state::STATE;

/// A data removal the user confirmed finishes here, before anything opens the folder
/// (core/data-reset.ts). The log folder is outside it on macOS.
fn finish_reset() {
    let paths = host::relay_paths();
    let logs = vec![host::logs_dir()];
    finish_pending_reset(
        &paths.data,
        &logs,
        &NodeFs,
        &relay_core::relay_paths::home_dir(),
    );
}

/// A second launch: its relay:// link, or else the main window.
fn second_instance(app: &tauri::AppHandle, argv: Vec<String>) {
    match relay_link_argument(&argv) {
        Some(link) => services::links::open_relay_link(link),
        None => windows::main::show(app, None),
    }
}

pub fn run() {
    services::errors::install_process_error_handlers();
    finish_reset();
    let mut builder = tauri::Builder::default()
        // First, so a second launch hands over before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            second_instance(app, argv);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }
    builder = builder
        .invoke_handler(tauri::generate_handler![
            ipc::commands::relay_invoke,
            ipc::commands::relay_send
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            state::set_app(handle.clone());
            host::install(&handle);
            boot::shell::note_launch();
            // A shutdown or restart quits Relay without asking: a veto there would stall it.
            shutdown::watch();
            listen_for_links(&handle);
            // The Keychain, Claude's files and the first reads may take a while: the event
            // loop keeps running meanwhile.
            std::thread::Builder::new()
                .name("relay-boot".into())
                .spawn(move || {
                    if let Err(error) = boot::boot(&handle) {
                        services::errors::record_main_error("boot", &error);
                        STATE
                            .shell()
                            .error_box(&i18n::say("electronMain.relayDidNotStart"), &error);
                        handle.exit(1);
                    }
                })?;
            Ok(())
        });
    let app = match builder.build(tauri::generate_context!()) {
        Ok(app) => app,
        Err(error) => {
            services::errors::record_main_error("tauri", &error.to_string());
            eprintln!("Relay failed to start: {error}");
            std::process::exit(1);
        }
    };
    app.run(lifecycle::on_event);
}

/// macOS hands relay:// links (the widgets', including the one that launches Relay) to the
/// running app.
fn listen_for_links(app: &tauri::AppHandle) {
    use tauri_plugin_deep_link::DeepLinkExt;
    app.deep_link().on_open_url(|event| {
        for url in event.urls() {
            services::links::open_relay_link(url.as_str());
        }
    });
    // A development build would claim relay:// for the bare binary; only a packaged Relay
    // registers (Windows and Linux; macOS takes it from Info.plist).
    #[cfg(any(windows, target_os = "linux"))]
    if !host::UNPACKAGED {
        let _ = app.deep_link().register("relay");
    }
}
