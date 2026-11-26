//! Rust port of `tests/extension-world.ts`: browsers and the extension's storage in a temp
//! folder, with real files for what Relay reads, a recorded `quit` and `launch`, and storages
//! that, like LevelDB and SQLite, refuse to open while the browser runs.
#![allow(dead_code)]

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use indexmap::IndexMap;
use relay_core::browser_system::BrowserSystem;
use relay_core::cookie_store::{
    CookieRow, CookieSnapshot, CookieStorage, CookieStoreError, CookieStoreReason, CookieValue,
};
use relay_core::extension_storage::{ExtensionStorage, StorageError, StorageReason};
use relay_core::shared::browser_extension::{BrowserApp, CLAUDE_EXTENSION_ID, browser};
use relay_core::shared::extension_auth::SignIn;

pub const LOGIN_COLUMNS: [&str; 5] = [
    "creation_utc",
    "host_key",
    "top_frame_site_key",
    "name",
    "encrypted_value",
];

/// The default creation time of `login_for`: each account and `n` at its own moment.
pub fn login_created(account_uuid: &str, n: i64) -> i64 {
    let head = i64::from_str_radix(&account_uuid[..6], 16).unwrap_or(0);
    1_700_000_000_000 + (head % 100_000) * 7 + n * 13
}

/// A browser profile's claude.ai login as the cookie database holds it; `n` tells copies apart.
pub fn login_for(account_uuid: &str, n: i64) -> CookieSnapshot {
    login_at(account_uuid, n, login_created(account_uuid, n))
}

/// `login_for` created at `created_ms`.
pub fn login_at(account_uuid: &str, n: i64, created_ms: i64) -> CookieSnapshot {
    let row = |name: &str, host: &str, value: &str| -> CookieRow {
        IndexMap::from([
            (
                "creation_utc".to_owned(),
                CookieValue::Integer((created_ms + 11_644_473_600_000) * 1000),
            ),
            ("host_key".to_owned(), CookieValue::Text(host.to_owned())),
            (
                "top_frame_site_key".to_owned(),
                CookieValue::Text(String::new()),
            ),
            ("name".to_owned(), CookieValue::Text(name.to_owned())),
            (
                "encrypted_value".to_owned(),
                CookieValue::Blob(format!("v10{value}-{account_uuid}-{n}").into_bytes()),
            ),
        ])
    };
    CookieSnapshot {
        version: "24".into(),
        columns: LOGIN_COLUMNS.map(str::to_owned).to_vec(),
        rows: vec![
            row("sessionKey", ".claude.ai", "SESSION-SECRET"),
            row("__Host-sessionBinding", "claude.ai", "BINDING-SECRET"),
        ],
        unlisted: Vec::new(),
    }
}

fn empty_login() -> CookieSnapshot {
    CookieSnapshot {
        version: "24".into(),
        columns: LOGIN_COLUMNS.map(str::to_owned).to_vec(),
        rows: Vec::new(),
        unlisted: Vec::new(),
    }
}

/// A stored sign-in for an account, as the extension keeps it: each value is JSON text.
pub fn sign_in_for(account_uuid: &str, n: i64) -> SignIn {
    let mut sign_in = SignIn::new();
    sign_in.insert("accountUuid", serde_json::to_string(account_uuid).unwrap());
    sign_in.insert("accessToken", format!("\"ACCESS-SECRET-{n}\""));
    sign_in.insert("refreshToken", format!("\"REFRESH-SECRET-{n}\""));
    sign_in.insert("tokenExpiry", (1_900_000_000_000_i64 + n).to_string());
    sign_in
}

