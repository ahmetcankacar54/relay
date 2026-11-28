//! The menu bar item (port of electron/tray.ts, tray-icons.ts and mascot-tray-frames.ts). macOS
//! shows the panda, its title and, with a panel, opens the panel on a click; the full native menu
//! is still built and popped up only when the panel cannot open. Windows and Linux keep the
//! coloured R with a native context menu.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use relay_core::clock::now_ms;
use relay_core::mascot_player::{MascotPlayer, MascotPlayerHost};
use relay_core::shared::mascot::{MascotPose, mascot_pose};
use relay_core::shared::mascot_frames::MascotFrame;
use relay_core::shared::tray::{
    TrayCommand, TrayMenuItem, TraySnapshot, build_tray_menu, can_request_tray_switch, tray_title,
    tray_tooltip, unavailable_tray_menu,
};
use relay_core::shared::tray_panel::{Rect, TrayClickAction, tray_click_action};
use relay_core::tray_face::{TitleOptions, TrayFace, TrayFaceTarget};
use relay_core::tray_menu_lifecycle::{TrayMenuHost, TrayMenuLifecycle};
use relay_core::tray_place::TRAY_GUID;
use relay_core::tray_refresh::{TrayRefreshSteps, refresh_tray};
use relay_i18n::{Args, Locale, translate};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Wry};

use crate::state::lock;
use crate::windows::panel::TrayPanel;

/// How often the item is refreshed (electron/main/tray-setup.ts `trayTimer`).
pub const TRAY_REFRESH: Duration = Duration::from_secs(5);

pub struct RelayTrayOptions {
    pub get_snapshot: Arc<dyn Fn() -> Result<TraySnapshot, String> + Send + Sync>,
    pub show_window: Arc<dyn Fn() + Send + Sync>,
    /// Confirm natively, then switch Claude Desktop to this saved account.
    pub request_switch: Arc<dyn Fn(String) + Send + Sync>,
    pub quit: Arc<dyn Fn() + Send + Sync>,
    pub language: Arc<dyn Fn() -> Locale + Send + Sync>,
    /// macOS menu bar panel; when present, left click toggles it instead of the menu.
    pub panel: Option<TrayPanel>,
    /// Whether the menu bar panda may animate (setting and Reduce motion); poses change regardless.
    pub motion_allowed: Arc<dyn Fn() -> bool + Send + Sync>,
}

// ---------------------------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------------------------

/// PNG representations by scale factor, from scripts/icon.mjs and scripts/mascot.ts output.
type Representations = &'static [(f64, &'static [u8])];

macro_rules! representations {
    ($name:expr) => {
        const {
            &[
                (
                    1.0,
                    include_bytes!(concat!("../icons/tray/", $name, "@1x.png")).as_slice(),
                ),
                (
                    2.0,
                    include_bytes!(concat!("../icons/tray/", $name, "@2x.png")).as_slice(),
                ),
                (
                    3.0,
                    include_bytes!(concat!("../icons/tray/", $name, "@3x.png")).as_slice(),
                ),
            ]
        }
    };
}

macro_rules! frames {
    ($tone:literal) => {
        |frame: MascotFrame| -> Representations {
            match frame {
                MascotFrame::Idle => representations!(concat!("mascot-", $tone, "-idle")),
                MascotFrame::Blink => representations!(concat!("mascot-", $tone, "-blink")),
                MascotFrame::Hungry => representations!(concat!("mascot-", $tone, "-hungry")),
                MascotFrame::Sleep => representations!(concat!("mascot-", $tone, "-sleep")),
                MascotFrame::Alert => representations!(concat!("mascot-", $tone, "-alert")),
                MascotFrame::Away => representations!(concat!("mascot-", $tone, "-away")),
                MascotFrame::Full => representations!(concat!("mascot-", $tone, "-full")),
            }
        }
    };
}

/// A panda frame for the menu bar's tone. macOS tints a template image black on a light menu bar
/// and white on a dark one; alpha alone cannot say which parts are dark, so the dark menu bar gets
/// its own set with the tones swapped (a white mask and dark eyes, not their negative).
fn mascot_frame(dark: bool, frame: MascotFrame) -> Representations {
    if dark {
        frames!("dark")(frame)
    } else {
        frames!("light")(frame)
    }
}

/// The coloured R of Windows and Linux.
const COLOR_ICON: Representations = representations!("icon-color");

