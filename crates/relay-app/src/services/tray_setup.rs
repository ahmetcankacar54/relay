//! The menu bar: its panel, title, icon, switch window and story, and the global shortcuts
//! (port of electron/main/tray-setup.ts over Shell's `crate::tray` and `crate::windows`).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use relay_core::desktop::RestartHook;
use relay_core::global_shortcuts::{
    GlobalShortcuts, ShortcutCallback, ShortcutHandlers, ShortcutHost,
};
use relay_core::menu_bar_title::MenuBarTitle;
use relay_core::shared::switch_scene::{
    SceneContext, SwitchSceneEvent, SwitchSceneState, SwitchStory, SwitchStoryHost, scene_view,
};
use relay_core::shared::tray::TraySnapshot;
use relay_core::shared::types::DesktopRestartEvent;
use relay_core::tray_mascot::{AnimationSettings, read_desktop_for_tray};
use tauri::AppHandle;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use crate::services::desktop_lock::DESKTOP_LOCK;
use crate::state::{STATE, lock};
use crate::tray::{RelayTray, RelayTrayOptions};
use crate::windows::panel::TrayPanel;
use crate::windows::switch::{SwitchWindow, SwitchWindowOptions};

static SWITCH_WINDOW: Mutex<Option<SwitchWindow>> = Mutex::new(None);
static SWITCH_STORY: Mutex<Option<SwitchStory<StoryHost>>> = Mutex::new(None);

/// An update is running; another asked meanwhile.
static UPDATING: AtomicBool = AtomicBool::new(false);
static UPDATE_AGAIN: AtomicBool = AtomicBool::new(false);

/// `void tray?.update()`: redraws the menu-bar item from the current state, off the caller's
/// thread (the Desktop lock tells this inside its hold). Calls during an update fold into one
/// more.
pub fn update_tray() {
    if RelayTray::current().is_none() {
        return;
    }
    if UPDATING.swap(true, Ordering::SeqCst) {
        UPDATE_AGAIN.store(true, Ordering::SeqCst);
        return;
    }
    std::thread::spawn(|| {
        loop {
            UPDATE_AGAIN.store(false, Ordering::SeqCst);
            if let Some(tray) = RelayTray::current() {
                tray.update();
            }
            if !UPDATE_AGAIN.load(Ordering::SeqCst) {
                break;
            }
        }
        UPDATING.store(false, Ordering::SeqCst);
    });
}

/// At quit: the tray, panel, switch story and window go (`will-quit`).
pub fn destroy() {
    if let Some(tray) = RelayTray::current() {
        tray.destroy();
    }
    if let Some(panel) = TrayPanel::current() {
        panel.destroy();
    }
    if let Some(story) = lock(&SWITCH_STORY).as_mut() {
        story.destroy();
    }
    if let Some(window) = lock(&SWITCH_WINDOW).take() {
        window.destroy();
    }
}

/// The switch window, while there is one.
pub fn switch_window() -> Option<SwitchWindow> {
    lock(&SWITCH_WINDOW).clone()
}

/// Whether the menu bar panda may animate: the setting, and macOS Reduce motion.
pub fn motion_allowed() -> bool {
    relay_core::tray_mascot::motion_allowed(STATE.settings().menu_bar_animation, || {
        Ok::<_, ()>(AnimationSettings {
            prefers_reduced_motion: reduced_motion(),
        })
    })
}

fn reduced_motion() -> bool {
    #[cfg(target_os = "macos")]
    return crate::macos::prefers_reduced_motion();
    #[cfg(not(target_os = "macos"))]
    false
}

