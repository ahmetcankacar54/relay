//! The switch story window under the menu bar icon (port of electron/switch-window.ts): never
//! focused and transparent to the mouse. It is made when a story starts and destroyed a while
//! after it ends, so between switches Relay keeps no page for it. macOS only; elsewhere
//! `SwitchWindow` never makes a window.

use std::sync::{Arc, Mutex};

use relay_core::shared::switch_scene::SwitchSceneView;
use relay_core::shared::tray_panel::Rect;
use tauri::AppHandle;

pub const LABEL: &str = "switch";
pub const SWITCH_WINDOW_SIZE: (f64, f64) = (240.0, 150.0);
/// How long the window stays loaded after a story ends, so the next switch opens it at once.
pub const SWITCH_WINDOW_RELEASE_MS: u64 = 30_000;

pub struct SwitchWindowOptions {
    /// The menu bar icon, to open under it; without it the window stays hidden.
    pub anchor: Arc<dyn Fn() -> Option<Rect> + Send + Sync>,
    /// The "show the panda window" setting.
    pub enabled: Arc<dyn Fn() -> bool + Send + Sync>,
    pub panel_open: Arc<dyn Fn() -> bool + Send + Sync>,
}

#[derive(Clone)]
pub struct SwitchWindow {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    inner: Arc<Inner>,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
struct Inner {
    app: AppHandle,
    options: SwitchWindowOptions,
    state: Mutex<imp::State>,
}

static CURRENT: Mutex<Option<SwitchWindow>> = Mutex::new(None);

impl SwitchWindow {
    pub fn new(app: &AppHandle, options: SwitchWindowOptions) -> Self {
        let window = SwitchWindow {
            inner: Arc::new(Inner {
                app: app.clone(),
                options,
                state: Mutex::new(imp::State::default()),
            }),
        };
        *crate::state::lock(&CURRENT) = Some(window.clone());
        #[cfg(all(target_os = "macos", debug_assertions))]
        imp::debug_scene(&window);
        window
    }

    /// The switch window made last, if any.
    pub fn current() -> Option<SwitchWindow> {
        crate::state::lock(&CURRENT).clone()
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;

    #[derive(Default)]
    pub struct State {}

    impl SwitchWindow {
        pub fn show(&self, _view: SwitchSceneView) {}
        pub fn ready(&self, _label: &str) {}
        pub fn sync(&self) {}
        pub fn destroy(&self) {}
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;

    use std::time::Duration;

    use relay_core::shared::switch_scene::{SwitchWindowState, switch_window_visible};
    use relay_core::shared::tray_panel::{
        INITIAL_PANEL_LOAD, PanelLoadEvent, PanelLoadState, PanelPhase, Point, Size,
        panel_load_state, panel_position,
    };
    use tauri::webview::{NewWindowResponse, PageLoadEvent};
    use tauri::{LogicalPosition, Manager, WebviewWindow, WebviewWindowBuilder, WindowEvent};
    use tauri_nspanel::{CollectionBehavior, PanelLevel, StyleMask, WebviewWindowExt, tauri_panel};

    use crate::state::lock;
    use crate::windows::release::after;
    use crate::windows::{SWITCH_PAGE, on_main, page_url, relay_page};

    tauri_panel! {
        panel!(RelaySwitchPanel {
            config: {
                can_become_key_window: false,
                can_become_main_window: false,
                is_floating_panel: true
            }
        })
    }

    pub struct State {
        /// Ready once the page has said it listens; one crash reloads it, a second keeps it off.
        load: PanelLoadState,
        view: Option<SwitchSceneView>,
        shown: bool,
        /// The running release timer's number.
        release: Option<u64>,
        timers: u64,
    }

    impl Default for State {
        fn default() -> Self {
            State {
                load: INITIAL_PANEL_LOAD,
                view: None,
                shown: false,
                release: None,
                timers: 0,
            }
        }
    }

    impl SwitchWindow {
        fn state(&self) -> std::sync::MutexGuard<'_, State> {
            lock(&self.inner.state)
        }

        fn live(&self) -> Option<WebviewWindow> {
            self.inner.app.get_webview_window(LABEL)
        }

        fn ns_panel(&self) -> Option<tauri_nspanel::PanelHandle<tauri::Wry>> {
            use tauri_nspanel::ManagerExt;
            self.inner.app.get_webview_panel(LABEL).ok()
        }

        fn create(&self) -> tauri::Result<()> {
            let app = self.inner.app.clone();
            let pages = app.clone();
            let loads = self.clone();
            {
                let mut state = self.state();
                state.load = INITIAL_PANEL_LOAD;
                state.shown = false;
            }
            let window = WebviewWindowBuilder::new(&app, LABEL, page_url(SWITCH_PAGE, None))
                .title("Relay")
                .inner_size(SWITCH_WINDOW_SIZE.0, SWITCH_WINDOW_SIZE.1)
                .decorations(false)
                .resizable(false)
                .visible(false)
                .focused(false)
                .focusable(false)
                .skip_taskbar(true)
                .shadow(false)
                .transparent(true)
                .on_navigation(move |url| relay_page(&pages, url))
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .on_page_load(move |_, payload| {
                    // A new document: a navigation that changes nothing reports no start.
                    if payload.event() == PageLoadEvent::Started {
                        let window = loads.clone();
                        on_main(&window.inner.app.clone(), move || {
                            window.dispatch(PanelLoadEvent::Start)
                        });
                    }
                })
                .build()?;
            let _ = window.set_ignore_cursor_events(true);
            let panel = window.to_panel::<RelaySwitchPanel>()?;
            let _ = panel.add_style_mask(StyleMask::empty().nonactivating_panel().value());
            panel.set_level(PanelLevel::PopUpMenu.value());
            panel.set_collection_behavior(
                CollectionBehavior::new()
                    .can_join_all_spaces()
                    .full_screen_auxiliary()
                    .value(),
            );
            panel.set_has_shadow(false);
            panel.set_hides_on_deactivate(false);
            let events = self.clone();
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::Destroyed) {
                    events.state().shown = false;
                }
            });
            Ok(())
        }

