//! The shell the core drives (`relay_core::host`): dialogs, the clipboard, the browser and
//! Finder, notifications and the menu bar through Tauri's plugins; web windows through
//! `crate::windows`; paths from `relay_paths().data`, never Tauri's own app-data dir.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use relay_core::host::{
    AppPaths, FileDialog, MessageBox, MessageBoxResult, MessageKind, Notice, QuietOpened,
    QuietWindow, Shell, SignInWindow, Webviews,
};
use relay_core::relay_paths::{Platform, RelayPaths, relay_paths_with};
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

/// A development or smoke build: the test overrides (RELAY_HOME, RELAY_CLAUDE_DIR,
/// RELAY_CLAUDE_APP, RELAY_SECURITY_TOOL) are honored, as an unpackaged Electron did.
pub const UNPACKAGED: bool = cfg!(any(debug_assertions, feature = "smoke"));

/// Relay's folders. A packaged build ignores the RELAY_* overrides, so a stray variable can
/// never point the app at another data folder.
pub fn relay_paths() -> RelayPaths {
    relay_paths_with(
        &|key| {
            if !UNPACKAGED && key.starts_with("RELAY_") {
                None
            } else {
                std::env::var_os(key)
            }
        },
        &relay_core::relay_paths::home_dir(),
        Platform::current(),
    )
}

/// Whether a page address is one of Relay's own bundled pages (or the Vite dev server in a
/// development build): only those may call the bridge.
pub fn relay_page(url: &url::Url) -> bool {
    let origin = (url.scheme(), url.host_str().unwrap_or(""), url.port());
    matches!(
        origin,
        ("tauri", "localhost", None) | ("http" | "https", "tauri.localhost", None)
    ) || (cfg!(debug_assertions) && origin == ("http", "127.0.0.1", Some(5173)))
}

/// Electron's `logs`: ~/Library/Logs/Relay on macOS, `<data>/logs` elsewhere.
pub fn logs_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        relay_core::relay_paths::home_dir()
            .join("Library")
            .join("Logs")
            .join("Relay")
    } else {
        relay_paths().data.join("logs")
    }
}

fn dialog_kind(kind: MessageKind) -> MessageDialogKind {
    match kind {
        MessageKind::Warning => MessageDialogKind::Warning,
        MessageKind::Error => MessageDialogKind::Error,
        _ => MessageDialogKind::Info,
    }
}

fn file_builder(
    app: &AppHandle,
    options: &FileDialog,
) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    let mut builder = app.dialog().file();
    if !options.title.is_empty() {
        builder = builder.set_title(&options.title);
    }
    if let Some(default) = &options.default_path {
        // Electron's defaultPath names a folder to open in, or a file to suggest.
        if default.is_dir() {
            builder = builder.set_directory(default);
        } else {
            if let Some(dir) = default.parent().filter(|dir| !dir.as_os_str().is_empty()) {
                builder = builder.set_directory(dir);
            }
            if let Some(name) = default.file_name() {
                builder = builder.set_file_name(name.to_string_lossy());
            }
        }
    }
    for filter in &options.filters {
        let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        builder = builder.add_filter(&filter.name, &extensions);
    }
    builder
}

/// An open panel for a folder; `None` when cancelled (Electron's `openDirectory`).
pub fn pick_folder(app: &AppHandle, title: &str) -> Option<PathBuf> {
    let mut builder = app.dialog().file().set_can_create_directories(true);
    if !title.is_empty() {
        builder = builder.set_title(title);
    }
    builder.blocking_pick_folder()?.into_path().ok()
}

pub struct TauriShell {
    app: AppHandle,
}

impl TauriShell {
    pub fn new(app: AppHandle) -> TauriShell {
        TauriShell { app }
    }
}

impl Shell for TauriShell {
    /// The dialog plugin draws up to three buttons and no checkbox: a fourth button and the
    /// checkbox are left out (no Relay dialog asks for either), the detail goes under the
    /// message.
    fn message_box(&self, options: &MessageBox) -> MessageBoxResult {
        let message = match &options.detail {
            Some(detail) if !detail.is_empty() => format!("{}\n\n{detail}", options.message),
            _ => options.message.clone(),
        };
        let buttons = &options.buttons;
        let mut builder = self
            .app
            .dialog()
            .message(message)
            .kind(dialog_kind(options.kind));
        if !options.title.is_empty() {
            builder = builder.title(&options.title);
        }
        builder = builder.buttons(match buttons.len() {
            0 => MessageDialogButtons::Ok,
            1 => MessageDialogButtons::OkCustom(buttons[0].clone()),
            2 => MessageDialogButtons::OkCancelCustom(buttons[0].clone(), buttons[1].clone()),
            _ => MessageDialogButtons::YesNoCancelCustom(
                buttons[0].clone(),
                buttons[1].clone(),
                buttons[2].clone(),
            ),
        });
        let cancel = options
            .cancel_id
            .unwrap_or_else(|| buttons.len().saturating_sub(1));
        let response = match builder.blocking_show_with_result() {
            MessageDialogResult::Custom(text) => buttons
                .iter()
                .position(|button| *button == text)
                .unwrap_or(cancel),
            MessageDialogResult::Ok | MessageDialogResult::Yes => 0,
            MessageDialogResult::No => 1.min(buttons.len().saturating_sub(1)),
            MessageDialogResult::Cancel => cancel,
        };
        MessageBoxResult {
            response,
            checkbox_checked: false,
        }
    }

