//! Port of `shared/browser-extension.ts`: the Claude browser extension ("Claude in Chrome").

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::types::js;

pub const CLAUDE_EXTENSION_ID: &str = "fcoeoabgfenejglbffodgkkbkcdhcgfn";

/// The Chromium browsers Relay can keep the extension's sign-in for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BrowserApp {
    Chrome,
    Brave,
    Edge,
    Chromium,
    Vivaldi,
    Arc,
    ChromeBeta,
    ChromeDev,
    ChromeCanary,
    Dia,
    Comet,
}

/// `BROWSER_APPS`, in Relay's order.
pub const BROWSER_APPS: [BrowserApp; 11] = [
    BrowserApp::Chrome,
    BrowserApp::Brave,
    BrowserApp::Edge,
    BrowserApp::Chromium,
    BrowserApp::Vivaldi,
    BrowserApp::Arc,
    BrowserApp::ChromeBeta,
    BrowserApp::ChromeDev,
    BrowserApp::ChromeCanary,
    BrowserApp::Dia,
    BrowserApp::Comet,
];

impl BrowserApp {
    pub const fn as_str(self) -> &'static str {
        match self {
            BrowserApp::Chrome => "chrome",
            BrowserApp::Brave => "brave",
            BrowserApp::Edge => "edge",
            BrowserApp::Chromium => "chromium",
            BrowserApp::Vivaldi => "vivaldi",
            BrowserApp::Arc => "arc",
            BrowserApp::ChromeBeta => "chrome-beta",
            BrowserApp::ChromeDev => "chrome-dev",
            BrowserApp::ChromeCanary => "chrome-canary",
            BrowserApp::Dia => "dia",
            BrowserApp::Comet => "comet",
        }
    }

    pub fn parse(id: &str) -> Option<Self> {
        BROWSER_APPS.into_iter().find(|a| a.as_str() == id)
    }
}

/// A browser's Linux build.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinuxBrowser {
    /// The user data folder, under $XDG_CONFIG_HOME (~/.config).
    pub data_dir: &'static str,
    /// Launchers looked for on PATH, in order.
    pub commands: &'static [&'static str],
    /// The main executable as /proc/<pid>/exe names it, where the distributions install it.
    pub executables: &'static [&'static str],
}

/// One entry of `BROWSERS`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BrowserInfo {
    pub name: &'static str,
    pub bundle_id: &'static str,
    /// The user data folder, under ~/Library/Application Support.
    pub data_dir: &'static str,
    /// The main process's file name in Contents/MacOS.
    pub executable: &'static str,
    /// Linux builds only; browsers without one (Arc, Dia, Comet, Canary) are not looked for there.
    pub linux: Option<LinuxBrowser>,
}

