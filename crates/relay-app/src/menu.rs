//! The application menu, in the app's language (port of electron/app-menu.ts and `applyAppMenu`
//! of electron/main/windows.ts). Cmd+Q closes the window to the menu bar and Alt+Cmd+Q quits
//! (there is no stock quit item); Cmd+W closes the focused window. Help opens the documentation
//! and the bug report form, and exports the diagnostics zip. `app_menu_template` is pure, so the
//! tests read it in both languages; `apply` installs it and is called again on a language change.

use std::collections::HashMap;
use std::sync::{Mutex, Once};

use relay_i18n::{Args, Locale, translate};
use tauri::menu::{
    AboutMetadata, IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu,
};
use tauri::{AppHandle, Manager, Url, Wry};

use crate::state::lock;

/// Relay's README on GitHub, which Help → Documentation opens.
pub const DOCUMENTATION_URL: &str = "https://github.com/ahmetcankacar54/relay#readme";

/// Menu event ids are `app-menu:<action>`; the tray's own items use another prefix.
const ID_PREFIX: &str = "app-menu:";

/// A stock item AppKit (or the platform) runs by itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    About,
    Hide,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    ToggleFullScreen,
    Minimize,
    Zoom,
}

/// An item Relay handles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    CloseToTray,
    Quit,
    CloseWindow,
    OpenDocumentation,
    ReportBug,
    ExportDiagnostics,
    ResetZoom,
    ZoomIn,
    ZoomOut,
}

impl Action {
    const ALL: [Action; 9] = [
        Action::CloseToTray,
        Action::Quit,
        Action::CloseWindow,
        Action::OpenDocumentation,
        Action::ReportBug,
        Action::ExportDiagnostics,
        Action::ResetZoom,
        Action::ZoomIn,
        Action::ZoomOut,
    ];

    fn id(self) -> &'static str {
        match self {
            Action::CloseToTray => "close-to-tray",
            Action::Quit => "quit",
            Action::CloseWindow => "close-window",
            Action::OpenDocumentation => "open-documentation",
            Action::ReportBug => "report-bug",
            Action::ExportDiagnostics => "export-diagnostics",
            Action::ResetZoom => "reset-zoom",
            Action::ZoomIn => "zoom-in",
            Action::ZoomOut => "zoom-out",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Item {
    Separator,
    Role {
        role: Role,
        label: String,
    },
    Action {
        action: Action,
        label: String,
        accelerator: Option<&'static str>,
    },
}

impl Item {
    pub fn label(&self) -> Option<&str> {
        match self {
            Item::Separator => None,
            Item::Role { label, .. } | Item::Action { label, .. } => Some(label),
        }
    }
}

/// The macOS role of a top-level menu (`window`, `help`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuRole {
    Window,
    Help,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TopMenu {
    pub label: String,
    pub role: Option<MenuRole>,
    pub items: Vec<Item>,
}

/// The application menu in `language`; the Relay menu only on macOS.
pub fn app_menu_template(language: Locale, mac: bool) -> Vec<TopMenu> {
    let t = |id: &str| translate(language, id, &Args::new());
    let role = |role, id: &str| Item::Role { role, label: t(id) };
    let action = |action, id: &str, accelerator| Item::Action {
        action,
        label: t(id),
        accelerator,
    };
    let mut menus = Vec::new();
    if mac {
        menus.push(TopMenu {
            label: "Relay".into(),
            role: None,
            items: vec![
                role(Role::About, "appMenu.aboutRelay"),
                Item::Separator,
                role(Role::Hide, "appMenu.hideRelay"),
                action(
                    Action::CloseToTray,
                    "appMenu.closeRelayWindow",
                    Some("CmdOrCtrl+Q"),
                ),
                action(Action::Quit, "appMenu.quitRelay", Some("Alt+CmdOrCtrl+Q")),
            ],
        });
    }
    menus.push(TopMenu {
        label: t("appMenu.edit"),
        role: None,
        items: vec![
            role(Role::Undo, "appMenu.undo"),
            role(Role::Redo, "appMenu.redo"),
            Item::Separator,
            role(Role::Cut, "appMenu.cut"),
            role(Role::Copy, "common.copy"),
            role(Role::Paste, "appMenu.paste"),
            role(Role::SelectAll, "appMenu.selectAll"),
        ],
    });
    menus.push(TopMenu {
        label: t("appMenu.view"),
        role: None,
        items: vec![
            // Electron's resetZoom, zoomIn and zoomOut roles, with their accelerators.
            action(Action::ResetZoom, "appMenu.actualSize", Some("CmdOrCtrl+0")),
            action(Action::ZoomIn, "appMenu.zoomIn", Some("CmdOrCtrl+Plus")),
            action(Action::ZoomOut, "appMenu.zoomOut", Some("CmdOrCtrl+-")),
            Item::Separator,
            role(Role::ToggleFullScreen, "appMenu.toggleFullScreen"),
        ],
    });
    menus.push(TopMenu {
        label: t("appMenu.window"),
        role: Some(MenuRole::Window),
        items: vec![
            role(Role::Minimize, "appMenu.minimize"),
            role(Role::Zoom, "appMenu.zoom"),
            Item::Separator,
            action(
                Action::CloseWindow,
                "appMenu.closeWindow",
                Some("CmdOrCtrl+W"),
            ),
        ],
    });
    menus.push(TopMenu {
        label: t("appMenu.help"),
        role: Some(MenuRole::Help),
        items: vec![
            action(Action::OpenDocumentation, "appMenu.documentation", None),
            action(Action::ReportBug, "appMenu.reportABug", None),
            Item::Separator,
            action(Action::ExportDiagnostics, "appMenu.exportDiagnostics", None),
        ],
    });
    menus
}

/// The issue form's names for each platform (`.github/ISSUE_TEMPLATE/bug_report.yml`, field
/// `platform`), by Node's `process.platform`.
fn form_platform(platform: &str) -> Option<&'static str> {
    match platform {
        "darwin" => Some("macOS"),
        "win32" => Some("Windows"),
        "linux" => Some("Linux"),
        _ => None,
    }
}

/// The bug report form with the Relay version, the platform and the system version ("macOS
/// 15.5") filled in; GitHub prefills an issue form field from the query parameter named by its id.
pub fn bug_report_url(version: &str, platform: &str, os_version: &str) -> String {
    let name = form_platform(platform);
    let os = match name {
        Some(name) => format!("{name} {os_version}"),
        None => os_version.to_owned(),
    };
    let mut url =
        Url::parse("https://github.com/ahmetcankacar54/relay/issues/new").expect("static");
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("template", "bug_report.yml");
        query.append_pair("version", version);
        query.append_pair("os", &os);
        if let Some(name) = name {
            query.append_pair("platform", name);
        }
    }
    url.into()
}