        /// A new state of the story.
        pub fn show(&self, view: SwitchSceneView) {
            let window = self.clone();
            on_main(&self.inner.app.clone(), move || window.show_now(view));
        }

        fn show_now(&self, view: SwitchSceneView) {
            let visible = view.visible;
            self.state().view = Some(view);
            if visible && (self.inner.options.enabled)() {
                self.cancel_release();
                // The story is decoration: a window that cannot be made leaves the switch alone.
                if self.live().is_none() && self.create().is_err() {
                    if let Some(window) = self.live() {
                        let _ = window.destroy();
                    }
                }
            }
            self.send();
            self.sync_now();
            if !visible {
                self.schedule_release();
            }
        }

        /// The page listens now; only this window's page may say so.
        pub fn ready(&self, label: &str) {
            if label != LABEL {
                return;
            }
            let window = self.clone();
            on_main(&self.inner.app.clone(), move || {
                if window.live().is_none() {
                    return;
                }
                window.dispatch(PanelLoadEvent::Painted);
                window.send();
                window.sync_now();
            });
        }

        /// Shows or hides the window for the current story, setting and menu bar panel.
        pub fn sync(&self) {
            let window = self.clone();
            on_main(&self.inner.app.clone(), move || window.sync_now());
        }

        fn sync_now(&self) {
            let Some(window) = self.live() else {
                return;
            };
            let (visible, shown) = {
                let state = self.state();
                let visible = switch_window_visible(
                    state.view.as_ref().map(|v| v.visible),
                    SwitchWindowState {
                        loaded: state.load.phase == PanelPhase::Ready,
                        enabled: (self.inner.options.enabled)(),
                        panel_open: (self.inner.options.panel_open)(),
                    },
                );
                (visible, state.shown)
            };
            if visible && !shown {
                if self.place(&window)
                    && let Some(panel) = self.ns_panel()
                {
                    panel.show();
                    self.state().shown = true;
                }
            } else if !visible && shown {
                if let Some(panel) = self.ns_panel() {
                    panel.hide();
                }
                self.state().shown = false;
            }
        }

