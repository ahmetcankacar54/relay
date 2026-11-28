//! The macOS menu bar popover (port of electron/tray-panel.ts): one hidden non-activating panel,
//! shown under the tray icon. Its page reports its first paint (`relay:panel-size`), and only a
//! painted panel opens; a tray click that finds it unusable brings it back for the next one. A
//! panel AppKit orders in on no Space is made again and opened once it has painted.
//!
//! Outside macOS Relay has no panel: `TrayPanel` exists but never makes a window.

use std::sync::{Arc, Mutex};

use relay_core::shared::tray_panel::Rect;
use serde_json::Value;
use tauri::AppHandle;

pub const LABEL: &str = "panel";
/// The panel's height before its page reports one.
pub const INITIAL_HEIGHT: f64 = 520.0;

/// Something that keeps the panel from opening, for the private diagnosis log: (event, fields).
pub type PanelEvent = Arc<dyn Fn(&str, Value) + Send + Sync>;

static CURRENT: Mutex<Option<TrayPanel>> = Mutex::new(None);

#[derive(Clone)]
pub struct TrayPanel {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    inner: Arc<Inner>,
}

struct Inner {
    app: AppHandle,
    on_event: PanelEvent,
    on_visibility_change: Arc<dyn Fn() + Send + Sync>,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    state: Mutex<imp::State>,
}

impl TrayPanel {
    pub fn new(
        app: &AppHandle,
        on_event: PanelEvent,
        on_visibility_change: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        let panel = TrayPanel {
            inner: Arc::new(Inner {
                app: app.clone(),
                on_event,
                on_visibility_change,
                state: Mutex::new(imp::State::new()),
            }),
        };
        *crate::state::lock(&CURRENT) = Some(panel.clone());
        #[cfg(target_os = "macos")]
        {
            let made = panel.clone();
            super::on_main(app, move || made.create());
        }
        panel
    }