#[derive(Clone, Copy)]
pub struct TrayImage {
    representations: Representations,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    template: bool,
}

// ---------------------------------------------------------------------------------------------
// The face: title, tooltip and image
// ---------------------------------------------------------------------------------------------

struct FaceTarget {
    app: AppHandle,
    tray: TrayIcon,
}

impl TrayFaceTarget for FaceTarget {
    type Image = TrayImage;
    type Error = String;

    fn set_title(&mut self, title: &str, _options: TitleOptions) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            // Digits of one width, set on the status item itself (tray-icon has no font option).
            let tray = self.tray.clone();
            let title = title.to_owned();
            on_main_sync(&self.app, move || {
                tray.with_inner_tray_icon(move |inner| {
                    if let Some(item) = inner.ns_status_item() {
                        crate::macos::set_status_title(&item, &title);
                    }
                })
                .map_err(|e| e.to_string())
            })
            .unwrap_or_else(|| Err("the main thread did not answer".into()))
        }
        #[cfg(not(target_os = "macos"))]
        {
            self.tray.set_title(Some(title)).map_err(|e| e.to_string())
        }
    }

    fn set_tool_tip(&mut self, tooltip: &str) -> Result<(), String> {
        self.tray
            .set_tooltip(Some(tooltip))
            .map_err(|e| e.to_string())
    }

    fn set_image(&mut self, image: TrayImage) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            let tray = self.tray.clone();
            on_main_sync(&self.app, move || {
                tray.with_inner_tray_icon(move |inner| {
                    if let Some(item) = inner.ns_status_item() {
                        crate::macos::set_status_image(
                            &item,
                            image.representations,
                            image.template,
                        );
                    }
                })
                .map_err(|e| e.to_string())
            })
            .unwrap_or_else(|| Err("the main thread did not answer".into()))
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = &self.app;
            let png = image
                .representations
                .iter()
                .find(|(scale, _)| *scale == 2.0)
                .or(image.representations.first())
                .map(|(_, png)| *png)
                .ok_or("no image")?;
            let icon = Image::from_bytes(png).map_err(|e| e.to_string())?;
            self.tray.set_icon(Some(icon)).map_err(|e| e.to_string())
        }
    }
}

/// Runs `run` on the main thread and waits for its answer; `None` if it did not come in time.
#[cfg(target_os = "macos")]
fn on_main_sync<T: Send + 'static>(
    app: &AppHandle,
    run: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    if crate::windows::is_main_thread() {
        return Some(run());
    }
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = send.send(run());
    })
    .ok()?;
    receive.recv_timeout(Duration::from_secs(2)).ok()
}

// ---------------------------------------------------------------------------------------------
// The panda
// ---------------------------------------------------------------------------------------------

struct PlayerHost {
    inner: std::sync::Weak<Inner>,
    motion_allowed: Arc<dyn Fn() -> bool + Send + Sync>,
    timers: u64,
    cleared: Arc<Mutex<Vec<u64>>>,
}

impl MascotPlayerHost for PlayerHost {
    type Error = String;

    fn show(&mut self, frame: MascotFrame) -> Result<(), String> {
        let inner = self.inner.upgrade().ok_or("the tray is gone")?;
        *lock(&inner.frame) = frame;
        inner.show_frame(frame)
    }

    fn motion_allowed(&mut self) -> bool {
        (self.motion_allowed)()
    }

    fn set_timeout(&mut self, ms: f64) -> u64 {
        self.timers += 1;
        let handle = self.timers;
        let inner = self.inner.clone();
        let cleared = self.cleared.clone();
        crate::windows::release::after(
            Duration::from_millis(ms.max(0.0) as u64),
            Box::new(move || {
                if lock(&cleared).contains(&handle) {
                    return;
                }
                if let Some(inner) = inner.upgrade()
                    && let Some(player) = lock(&inner.mascot).as_mut()
                {
                    player.fire(handle);
                }
            }),
        );
        handle
    }

