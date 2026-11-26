//! What the app shell provides to the core: dialogs, clipboard, notifications, webviews and paths.
//! relay-app (Tauri) implements these traits; the core decides what to show and where a window
//! may go, the shell only draws it.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use url::Url;

use crate::auth_page_policy::{
    is_https, local_callback, sign_in_navigation_allowed, sign_in_partition,
};
use crate::desktop_usage::{PlainCookie, SameSite};

// ---------------------------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------------------------

/// The icon of a message box.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageKind {
    #[default]
    None,
    Info,
    Warning,
    Error,
    Question,
}

/// A modal message box with buttons; the answer is the index of the button chosen.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MessageBox {
    pub kind: MessageKind,
    pub title: String,
    pub message: String,
    pub detail: Option<String>,
    pub buttons: Vec<String>,
    /// The button Return chooses.
    pub default_id: usize,
    /// The button Escape or closing the box chooses; `None` = the platform's pick.
    pub cancel_id: Option<usize>,
    /// A checkbox under the message ("Don't ask again").
    pub checkbox_label: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MessageBoxResult {
    /// Index into `MessageBox::buttons`.
    pub response: usize,
    pub checkbox_checked: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FileFilter {
    pub name: String,
    /// Without the dot: `["relaybackup"]`.
    pub extensions: Vec<String>,
}

/// A save or open panel.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FileDialog {
    pub title: String,
    pub default_path: Option<PathBuf>,
    pub button_label: Option<String>,
    pub filters: Vec<FileFilter>,
}

/// A system notification. A click on it reaches the app with `action`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Notice {
    pub title: String,
    pub body: String,
    pub silent: bool,
    pub action: Option<String>,
}

/// The desktop around the app: dialogs, the clipboard, the system browser and Finder,
/// notifications and the menu-bar item.
pub trait Shell: Send + Sync {
    /// Shows a modal message box and waits for the answer.
    fn message_box(&self, options: &MessageBox) -> MessageBoxResult;
    /// A last-resort error box (startup failures); returns when dismissed.
    fn error_box(&self, title: &str, content: &str);
    /// A save panel; `None` when cancelled.
    fn save_dialog(&self, options: &FileDialog) -> Option<PathBuf>;
    /// An open panel for one file; `None` when cancelled.
    fn open_dialog(&self, options: &FileDialog) -> Option<PathBuf>;
    fn write_clipboard(&self, text: &str);
    /// Opens an address in the system browser (or its registered app).
    fn open_external(&self, url: &str) -> Result<(), String>;
    /// Opens a file or folder with its default app.
    fn open_path(&self, path: &Path) -> Result<(), String>;
    /// Reveals a file in Finder / Explorer / the file manager.
    fn show_item_in_folder(&self, path: &Path);
    fn notify(&self, notice: &Notice);
    /// Redraws the menu-bar item (title, icon, menu) from the current state.
    fn refresh_tray(&self);
}

// ---------------------------------------------------------------------------------------------
// Webviews
// ---------------------------------------------------------------------------------------------

/// Width and height of the sign-in and quiet renewal windows.
pub const SIGN_IN_WINDOW_SIZE: (u32, u32) = (520, 720);
/// How long the sign-in window stays on the CLI's "approved" page before it closes.
pub const SIGN_IN_CLOSE_DELAY: Duration = Duration::from_millis(1_500);

/// What a window does with an address it is about to load.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Navigation {
    /// Load it here.
    Allow,
    /// Stay on the current page.
    Block,
    /// Stay, and hand the address to the system browser (`Shell::open_external`).
    OpenExternal,
}

/// An account's own sign-in window: its own persistent claude.ai session, so whichever account
/// the system browser is signed in to cannot approve the wrong one and a renewal finds the
/// account still signed in. Permission requests are denied; dev tools only when unpackaged.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignInWindow {
    pub account_id: String,
    pub url: String,
    pub title: String,
    /// The CLI's localhost callback the page returns to, when it names one.
    pub callback: Option<Url>,
}

impl SignInWindow {
    pub fn new(account_id: &str, url: &str, title: &str) -> Self {
        Self {
            account_id: account_id.to_owned(),
            url: url.to_owned(),
            title: title.to_owned(),
            callback: local_callback(url),
        }
    }

    /// The session partition (Electron) the window's storage is keyed by.
    pub fn partition(&self) -> String {
        sign_in_partition(&self.account_id)
    }

    /// A navigation or redirect of the main page: allowed sites load, other https addresses
    /// open in the system browser, anything else is blocked.
    pub fn navigation(&self, target: &str) -> Navigation {
        if sign_in_navigation_allowed(target, self.callback.as_ref()) {
            Navigation::Allow
        } else if is_https(target) {
            Navigation::OpenExternal
        } else {
            Navigation::Block
        }
    }

    /// A pop-up the page opens (a provider's sign-in): allowed ones open in a child window of
    /// the same session; the rest go to the system browser when https.
    pub fn popup(&self, target: &str) -> Navigation {
        self.navigation(target)
    }

    /// How long after committing `target` the window closes itself: the approval reached the
    /// CLI and the page it shows says so.
    pub fn closes_after(&self, target: &str) -> Option<Duration> {
        (self.callback.is_some()
            && sign_in_navigation_allowed(target, self.callback.as_ref())
            && target.starts_with("http:"))
        .then_some(SIGN_IN_CLOSE_DELAY)
    }
}