/// `process.platform` of this build.
fn node_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}

/// Installs the application menu in `locale`.
pub fn apply(app: &AppHandle, locale: Locale) {
    static EVENTS: Once = Once::new();
    EVENTS.call_once(|| app.on_menu_event(on_menu_event));
    match build(app, &app_menu_template(locale, cfg!(target_os = "macos"))) {
        Ok(menu) => {
            if let Err(error) = app.set_menu(menu) {
                eprintln!("Relay could not set its menu. {error}");
            }
        }
        Err(error) => eprintln!("Relay could not build its menu. {error}"),
    }
}

fn build(app: &AppHandle, template: &[TopMenu]) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    for top in template {
        let submenu = Submenu::new(app, &top.label, true)?;
        for item in &top.items {
            let built: Box<dyn IsMenuItem<Wry>> = match item {
                Item::Separator => Box::new(PredefinedMenuItem::separator(app)?),
                Item::Role { role, label } => Box::new(role_item(app, *role, label)?),
                Item::Action {
                    action,
                    label,
                    accelerator,
                } => Box::new(MenuItem::with_id(
                    app,
                    format!("{ID_PREFIX}{}", action.id()),
                    label,
                    true,
                    *accelerator,
                )?),
            };
            submenu.append(built.as_ref())?;
        }
        menu.append(&submenu)?;
        #[cfg(target_os = "macos")]
        match top.role {
            Some(MenuRole::Window) => submenu.set_as_windows_menu_for_nsapp()?,
            Some(MenuRole::Help) => submenu.set_as_help_menu_for_nsapp()?,
            None => {}
        }
    }
    Ok(menu)
}

