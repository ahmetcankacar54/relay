//! Port of tests/desktop-terminal.test.ts.

#[path = "common/desktop.rs"]
mod helpers;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use helpers::{Fixture, Sealing};
use relay_core::desktop_files::JsonObject;
use relay_core::shared::terminal_identity::{
    TerminalIdentity, TerminalMode, TerminalReason, TerminalResult,
};
use relay_core::shared::types::{Account, AccountDesktop};
use relay_core::terminal_identity::{
    TerminalConfig, TerminalError, TerminalKeychain, TerminalPorts, TerminalVault,
};
use relay_core::vault_crypto::Sealer;
use serde_json::{Value, json};

fn oauth(n: u32) -> Value {
    json!({ "accessToken": format!("access-{n}"), "refreshToken": format!("refresh-{n}") })
}

#[derive(Default)]
struct Terminal {
    item: Option<String>,
    config: JsonObject,
    fail_read: bool,
}

struct Keychain(Arc<Mutex<Terminal>>);

impl TerminalKeychain for Keychain {
    fn read(&self) -> Result<Option<String>, TerminalError> {
        let terminal = self.0.lock().unwrap();
        if terminal.fail_read {
            // "Keychain on fire": a failure that is not one of the step's own.
            return Err(TerminalError(TerminalReason::Unreadable));
        }
        Ok(terminal.item.clone())
    }
    fn write(&self, text: &str) -> Result<(), TerminalError> {
        self.0.lock().unwrap().item = Some(text.to_string());
        Ok(())
    }
    fn remove(&self) -> Result<(), TerminalError> {
        self.0.lock().unwrap().item = None;
        Ok(())
    }
}

struct Config(Arc<Mutex<Terminal>>);

impl TerminalConfig for Config {
    fn read(&self) -> Result<Option<JsonObject>, TerminalError> {
        Ok(Some(self.0.lock().unwrap().config.clone()))
    }
    fn write_account(&self, account: Option<&JsonObject>) -> Result<(), TerminalError> {
        let mut terminal = self.0.lock().unwrap();
        match account {
            Some(account) => {
                terminal
                    .config
                    .insert("oauthAccount".into(), Value::Object(account.clone()));
            }
            None => {
                terminal.config.shift_remove("oauthAccount");
            }
        }
        Ok(())
    }
}

struct World {
    f: Fixture,
    vault: TerminalVault,
    terminal: Arc<Mutex<Terminal>>,
    owners: Arc<Mutex<HashMap<String, TerminalIdentity>>>,
}

fn sealer() -> Arc<Sealer> {
    Arc::new(Sealer::new(&[5u8; 32]).unwrap())
}

fn fixture() -> World {
    let sealer = sealer();
    let f = Fixture::with(Sealing::Real(Arc::clone(&sealer)));
    let terminal = Arc::new(Mutex::new(Terminal::default()));
    let owners: Arc<Mutex<HashMap<String, TerminalIdentity>>> = Arc::default();
    let lookup = Arc::clone(&owners);
    let ports = TerminalPorts {
        keychain: Arc::new(Keychain(Arc::clone(&terminal))),
        config: Arc::new(Config(Arc::clone(&terminal))),
        lock: Arc::new(|action: &mut dyn FnMut()| {
            action();
            Ok(())
        }),
        owner: Some(Arc::new(move |token: &str| {
            lookup.lock().unwrap().get(token).cloned()
        })),
    };
    f.manager.configure(|h| h.terminal = Some(ports));
    let (seal, unseal) = (Arc::clone(&sealer), Arc::clone(&sealer));
    let vault = TerminalVault::new(
        f.vault(),
        Arc::new(move |x: &str| Ok(seal.seal(x))),
        Arc::new(move |d: &[u8]| unseal.unseal(d).map_err(|e| e.to_string())),
    );
    World {
        f,
        vault,
        terminal,
        owners,
    }
}