/// A sign-in from `(key, value)` pairs.
pub fn sign_in(pairs: &[(&str, &str)]) -> SignIn {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

type PathHook = Arc<dyn Fn(&Path) + Send + Sync>;

/// What the fakes share; tests change it between steps.
#[derive(Default)]
pub struct WorldState {
    pub running: bool,
    /// The browser ignores a quit request, as one with an open prompt would.
    pub stuck: bool,
    pub fail_launch: bool,
    /// The LevelDB library can be used.
    pub available: bool,
    /// Makes the next write change the folder, then fail with this reason.
    pub fail_write: Option<StorageReason>,
    pub cookies_available: bool,
    /// Makes the next cookie write change the cookie file, then fail with this reason.
    pub fail_cookie_write: Option<CookieStoreReason>,
    pub events: Vec<String>,
    /// The login each profile folder's cookie database holds; absent reads as logged out.
    pub web: HashMap<PathBuf, CookieSnapshot>,
    /// Every dir a storage was used on, with whether the browser ran then.
    pub opened: Vec<(PathBuf, bool)>,
    pub stored: HashMap<PathBuf, SignIn>,
    /// When each extension folder was last written; unset folders read as unknown.
    pub modified: HashMap<PathBuf, f64>,
    /// Runs after every extension write, whatever it did (the TS tests' wrapped `write`).
    pub after_write: Option<PathHook>,
    /// Runs after every cookie write, whatever it did.
    pub after_cookie_write: Option<PathHook>,
    /// Every read fails with this message (the TS tests' replaced `read`).
    pub fail_read: Option<String>,
    /// Runs after every launch that succeeded (the TS tests' wrapped `launch`).
    pub after_launch: Option<Arc<dyn Fn() + Send + Sync>>,
}

#[derive(Clone)]
pub struct Shared(Arc<Mutex<WorldState>>);

impl Shared {
    pub fn lock(&self) -> MutexGuard<'_, WorldState> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// A copy Relay made names its source in a file; it opens while the browser runs.
fn source_of(dir: &Path, file: &str) -> Option<PathBuf> {
    let source = fs::read_to_string(dir.join(file)).ok()?;
    (source != dir.to_string_lossy()).then(|| PathBuf::from(source))
}

pub struct FakeSystem {
    support: PathBuf,
    state: Shared,
}

impl BrowserSystem for FakeSystem {
    fn support(&self) -> &Path {
        &self.support
    }
    fn read_text(&self, file: &Path) -> Option<String> {
        fs::read_to_string(file).ok()
    }
    fn exists(&self, file: &Path) -> bool {
        file.exists()
    }
    fn modified_at(&self, dir: &Path) -> Option<f64> {
        self.state.lock().modified.get(dir).copied()
    }
    fn read_link(&self, _file: &Path) -> Option<String> {
        None
    }
    fn alive(&self, _pid: i64) -> bool {
        false
    }
    fn processes(&self) -> Result<String, String> {
        Ok(if self.state.lock().running {
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser\n".into()
        } else {
            String::new()
        })
    }
    fn quit(&self, app: BrowserApp) -> Result<(), String> {
        let mut state = self.state.lock();
        state.events.push(format!("quit:{}", app.as_str()));
        if !state.stuck {
            state.running = false;
        }
        Ok(())
    }
    fn launch(&self, app: BrowserApp) -> Result<(), String> {
        let hook = {
            let mut state = self.state.lock();
            state.events.push(format!("launch:{}", app.as_str()));
            if state.fail_launch {
                return Err("open failed".into());
            }
            state.running = true;
            state.after_launch.clone()
        };
        if let Some(hook) = hook {
            hook();
        }
        Ok(())
    }
    fn open_url(&self, app: BrowserApp, url: &str, profile: &str) -> Result<(), String> {
        self.state
            .lock()
            .events
            .push(format!("open:{}:{profile}:{url}", app.as_str()));
        Ok(())
    }
    fn sleep(&self, _ms: u64) {}
}

pub struct FakeStorage {
    state: Shared,
}

impl ExtensionStorage for FakeStorage {
    fn available(&self) -> bool {
        self.state.lock().available
    }
    fn read(&self, dir: &Path) -> Result<Vec<(String, String)>, StorageError> {
        let mut state = self.state.lock();
        if let Some(message) = &state.fail_read {
            return Err(StorageError::new(StorageReason::Failed, message.clone()));
        }
        let source = source_of(dir, "source.txt");
        if source.is_none() {
            let running = state.running;
            state.opened.push((dir.to_path_buf(), running));
            if running {
                return Err(StorageError::new(StorageReason::Locked, "locked"));
            }
        }
        let key = source.unwrap_or_else(|| dir.to_path_buf());
        Ok(state
            .stored
            .get(&key)
            .map(|s| s.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default())
    }
    fn write(&self, dir: &Path, sign_in: &SignIn) -> Result<(), StorageError> {
        let result = (|| {
            let mut state = self.state.lock();
            let running = state.running;
            state.opened.push((dir.to_path_buf(), running));
            if running {
                return Err(StorageError::new(StorageReason::Locked, "locked"));
            }
            if let Some(reason) = state.fail_write {
                // A half-done write: the folder changed, the sign-in did not.
                let _ = fs::write(dir.join("data.txt"), "HALF-WRITTEN");
                return Err(StorageError::new(reason, "write failed"));
            }
            state.stored.insert(dir.to_path_buf(), sign_in.clone());
            Ok(())
        })();
        let hook = self.state.lock().after_write.clone();
        if let Some(hook) = hook {
            hook(dir);
        }
        result
    }
}

pub struct FakeCookies {
    state: Shared,
}

impl CookieStorage for FakeCookies {
    #[allow(
        clippy::misnamed_getters,
        reason = "the world's flag for SQLite, not LevelDB"
    )]
    fn available(&self) -> bool {
        self.state.lock().cookies_available
    }
    fn read(&self, dir: &Path) -> Result<CookieSnapshot, CookieStoreError> {
        let mut state = self.state.lock();
        let source = source_of(dir, "Cookies");
        if source.is_none() {
            let running = state.running;
            state.opened.push((dir.to_path_buf(), running));
            if running {
                return Err(CookieStoreError::new(CookieStoreReason::Locked, "locked"));
            }
        }
        let key = source.unwrap_or_else(|| dir.to_path_buf());
        Ok(state.web.get(&key).cloned().unwrap_or_else(empty_login))
    }
    fn write(&self, dir: &Path, snapshot: &CookieSnapshot) -> Result<(), CookieStoreError> {
        let result = (|| {
            let mut state = self.state.lock();
            let running = state.running;
            state.opened.push((dir.to_path_buf(), running));
            if running {
                return Err(CookieStoreError::new(CookieStoreReason::Locked, "locked"));
            }
            if let Some(reason) = state.fail_cookie_write {
                // A half-done write: the cookie file changed, the login did not.
                let _ = fs::write(dir.join("Cookies"), "HALF-WRITTEN");
                return Err(CookieStoreError::new(reason, "write failed"));
            }
            state.web.insert(dir.to_path_buf(), snapshot.clone());
            Ok(())
        })();
        let hook = self.state.lock().after_cookie_write.clone();
        if let Some(hook) = hook {
            hook(dir);
        }
        result
    }
}

pub struct World {
    pub support: PathBuf,
    pub state: Shared,
    pub system: Arc<FakeSystem>,
    pub storage: Arc<FakeStorage>,
    pub cookies: Arc<FakeCookies>,
}

/// The fake world in `temp`.
pub fn extension_world(temp: &Path) -> World {
    let support = temp
        .join("home")
        .join("Library")
        .join("Application Support");
    let state = Shared(Arc::new(Mutex::new(WorldState {
        available: true,
        cookies_available: true,
        ..WorldState::default()
    })));
    World {
        system: Arc::new(FakeSystem {
            support: support.clone(),
            state: state.clone(),
        }),
        storage: Arc::new(FakeStorage {
            state: state.clone(),
        }),
        cookies: Arc::new(FakeCookies {
            state: state.clone(),
        }),
        support,
        state,
    }
}

impl World {
    /// Adds a profile with the extension installed and, unless `opened` is false, its storage
    /// folder; returns that folder (which then does not exist).
    pub fn install_with(
        &self,
        app: BrowserApp,
        profile: &str,
        name: &str,
        opened: bool,
    ) -> PathBuf {
        let data = self.support.join(browser(app).data_dir);
        fs::create_dir_all(&data).unwrap();
        let file = data.join("Local State");
        let mut local: serde_json::Value = fs::read_to_string(&file)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        if local.get("profile").is_none() {
            local["profile"] = serde_json::json!({ "info_cache": {} });
        }
        local["profile"]["info_cache"][profile] = serde_json::json!({ "name": name });
        fs::write(&file, local.to_string()).unwrap();
        fs::create_dir_all(
            data.join(profile)
                .join("Extensions")
                .join(CLAUDE_EXTENSION_ID)
                .join("1.0.102_0"),
        )
        .unwrap();
        let dir = data
            .join(profile)
            .join("Local Extension Settings")
            .join(CLAUDE_EXTENSION_ID);
        if !opened {
            return dir;
        }
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("data.txt"), "ORIGINAL").unwrap();
        fs::write(dir.join("source.txt"), dir.to_string_lossy().as_bytes()).unwrap();
        let profile_dir = data.join(profile);
        fs::write(
            profile_dir.join("Cookies"),
            profile_dir.to_string_lossy().as_bytes(),
        )
        .unwrap();
        fs::write(profile_dir.join("Device Bound Sessions"), "DBSC").unwrap();
        dir
    }

    pub fn install(&self, app: BrowserApp) -> PathBuf {
        self.install_with(app, "Default", "Default", true)
    }

    pub fn stored(&self, dir: &Path) -> Option<SignIn> {
        self.state.lock().stored.get(dir).cloned()
    }

    pub fn set_stored(&self, dir: &Path, sign_in: Option<SignIn>) {
        let mut state = self.state.lock();
        match sign_in {
            Some(s) => state.stored.insert(dir.to_path_buf(), s),
            None => state.stored.remove(dir),
        };
    }

    pub fn web(&self, profile: &Path) -> Option<CookieSnapshot> {
        self.state.lock().web.get(profile).cloned()
    }

    pub fn set_web(&self, profile: &Path, login: CookieSnapshot) {
        self.state.lock().web.insert(profile.to_path_buf(), login);
    }

    pub fn events(&self) -> Vec<String> {
        self.state.lock().events.clone()
    }

    pub fn opened(&self) -> Vec<(PathBuf, bool)> {
        self.state.lock().opened.clone()
    }
}