fn role_item(app: &AppHandle, role: Role, label: &str) -> tauri::Result<PredefinedMenuItem<Wry>> {
    let text = Some(label);
    match role {
        Role::About => PredefinedMenuItem::about(
            app,
            text,
            Some(AboutMetadata {
                name: Some("Relay".into()),
                version: Some(app.package_info().version.to_string()),
                ..Default::default()
            }),
        ),
        Role::Hide => PredefinedMenuItem::hide(app, text),
        Role::Undo => PredefinedMenuItem::undo(app, text),
        Role::Redo => PredefinedMenuItem::redo(app, text),
        Role::Cut => PredefinedMenuItem::cut(app, text),
        Role::Copy => PredefinedMenuItem::copy(app, text),
        Role::Paste => PredefinedMenuItem::paste(app, text),
        Role::SelectAll => PredefinedMenuItem::select_all(app, text),
        Role::ToggleFullScreen => PredefinedMenuItem::fullscreen(app, text),
        Role::Minimize => PredefinedMenuItem::minimize(app, text),
        Role::Zoom => PredefinedMenuItem::maximize(app, text),
    }
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let Some(id) = event.id().as_ref().strip_prefix(ID_PREFIX) else {
        return;
    };
    let Some(action) = Action::ALL.into_iter().find(|a| a.id() == id) else {
        return;
    };
    match action {
        Action::CloseToTray => crate::windows::main::close_to_tray(app),
        Action::Quit => crate::lifecycle::quit(),
        Action::CloseWindow => crate::windows::main::close_focused_window(app),
        Action::OpenDocumentation => open(DOCUMENTATION_URL),
        Action::ReportBug => open(&bug_report_url(
            &app.package_info().version.to_string(),
            node_platform(),
            &sysinfo::System::os_version().unwrap_or_default(),
        )),
        Action::ExportDiagnostics => {
            let app = app.clone();
            // A save panel and possibly an error box: off the menu's main-thread callback.
            std::thread::spawn(move || {
                if let Err(error) = crate::services::diagnostics::export_diagnostics(&app) {
                    crate::services::errors::record_main_error("export-diagnostics", &error);
                    if let Some(shell) = crate::state::STATE.shell.get() {
                        shell.error_box(
                            &crate::i18n::say("electronMain.diagnosticsWereNotExported"),
                            &error,
                        );
                    }
                }
            });
        }
        Action::ResetZoom => zoom(app, None),
        Action::ZoomIn => zoom(app, Some(0.5)),
        Action::ZoomOut => zoom(app, Some(-0.5)),
    }
}

fn open(url: &str) {
    let _ = tauri_plugin_opener::open_url(url, None::<&str>);
}