/// A navigation inside a pop-up of the sign-in window: it stays on https: pages and opens no
/// windows of its own.
pub fn sign_in_popup_navigation(target: &str) -> Navigation {
    if is_https(target) {
        Navigation::Allow
    } else {
        Navigation::Block
    }
}

/// A cookie as a quiet window's session gets it; the shape `session.cookies.set` and
/// `Webview::set_cookie` both take.
#[derive(Clone, Debug, PartialEq)]
pub struct CookieSpec {
    /// `https://<host without leading dot><path>`.
    pub url: String,
    /// Only for domain cookies (`.claude.ai`): a host-only cookie (`__Host-…`) gets none.
    pub domain: Option<String>,
    pub path: String,
    pub name: String,
    pub value: String,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: SameSite,
    /// Seconds since the epoch.
    pub expiration_date: f64,
}

/// A hidden, in-memory (incognito) window that holds an account's claude.ai session for one
/// renewal. Permission requests are denied, audio muted, `window.open` denied, and the user
/// agent is a plain browser's (no Relay or engine tokens).
#[derive(Clone, Debug, PartialEq)]
pub struct QuietWindow {
    pub url: String,
    pub cookies: Vec<PlainCookie>,
    /// The CLI's localhost callback; reaching it means approved.
    pub callback: Url,
}

impl QuietWindow {
    /// Whether the window may load `target` (navigations and redirects); the rest are blocked.
    pub fn allows(&self, target: &str) -> bool {
        sign_in_navigation_allowed(target, Some(&self.callback))
    }

    /// The cookies to set before the first load, each as the Claude app keeps it, expiring
    /// within the hour at most (the window lives a minute; the session goes with it).
    pub fn cookie_specs(&self, now_secs: f64) -> Vec<CookieSpec> {
        self.cookies
            .iter()
            .map(|cookie| CookieSpec {
                url: format!(
                    "https://{}{}",
                    cookie.host.strip_prefix('.').unwrap_or(&cookie.host),
                    cookie.path
                ),
                domain: cookie.host.starts_with('.').then(|| cookie.host.clone()),
                path: cookie.path.clone(),
                name: cookie.name.clone(),
                value: cookie.value.clone(),
                secure: cookie.secure,
                http_only: cookie.http_only,
                same_site: cookie.same_site,
                expiration_date: cookie
                    .expires
                    .unwrap_or(f64::INFINITY)
                    .min(now_secs + 3_600.0),
            })
            .collect()
    }
}

/// How the quiet window arrived at an address.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuietNavigationKind {
    /// A main-frame navigation committed (`did-navigate`).
    Committed,
    /// Same-document (`did-navigate-in-page`).
    InPage,
    /// A server redirect on the way (`will-redirect`).
    Redirect,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuietNavigation {
    pub kind: QuietNavigationKind,
    pub url: String,
}

/// An open quiet window.
pub trait QuietPage: Send {
    /// Runs `script` in the page and returns its JSON result; `None` when it fails.
    fn eval(&self, script: &str) -> Option<serde_json::Value>;
    /// The addresses reached since the last call, in order.
    fn take_navigations(&mut self) -> Vec<QuietNavigation>;
    /// Destroys the window and drops its session.
    fn close(self: Box<Self>);
}

pub struct QuietOpened {
    pub page: Box<dyn QuietPage>,
    /// Cookies the session refused, by name.
    pub refused: Vec<String>,
}

/// The app's web windows the core drives.
pub trait Webviews: Send + Sync {
    /// Shows the account's sign-in window at `window.url`, or brings its open one to the front.
    /// Navigation follows `SignInWindow::navigation` / `popup` / `closes_after`.
    fn show_sign_in(&self, window: SignInWindow);
    fn close_sign_in(&self, account_id: &str);
    /// Forgets an account's sign-in window session: its claude.ai login and cookies.
    fn forget_sign_in_session(&self, account_id: &str) -> Result<(), String>;
    /// Opens a hidden quiet window: sets `window.cookie_specs`, then loads `window.url`,
    /// blocking navigations `window.allows` refuses.
    fn open_quiet(&self, window: &QuietWindow) -> Result<QuietOpened, String>;
}

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/// Where the app lives and keeps things.
pub trait AppPaths: Send + Sync {
    /// Relay's data folder: `relay_paths().data` (never the shell's own app-data dir).
    fn data_dir(&self) -> PathBuf;
    /// The per-user application-data root that holds `Relay` and `Claude`.
    fn app_data_dir(&self) -> PathBuf;
    fn logs_dir(&self) -> PathBuf;
    fn temp_dir(&self) -> PathBuf;
    fn documents_dir(&self) -> PathBuf;
    /// The running executable.
    fn exe_path(&self) -> PathBuf;
    /// Bundled resources (`Contents/Resources` on macOS).
    fn resources_dir(&self) -> PathBuf;
    /// A built, installed app rather than a development run.
    fn is_packaged(&self) -> bool;
    fn app_version(&self) -> String;

    /// The `security` stand-in tests name; honored only when unpackaged.
    fn security_tool(&self) -> Option<PathBuf> {
        if self.is_packaged() {
            return None;
        }
        std::env::var_os("RELAY_SECURITY_TOOL")
            .filter(|tool| !tool.is_empty())
            .map(PathBuf::from)
    }
}
