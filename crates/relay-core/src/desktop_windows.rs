//! Port of `electron/core/desktop-windows.ts`: separate Claude windows — an account opened in its
//! own Claude, next to the main one, on a data folder of its own (`--user-data-dir`).
//!
//! The window opens signed in with the sign-in the vault holds, and gives it back once it
//! closes, so an account's live sign-in has one holder at a time. The state lives outside the
//! registry, in `windows.json`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use indexmap::IndexMap;
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::continuation_journal::{MAX_BYTES, private_journal_directory, write_private_json};
use crate::desktop::{
    DesktopError, DesktopHost, DesktopResult, LaunchOptions, WINDOWS_UNSUPPORTED,
};
use crate::desktop_instances::ClaudeWindowProcess;
use crate::fs_util::resolve;
use crate::shared::types::js::ser_num;

/// An account's separate Claude window that runs now.
#[derive(Debug, Clone, PartialEq)]
pub struct OpenWindow {
    pub account_uuid: String,
    /// The window's main process.
    pub pid: i64,
    /// When Relay opened it; None when Relay does not remember.
    pub opened_at: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
struct Opened {
    #[serde(rename = "openedAt", serialize_with = "ser_num")]
    opened_at: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
struct Saved {
    /// The feature is on: off until the user turns it on in Settings.
    enabled: bool,
    /// The windows Relay opened and has not yet seen closed, by account.
    open: IndexMap<String, Opened>,
}

pub const WINDOWS_OFF: &str = "Separate Claude windows are turned off in Settings.";
pub const WINDOW_IS_MAIN: &str = "This account is already open in the Claude app. Switch the Claude app to another account first.";
pub const WINDOW_DID_NOT_OPEN: &str = "Claude did not open the separate window. Try again.";
pub const WINDOW_DID_NOT_CLOSE: &str =
    "The separate window is still open. Claude may be asking about work left running there.";

static UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").unwrap()
});
static SESSION_FILE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^local_[0-9a-f-]{36}\.json$").unwrap());
const OPEN_WAIT_MS: u64 = 15_000;
const CLOSE_WAIT_MS: u64 = 20_000;
const POLL_MS: u64 = 250;
/// How long after a closed window's last activity its rows are still its own (the ledger lags).
const OWNER_SLACK_MS: f64 = 10.0 * 60_000.0;

/// Who a window's Claude Code session belongs to, and until when (infinity while it runs).
#[derive(Debug, Clone, PartialEq)]
pub struct SessionOwner {
    pub account_uuid: String,
    pub until: f64,
}

/// Fields of a diagnosis event: ids, counts and times only.
pub type LogFields = Map<String, Value>;

pub type AccountCheck = Box<dyn Fn() -> DesktopResult<Option<String>> + Send + Sync>;
pub type FolderStep<T> = Box<dyn Fn(&str, &Path) -> DesktopResult<T> + Send + Sync>;
pub type LogHook = Box<dyn Fn(&str, &LogFields) + Send + Sync>;

pub struct DesktopWindowsDeps {
    /// Where windows live: `<id>/data` is an account's Claude data folder, `windows.json` the state.
    pub folder: PathBuf,
    pub host: Arc<dyn DesktopHost>,
    /// The account the main Claude is signed in to, as its data folder says.
    pub current: AccountCheck,
    /// Puts the account's saved sign-in into a window's data folder.
    pub seed: FolderStep<()>,
    /// Saves the sign-in a closed window left back to the vault; whether it did.
    pub seal: FolderStep<bool>,
    pub quic_off: Option<Box<dyn Fn() -> bool + Send + Sync>>,
    pub now: Box<dyn Fn() -> i64 + Send + Sync>,
    pub sleep: Option<Box<dyn Fn(u64) + Send + Sync>>,
    /// For a diagnosis log. May fail; nothing depends on it.
    pub log: Option<LogHook>,
}