    fn clear_timeout(&mut self, handle: u64) {
        let mut cleared = lock(&self.cleared);
        cleared.push(handle);
        // Only recent handles can still be pending; keep the list short.
        if cleared.len() > 64 {
            cleared.drain(..32);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------------------------

struct MenuHost {
    app: AppHandle,
    tray: TrayIcon,
    /// The installed native menu and the commands of its items, by id.
    menu: Option<Menu<Wry>>,
    commands: HashMap<String, TrayCommand>,
    /// The generation of the installed menu, for the lifecycle's open and close reports.
    generation: u64,
    /// The tray this host belongs to, to schedule `run_scheduled` on.
    inner: std::sync::Weak<Inner>,
}

const TRAY_ITEM_PREFIX: &str = "tray:";
const SHORT_OPEN: &str = "tray-short:open";
const SHORT_QUIT: &str = "tray-short:quit";

impl TrayMenuHost<Vec<TrayMenuItem>> for MenuHost {
    type Error = String;

    fn apply(&mut self, items: Vec<TrayMenuItem>, generation: u64) -> Result<(), String> {
        let menu = Menu::new(&self.app).map_err(|e| e.to_string())?;
        let mut commands = HashMap::new();
        for (index, item) in items.iter().enumerate() {
            let id = format!("{TRAY_ITEM_PREFIX}{generation}:{index}");
            let built: Box<dyn IsMenuItem<Wry>> = match item {
                TrayMenuItem::Separator => {
                    Box::new(PredefinedMenuItem::separator(&self.app).map_err(|e| e.to_string())?)
                }
                TrayMenuItem::Normal(entry) => Box::new(
                    MenuItem::with_id(&self.app, &id, &entry.label, entry.enabled, None::<&str>)
                        .map_err(|e| e.to_string())?,
                ),
                TrayMenuItem::Checkbox(entry) => Box::new(
                    CheckMenuItem::with_id(
                        &self.app,
                        &id,
                        &entry.label,
                        entry.enabled,
                        entry.checked.unwrap_or(false),
                        None::<&str>,
                    )
                    .map_err(|e| e.to_string())?,
                ),
            };
            if let Some(command) = item.entry().and_then(|e| e.command.clone()) {
                commands.insert(id, command);
            }
            menu.append(built.as_ref()).map_err(|e| e.to_string())?;
        }
        // In panel mode the menu is popped up on demand only (left click goes to the panel);
        // tray-icon keeps it but shows it on no click by itself.
        self.tray
            .set_menu(Some(menu.clone()))
            .map_err(|e| e.to_string())?;
        self.menu = Some(menu);
        self.commands = commands;
        self.generation = generation;
        Ok(())
    }

    fn schedule(&mut self, generation: u64) {
        let inner = self.inner.clone();
        let _ = self.app.run_on_main_thread(move || {
            if let Some(inner) = inner.upgrade() {
                lock(&inner.menu).run_scheduled(generation);
            }
        });
    }

    fn on_apply_error(&mut self, _error: String) {
        if let Some(inner) = self.inner.upgrade() {
            RelayTray { inner }.update();
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The tray
// ---------------------------------------------------------------------------------------------

#[derive(Clone)]
pub struct RelayTray {
    inner: Arc<Inner>,
}

struct Inner {
    app: AppHandle,
    options: RelayTrayOptions,
    tray: TrayIcon,
    face: Mutex<TrayFace<FaceTarget>>,
    menu: Mutex<TrayMenuLifecycle<Vec<TrayMenuItem>, MenuHost>>,
    mascot: Mutex<Option<MascotPlayer<PlayerHost>>>,
    /// The panda frame on screen, redrawn in the other set when the appearance changes.
    frame: Mutex<MascotFrame>,
    revision: AtomicU64,
    destroyed: AtomicBool,
    /// macOS with a panel: left click opens the popover.
    panel_mode: bool,
}

static CURRENT: Mutex<Option<RelayTray>> = Mutex::new(None);

impl Inner {
    fn show_frame(&self, frame: MascotFrame) -> Result<(), String> {
        let dark = menu_bar_dark();
        let tone = if dark { "dark" } else { "light" };
        lock(&self.face).set_image(&format!("{tone}:{}", frame.as_str()), || TrayImage {
            representations: mascot_frame(dark, frame),
            template: true,
        })
    }

    fn language(&self) -> Locale {
        (self.options.language)()
    }
}

#[cfg(target_os = "macos")]
fn menu_bar_dark() -> bool {
    crate::macos::menu_bar_dark()
}

#[cfg(not(target_os = "macos"))]
fn menu_bar_dark() -> bool {
    false
}

impl RelayTray {
    pub fn new(app: &AppHandle, options: RelayTrayOptions) -> Result<Self, String> {
        let mac = cfg!(target_os = "macos");
        let panel_mode = mac && options.panel.is_some();
        #[cfg(target_os = "macos")]
        // A stable id keeps the item's place across starts, clear of the notch (tray-place.ts).
        crate::macos::place_status_item();
        let first = Image::from_bytes(if mac {
            mascot_frame(menu_bar_dark(), MascotFrame::Idle)[1].1
        } else {
            COLOR_ICON[1].1
        })
        .map_err(|e| e.to_string())?;
        let tray = TrayIconBuilder::with_id(TRAY_GUID)
            .icon(first)
            .icon_as_template(mac)
            .tooltip("Relay")
            // With a panel, clicks go to the panel and the menus pop up on demand.
            .show_menu_on_left_click(!panel_mode)
            .build(app)
            .map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        {
            let _ = tray.with_inner_tray_icon(move |inner| {
                inner.set_show_menu_on_right_click(!panel_mode);
                if let Some(item) = inner.ns_status_item() {
                    crate::macos::set_status_item_autosave_name(&item);
                }
            });
        }
        let inner = Arc::new_cyclic(|weak: &std::sync::Weak<Inner>| Inner {
            app: app.clone(),
            face: Mutex::new(TrayFace::new(FaceTarget {
                app: app.clone(),
                tray: tray.clone(),
            })),
            menu: Mutex::new(TrayMenuLifecycle::new(MenuHost {
                app: app.clone(),
                tray: tray.clone(),
                menu: None,
                commands: HashMap::new(),
                generation: 0,
                inner: weak.clone(),
            })),
            mascot: Mutex::new(None),
            frame: Mutex::new(MascotFrame::Idle),
            revision: AtomicU64::new(0),
            destroyed: AtomicBool::new(false),
            panel_mode,
            tray,
            options,
        });
        let _ = lock(&inner.face).set_tool_tip("Relay");
        if mac {
            // macOS shows the panda; other platforms keep the coloured R.
            let player = MascotPlayer::new(PlayerHost {
                inner: Arc::downgrade(&inner),
                motion_allowed: inner.options.motion_allowed.clone(),
                timers: 0,
                cleared: Arc::default(),
            });
            *lock(&inner.mascot) = Some(player);
        } else {
            let _ = lock(&inner.face).set_image("color", || TrayImage {
                representations: COLOR_ICON,
                template: false,
            });
        }
        let tray_ref = RelayTray {
            inner: inner.clone(),
        };
        let clicks = tray_ref.clone();
        inner
            .tray
            .on_tray_icon_event(move |_, event| clicks.on_click(event));
        let menus = tray_ref.clone();
        inner
            .tray
            .on_menu_event(move |_, event| menus.on_menu_item(event.id().as_ref()));
        *lock(&CURRENT) = Some(tray_ref.clone());
        tray_ref.update();
        let timer = Arc::downgrade(&inner);
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(TRAY_REFRESH);
                let Some(inner) = timer.upgrade() else { break };
                if inner.destroyed.load(Ordering::SeqCst) {
                    break;
                }
                RelayTray { inner }.update();
            }
        });
        Ok(tray_ref)
    }

    /// The tray made last, if any.
    pub fn current() -> Option<RelayTray> {
        lock(&CURRENT).clone()
    }

    fn on_click(&self, event: TrayIconEvent) {
        if self.inner.destroyed.load(Ordering::SeqCst) {
            return;
        }
        let options = &self.inner.options;
        match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } if self.inner.panel_mode => {
                let Some(panel) = options.panel.as_ref() else {
                    return;
                };
                // Every click toggles the panel, a second one within the double-click time too.
                if tray_click_action(panel.usable()) == TrayClickAction::Toggle
                    && let Some(bounds) = self.bounds()
                {
                    return panel.toggle(bounds);
                }
                // The menu for this click, and the panel back for the next.
                panel.revive();
                self.pop_up_menu();
            }
            TrayIconEvent::Click {
                button: MouseButton::Right,
                button_state: MouseButtonState::Down,
                ..
            } if self.inner.panel_mode => self.pop_up_short_menu(),
            TrayIconEvent::DoubleClick { .. } if !self.inner.panel_mode => (options.show_window)(),
            // StatusNotifierItem sends no double-click: a left click opens Relay, and the menu
            // stays on the right click.
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } if cfg!(target_os = "linux") => (options.show_window)(),
            _ => {}
        }
    }