    /// The panel made last, if any.
    pub fn current() -> Option<TrayPanel> {
        crate::state::lock(&CURRENT).clone()
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;

    pub struct State;

    impl State {
        pub fn new() -> Self {
            State
        }
    }

    impl TrayPanel {
        pub fn usable(&self) -> bool {
            false
        }
        pub fn revive(&self) {}
        pub fn toggle(&self, _tray: Rect) {}
        pub fn hide(&self) {}
        pub fn is_open(&self) -> bool {
            false
        }
        pub fn set_height(&self, _height: f64) {}
        pub fn destroy(&self) {}
    }

    #[allow(dead_code)]
    fn unused(inner: &Inner) -> (&AppHandle, &PanelEvent, &Arc<dyn Fn() + Send + Sync>) {
        (&inner.app, &inner.on_event, &inner.on_visibility_change)
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;

    use relay_core::clock::now_ms;
    use relay_core::shared::tray_panel::{
        INITIAL_PANEL_LOAD, PANEL_WIDTH, PanelBlur, PanelBlurAction, PanelHealth, PanelLoadEvent,
        PanelLoadState, PanelOffSpaceAction, PanelPhase, PanelRevival, PendingOpen, Point, Size,
        ToggleGuard, clamp_panel_height, panel_blur_action, panel_load_state,
        panel_off_space_action, panel_position, panel_revival, pending_open_due,
    };
    use serde_json::json;
    use tauri::webview::{NewWindowResponse, PageLoadEvent};
    use tauri::{
        LogicalPosition, LogicalSize, Manager, WebviewWindow, WebviewWindowBuilder, WindowEvent,
    };
    use tauri_nspanel::{CollectionBehavior, PanelLevel, StyleMask, WebviewWindowExt, tauri_panel};

    use crate::state::lock;
    use crate::windows::{PANEL_PAGE, on_main, page_url, relay_page};

    tauri_panel! {
        panel!(RelayPanel {
            config: {
                can_become_key_window: true,
                can_become_main_window: false,
                is_floating_panel: true
            }
        })
    }

    pub struct State {
        /// Ready only once the page has painted (sent its first size).
        load: PanelLoadState,
        guard: ToggleGuard,
        anchor: Option<Rect>,
        height: f64,
        visible: bool,
        /// The page is loading now.
        loading: bool,
        /// When the panel last stopped being ready (or was made).
        unready_since: f64,
        revived_at: f64,
        opened_at: f64,
        rebuilt_at: f64,
        /// The click that found the panel off the Space, to open the new window for once it paints.
        pending_open: Option<(Rect, PendingOpen)>,
        /// The window is being destroyed to be made again: its Destroyed event makes the new one.
        rebuilding: bool,
        destroyed: bool,
    }

    impl State {
        pub fn new() -> Self {
            State {
                load: INITIAL_PANEL_LOAD,
                guard: ToggleGuard::new(),
                anchor: None,
                height: INITIAL_HEIGHT,
                visible: false,
                loading: false,
                unready_since: now(),
                revived_at: f64::NEG_INFINITY,
                opened_at: f64::NEG_INFINITY,
                rebuilt_at: f64::NEG_INFINITY,
                pending_open: None,
                rebuilding: false,
                destroyed: false,
            }
        }
    }

    fn now() -> f64 {
        now_ms() as f64
    }

    fn message(error: impl std::fmt::Display) -> Value {
        Value::String(error.to_string())
    }

    impl TrayPanel {
        fn state(&self) -> std::sync::MutexGuard<'_, State> {
            lock(&self.inner.state)
        }

        fn event(&self, event: &str, fields: Value) {
            (self.inner.on_event)(event, fields);
        }

        fn live(&self) -> Option<WebviewWindow> {
            self.inner.app.get_webview_window(LABEL)
        }

        fn ns_panel(&self) -> Option<tauri_nspanel::PanelHandle<tauri::Wry>> {
            use tauri_nspanel::ManagerExt;
            self.inner.app.get_webview_panel(LABEL).ok()
        }

        /// Makes the hidden panel window and loads its page. Main thread.
        pub(super) fn create(&self) {
            {
                let mut state = self.state();
                if state.destroyed {
                    return;
                }
                state.load = INITIAL_PANEL_LOAD;
                state.unready_since = now();
                state.visible = false;
                state.loading = true;
                state.height = INITIAL_HEIGHT;
            }
            if let Err(error) = self.build() {
                self.state().loading = false;
                self.event(
                    "tray-panel-revive-failed",
                    json!({ "action": "create", "error": message(error) }),
                );
            }
        }

        fn build(&self) -> tauri::Result<()> {
            let app = self.inner.app.clone();
            let pages = app.clone();
            let loads = self.clone();
            let window = WebviewWindowBuilder::new(&app, LABEL, page_url(PANEL_PAGE, None))
                .title("Relay")
                .inner_size(PANEL_WIDTH, INITIAL_HEIGHT)
                .decorations(false)
                .resizable(false)
                .visible(false)
                .focused(false)
                .skip_taskbar(true)
                .transparent(true)
                .on_navigation(move |url| relay_page(&pages, url))
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .on_page_load(move |_, payload| {
                    let panel = loads.clone();
                    let event = payload.event();
                    on_main(&panel.inner.app.clone(), move || match event {
                        // A new document: a navigation that changes nothing reports no start.
                        PageLoadEvent::Started => {
                            panel.state().loading = true;
                            panel.dispatch(PanelLoadEvent::Start);
                        }
                        PageLoadEvent::Finished => {
                            panel.state().loading = false;
                            panel.dispatch(PanelLoadEvent::Finish);
                        }
                    });
                })
                .build()?;
            {
                use window_vibrancy::{
                    NSVisualEffectMaterial, NSVisualEffectState, apply_vibrancy,
                };
                let _ = apply_vibrancy(
                    &window,
                    NSVisualEffectMaterial::Popover,
                    Some(NSVisualEffectState::Active),
                    None,
                );
            }
            let panel = window.to_panel::<RelayPanel>()?;
            // NSWindowStyleMaskNonactivatingPanel: the panel can become key (blur and Esc keep
            // working) without activating Relay, so opening it never raises the main window or
            // pulls focus away from the app the user is in.
            let _ = panel.add_style_mask(StyleMask::empty().nonactivating_panel().value());
            panel.set_level(PanelLevel::PopUpMenu.value());
            // Also over full-screen Spaces.
            panel.set_collection_behavior(
                CollectionBehavior::new()
                    .can_join_all_spaces()
                    .full_screen_auxiliary()
                    .value(),
            );
            panel.set_hides_on_deactivate(false);
            let events = self.clone();
            window.on_window_event(move |event| match event {
                // A blur right after opening (AppKit status item tracking ending, focus
                // transition) must not close the panel; a blur from a later tray click closes it
                // and arms the reopen guard; a blur from anywhere else closes it without arming.
                WindowEvent::Focused(false) => events.blurred(),
                WindowEvent::Destroyed => events.destroyed(),
                _ => {}
            });
            Ok(())
        }

        fn blurred(&self) {
            let (opened_at, tray) = {
                let state = self.state();
                if !state.visible {
                    return;
                }
                (state.opened_at, state.anchor)
            };
            let cursor = crate::macos::cursor().unwrap_or(Point { x: -1e9, y: -1e9 });
            let action = panel_blur_action(PanelBlur {
                opened_at,
                now: now(),
                tray,
                cursor,
            });
            match action {
                PanelBlurAction::Ignore => {}
                PanelBlurAction::HideByTray => self.hide_now(true),
                PanelBlurAction::Hide => self.hide_now(false),
            }
        }

        fn destroyed(&self) {
            let rebuild = {
                let mut state = self.state();
                state.visible = false;
                state.loading = false;
                std::mem::take(&mut state.rebuilding) && !state.destroyed
            };
            if rebuild {
                self.create();
            }
        }

        /// Whether a tray click may open the panel; otherwise the native menu is used.
        pub fn usable(&self) -> bool {
            self.state().load.phase == PanelPhase::Ready && self.live().is_some()
        }

        /// A tray click found the panel unusable and showed the native menu instead. Brings the
        /// panel back for the next click: its window again when that is gone, its page again when
        /// it failed, crashed out or never painted.
        pub fn revive(&self) {
            let panel = self.clone();
            on_main(&self.inner.app.clone(), move || panel.revive_now());
        }

        fn revive_now(&self) {
            let at = now();
            let window = self.live();
            let (health, crashes) = {
                let state = self.state();
                (
                    PanelHealth {
                        phase: state.load.phase,
                        alive: window.is_some(),
                        page_loading: window.is_some() && state.loading,
                        unready_for: at - state.unready_since,
                        since_revival: at - state.revived_at,
                    },
                    state.load.crashes,
                )
            };
            let action = panel_revival(health);
            self.event(
                "tray-panel-unusable",
                json!({
                    "phase": health.phase.as_str(),
                    "crashes": crashes,
                    "alive": health.alive,
                    "pageLoading": health.page_loading,
                    "unreadyFor": health.unready_for,
                    "action": action.map_or("wait", PanelRevival::as_str),
                }),
            );
            let Some(action) = action else {
                return;
            };
            self.state().revived_at = at;
            match (action, window) {
                (PanelRevival::Reload, Some(window)) => {
                    {
                        let mut state = self.state();
                        state.load = INITIAL_PANEL_LOAD;
                        state.unready_since = at;
                    }
                    if let Err(error) = window.reload() {
                        self.event(
                            "tray-panel-revive-failed",
                            json!({ "action": "reload", "error": message(error) }),
                        );
                    }
                }
                _ => self.create(),
            }
        }

        pub fn toggle(&self, tray: Rect) {
            let panel = self.clone();
            on_main(&self.inner.app.clone(), move || panel.toggle_now(tray));
        }

        fn toggle_now(&self, tray: Rect) {
            let (Some(window), Some(ns_panel)) = (self.live(), self.ns_panel()) else {
                return;
            };
            if self.state().visible {
                return self.hide_now(true);
            }
            if !self.state().guard.should_open(now()) {
                return;
            }
            {
                let mut state = self.state();
                state.anchor = Some(tray);
            }
            self.place(&window);
            self.state().opened_at = now();
            // Shown and made key without activating the app: a plain show would bring Relay
            // and its main window forward.
            ns_panel.show_and_make_key();
            self.state().visible = true;
            if self.off_space(&window) {
                return self.rebuild(&window, tray);
            }
            crate::events::panel_visibility(true);
            (self.inner.on_visibility_change)();
        }

        pub fn hide(&self) {
            let panel = self.clone();
            on_main(&self.inner.app.clone(), move || panel.hide_now(false));
        }

        fn hide_now(&self, by_tray_click: bool) {
            {
                let mut state = self.state();
                if !state.visible {
                    return;
                }
                state.visible = false;
                state.opened_at = f64::NEG_INFINITY;
                state.guard.hidden(now(), by_tray_click);
            }
            // Only the panel hides, never the app: focus returns to the previous app because
            // Relay never activated.
            if let Some(ns_panel) = self.ns_panel() {
                ns_panel.hide();
            }
            crate::events::panel_visibility(false);
            (self.inner.on_visibility_change)();
        }

        /// Whether the panel is on screen.
        pub fn is_open(&self) -> bool {
            self.state().visible && self.live().is_some()
        }

        /// The page's size report; the first one marks the panel as painted.
        pub fn set_height(&self, height: f64) {
            let panel = self.clone();
            on_main(&self.inner.app.clone(), move || {
                panel.set_height_now(height)
            });
        }

        fn set_height_now(&self, height: f64) {
            let Some(window) = self.live() else {
                return;
            };
            self.dispatch(PanelLoadEvent::Painted);
            let anchor = self.state().anchor;
            let area = crate::macos::work_area(anchor.unwrap_or(Rect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            }));
            let height = clamp_panel_height(height, area.map_or(f64::INFINITY, |a| a.height));
            self.state().height = height;
            let _ = window.set_size(LogicalSize::new(PANEL_WIDTH, height));
            if anchor.is_some() {
                self.place(&window);
            }
            // The rebuilt panel's first paint opens it for the click that found the old one off
            // the Space.
            let pending = {
                let mut state = self.state();
                if state.pending_open.is_none() || state.load.phase != PanelPhase::Ready {
                    return;
                }
                state.pending_open.take()
            };
            if let Some((bounds, pending)) = pending
                && pending_open_due(Some(pending), now())
                && !self.state().visible
            {
                self.toggle_now(bounds);
            }
        }

        pub fn destroy(&self) {
            let panel = self.clone();
            on_main(&self.inner.app.clone(), move || {
                panel.state().destroyed = true;
                if let Some(window) = panel.ns_panel().and_then(|p| p.to_window()) {
                    let _ = window.destroy();
                }
            });
        }

        /// A shown panel that macOS put on no Space the user can see.
        fn off_space(&self, window: &WebviewWindow) -> bool {
            window
                .ns_window()
                .ok()
                .and_then(crate::macos::on_active_space)
                == Some(false)
        }

        /// The panel was ordered in on no Space: hide it and make its window again, to open for
        /// this click once it has painted. Within PANEL_REBUILD_GAP_MS of the last rebuild it is
        /// only hidden.
        fn rebuild(&self, window: &WebviewWindow, tray: Rect) {
            let at = now();
            let action = panel_off_space_action(at - self.state().rebuilt_at);
            self.event("tray-panel-off-space", json!({ "action": action.as_str() }));
            if let Some(ns_panel) = self.ns_panel() {
                ns_panel.hide();
            }
            {
                let mut state = self.state();
                state.visible = false;
                state.opened_at = f64::NEG_INFINITY;
                state.guard.hidden(at, false);
            }
            if action == PanelOffSpaceAction::Rebuild {
                {
                    let mut state = self.state();
                    state.rebuilt_at = at;
                    state.pending_open = Some((tray, PendingOpen { at }));
                    state.rebuilding = true;
                }
                let window = self
                    .ns_panel()
                    .and_then(|p| p.to_window())
                    .unwrap_or_else(|| window.clone());
                if let Err(error) = window.destroy() {
                    let mut state = self.state();
                    state.pending_open = None;
                    state.rebuilding = false;
                    drop(state);
                    self.event(
                        "tray-panel-revive-failed",
                        json!({ "action": "rebuild", "error": message(error) }),
                    );
                }
            } else {
                crate::events::panel_visibility(false);
            }
            (self.inner.on_visibility_change)();
        }

        fn dispatch(&self, event: PanelLoadEvent) {
            let (before, after) = {
                let mut state = self.state();
                let before = state.load;
                state.load = panel_load_state(before, event);
                if state.load.phase != PanelPhase::Ready && before.phase == PanelPhase::Ready {
                    state.unready_since = now();
                }
                (before, state.load)
            };
            if after.phase == PanelPhase::Ready {
                return;
            }
            if before.phase == PanelPhase::Ready {
                self.event(
                    "tray-panel-left-ready",
                    json!({ "by": event.as_str(), "phase": after.phase.as_str() }),
                );
            }
            self.hide_now(false);
            if after.phase == PanelPhase::Reloading
                && before.phase != PanelPhase::Reloading
                && let Some(window) = self.live()
            {
                let _ = window.reload();
            }
        }

        fn place(&self, window: &WebviewWindow) {
            let (Some(anchor), height) = ({
                let state = self.state();
                (state.anchor, state.height)
            }) else {
                return;
            };
            let Some(area) = crate::macos::work_area(anchor) else {
                return;
            };
            let Point { x, y } = panel_position(
                anchor,
                area,
                Size {
                    width: PANEL_WIDTH,
                    height,
                },
            );
            let _ = window.set_position(LogicalPosition::new(x, y));
        }
    }
}
