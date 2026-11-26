//! The main window (port of electron/main/windows.ts): made on demand, hidden to the menu bar
//! when closed, and freed a minute after (window-release.ts) unless something still reports to it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};

use relay_core::shared::external_links::is_external_link;
use relay_core::shared::routes::{Destination, PageIntent, intent_hash};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, LogicalSize, Manager, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use super::release::{WindowRelease, WindowReleaseOptions};
use super::{INDEX_PAGE, page_url, relay_page};
use crate::state::{STATE, lock};

pub const LABEL: &str = "main";

/// The main window was closed to the menu bar; showing it again clears this.
static CLOSED_TO_TRAY: AtomicBool = AtomicBool::new(false);
/// Its page is loading: a navigation waits for it to finish.
static LOADING: AtomicBool = AtomicBool::new(false);
/// Pages asked for while it loaded (`relay:navigate` arguments).
static PENDING: Mutex<Vec<(String, Option<String>)>> = Mutex::new(Vec::new());
/// The Dock icon was hidden with the window (Cmd+Q).
#[cfg(target_os = "macos")]
static DOCK_HIDDEN: AtomicBool = AtomicBool::new(false);

/// A closed main window stays loaded a minute, then its page is freed; `show` makes it again. A
/// sign-in or a Desktop operation in progress keeps it.
static RELEASE: LazyLock<WindowRelease> = LazyLock::new(|| {
    WindowRelease::new(WindowReleaseOptions::new(
        // Only a window closed to the menu bar: Cmd+H, a minimized window and macOS occlusion
        // also hide it, and such a window must stay.
        || {
            CLOSED_TO_TRAY.load(Ordering::SeqCst)
                && current().is_some_and(|w| {
                    !w.is_visible().unwrap_or(true) && !w.is_minimized().unwrap_or(false)
                })
        },
        || STATE.main_window_busy(),
        || {
            if let Some(released) = current() {
                let _ = released.destroy();
            }
        },
    ))
});

fn release() -> &'static WindowRelease {
    &RELEASE
}

fn current() -> Option<WebviewWindow> {
    crate::state::app()?.get_webview_window(LABEL)
}

/// The main window, when it exists.
pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

/// Whether its page is still loading.
pub fn is_loading(app: &AppHandle) -> bool {
    window(app).is_some() && LOADING.load(Ordering::SeqCst)
}

/// Shows the main window on `target` (a page of src/app/routes.ts, with an optional intent): a
/// window made now opens there, a loaded one is told to go.
pub fn open_page(app: &AppHandle, target: &str, want: Option<&str>) {
    let fresh = window(app).is_none();
    let hash = Destination::parse(target).map(|page| {
        let intent = want.and_then(|want| {
            serde_json::from_value::<PageIntent>(serde_json::Value::String(want.into())).ok()
        });
        intent_hash(page, intent)
    });
    show(app, hash.as_deref());
    if fresh || window(app).is_none() {
        return;
    }
    if LOADING.load(Ordering::SeqCst) {
        lock(&PENDING).push((target.to_owned(), want.map(str::to_owned)));
    } else {
        crate::events::navigate(target, want);
    }
}

pub fn show(app: &AppHandle, hash: Option<&str>) {
    if !STATE.initialized() {
        return;
    }
    if window(app).is_none() && STATE.service.get().is_some() {
        create(app, hash);
    }
    let Some(window) = window(app) else {
        return;
    };
    // Cmd+Q hides the Dock icon with the window; opening it again brings it back. Only when
    // hidden: showing a visible Dock icon again re-activates the app.
    #[cfg(target_os = "macos")]
    if DOCK_HIDDEN.swap(false, Ordering::SeqCst) {
        let _ = app.set_dock_visibility(true);
    }
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    let _ = window.show();
    let _ = window.set_focus();
    shown();
}

/// Electron's "show" event: the window is back from the menu bar.
fn shown() {
    CLOSED_TO_TRAY.store(false, Ordering::SeqCst);
    release().cancel();
}

/// Cmd+Q: close the window and keep Relay running in the menu bar. Without a tray there is
/// nothing to stay for, so it quits. The switch window is left alone: it follows the menu bar
/// panel and the switch story.
pub fn close_to_tray(app: &AppHandle) {
    if !STATE.has_tray() {
        crate::lifecycle::quit();
        return;
    }
    if let Some(window) = window(app) {
        let _ = window.hide();
        close_window_to_tray();
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(panel) = super::panel::TrayPanel::current() {
            panel.hide();
        }
        DOCK_HIDDEN.store(true, Ordering::SeqCst);
        let _ = app.set_dock_visibility(false);
    }
}

