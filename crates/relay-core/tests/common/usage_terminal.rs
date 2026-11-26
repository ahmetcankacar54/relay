//! Helpers for the electron/core/terminal-identity ports: Claude Code's sign-in in memory, a
//! sealed vault and `security`/CLI stand-ins.
#![allow(dead_code)]

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use relay_core::desktop_files::JsonObject;
use relay_core::shared::terminal_identity::{TerminalIdentity, TerminalReason};
use relay_core::terminal_identity::{
    TerminalConfig, TerminalError, TerminalKeychain, TerminalLock, TerminalOwner, TerminalPorts,
    TerminalSwitcher, TerminalVault,
};
use relay_core::vault_crypto::Sealer;
use serde_json::{Value, json};

pub fn object(value: Value) -> JsonObject {
    match value {
        Value::Object(obj) => obj,
        other => panic!("not an object: {other}"),
    }
}

/// Claude Code's `claudeAiOauth` number `n`.
pub fn oauth(n: u64) -> JsonObject {
    object(json!({
        "accessToken": format!("sk-ant-oat01-access-{n}"),
        "refreshToken": format!("sk-ant-ort01-refresh-{n}"),
        "expiresAt": 1_900_000_000_000u64 + n,
        "scopes": ["user:inference", "user:profile"],
        "subscriptionType": "team",
    }))
}

pub fn access(n: u64) -> String {
    format!("sk-ant-oat01-access-{n}")
}

/// Claude Code's `oauthAccount`.
pub fn person(id: &TerminalIdentity, email: &str) -> JsonObject {
    object(json!({
        "accountUuid": id.account_uuid,
        "organizationUuid": id.org_id,
        "emailAddress": email,
        "organizationName": format!("Org of {email}"),
    }))
}

pub fn random_id() -> TerminalIdentity {
    TerminalIdentity {
        account_uuid: uuid::Uuid::new_v4().to_string(),
        org_id: uuid::Uuid::new_v4().to_string(),
    }
}

/// A vault sealed with a fixed key (`Buffer.alloc(32, 9)`).
pub fn sealed_vault(dir: &Path) -> TerminalVault {
    let sealer = Arc::new(Sealer::new(&[9u8; 32]).unwrap());
    let opener = sealer.clone();
    TerminalVault::new(
        dir,
        Arc::new(move |text: &str| Ok(sealer.seal(text))),
        Arc::new(move |data: &[u8]| opener.unseal(data).map_err(|e| e.to_string())),
    )
}

/// The lock that just runs the action.
pub fn open_lock() -> TerminalLock {
    Arc::new(|action: &mut dyn FnMut()| {
        action();
        Ok(())
    })
}

/// A lock Claude Code holds: always busy.
pub fn busy_lock() -> TerminalLock {
    Arc::new(|_: &mut dyn FnMut()| Err(TerminalError(TerminalReason::Busy)))
}

/// Who Anthropic says each access token is, from `owners`.
pub fn owner_from(owners: Arc<Mutex<HashMap<String, TerminalIdentity>>>) -> TerminalOwner {
    Arc::new(move |token: &str| owners.lock().unwrap().get(token).cloned())
}

pub struct State {
    pub item: Option<String>,
    pub config: JsonObject,
    pub writes: u32,
}

struct Keychain {
    state: Arc<Mutex<State>>,
    fail_write: bool,
}

impl TerminalKeychain for Keychain {
    fn read(&self) -> Result<Option<String>, TerminalError> {
        Ok(self.state.lock().unwrap().item.clone())
    }
    fn write(&self, text: &str) -> Result<(), TerminalError> {
        let mut state = self.state.lock().unwrap();
        state.writes += 1;
        if !self.fail_write || state.writes > 1 {
            state.item = Some(text.to_owned());
        }
        Ok(())
    }
    fn remove(&self) -> Result<(), TerminalError> {
        self.state.lock().unwrap().item = None;
        Ok(())
    }
}

struct Config {
    state: Arc<Mutex<State>>,
    fail: bool,
}