/// Separate Claude windows. The main Claude cannot switch to an account while its window runs
/// (see `DesktopManager::switch_to`).
pub struct DesktopWindows {
    deps: DesktopWindowsDeps,
    saved: Mutex<Saved>,
    /// Accounts whose window `open` is starting: not yet in the listing, never closed.
    opening: Mutex<HashSet<String>>,
    listed: Mutex<Option<(i64, Vec<ClaudeWindowProcess>)>>,
}

fn is_uuid(text: &str) -> bool {
    UUID.is_match(text)
}

impl DesktopWindows {
    pub fn new(deps: DesktopWindowsDeps) -> DesktopWindows {
        let saved = read_saved(&deps.folder.join("windows.json"));
        DesktopWindows {
            deps,
            saved: Mutex::new(saved),
            opening: Mutex::new(HashSet::new()),
            listed: Mutex::new(None),
        }
    }

    fn file(&self) -> PathBuf {
        self.deps.folder.join("windows.json")
    }

    fn saved(&self) -> std::sync::MutexGuard<'_, Saved> {
        self.saved.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn write(&self, saved: &Saved) -> DesktopResult<()> {
        private_journal_directory(&self.deps.folder)
            .and_then(|()| write_private_json(&self.file(), saved, MAX_BYTES))
            .map_err(|e| DesktopError::new(e.to_string()))
    }

    fn remember(&self, id: &str) -> DesktopResult<()> {
        let mut saved = self.saved();
        saved.open.insert(
            id.to_string(),
            Opened {
                opened_at: (self.deps.now)() as f64,
            },
        );
        self.write(&saved)
    }

    fn sleep(&self, ms: u64) {
        match &self.deps.sleep {
            Some(sleep) => sleep(ms),
            None => std::thread::sleep(std::time::Duration::from_millis(ms)),
        }
    }