/// The main window went to the menu bar: free its page if it stays there.
fn close_window_to_tray() {
    CLOSED_TO_TRAY.store(true, Ordering::SeqCst);
    release().arm();
}

/// Cmd+W. The main window closes as its close button does: it hides and Relay stays in the menu
/// bar. The menu bar panel hides; other windows are left alone.
pub fn close_focused_window(app: &AppHandle) {
    let focused = app
        .webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false));
    let Some(focused) = focused else {
        return;
    };
    if focused.label() == LABEL {
        let _ = focused.close();
    }
    #[cfg(target_os = "macos")]
    if focused.label() == super::panel::LABEL
        && let Some(panel) = super::panel::TrayPanel::current()
    {
        panel.hide();
    }
}

/// Makes the main window on `hash` (`#/planlama`), shown.
pub fn create(app: &AppHandle, hash: Option<&str>) -> Option<WebviewWindow> {
    let pages = app.clone();
    let links = app.clone();
    let mut builder = WebviewWindowBuilder::new(app, LABEL, page_url(INDEX_PAGE, hash))
        .title("Relay")
        .inner_size(960.0, 760.0)
        .min_inner_size(720.0, 560.0)
        // Only Relay's own pages load here.
        .on_navigation(move |url| relay_page(&pages, url))
        // A link opens in the browser only when it is one of the allow-listed pages; no window opens.
        .on_new_window(move |url, _features| {
            if is_external_link(url.as_str()) {
                let _ = links.run_on_main_thread({
                    let url = url.to_string();
                    move || {
                        let _ = tauri_plugin_opener::open_url(url, None::<&str>);
                    }
                });
            }
            NewWindowResponse::Deny
        })
        .on_page_load(|_window, payload| match payload.event() {
            PageLoadEvent::Started => LOADING.store(true, Ordering::SeqCst),
            PageLoadEvent::Finished => {
                LOADING.store(false, Ordering::SeqCst);
                for (target, want) in std::mem::take(&mut *lock(&PENDING)) {
                    crate::events::navigate(&target, want.as_deref());
                }
            }
        });
    #[cfg(target_os = "macos")]
    {
        // The sidebar shows the system material (the `vibrant` variant in src/styles/theme.css).
        // 16 px from the left: the three buttons end at 68 px, inside the 84 px collapsed rail.
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(16.0, 19.0))
            .transparent(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        // The window takes the page colour, so nothing flashes before the page draws.
        let dark = app
            .get_webview_window(LABEL)
            .and_then(|w| w.theme().ok())
            .or_else(|| dark_theme_hint(app))
            == Some(tauri::Theme::Dark);
        builder = builder.background_color(if dark {
            tauri::window::Color(0x10, 0x0f, 0x0e, 0xff)
        } else {
            tauri::window::Color(0xf5, 0xf4, 0xf2, 0xff)
        });
    }
    LOADING.store(true, Ordering::SeqCst);
    let window = match builder.build() {
        Ok(window) => window,
        Err(error) => {
            LOADING.store(false, Ordering::SeqCst);
            eprintln!("Relay could not open its window. {error}");
            return None;
        }
    };
    #[cfg(target_os = "macos")]
    {
        // AppKit views: on the main thread (boot makes the window from its own thread).
        let vibrant = window.clone();
        super::on_main(app, move || {
            use window_vibrancy::{NSVisualEffectMaterial, NSVisualEffectState, apply_vibrancy};
            let _ = apply_vibrancy(
                &vibrant,
                NSVisualEffectMaterial::Sidebar,
                Some(NSVisualEffectState::FollowsWindowActiveState),
                None,
            );
        });
    }
    let _ = window.set_min_size(Some(LogicalSize::new(720.0, 560.0)));
    let own = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            if !STATE.quitting() && STATE.has_tray() {
                api.prevent_close();
                // Linux desktops without a tray area would leave a hidden window unreachable.
                if cfg!(target_os = "linux") {
                    let _ = own.minimize();
                } else {
                    let _ = own.hide();
                }
                close_window_to_tray();
            }
        }
        WindowEvent::Destroyed => {
            release().cancel();
            LOADING.store(false, Ordering::SeqCst);
            lock(&PENDING).clear();
        }
        _ => {}
    });
    shown();
    Some(window)
}

/// The system's light or dark preference, read from any open window.
#[cfg(not(target_os = "macos"))]
fn dark_theme_hint(app: &AppHandle) -> Option<tauri::Theme> {
    app.webview_windows().values().find_map(|w| w.theme().ok())
}