fn identity(desktop: &AccountDesktop) -> TerminalIdentity {
    TerminalIdentity {
        account_uuid: desktop.account_uuid.to_lowercase(),
        org_id: desktop.org_id.to_lowercase(),
    }
}

impl World {
    fn account(&self, name: &str) -> Account {
        self.f.account(name, None)
    }

    fn sign_in(&self, desktop: &AccountDesktop, n: u32) {
        let mut terminal = self.terminal.lock().unwrap();
        terminal.item = Some(json!({ "claudeAiOauth": oauth(n) }).to_string());
        self.owners
            .lock()
            .unwrap()
            .insert(format!("access-{n}"), identity(desktop));
        terminal.config.insert(
            "oauthAccount".into(),
            json!({ "accountUuid": desktop.account_uuid, "organizationUuid": desktop.org_id }),
        );
    }

    fn item_oauth(&self) -> Value {
        let item = self.terminal.lock().unwrap().item.clone().unwrap();
        serde_json::from_str::<Value>(&item).unwrap()["claudeAiOauth"].clone()
    }
}

#[test]
fn a_switch_brings_the_terminals_claude_code_to_the_account_after_linking_it_with_a_check() {
    let w = fixture();
    let a = w.account("A");
    let b = w.account("B"); // Claude is on B
    let (da, db) = (a.desktop.clone().unwrap(), b.desktop.clone().unwrap());
    w.sign_in(&da, 1);
    let status = w.f.manager.check_terminal().unwrap();
    assert_eq!(status.current.unwrap().known, Some(true));
    assert_eq!(status.saved.len(), 1);
    w.sign_in(&db, 2);
    w.f.manager.switch_to(&a.id, Default::default()).unwrap();
    assert_eq!(w.item_oauth(), oauth(1));
    assert_eq!(
        w.terminal.lock().unwrap().config["oauthAccount"]["accountUuid"],
        json!(da.account_uuid)
    );
    assert_eq!(
        Value::Object(w.vault.load(&[identity(&db)]).unwrap().unwrap().oauth),
        oauth(2)
    );
    assert_eq!(
        w.f.manager.terminal_status().unwrap().last.unwrap().result,
        TerminalResult::Switched
    );
    let sync = w.f.manager.sync_terminal().unwrap();
    assert_eq!(sync.reason, Some(TerminalReason::AlreadyThere));
}

#[test]
fn mode_off_leaves_the_terminal_alone_at_a_switch() {
    let w = fixture();
    let a = w.account("A");
    let b = w.account("B");
    let (da, db) = (a.desktop.clone().unwrap(), b.desktop.clone().unwrap());
    w.f.store
        .update(|s| s.settings.terminal_cli = Some(TerminalMode::Off))
        .unwrap();
    w.vault
        .save(
            &identity(&da),
            oauth(1).as_object().unwrap(),
            json!({ "accountUuid": da.account_uuid, "organizationUuid": da.org_id })
                .as_object()
                .unwrap(),
            true,
        )
        .unwrap();
    w.sign_in(&db, 2);
    w.f.manager.switch_to(&a.id, Default::default()).unwrap();
    assert_eq!(w.item_oauth(), oauth(2));
    assert_eq!(
        w.f.manager.terminal_status().unwrap().last.unwrap().reason,
        Some(TerminalReason::Off)
    );
}

#[test]
fn a_terminal_step_that_fails_never_fails_the_switch() {
    let w = fixture();
    let a = w.account("A");
    w.account("B");
    w.terminal.lock().unwrap().fail_read = true;
    w.f.manager.switch_to(&a.id, Default::default()).unwrap();
    assert_eq!(
        w.f.manager.snapshot().unwrap().active_profile_id.as_deref(),
        Some(a.id.as_str())
    );
    assert_eq!(
        w.f.manager.terminal_status().unwrap().last.unwrap().result,
        TerminalResult::Failed
    );
}