/// What the menu bar shows now. Every 5 s: the shared cached reading. Through
/// `observed_desktop` it feeds the keeper's block and its active account between keeper runs.
fn tray_snapshot() -> Result<TraySnapshot, String> {
    let desktop = STATE.desktop();
    let read = read_desktop_for_tray(
        || desktop.cached_snapshot(),
        || desktop.is_busy() || DESKTOP_LOCK.busy(),
        || DESKTOP_LOCK.operations() + desktop.operations(),
    )
    .map_err(|e| e.to_string())?;
    STATE.set_observed_desktop(read.state.clone());
    crate::services::desktop_support::align_workspaces_later();
    // The widgets show the account open in Claude: a switch reaches them now.
    if read.state.active_profile_id != crate::services::tokens_widget::widget_active_id() {
        crate::services::tokens_widget::write_widget();
    }
    let mut desktop_state = read.state;
    desktop_state.busy = read.busy;
    let (accounts, settings) = STATE
        .service()
        .store
        .with_state(|state| (state.accounts.clone(), state.settings.clone()));
    let snapshot = TraySnapshot {
        accounts,
        usage: STATE.usage().snapshot().into_iter().collect(),
        desktop: Some(desktop_state),
        auth_busy: Some(STATE.auth_busy()),
        // Unreadable attempts only cost the panda its warm-up, never the tray.
        attempts: STATE.keeper.get().map(|keeper| keeper.recent_attempts()),
        // The title names a switch's target and gives a full window's reset in the planning
        // zone.
        switching_to: desktop.switching_to(),
        time_zone: Some(settings.planning.time_zone.clone()),
        // The items the user chose for the title, and today's figures some of them show.
        title_items: STATE
            .menu_bar_title
            .get()
            .map(|title| lock(title).current().items),
        today: crate::services::tokens_widget::tray_today(),
    };
    *lock(&STATE.last_tray_snapshot) = Some(snapshot.clone());
    Ok(snapshot)
}

/// The story's timers: each fires `tick` unless cleared or replaced first.
struct StoryHost {
    show: Arc<dyn Fn(&SwitchSceneState) + Send + Sync>,
}

static STORY_TIMER: AtomicU64 = AtomicU64::new(0);

impl SwitchStoryHost for StoryHost {
    type Error = std::convert::Infallible;

    fn show(&mut self, state: &SwitchSceneState) -> Result<(), Self::Error> {
        (self.show)(state);
        Ok(())
    }

    fn set_timeout(&mut self, ms: f64) -> u64 {
        let handle = STORY_TIMER.fetch_add(1, Ordering::SeqCst) + 1;
        let wait = Duration::from_millis(ms.max(0.0) as u64);
        std::thread::spawn(move || {
            std::thread::sleep(wait);
            if STORY_TIMER.load(Ordering::SeqCst) == handle
                && let Some(story) = lock(&SWITCH_STORY).as_mut()
            {
                story.tick();
            }
        });
        handle
    }

    fn clear_timeout(&mut self, handle: u64) {
        // A newer timer leaves the count past `handle`; this one moves it past too.
        let _ =
            STORY_TIMER.compare_exchange(handle, handle + 1, Ordering::SeqCst, Ordering::SeqCst);
    }
}

/// The scene the switch window draws for a story state.
fn show_scene(state: &SwitchSceneState) {
    let Some(window) = switch_window() else {
        return;
    };
    let usage = STATE.usage().snapshot();
    let accounts = STATE.accounts();
    let name = |id: &str| {
        accounts
            .iter()
            .find(|account| account.id == id)
            .map(|account| account.name.clone())
    };
    let percent = |id: &str| {
        usage
            .get(id)
            .and_then(|usage| usage.five_hour.as_ref())
            .map(|window| window.used_percent)
    };
    window.show(scene_view(
        state,
        &SceneContext {
            language: crate::i18n::locale(),
            name: &name,
            percent: Some(&percent),
            motion: motion_allowed(),
        },
    ));
}