impl TerminalConfig for Config {
    fn read(&self) -> Result<Option<JsonObject>, TerminalError> {
        Ok(Some(self.state.lock().unwrap().config.clone()))
    }
    fn write_account(&self, account: Option<&JsonObject>) -> Result<(), TerminalError> {
        if self.fail {
            return Err(TerminalError(TerminalReason::Busy));
        }
        let mut state = self.state.lock().unwrap();
        match account {
            None => {
                state.config.shift_remove("oauthAccount");
            }
            Some(account) => {
                state
                    .config
                    .insert("oauthAccount".into(), Value::Object(account.clone()));
            }
        }
        Ok(())
    }
}

#[derive(Default, Clone, Copy)]
pub struct WorldOptions {
    pub fail_write: bool,
    pub fail_config: bool,
}

/// Claude Code's sign-in in memory: the Keychain item's text and `~/.claude.json`.
pub struct World {
    pub temp: tempfile::TempDir,
    state: Arc<Mutex<State>>,
    /// Who Anthropic says each access token is; missing means it cannot be asked.
    pub owners: Arc<Mutex<HashMap<String, TerminalIdentity>>>,
    pub ports: TerminalPorts,
    pub vault: TerminalVault,
    pub a: TerminalIdentity,
    pub b: TerminalIdentity,
    pub switcher: TerminalSwitcher,
}

impl World {
    pub fn new(options: WorldOptions) -> World {
        let temp = tempfile::Builder::new()
            .prefix("relay-terminal-")
            .tempdir()
            .unwrap();
        let state = Arc::new(Mutex::new(State {
            item: None,
            config: object(json!({ "theme": "dark", "projects": { "/x": {} } })),
            writes: 0,
        }));
        let owners = Arc::new(Mutex::new(HashMap::new()));
        let ports = TerminalPorts {
            keychain: Arc::new(Keychain {
                state: state.clone(),
                fail_write: options.fail_write,
            }),
            config: Arc::new(Config {
                state: state.clone(),
                fail: options.fail_config,
            }),
            lock: open_lock(),
            owner: Some(owner_from(owners.clone())),
        };
        let vault = sealed_vault(&temp.path().join("vault"));
        let switcher = TerminalSwitcher::new(ports.clone(), vault.clone());
        World {
            temp,
            state,
            owners,
            ports,
            vault,
            a: random_id(),
            b: random_id(),
            switcher,
        }
    }

    pub fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap()
    }

    pub fn item(&self) -> Option<String> {
        self.state().item.clone()
    }

    /// The item's text parsed.
    pub fn item_json(&self) -> Value {
        serde_json::from_str(&self.item().expect("an item")).unwrap()
    }

    pub fn set_item(&self, item: Option<String>) {
        self.state().item = item;
    }

    /// The config's `oauthAccount.<key>`.
    pub fn account_field(&self, key: &str) -> Value {
        self.state().config["oauthAccount"][key].clone()
    }

    pub fn sign_in(&self, id: &TerminalIdentity, n: u64, email: &str) {
        {
            let mut state = self.state();
            state.item = Some(
                serde_json::to_string(&json!({
                    "claudeAiOauth": oauth(n),
                    "mcpOAuth": { "server": { "token": "mcp" } },
                }))
                .unwrap(),
            );
            state
                .config
                .insert("oauthAccount".into(), Value::Object(person(id, email)));
        }
        self.owners.lock().unwrap().insert(access(n), id.clone());
    }

    /// The same ports with another lock.
    pub fn ports_with_lock(&self, lock: TerminalLock) -> TerminalPorts {
        TerminalPorts {
            lock,
            ..self.ports.clone()
        }
    }

    pub fn save(&self, id: &TerminalIdentity, n: u64, email: &str, parked: bool) {
        self.vault
            .save(id, &oauth(n), &person(id, email), parked)
            .unwrap();
    }

    /// The `oauth` saved for `id`, if any.
    pub fn saved_oauth(&self, id: &TerminalIdentity) -> Option<JsonObject> {
        self.vault
            .load(std::slice::from_ref(id))
            .unwrap()
            .map(|s| s.oauth)
    }

    pub fn saved_parked(&self, id: &TerminalIdentity) -> Option<bool> {
        self.vault
            .load(std::slice::from_ref(id))
            .unwrap()
            .map(|s| s.parked)
    }
}

/// Writes an executable (0755) script.
pub fn write_script(file: &Path, body: &str) {
    std::fs::write(file, body).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}