/// `BROWSERS[app]`.
pub const fn browser(app: BrowserApp) -> BrowserInfo {
    const fn info(
        name: &'static str,
        bundle_id: &'static str,
        data_dir: &'static str,
        executable: &'static str,
        linux: Option<LinuxBrowser>,
    ) -> BrowserInfo {
        BrowserInfo {
            name,
            bundle_id,
            data_dir,
            executable,
            linux,
        }
    }
    const fn linux(
        data_dir: &'static str,
        commands: &'static [&'static str],
        executables: &'static [&'static str],
    ) -> Option<LinuxBrowser> {
        Some(LinuxBrowser {
            data_dir,
            commands,
            executables,
        })
    }
    match app {
        BrowserApp::Chrome => info(
            "Chrome",
            "com.google.Chrome",
            "Google/Chrome",
            "Google Chrome",
            linux(
                "google-chrome",
                &["google-chrome-stable", "google-chrome"],
                &["/opt/google/chrome/chrome"],
            ),
        ),
        BrowserApp::Brave => info(
            "Brave",
            "com.brave.Browser",
            "BraveSoftware/Brave-Browser",
            "Brave Browser",
            linux(
                "BraveSoftware/Brave-Browser",
                &["brave-browser", "brave-browser-stable", "brave"],
                &["/opt/brave.com/brave/brave", "/opt/brave-bin/brave"],
            ),
        ),
        BrowserApp::Edge => info(
            "Edge",
            "com.microsoft.edgemac",
            "Microsoft Edge",
            "Microsoft Edge",
            linux(
                "microsoft-edge",
                &["microsoft-edge-stable", "microsoft-edge"],
                &["/opt/microsoft/msedge/msedge"],
            ),
        ),
        BrowserApp::Chromium => info(
            "Chromium",
            "org.chromium.Chromium",
            "Chromium",
            "Chromium",
            linux(
                "chromium",
                &["chromium", "chromium-browser"],
                &[
                    "/usr/lib/chromium/chromium",
                    "/usr/lib/chromium-browser/chromium-browser",
                    "/usr/lib64/chromium-browser/chromium-browser",
                ],
            ),
        ),
        BrowserApp::Vivaldi => info(
            "Vivaldi",
            "com.vivaldi.Vivaldi",
            "Vivaldi",
            "Vivaldi",
            linux(
                "vivaldi",
                &["vivaldi-stable", "vivaldi"],
                &["/opt/vivaldi/vivaldi-bin"],
            ),
        ),
        BrowserApp::Arc => info(
            "Arc",
            "company.thebrowser.Browser",
            "Arc/User Data",
            "Arc",
            None,
        ),
        BrowserApp::ChromeBeta => info(
            "Chrome Beta",
            "com.google.Chrome.beta",
            "Google/Chrome Beta",
            "Google Chrome Beta",
            linux(
                "google-chrome-beta",
                &["google-chrome-beta"],
                &["/opt/google/chrome-beta/chrome"],
            ),
        ),
        BrowserApp::ChromeDev => info(
            "Chrome Dev",
            "com.google.Chrome.dev",
            "Google/Chrome Dev",
            "Google Chrome Dev",
            linux(
                "google-chrome-unstable",
                &["google-chrome-unstable"],
                &["/opt/google/chrome-unstable/chrome"],
            ),
        ),
        BrowserApp::ChromeCanary => info(
            "Chrome Canary",
            "com.google.Chrome.canary",
            "Google/Chrome Canary",
            "Google Chrome Canary",
            None,
        ),
        // Dia and Comet: bundle ids and folders as reported, not yet seen on a Mac with the extension.
        BrowserApp::Dia => info(
            "Dia",
            "company.thebrowser.dia",
            "Dia/User Data",
            "Dia",
            None,
        ),
        BrowserApp::Comet => info("Comet", "ai.perplexity.comet", "Comet", "Comet", None),
    }
}

/// The browsers Relay looks in on `platform`: on Linux only those with a Linux build.
pub fn browser_apps(platform: Option<&str>) -> Vec<BrowserApp> {
    BROWSER_APPS
        .into_iter()
        .filter(|&app| platform != Some("linux") || browser(app).linux.is_some())
        .collect()
}

/// `PROFILE_FOLDER` (`/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/`): "Default", "Profile 1" and the like.
pub fn is_profile_folder(folder: &str) -> bool {
    let bytes = folder.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|&b| b.is_ascii_alphanumeric() || matches!(b, b' ' | b'.' | b'_' | b'-'))
}

/// Profiles the browser keeps for itself; never a user's.
const HIDDEN_FOLDERS: [&str; 2] = ["Guest Profile", "System Profile"];

/// What Relay does with the extension's sign-in at a switch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExtensionMode {
    /// Swaps both, closing a running browser for a moment and opening it again.
    Restart,
    /// Swaps both, only when the browser is already closed.
    Closed,
    /// Writes nothing and quits nothing; says when the extension is not on the account.
    Guide,
    /// Never touches or reads the extension.
    Off,
}

pub const EXTENSION_MODES: [ExtensionMode; 4] = [
    ExtensionMode::Restart,
    ExtensionMode::Closed,
    ExtensionMode::Guide,
    ExtensionMode::Off,
];

/// The browser profile whose extension Relay manages.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ExtensionTarget {
    pub app: BrowserApp,
    pub profile: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtensionSetting {
    pub mode: ExtensionMode,
    /// Chosen when several browser profiles have the extension; the only one is used without.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<ExtensionTarget>,
}

/// `DEFAULT_EXTENSION`: until the user picks "restart" or "closed", Relay only guides.
pub fn default_extension() -> ExtensionSetting {
    ExtensionSetting {
        mode: ExtensionMode::Guide,
        browser: None,
    }
}