    fn error_box(&self, title: &str, content: &str) {
        self.app
            .dialog()
            .message(content)
            .title(title)
            .kind(MessageDialogKind::Error)
            .blocking_show();
    }

    fn save_dialog(&self, options: &FileDialog) -> Option<PathBuf> {
        file_builder(&self.app, options)
            .blocking_save_file()?
            .into_path()
            .ok()
    }

    fn open_dialog(&self, options: &FileDialog) -> Option<PathBuf> {
        file_builder(&self.app, options)
            .blocking_pick_file()?
            .into_path()
            .ok()
    }

    fn write_clipboard(&self, text: &str) {
        let _ = self.app.clipboard().write_text(text);
    }

    fn open_external(&self, url: &str) -> Result<(), String> {
        self.app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|e| e.to_string())
    }

    fn open_path(&self, path: &Path) -> Result<(), String> {
        self.app
            .opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|e| e.to_string())
    }

    fn show_item_in_folder(&self, path: &Path) {
        let _ = self.app.opener().reveal_item_in_dir(path);
    }

    /// The platform's own notices, whose click opens `action` (crate::notify); the plugin's,
    /// which deliver no click, where that path is unavailable (an unbundled macOS build).
    fn notify(&self, notice: &Notice) {
        if crate::notify::show(&self.app, notice) {
            return;
        }
        let mut builder = self
            .app
            .notification()
            .builder()
            .title(&notice.title)
            .body(&notice.body);
        if notice.silent {
            builder = builder.silent();
        }
        let _ = builder.show();
    }

    fn refresh_tray(&self) {
        crate::services::tray_setup::update_tray();
    }
}

pub struct TauriWebviews {
    app: AppHandle,
}

impl TauriWebviews {
    pub fn new(app: AppHandle) -> TauriWebviews {
        TauriWebviews { app }
    }
}

impl Webviews for TauriWebviews {
    fn show_sign_in(&self, window: SignInWindow) {
        crate::windows::auth::show_sign_in(&self.app, window);
    }

    fn close_sign_in(&self, account_id: &str) {
        crate::windows::auth::close_sign_in(&self.app, account_id);
    }

    fn forget_sign_in_session(&self, account_id: &str) -> Result<(), String> {
        crate::windows::auth::forget_session(&self.app, account_id)
    }

    fn open_quiet(&self, window: &QuietWindow) -> Result<QuietOpened, String> {
        crate::windows::quiet::open(&self.app, window)
    }
}

/// Where the app lives: Relay's data folder from `relay_paths()`; the rest from Tauri.
pub struct TauriPaths {
    app: Option<AppHandle>,
    data: PathBuf,
}

impl TauriPaths {
    pub fn new(app: Option<AppHandle>) -> TauriPaths {
        TauriPaths {
            app,
            data: relay_paths().data,
        }
    }
}

impl AppPaths for TauriPaths {
    fn data_dir(&self) -> PathBuf {
        self.data.clone()
    }

    fn app_data_dir(&self) -> PathBuf {
        relay_core::relay_paths::app_data_root(
            Platform::current(),
            &relay_core::relay_paths::home_dir(),
            &|key| std::env::var_os(key),
        )
    }

    fn logs_dir(&self) -> PathBuf {
        logs_dir()
    }

    fn temp_dir(&self) -> PathBuf {
        std::env::temp_dir()
    }

    fn documents_dir(&self) -> PathBuf {
        self.app
            .as_ref()
            .and_then(|app| app.path().document_dir().ok())
            .unwrap_or_else(|| relay_core::relay_paths::home_dir().join("Documents"))
    }

    fn exe_path(&self) -> PathBuf {
        std::env::current_exe().unwrap_or_default()
    }

    fn resources_dir(&self) -> PathBuf {
        self.app
            .as_ref()
            .and_then(|app| app.path().resource_dir().ok())
            .unwrap_or_else(|| {
                self.exe_path()
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_default()
            })
    }

    fn is_packaged(&self) -> bool {
        !UNPACKAGED
    }

    fn app_version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_owned()
    }
}

/// The three host traits over the running app, installed into `STATE`.
pub fn install(app: &AppHandle) {
    let state = &crate::state::STATE;
    let _ = state
        .shell
        .set(Arc::new(TauriShell::new(app.clone())) as Arc<dyn Shell>);
    let _ = state
        .webviews
        .set(Arc::new(TauriWebviews::new(app.clone())) as Arc<dyn Webviews>);
    let _ = state
        .paths
        .set(Arc::new(TauriPaths::new(Some(app.clone()))) as Arc<dyn AppPaths>);
}