/// The switch window and its story, macOS only. The story is decoration: if it cannot start,
/// Relay starts without it.
fn create_switch_story(app: &AppHandle) {
    let window = SwitchWindow::new(
        app,
        SwitchWindowOptions {
            anchor: Arc::new(|| RelayTray::current().and_then(|tray| tray.bounds())),
            enabled: Arc::new(|| STATE.settings().switch_window != Some(false)),
            panel_open: Arc::new(|| TrayPanel::current().is_some_and(|panel| panel.is_open())),
        },
    );
    *lock(&SWITCH_WINDOW) = Some(window);
    *lock(&SWITCH_STORY) = Some(SwitchStory::new(StoryHost {
        show: Arc::new(show_scene),
    }));
    // Real restarts only: lock holders that never quit Claude stay silent. A start names the
    // account Claude had open, for the window's from → to line.
    let hook: RestartHook = Arc::new(|event: &DesktopRestartEvent| {
        let event = match event.clone() {
            DesktopRestartEvent::Start { kind, profile_id } => SwitchSceneEvent::Start {
                kind,
                profile_id,
                from_id: STATE
                    .observed_desktop()
                    .and_then(|state| state.active_profile_id),
            },
            DesktopRestartEvent::End {
                kind,
                profile_id,
                ok,
            } => SwitchSceneEvent::End {
                kind,
                profile_id,
                ok,
                from_id: None,
            },
        };
        if let Some(story) = lock(&SWITCH_STORY).as_mut() {
            story.report(event);
        }
    });
    STATE
        .desktop()
        .configure(|hooks| hooks.on_restart = Some(hook));
}

/// Tauri's global-shortcut plugin as the registry `GlobalShortcuts` drives.
struct TauriShortcuts(AppHandle);

impl ShortcutHost for TauriShortcuts {
    /// A key another app holds fails to register: `Ok(false)`, as Electron's `register`.
    fn register(&self, accelerator: &str, callback: ShortcutCallback) -> Result<bool, String> {
        let callback = Arc::new(callback);
        let registered =
            self.0
                .global_shortcut()
                .on_shortcut(accelerator, move |_app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        let callback = callback.clone();
                        std::thread::spawn(move || callback());
                    }
                });
        Ok(registered.is_ok())
    }

    fn unregister(&self, accelerator: &str) -> Result<(), String> {
        self.0
            .global_shortcut()
            .unregister(accelerator)
            .map_err(|e| e.to_string())
    }
}

pub fn create_tray_stack(app: &AppHandle) {
    let panel = cfg!(target_os = "macos").then(|| {
        TrayPanel::new(
            app,
            Arc::new(|event: &str, fields| {
                crate::services::logs::log_draft_event(event, fields.as_object());
            }),
            Arc::new(|| {
                // The switch window never affects the menu bar panel.
                if let Some(window) = switch_window() {
                    window.sync();
                }
            }),
        )
    });
    let data = STATE.paths().data_dir();
    let _ = STATE
        .menu_bar_title
        .set(Mutex::new(MenuBarTitle::new(data.join("menu-bar.json"))));
    let app_for_show = app.clone();
    match RelayTray::new(
        app,
        RelayTrayOptions {
            get_snapshot: Arc::new(tray_snapshot),
            show_window: Arc::new(move || crate::windows::main::show(&app_for_show, None)),
            request_switch: Arc::new(crate::services::tray_actions::tray_switch),
            quit: Arc::new(crate::lifecycle::quit),
            language: Arc::new(crate::i18n::locale),
            panel,
            motion_allowed: Arc::new(motion_allowed),
        },
    ) {
        Ok(_) => STATE.has_tray.store(true, Ordering::SeqCst),
        Err(error) => crate::services::errors::record_main_error("tray", &error),
    }
    if cfg!(target_os = "macos") {
        create_switch_story(app);
    }
    let mut shortcuts = GlobalShortcuts::new(
        Arc::new(TauriShortcuts(app.clone())),
        ShortcutHandlers {
            open_panel: Box::new(|| {
                crate::services::tray_actions::open_from_shortcut();
                Ok(())
            }),
            switch_to_suggested: Box::new(|| {
                crate::services::tray_actions::switch_from_shortcut();
                Ok(())
            }),
        },
        Some(Arc::new(|event: &str, fields| {
            crate::services::logs::log_draft_event(event, Some(fields));
        })),
    );
    shortcuts.apply(STATE.settings().shortcuts.as_ref());
    let _ = STATE.global_shortcuts.set(Mutex::new(shortcuts));
}