/// Modes that change a browser profile's files: the claude.ai login and the extension's sign-in.
pub fn writes_browser(mode: ExtensionMode) -> bool {
    matches!(mode, ExtensionMode::Restart | ExtensionMode::Closed)
}

/// A browser profile that has the Claude extension installed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionInstance {
    pub app: BrowserApp,
    pub profile: String,
    pub name: String,
    /// The extension has its storage in this profile (it was opened at least once).
    pub opened: bool,
    /// When the extension last wrote its storage in this profile (ms); the one in use is the newest.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "js::ser_opt_num"
    )]
    pub used_at: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExtensionResult {
    Switched,
    Saved,
    Unchanged,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExtensionReason {
    Off,
    NotInstalled,
    ChooseInstance,
    Unavailable,
    BrowserRunning,
    BrowserDidNotQuit,
    UnknownAccount,
    NoSavedLogin,
    /// The extension is installed but was never opened, so it has no storage to swap.
    NotOpened,
    AlreadyThere,
    Locked,
    Unreadable,
    WriteFailed,
    VerifyFailed,
    RestoreFailed,
    /// Mode "guide": the extension is not on the account Desktop is on; nothing was changed.
    GuideMismatch,
    /// The browser's claude.ai login cannot be tied to the extension's account.
    AmbiguousOwner,
    /// The browser's cookie database or its login cookies are not laid out as Relay expects.
    SchemaChanged,
    /// The browser's cookie database was not closed cleanly.
    JournalPending,
    /// The target's saved claude.ai login was unused until its cookie ended.
    LoginExpired,
}

/// What the last extension step did.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionOutcome {
    pub result: ExtensionResult,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<ExtensionReason>,
    /// The extension's sign-in was sealed into the vault.
    pub saved: bool,
    /// The step removed the extension's record of a failed sign-in (always `true` when set).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cleared: Option<bool>,
    /// Mode "guide": who the extension was signed in to when the step looked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<ExtensionCurrent>,
    pub at: String,
    /// Relay quit the browser for the step.
    pub restarted: bool,
    /// Relay opened it again; false when it quit it and could not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reopened: Option<bool>,
}

/// Who the extension is signed in to right now, read from a copy of its storage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum ExtensionCurrent {
    #[serde(rename_all = "camelCase")]
    SignedIn {
        /// Set for one of Relay's accounts (`known`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        account_uuid: Option<String>,
        known: bool,
        /// The data names an account that is not Relay's.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        other: Option<bool>,
        /// The extension recorded that its sign-in expired (always `true` when set).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expired: Option<bool>,
        at: String,
    },
    /// `unopened`: the extension is installed but was never opened in this profile.
    SignedOut {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unopened: Option<bool>,
        at: String,
    },
    Unreadable {
        at: String,
    },
}

/// The panel's offer to bring the extension to the account Claude Desktop is on. Names only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionOffer {
    pub account_id: String,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signed_out: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expired: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reconnect: Option<bool>,
    /// The browser that is quit and opened again, by name.
    pub browser: String,
}

/// How `ExtensionStatus::target` was picked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstancePicked {
    Chosen,
    Only,
    Recent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSignIn {
    pub account_uuid: String,
    pub saved_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokenSignIn {
    pub account_uuid: String,
    pub at: String,
}

/// What the settings card and the account page show.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionStatus {
    pub setting: ExtensionSetting,
    pub instances: Vec<ExtensionInstance>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<ExtensionInstance>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub picked: Option<InstancePicked>,
    /// Browsers macOS does not let Relay read; set only when there are some.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub denied: Option<Vec<BrowserApp>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restores_tabs: Option<bool>,
    /// Sealed sign-ins, by the extension's account uuid (lower case).
    pub saved: Vec<SavedSignIn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cookies_saved: Option<Vec<SavedSignIn>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last: Option<ExtensionOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<ExtensionCurrent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub broken: Option<BrokenSignIn>,
}

fn record(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value?.as_object()
}

/// Whether `key` is a JS array index (`Object.keys` lists those first, ascending).
fn array_index(key: &str) -> Option<u32> {
    let n: u32 = key.parse().ok()?;
    (n != u32::MAX && n.to_string() == key).then_some(n)
}