    fn on_menu_item(&self, id: &str) {
        if self.inner.destroyed.load(Ordering::SeqCst) {
            return;
        }
        match id {
            SHORT_OPEN => return (self.inner.options.show_window)(),
            SHORT_QUIT => return (self.inner.options.quit)(),
            _ => {}
        }
        let command = lock(&self.inner.menu).host().commands.get(id).cloned();
        if let Some(command) = command {
            let tray = self.clone();
            std::thread::spawn(move || tray.run(command));
        }
    }

    /// The full menu, popped up when the panel could not open. AppKit tracks it modally; the
    /// lifecycle holds menu changes until it closes. Main thread.
    fn pop_up_menu(&self) {
        let generation = {
            let menu = lock(&self.inner.menu);
            if menu.host().menu.is_none() {
                drop(menu);
                return self.pop_up_short_menu();
            }
            menu.host().generation
        };
        lock(&self.inner.menu).opened(generation);
        let _ = self
            .inner
            .tray
            .with_inner_tray_icon(|inner| inner.show_menu());
        lock(&self.inner.menu).closed(generation);
    }

    /// Right click in panel mode: open the main window or quit.
    fn pop_up_short_menu(&self) {
        if self.inner.destroyed.load(Ordering::SeqCst) {
            return;
        }
        let app = &self.inner.app;
        let language = self.inner.language();
        let t = |id: &str| translate(language, id, &Args::new());
        let short = (|| -> tauri::Result<Menu<Wry>> {
            let open =
                MenuItem::with_id(app, SHORT_OPEN, t("common.openRelay"), true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(
                app,
                SHORT_QUIT,
                t("electronTray.quitRelay"),
                true,
                None::<&str>,
            )?;
            Menu::with_items(app, &[&open, &separator, &quit])
        })();
        let Ok(short) = short else { return };
        let full = lock(&self.inner.menu).host().menu.clone();
        let tray = &self.inner.tray;
        let _ = tray.set_menu(Some(short));
        let _ = tray.with_inner_tray_icon(|inner| inner.show_menu());
        let _ = tray.set_menu(full);
    }

    fn run(&self, command: TrayCommand) {
        let options = &self.inner.options;
        match command {
            TrayCommand::Show => return (options.show_window)(),
            TrayCommand::Quit => return (options.quit)(),
            TrayCommand::ReviewSwitch { profile_id } => match (options.get_snapshot)() {
                Ok(snapshot) => {
                    if self.inner.destroyed.load(Ordering::SeqCst) {
                        return;
                    }
                    if can_request_tray_switch(&snapshot, &profile_id) {
                        (options.request_switch)(profile_id);
                    } else {
                        (options.show_window)();
                    }
                }
                Err(_) => {
                    if !self.inner.destroyed.load(Ordering::SeqCst) {
                        (options.show_window)();
                    }
                }
            },
        }
        self.update();
    }

    /// The menu bar icon, for windows that open under it.
    pub fn bounds(&self) -> Option<Rect> {
        if self.inner.destroyed.load(Ordering::SeqCst) {
            return None;
        }
        #[cfg(target_os = "macos")]
        {
            let tray = self.inner.tray.clone();
            on_main_sync(&self.inner.app, move || {
                tray.with_inner_tray_icon(|inner| {
                    inner
                        .ns_status_item()
                        .and_then(|item| crate::macos::status_item_bounds(&item))
                })
                .ok()
                .flatten()
            })
            .flatten()
        }
        #[cfg(not(target_os = "macos"))]
        {
            let rect = self.inner.tray.rect().ok().flatten()?;
            let scale = self
                .inner
                .app
                .primary_monitor()
                .ok()
                .flatten()
                .map_or(1.0, |m| m.scale_factor());
            let position = rect.position.to_logical::<f64>(scale);
            let size = rect.size.to_logical::<f64>(scale);
            Some(Rect {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            })
        }
    }

    /// Refreshes title, tooltip, panda and menu from a fresh snapshot, off the main thread.
    pub fn update(&self) {
        if self.inner.destroyed.load(Ordering::SeqCst) {
            return;
        }
        let revision = self.inner.revision.fetch_add(1, Ordering::SeqCst) + 1;
        let tray = self.clone();
        std::thread::spawn(move || {
            // The menu bar's appearance changed: the panda in the other set.
            if cfg!(target_os = "macos") {
                let frame = *lock(&tray.inner.frame);
                let _ = tray.inner.show_frame(frame);
            }
            refresh_tray(&mut Refresh {
                tray: &tray,
                revision,
            });
        });
    }

    pub fn destroy(&self) {
        let inner = &self.inner;
        inner.destroyed.store(true, Ordering::SeqCst);
        inner.revision.fetch_add(1, Ordering::SeqCst);
        lock(&inner.menu).destroy();
        if let Some(player) = lock(&inner.mascot).as_mut() {
            player.destroy();
        }
        let _ = inner.tray.set_visible(false);
        let _ = inner.app.remove_tray_by_id(TRAY_GUID);
        let mut current = lock(&CURRENT);
        if current
            .as_ref()
            .is_some_and(|c| Arc::ptr_eq(&c.inner, inner))
        {
            *current = None;
        }
    }

    /// Opening Relay remains available if a read-only snapshot fails. A stale menu must not offer
    /// an action against unknown Desktop state.
    fn show_unavailable(&self) -> Result<(), String> {
        let items = unavailable_tray_menu(self.inner.language());
        if cfg!(target_os = "macos") {
            lock(&self.inner.face).set_title("")?;
        }
        self.install_menu(items, false);
        lock(&self.inner.face).set_tool_tip("Relay")
    }

    /// Hands a poll's menu to the lifecycle on the main thread, the only thread that touches it:
    /// installing a menu waits for the main thread, which must never wait for the menu's lock in
    /// turn (it holds a popped-up menu open). A snapshot menu that cannot be built falls back to
    /// the unavailable one.
    fn install_menu(&self, items: Vec<TrayMenuItem>, fallback: bool) {
        let tray = self.clone();
        let run = move || {
            let fingerprint = serde_json::to_string(&items).unwrap_or_default();
            let installed = lock(&tray.inner.menu).update(items, &fingerprint);
            if installed.is_err() && fallback && !tray.inner.destroyed.load(Ordering::SeqCst) {
                let items = unavailable_tray_menu(tray.inner.language());
                let fingerprint = serde_json::to_string(&items).unwrap_or_default();
                let _ = lock(&tray.inner.menu).update(items, &fingerprint);
            }
        };
        if crate::windows::is_main_thread() {
            run();
        } else {
            let _ = self.inner.app.run_on_main_thread(run);
        }
    }
}

struct Refresh<'a> {
    tray: &'a RelayTray,
    revision: u64,
}

