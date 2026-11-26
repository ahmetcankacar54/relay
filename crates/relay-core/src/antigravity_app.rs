//! Port of `electron/core/antigravity-app.ts`: Google's Antigravity app, its data folder and
//! the account it last signed in with.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;

use crate::detached_exec::{ExecOptions, run_detached};
use crate::relay_cli_path::js_join;
use crate::relay_paths::Platform;
use crate::shared::types::{Account, AccountProvider, AntigravityAppState};

/// The Antigravity app's bundle id.
pub const ANTIGRAVITY_BUNDLE_ID: &str = "com.google.antigravity";
/// The key its settings file keeps the last sign-in under.
const LAST_LOGIN_KEY: &str = "agy.onboarding.lastLoginUsername";
pub(crate) const MAX_SETTINGS_BYTES: u64 = 4 * 1024 * 1024;

/// An e-mail fit to name a Google account.
pub(crate) static EMAIL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[^@\s]{1,64}@[^@\s]{1,255}$").expect("valid regex"));

/// Where the Antigravity app keeps its data on `platform`, with that platform's separators.
pub fn antigravity_data_dir(
    platform: Platform,
    home: &str,
    env: &BTreeMap<String, String>,
) -> String {
    match platform {
        Platform::Windows => {
            let appdata = env
                .get("APPDATA")
                .cloned()
                .unwrap_or_else(|| js_join(true, &[home, "AppData", "Roaming"]));
            js_join(true, &[&appdata, "Antigravity"])
        }
        Platform::MacOs => js_join(
            false,
            &[home, "Library", "Application Support", "Antigravity"],
        ),
        Platform::Linux => {
            let config = env
                .get("XDG_CONFIG_HOME")
                .cloned()
                .unwrap_or_else(|| js_join(false, &[home, ".config"]));
            js_join(false, &[&config, "Antigravity"])
        }
    }
}

/// What the app's settings file says about its sign-in.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AntigravityLastLogin {
    pub installed: bool,
    pub email: Option<String>,
}

/// The e-mail the app last signed in with, from its settings file; None when there is none.
pub fn antigravity_last_login(data_dir: &Path) -> AntigravityLastLogin {
    let file = data_dir.join("app_storage.json");
    let read = || -> Option<AntigravityLastLogin> {
        let stat = fs::symlink_metadata(&file).ok()?;
        if !stat.is_file() || stat.len() > MAX_SETTINGS_BYTES {
            return Some(AntigravityLastLogin {
                installed: true,
                email: None,
            });
        }
        let data: serde_json::Value = serde_json::from_slice(&fs::read(&file).ok()?).ok()?;
        let email = data
            .get(LAST_LOGIN_KEY)
            .and_then(|v| v.as_str())
            .filter(|e| EMAIL.is_match(e))
            .map(str::to_owned);
        Some(AntigravityLastLogin {
            installed: true,
            email,
        })
    };
    // No settings file: installed only if its data folder exists (it was opened once).
    read().unwrap_or_else(|| AntigravityLastLogin {
        installed: fs::metadata(data_dir).is_ok_and(|m| m.is_dir()),
        email: None,
    })
}

/// Which Relay Antigravity account the app is signed in with, as the snapshot carries it: the
/// account's id, never the e-mail. `other_sign_in` is an app signed in with an account Relay
/// does not have. The app reads its sign-in at start, so this is the account it uses until it
/// restarts.
pub fn match_antigravity_app(
    read: &AntigravityLastLogin,
    accounts: &[Account],
    can_open: bool,
) -> AntigravityAppState {
    if !read.installed {
        return AntigravityAppState::default();
    }
    let email = read.email.as_deref().map(str::to_lowercase);
    let matched = email.as_deref().and_then(|email| {
        accounts.iter().find(|a| {
            a.provider == Some(AccountProvider::Antigravity)
                && a.auth
                    .as_ref()
                    .and_then(|auth| auth.email.as_deref())
                    .is_some_and(|e| e.to_lowercase() == email)
        })
    });
    AntigravityAppState {
        installed: true,
        can_open,
        account_id: matched.map(|a| a.id.clone()),
        other_sign_in: (email.is_some() && matched.is_none()).then_some(true),
        ..AntigravityAppState::default()
    }
}

/// HOME, USER and PATH only: Relay's own environment (gateway variables, a Claude Code
/// session's) must not reach another app.
pub(crate) fn app_launch_env() -> BTreeMap<String, String> {
    BTreeMap::from([
        (
            "HOME".to_owned(),
            std::env::home_dir()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
        ),
        (
            "USER".to_owned(),
            crate::terminal_identity::current_user_name().unwrap_or_default(),
        ),
        ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
    ])
}

/// Brings the Antigravity app forward, or starts it.
pub fn open_antigravity_app() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("Opening Antigravity from Relay works on macOS only".into());
    }
    run_detached(
        "/usr/bin/open",
        &["-b".to_owned(), ANTIGRAVITY_BUNDLE_ID.to_owned()],
        &ExecOptions {
            env: Some(app_launch_env()),
            ..ExecOptions::timeout_ms(15_000)
        },
    )
    .map(|_| ())
    .map_err(|e| e.message)
}