        pub fn destroy(&self) {
            let window = self.clone();
            on_main(&self.inner.app.clone(), move || {
                window.cancel_release();
                window.close_window();
            });
        }

        fn close_window(&self) {
            if let Some(window) = self
                .ns_panel()
                .and_then(|p| p.to_window())
                .or_else(|| self.live())
            {
                let _ = window.destroy();
            }
            self.state().shown = false;
        }

        fn schedule_release(&self) {
            let id = {
                let mut state = self.state();
                if state.release.is_some() || self.live().is_none() {
                    return;
                }
                state.timers += 1;
                state.release = Some(state.timers);
                state.timers
            };
            let window = self.clone();
            after(
                Duration::from_millis(SWITCH_WINDOW_RELEASE_MS),
                Box::new(move || {
                    let app = window.inner.app.clone();
                    on_main(&app, move || {
                        {
                            let mut state = window.state();
                            if state.release != Some(id) {
                                return;
                            }
                            state.release = None;
                            if state.view.as_ref().is_some_and(|v| v.visible) {
                                return;
                            }
                        }
                        window.close_window();
                    });
                }),
            );
        }

        fn cancel_release(&self) {
            self.state().release = None;
        }

        fn send(&self) {
            let view = {
                let state = self.state();
                if state.load.phase != PanelPhase::Ready {
                    return;
                }
                state.view.clone()
            };
            if let Some(view) = view
                && self.live().is_some()
            {
                crate::events::switch_scene(view);
            }
        }

        fn dispatch(&self, event: PanelLoadEvent) {
            let (before, after) = {
                let mut state = self.state();
                let before = state.load;
                state.load = panel_load_state(before, event);
                (before, state.load)
            };
            if after.phase == PanelPhase::Ready {
                return;
            }
            if let Some(panel) = self.ns_panel() {
                panel.hide();
            }
            self.state().shown = false;
            if after.phase == PanelPhase::Reloading
                && before.phase != PanelPhase::Reloading
                && let Some(window) = self.live()
            {
                let _ = window.reload();
            }
        }

        fn place(&self, window: &WebviewWindow) -> bool {
            let Some(anchor) = (self.inner.options.anchor)() else {
                return false;
            };
            let Some(area) = crate::macos::work_area(anchor) else {
                return false;
            };
            let Point { x, y } = panel_position(
                anchor,
                area,
                Size {
                    width: SWITCH_WINDOW_SIZE.0,
                    height: SWITCH_WINDOW_SIZE.1,
                },
            );
            let _ = window.set_position(LogicalPosition::new(x, y));
            true
        }
    }

    /// Development only: `RELAY_DEBUG_SWITCH_SCENE=1` plays one switch scene a few seconds after
    /// start (Electron's `relaySmokeSwitchScene` hook), so the window can be seen without a
    /// real Claude switch.
    #[cfg(debug_assertions)]
    pub fn debug_scene(window: &SwitchWindow) {
        use relay_core::shared::switch_scene::{SceneAccount, SceneAccounts, SwitchStage};
        if std::env::var_os("RELAY_DEBUG_SWITCH_SCENE").is_none() {
            return;
        }
        let window = window.clone();
        let scene = move |stage, visible| SwitchSceneView {
            visible,
            stage,
            story: 1,
            outcome: None,
            disguise: None,
            line: "Relay switches to Work".into(),
            locale: relay_i18n::Locale::En,
            accounts: Some(SceneAccounts {
                from: Some(SceneAccount {
                    name: "Personal".into(),
                    percent: Some(82.0),
                }),
                to: SceneAccount {
                    name: "Work".into(),
                    percent: Some(12.0),
                },
            }),
            motion: true,
        };
        after(
            Duration::from_secs(4),
            Box::new(move || {
                window.show(scene(SwitchStage::Leaving, true));
                std::thread::sleep(Duration::from_millis(1_200));
                window.show(scene(SwitchStage::Waiting, true));
                std::thread::sleep(Duration::from_secs(20));
                window.show(scene(SwitchStage::Hidden, false));
            }),
        );
    }
}