impl TrayRefreshSteps for Refresh<'_> {
    type Snapshot = TraySnapshot;
    type Error = String;

    fn current(&mut self) -> bool {
        let inner = &self.tray.inner;
        !inner.destroyed.load(Ordering::SeqCst)
            && inner.revision.load(Ordering::SeqCst) == self.revision
    }

    fn snapshot(&mut self) -> Result<TraySnapshot, String> {
        (self.tray.inner.options.get_snapshot)()
    }

    fn mascot_next(&mut self, snapshot: &TraySnapshot) -> Result<(), String> {
        let pose = mascot_pose(snapshot.mascot_input(), now_ms() as f64);
        if let Some(player) = lock(&self.tray.inner.mascot).as_mut() {
            player.update(pose);
        }
        Ok(())
    }

    fn mascot_unavailable(&mut self) -> Result<(), String> {
        if let Some(player) = lock(&self.tray.inner.mascot).as_mut() {
            player.update(MascotPose::Idle);
        }
        Ok(())
    }

    fn show(&mut self, snapshot: &TraySnapshot) -> Result<(), String> {
        let inner = &self.tray.inner;
        let language = inner.language();
        let now = now_ms() as f64;
        // AppKit leaves 2 pt between the panda and the title; a leading space would widen the gap.
        if cfg!(target_os = "macos") {
            lock(&inner.face).set_title(&tray_title(snapshot, now, language))?;
        }
        lock(&inner.face).set_tool_tip(&tray_tooltip(snapshot, language, now))?;
        let items = build_tray_menu(snapshot, language, now);
        self.tray.install_menu(items, true);
        Ok(())
    }

    fn unavailable(&mut self) -> Result<(), String> {
        // Retain the existing menu if even a native fallback cannot be built. Every account
        // action still rechecks Desktop state before review.
        let _ = self.tray.show_unavailable();
        Ok(())
    }
}
