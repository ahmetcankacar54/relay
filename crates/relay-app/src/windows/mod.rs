//! Relay's windows: the main window, the menu bar panel, the switch story window, the per-account
//! sign-in windows and the hidden quiet renewal windows (ports of electron/main/windows.ts,
//! tray-panel.ts, switch-window.ts, auth-window.ts and quiet-sign-in.ts).

pub mod auth;
pub mod main;
pub mod panel;
pub mod quiet;
pub mod release;
pub mod switch;

use tauri::{AppHandle, Manager, Url, WebviewUrl};

/// The bundled pages Relay's own windows load.
pub const INDEX_PAGE: &str = "index.html";
pub const PANEL_PAGE: &str = "panel.html";
pub const SWITCH_PAGE: &str = "switch.html";

/// A bundled page, opened on `hash` (`#/planlama`) for the main window.
pub fn page_url(page: &str, hash: Option<&str>) -> WebviewUrl {
    WebviewUrl::App(format!("{page}{}", hash.unwrap_or_default()).into())
}

/// Whether `url` is one of Relay's own pages: the bundled origin (`tauri://localhost` on macOS
/// and Linux, `http(s)://tauri.localhost` on Windows) or, in development, the Vite dev server.
pub fn relay_page(app: &AppHandle, url: &Url) -> bool {
    match (url.scheme(), url.host_str()) {
        ("tauri", Some("localhost")) => return true,
        ("http" | "https", Some("tauri.localhost")) => return true,
        _ => {}
    }
    tauri::is_dev()
        && app
            .config()
            .build
            .dev_url
            .as_ref()
            .is_some_and(|dev| dev.origin() == url.origin())
}

/// Runs `run` on the main thread: now when already there, else queued to it. AppKit and the
/// panel's state are main-thread only.
pub fn on_main(app: &AppHandle, run: impl FnOnce() + Send + 'static) {
    if is_main_thread() {
        run();
    } else {
        let _ = app.run_on_main_thread(run);
    }
}

#[cfg(target_os = "macos")]
pub fn is_main_thread() -> bool {
    objc2::MainThreadMarker::new().is_some()
}

#[cfg(not(target_os = "macos"))]
pub fn is_main_thread() -> bool {
    std::thread::current().name() == Some("main")
}

/// The window labelled `label`, unless it is gone.
pub fn window(app: &AppHandle, label: &str) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(label)
}