    fn log(&self, event: &str, fields: Value) {
        if let (Some(log), Value::Object(fields)) = (&self.deps.log, fields) {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| log(event, &fields)));
        }
    }

    pub fn enabled(&self) -> bool {
        self.saved().enabled
    }

    pub fn set_enabled(&self, enabled: bool) -> DesktopResult<()> {
        let mut saved = self.saved();
        saved.enabled = enabled;
        self.write(&saved)
    }

    /// The account's Claude data folder.
    pub fn data_dir(&self, account_uuid: &str) -> DesktopResult<PathBuf> {
        if !is_uuid(account_uuid) {
            return Err("Invalid account id.".into());
        }
        Ok(resolve(
            &self
                .deps
                .folder
                .join(account_uuid.to_lowercase())
                .join("data"),
        ))
    }

    /// The account's data folder when a window ever used it, for the main Claude's history.
    pub fn folder_of(&self, account_uuid: &str) -> Option<PathBuf> {
        let dir = self.data_dir(account_uuid).ok()?;
        dir.join("config.json").exists().then_some(dir)
    }

    /// The accounts' windows that run, and how many other Claudes run on a folder of their own:
    /// from a listing at most `max_age_ms` old, a fresh one by default.
    pub fn running(&self, max_age_ms: i64) -> DesktopResult<(Vec<OpenWindow>, usize)> {
        let now = (self.deps.now)();
        let cached = self
            .listed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .filter(|(at, _)| now - at >= 0 && now - at < max_age_ms)
            .map(|(_, list)| list.clone());
        let processes = match cached {
            Some(list) => list,
            None => {
                let list = self.deps.host.windows()?;
                *self.listed.lock().unwrap_or_else(|e| e.into_inner()) = Some((now, list.clone()));
                list
            }
        };
        let saved = self.saved().clone();
        let mut windows = Vec::new();
        let mut others = 0;
        for process in processes {
            let dir = PathBuf::from(&process.dir);
            let id = dir
                .parent()
                .and_then(Path::file_name)
                .map(|name| name.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if is_uuid(&id) && self.data_dir(&id).ok() == Some(resolve(&dir)) {
                windows.push(OpenWindow {
                    opened_at: saved.open.get(&id).map(|o| o.opened_at),
                    account_uuid: id,
                    pid: process.pid,
                });
            } else {
                others += 1;
            }
        }
        Ok((windows, others))
    }

    pub fn open_accounts(&self) -> DesktopResult<Vec<String>> {
        Ok(self
            .running(0)?
            .0
            .into_iter()
            .map(|window| window.account_uuid)
            .collect())
    }

    /// Whether any Claude runs next to the main one: automatic switching waits while one does.
    pub fn any_open(&self) -> DesktopResult<bool> {
        let (windows, others) = self.running(0)?;
        Ok(windows.len() + others > 0)
    }

    fn window_of(&self, id: &str) -> DesktopResult<Option<i64>> {
        Ok(self
            .running(0)?
            .0
            .into_iter()
            .find(|w| w.account_uuid == id)
            .map(|w| w.pid))
    }

    /// Opens the account's window, or brings it forward when it runs.
    pub fn open(&self, account_uuid: &str) -> DesktopResult<WindowOpened> {
        if !self.enabled() {
            return Err(WINDOWS_OFF.into());
        }
        if !self.deps.host.has_windows() {
            return Err(WINDOWS_UNSUPPORTED.into());
        }
        let id = account_uuid.to_lowercase();
        let dir = self.data_dir(&id)?;
        if let Some(pid) = self.window_of(&id)? {
            self.deps.host.activate_window(pid)?;
            return Ok(WindowOpened::Shown);
        }
        if (self.deps.current)()?.map(|c| c.to_lowercase()).as_deref() == Some(id.as_str()) {
            return Err(WINDOW_IS_MAIN.into());
        }
        // A window that closed before gives its sign-in back first: it may be newer.
        self.reconcile()?;
        crate::fs_util::create_private_dir_all(&dir)?;
        // Until the listing shows it, a reconcile in between must not take it for closed.
        self.opening
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone());
        let result = (|| -> DesktopResult<Option<WindowOpened>> {
            (self.deps.seed)(&id, &dir)?;
            self.remember(&id)?;
            let begun = (self.deps.now)();
            let quic_off = self.deps.quic_off.as_ref().is_some_and(|q| q());
            self.deps
                .host
                .launch_window(&dir, quic_off.then_some(LaunchOptions { quic_off: true }))?;
            let mut waited = 0;
            while waited < OPEN_WAIT_MS {
                if self.window_of(&id)?.is_some() {
                    self.log(
                        "window-opened",
                        json!({ "account": &id[..8], "waitedMs": (self.deps.now)() - begun }),
                    );
                    return Ok(Some(WindowOpened::Opened));
                }
                self.sleep(POLL_MS);
                waited += POLL_MS;
            }
            Ok(None)
        })();
        self.opening
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
        if let Some(opened) = result? {
            return Ok(opened);
        }
        self.log("window-open-failed", json!({ "account": &id[..8] }));
        Err(WINDOW_DID_NOT_OPEN.into())
    }

    /// Asks the account's window to quit, waits for it, and gives its sign-in back.
    pub fn close(&self, account_uuid: &str) -> DesktopResult<()> {
        let id = account_uuid.to_lowercase();
        if let Some(pid) = self.window_of(&id)? {
            if !self.deps.host.has_windows() {
                return Err(WINDOWS_UNSUPPORTED.into());
            }
            // Its sign-in goes back once it closes, even when Relay lost track of opening it.
            if !self.saved().open.contains_key(&id) {
                self.remember(&id)?;
            }
            self.deps.host.quit_window(pid)?;
            let mut closed = false;
            let mut waited = 0;
            while waited < CLOSE_WAIT_MS && !closed {
                closed = self.window_of(&id)?.is_none();
                if !closed {
                    self.sleep(POLL_MS);
                }
                waited += POLL_MS;
            }
            if !closed {
                return Err(WINDOW_DID_NOT_CLOSE.into());
            }
        }
        self.reconcile()?;
        Ok(())
    }

    /// The Claude Code sessions the accounts' windows hold, by session id (lower case): the
    /// account each window's own session index names, while its window runs and up to a while
    /// after the session's last activity there. Unreadable files are skipped.
    pub fn session_owners(&self) -> HashMap<String, SessionOwner> {
        let mut owners = HashMap::new();
        let open: HashSet<String> = self
            .open_accounts()
            .unwrap_or_default()
            .into_iter()
            .collect();
        let list = |dir: &Path| -> Vec<String> {
            std::fs::read_dir(dir)
                .map(|entries| {
                    entries
                        .filter_map(Result::ok)
                        .map(|e| e.file_name().to_string_lossy().into_owned())
                        .collect()
                })
                .unwrap_or_default()
        };
        for id in list(&self.deps.folder) {
            if !is_uuid(&id) {
                continue;
            }
            let Ok(data) = self.data_dir(&id) else {
                continue;
            };
            let scope = data.join("claude-code-sessions").join(id.to_lowercase());
            for org in list(&scope) {
                if !is_uuid(&org) {
                    continue;
                }
                for name in list(&scope.join(&org)) {
                    if !SESSION_FILE.is_match(&name) {
                        continue;
                    }
                    // Being rewritten, or not a session record.
                    let Ok(text) = std::fs::read_to_string(scope.join(&org).join(&name)) else {
                        continue;
                    };
                    let Ok(record) = serde_json::from_str::<Value>(&text) else {
                        continue;
                    };
                    let Some(session) = record
                        .get("cliSessionId")
                        .and_then(Value::as_str)
                        .filter(|s| is_uuid(s))
                    else {
                        continue;
                    };
                    let account = id.to_lowercase();
                    let until = if open.contains(&account) {
                        Some(f64::INFINITY)
                    } else {
                        record
                            .get("lastActivityAt")
                            .and_then(Value::as_f64)
                            .filter(|n| n.is_finite())
                            .map(|at| at + OWNER_SLACK_MS)
                    };
                    if let Some(until) = until {
                        owners.insert(
                            session.to_lowercase(),
                            SessionOwner {
                                account_uuid: account,
                                until,
                            },
                        );
                    }
                }
            }
        }
        owners
    }

    /// Gives back the sign-in of every window Relay opened that no longer runs, however it
    /// closed. One that cannot be saved now (another Desktop operation runs) is tried again next
    /// time. The accounts whose sign-in went back to the vault.
    pub fn reconcile(&self) -> DesktopResult<Vec<String>> {
        let ids: Vec<String> = self.saved().open.keys().cloned().collect();
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let open: HashSet<String> = self.open_accounts()?.into_iter().collect();
        let mut sealed = Vec::new();
        for id in ids {
            let opening = self
                .opening
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains(&id);
            if open.contains(&id) || opening {
                continue;
            }
            let saved = match self
                .data_dir(&id)
                .and_then(|dir| (self.deps.seal)(&id, &dir))
            {
                Ok(saved) => saved,
                Err(_) => continue,
            };
            {
                let mut state = self.saved();
                state.open.shift_remove(&id);
                self.write(&state)?;
            }
            self.log(
                "window-closed",
                json!({ "account": &id[..8], "sealed": saved }),
            );
            if saved {
                sealed.push(id);
            }
        }
        Ok(sealed)
    }
}

/// What `open` did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowOpened {
    Opened,
    Shown,
}

impl WindowOpened {
    pub fn as_str(self) -> &'static str {
        match self {
            WindowOpened::Opened => "opened",
            WindowOpened::Shown => "shown",
        }
    }
}

/// `windows.json` as saved; anything unreadable is the default (off, nothing open).
fn read_saved(file: &Path) -> Saved {
    let Ok(text) = std::fs::read_to_string(file) else {
        return Saved::default();
    };
    let Ok(saved) = serde_json::from_str::<Value>(&text) else {
        return Saved::default();
    };
    let mut open = IndexMap::new();
    if let Some(entries) = saved.get("open").and_then(Value::as_object) {
        for (id, entry) in entries {
            let at = entry
                .get("openedAt")
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite());
            if let (true, Some(at)) = (is_uuid(id), at) {
                open.insert(id.to_lowercase(), Opened { opened_at: at });
            }
        }
    }
    Saved {
        enabled: saved.get("enabled") == Some(&Value::Bool(true)),
        open,
    }
}