/// Electron's zoom roles on the focused window: a level of 0 is 100%, each step half a level,
/// the factor 1.2 to the power of the level, between -8 and 9 levels.
fn zoom(app: &AppHandle, step: Option<f64>) {
    static LEVELS: Mutex<Option<HashMap<String, f64>>> = Mutex::new(None);
    let Some(window) = app
        .webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
    else {
        return;
    };
    let level = {
        let mut levels = lock(&LEVELS);
        let level = levels
            .get_or_insert_with(HashMap::new)
            .entry(window.label().to_owned())
            .or_insert(0.0);
        *level = match step {
            Some(step) => (*level + step).clamp(-8.0, 9.0),
            None => 0.0,
        };
        *level
    };
    let _ = window.set_zoom(1.2_f64.powf(level));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(menu: &[TopMenu]) -> Vec<(String, Vec<String>)> {
        menu.iter()
            .map(|top| {
                (
                    top.label.clone(),
                    top.items
                        .iter()
                        .filter_map(|item| item.label().map(str::to_owned))
                        .collect(),
                )
            })
            .collect()
    }

    fn owned(menus: &[(&str, &[&str])]) -> Vec<(String, Vec<String>)> {
        menus
            .iter()
            .map(|(label, items)| {
                (
                    label.to_string(),
                    items.iter().map(|i| i.to_string()).collect(),
                )
            })
            .collect()
    }

    #[test]
    fn the_app_menu_speaks_turkish() {
        assert_eq!(
            labels(&app_menu_template(Locale::Tr, true)),
            owned(&[
                (
                    "Relay",
                    &[
                        "Relay hakkında",
                        "Relay’i gizle",
                        "Relay penceresini kapat",
                        "Relay’den çık"
                    ]
                ),
                (
                    "Düzen",
                    &[
                        "Geri al",
                        "Yinele",
                        "Kes",
                        "Kopyala",
                        "Yapıştır",
                        "Tümünü seç"
                    ]
                ),
                (
                    "Görüntü",
                    &["Gerçek boyut", "Yakınlaştır", "Uzaklaştır", "Tam ekran"]
                ),
                ("Pencere", &["Küçült", "Büyüt", "Pencereyi kapat"]),
                (
                    "Yardım",
                    &["Belgeler", "Hata bildir", "Tanılamayı dışa aktar…"]
                ),
            ])
        );
    }

    #[test]
    fn the_app_menu_speaks_english() {
        assert_eq!(
            labels(&app_menu_template(Locale::En, true)),
            owned(&[
                (
                    "Relay",
                    &[
                        "About Relay",
                        "Hide Relay",
                        "Close Relay window",
                        "Quit Relay"
                    ]
                ),
                (
                    "Edit",
                    &["Undo", "Redo", "Cut", "Copy", "Paste", "Select All"]
                ),
                (
                    "View",
                    &["Actual Size", "Zoom In", "Zoom Out", "Toggle Full Screen"]
                ),
                ("Window", &["Minimize", "Zoom", "Close Window"]),
                (
                    "Help",
                    &["Documentation", "Report a Bug", "Export Diagnostics…"]
                ),
            ])
        );
    }

    fn find(menu: &TopMenu, accelerator: &str) -> Option<Action> {
        menu.items.iter().find_map(|item| match item {
            Item::Action {
                action,
                accelerator: Some(a),
                ..
            } if *a == accelerator => Some(*action),
            _ => None,
        })
    }

    #[test]
    fn cmd_q_closes_to_the_menu_bar_alt_cmd_q_quits_cmd_w_closes_the_focused_window() {
        for language in [Locale::Tr, Locale::En] {
            let menu = app_menu_template(language, true);
            assert_eq!(find(&menu[0], "CmdOrCtrl+Q"), Some(Action::CloseToTray));
            assert_eq!(find(&menu[0], "Alt+CmdOrCtrl+Q"), Some(Action::Quit));
            assert_eq!(find(&menu[3], "CmdOrCtrl+W"), Some(Action::CloseWindow));
            // The macOS Window menu; no stock quit item anywhere (Role has none).
            assert_eq!(menu[3].role, Some(MenuRole::Window));
        }
    }

    #[test]
    fn other_platforms_have_no_relay_app_menu_but_keep_edit_view_window_and_help() {
        let labels: Vec<_> = app_menu_template(Locale::En, false)
            .into_iter()
            .map(|top| top.label)
            .collect();
        assert_eq!(labels, ["Edit", "View", "Window", "Help"]);
    }

    #[test]
    fn help_opens_the_documentation_and_the_bug_form_and_exports_the_diagnostics() {
        let menu = app_menu_template(Locale::En, false);
        let help = menu.last().unwrap();
        assert_eq!(help.role, Some(MenuRole::Help));
        let actions: Vec<_> = help
            .items
            .iter()
            .filter_map(|item| match item {
                Item::Action { action, .. } => Some(*action),
                _ => None,
            })
            .collect();
        assert_eq!(
            actions,
            [
                Action::OpenDocumentation,
                Action::ReportBug,
                Action::ExportDiagnostics
            ]
        );
        assert_eq!(
            DOCUMENTATION_URL,
            "https://github.com/ahmetcankacar54/relay#readme"
        );
    }

    #[test]
    fn the_bug_report_link_fills_the_issue_forms_version_platform_and_system_fields() {
        let url = Url::parse(&bug_report_url("0.28.0", "darwin", "15.5")).unwrap();
        assert_eq!(
            format!("{}{}", url.origin().ascii_serialization(), url.path()),
            "https://github.com/ahmetcankacar54/relay/issues/new"
        );
        let get = |url: &Url, key: &str| {
            url.query_pairs()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.into_owned())
        };
        assert_eq!(get(&url, "template").as_deref(), Some("bug_report.yml"));
        assert_eq!(get(&url, "version").as_deref(), Some("0.28.0"));
        assert_eq!(get(&url, "platform").as_deref(), Some("macOS"));
        assert_eq!(get(&url, "os").as_deref(), Some("macOS 15.5"));
        let other = Url::parse(&bug_report_url("0.28.0", "freebsd", "14")).unwrap();
        assert_eq!(get(&other, "platform"), None);
        // The ids and options are the form's own.
        let form = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../.github/ISSUE_TEMPLATE/bug_report.yml"),
        )
        .unwrap();
        for id in ["version", "platform", "os"] {
            assert!(form.contains(&format!("\n    id: {id}\n")), "{id}");
        }
        for name in ["macOS", "Windows", "Linux"] {
            assert!(form.contains(&format!("\n        - {name}\n")), "{name}");
        }
    }
}