/// `Object.keys(map)` in JS order: array indices ascending, then the rest as inserted.
pub(crate) fn js_object_keys(map: &Map<String, Value>) -> Vec<&String> {
    let mut indices: Vec<(u32, &String)> = map
        .keys()
        .filter_map(|k| array_index(k).map(|n| (n, k)))
        .collect();
    indices.sort_by_key(|(n, _)| *n);
    let mut keys: Vec<&String> = indices.into_iter().map(|(_, k)| k).collect();
    keys.extend(map.keys().filter(|k| array_index(k).is_none()));
    keys
}

/// `text.slice(0, n)` in UTF-16 code units.
pub(crate) fn js_slice_units(text: &str, n: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// A user profile from a browser's `Local State`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalStateProfile {
    pub profile: String,
    pub name: String,
}

/// The user's profiles in a browser's `Local State`, from `profile.info_cache`: folder and name,
/// in the browser's own order. Nothing else in the file is used.
pub fn local_state_profiles(local_state: &Value) -> Vec<LocalStateProfile> {
    let profile = record(record(Some(local_state)).and_then(|s| s.get("profile")));
    let Some(cache) = record(profile.and_then(|p| p.get("info_cache"))) else {
        return Vec::new();
    };
    let order: Vec<&str> = profile
        .and_then(|p| p.get("profiles_order"))
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut folders: Vec<&str> = Vec::new();
    for folder in order
        .into_iter()
        .filter(|x| cache.contains_key(*x))
        .chain(js_object_keys(cache).into_iter().map(String::as_str))
    {
        if !folders.contains(&folder) {
            folders.push(folder);
        }
    }
    folders
        .into_iter()
        .filter_map(|folder| {
            let entry = cache.get(folder)?.as_object()?;
            let flag = |key: &str| entry.get(key) == Some(&Value::Bool(true));
            if !is_profile_folder(folder)
                || HIDDEN_FOLDERS.contains(&folder)
                || flag("is_guest")
                || flag("is_ephemeral")
                || flag("is_omitted_from_profile_list")
            {
                return None;
            }
            let name = match entry.get("name").and_then(Value::as_str).map(js_trim) {
                Some(name) if !name.is_empty() => js_slice_units(name, 100),
                _ => folder.to_string(),
            };
            Some(LocalStateProfile {
                profile: folder.to_string(),
                name,
            })
        })
        .collect()
}

/// `String.prototype.trim`.
pub(crate) use super::types::js::trim as js_trim;

/// Whether a profile's `Preferences` make the browser open the last session again:
/// `session.restore_on_startup` 1 ("continue where you left off") or 5.
pub fn startup_restores(preferences: &Value) -> bool {
    let value = record(record(Some(preferences)).and_then(|p| p.get("session")))
        .and_then(|s| s.get("restore_on_startup"));
    value
        .and_then(Value::as_f64)
        .is_some_and(|v| v == 1.0 || v == 5.0)
}

/// The instance Relay manages: the chosen one when it is found, else the only one found, else the
/// one whose storage changed last.
pub fn choose_instance<'a>(
    instances: &'a [ExtensionInstance],
    chosen: Option<&ExtensionTarget>,
) -> Option<&'a ExtensionInstance> {
    pick_instance(instances, chosen).map(|(instance, _)| instance)
}

pub fn pick_instance<'a>(
    instances: &'a [ExtensionInstance],
    chosen: Option<&ExtensionTarget>,
) -> Option<(&'a ExtensionInstance, InstancePicked)> {
    if let Some(chosen) = chosen
        && let Some(found) = instances
            .iter()
            .find(|i| i.app == chosen.app && i.profile == chosen.profile)
    {
        return Some((found, InstancePicked::Chosen));
    }
    if instances.len() == 1 {
        return Some((&instances[0], InstancePicked::Only));
    }
    let mut newest: Option<&ExtensionInstance> = None;
    for instance in instances.iter().filter(|i| i.used_at.is_some()) {
        // `(b.usedAt ?? 0) > (a.usedAt ?? 0) ? b : a`: the first of equals stays.
        if newest.is_none_or(|a| instance.used_at.unwrap_or(0.0) > a.used_at.unwrap_or(0.0)) {
            newest = Some(instance);
        }
    }
    newest.map(|i| (i, InstancePicked::Recent))
}
