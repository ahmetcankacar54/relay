//! Port of `tests/desktop-extension.test.ts`: the extension step as `DesktopManager` runs it.

#[path = "common/browser.rs"]
mod browser;

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use browser::{Shared, World, extension_world, login_for, sign_in_for};
use relay_core::cookie_vault::CookieVault;
use relay_core::desktop::{
    AnswerGuard, DesktopHost, DesktopManager, DesktopResult, DesktopSwitchOptions, ExtensionPorts,
    LaunchOptions,
};
use relay_core::desktop_files::{json_bytes, write_bytes};
use relay_core::draft_vault::{Seal, Unseal};
use relay_core::extension_vault::ExtensionVault;
use relay_core::shared::browser_extension::{
    BrowserApp, ExtensionCurrent, ExtensionMode, ExtensionOffer, ExtensionReason, ExtensionResult,
    ExtensionSetting, ExtensionTarget,
};
use relay_core::shared::extension_auth::SignIn;
use relay_core::shared::types::{Account, AccountKind, CreateAccount};
use relay_core::store::{Store, StoreOptions};
use relay_core::vault_crypto::Sealer;
use serde_json::{Map, Value, json};

/// The TS fixture's host: Claude only flips a flag, and its quit and launch go to the world's
/// log, so the order of what happens can be told.
struct Host {
    running: Mutex<bool>,
    sealer: Arc<Sealer>,
    log: Shared,
    scratch: PathBuf,
}

impl DesktopHost for Host {
    fn available(&self) -> bool {
        true
    }
    fn running(&self) -> DesktopResult<bool> {
        Ok(*self.running.lock().unwrap())
    }
    fn quit(&self, _answer_guard: Option<&AnswerGuard>) -> DesktopResult<()> {
        self.log.lock().events.push("claude-quit".into());
        *self.running.lock().unwrap() = false;
        Ok(())
    }
    fn launch(&self, _options: Option<LaunchOptions>) -> DesktopResult<()> {
        self.log.lock().events.push("claude-launch".into());
        *self.running.lock().unwrap() = true;
        Ok(())
    }
    fn seal(&self, data: &str) -> DesktopResult<Vec<u8>> {
        Ok(self.sealer.seal(data))
    }
    fn unseal(&self, data: &[u8]) -> DesktopResult<String> {
        self.sealer
            .unseal(data)
            .map_err(|e| relay_core::desktop::DesktopError::new(e.to_string()))
    }
    fn draft_scratch_dir(&self) -> Option<PathBuf> {
        Some(self.scratch.clone())
    }
}

/// Claude folder, Relay store, a fake Claude host and a fake browser world.
struct F {
    _temp: tempfile::TempDir,
    root: PathBuf,
    store: Arc<Store>,
    manager: Arc<DesktopManager>,
    host: Arc<Host>,
    world: World,
    dir: PathBuf,
    profile: PathBuf,
    vault: ExtensionVault,
    cookie_vault: CookieVault,
}

fn fixture(default_setting: bool) -> F {
    let temp = tempfile::Builder::new()
        .prefix("relay-desktop-ext-")
        .tempdir()
        .unwrap();
    let base = relay_core::fs_util::real_path(temp.path()).unwrap();
    let root = base.join("Claude");
    fs::create_dir(&root).unwrap();
    let store = Arc::new(Store::open(base.join("Relay"), StoreOptions::default()).unwrap());
    let sealer = Arc::new(Sealer::new(&[3u8; 32]).unwrap());
    let world = extension_world(&base);
    let dir = world.install(BrowserApp::Brave);
    let host = Arc::new(Host {
        running: Mutex::new(false),
        sealer: sealer.clone(),
        log: world.state.clone(),
        scratch: base.join("tmp"),
    });
    let manager = DesktopManager::new(
        &root,
        Arc::clone(&store),
        Arc::clone(&host) as Arc<dyn DesktopHost>,
        Some(base.join(".claude")),
        None,
    );
    let (system, storage, cookies) = (
        world.system.clone(),
        world.storage.clone(),
        world.cookies.clone(),
    );
    manager.configure(move |h| {
        h.extension = Some(ExtensionPorts {
            system,
            storage,
            cookies: Some(cookies),
        });
    });
    // Writing to a browser is opt-in; these tests are about the modes that do.
    if !default_setting {
        set_mode(&store, ExtensionMode::Restart, None);
    }
    manager.initialize().unwrap();
    let s = sealer.clone();
    let seal: Seal = Arc::new(move |text: &str| Ok(s.seal(text)));
    let unseal: Unseal =
        Arc::new(move |data: &[u8]| sealer.unseal(data).map_err(|e| e.to_string()));
    let vault_dir = store.root().join("desktop-vault");
    let profile = dir.parent().unwrap().parent().unwrap().to_path_buf();
    F {
        vault: ExtensionVault::new(&vault_dir, seal.clone(), unseal.clone(), None),
        cookie_vault: CookieVault::new(&vault_dir, seal, unseal, None),
        _temp: temp,
        root,
        store,
        manager,
        host,
        world,
        dir,
        profile,
    }
}

fn set_mode(store: &Store, mode: ExtensionMode, browser: Option<ExtensionTarget>) {
    store
        .update(|s| s.settings.claude_extension = Some(ExtensionSetting { mode, browser }))
        .unwrap();
}

impl F {
    /// An account whose Claude app sign-in is saved; Claude is left on it.
    fn account(&self, name: &str) -> Account {
        let a = self
            .store
            .create(&CreateAccount {
                name: name.into(),
                kind: AccountKind::Personal,
                group: None,
                provider: None,
            })
            .unwrap();
        let account_uuid = uuid::Uuid::new_v4().to_string();
        let org_id = uuid::Uuid::new_v4().to_string();
        write_bytes(
            &self.root,
            "config.json",
            Some(&json_bytes(&json!({ "oauth:tokenCacheV2": format!("encrypted:{name}"), "lastKnownAccountUuid": account_uuid }))),
        )
        .unwrap();
        fs::create_dir_all(
            self.root
                .join("claude-code-sessions")
                .join(&account_uuid)
                .join(&org_id),
        )
        .unwrap();
        self.manager.capture(&a.id, &org_id).unwrap();
        self.world.state.lock().events.clear();
        self.store.account(&a.id).unwrap()
    }
    fn set_running(&self, value: bool) {
        *self.host.running.lock().unwrap() = value;
    }
    fn browser_running(&self, value: bool) {
        self.world.state.lock().running = value;
    }
    fn events(&self) -> Vec<String> {
        self.world.events()
    }
    fn stored(&self) -> Option<SignIn> {
        self.world.stored(&self.dir)
    }
    fn store_sign_in(&self, sign_in: SignIn) {
        self.world.set_stored(&self.dir, Some(sign_in));
    }
    fn web(&self) -> Option<relay_core::cookie_store::CookieSnapshot> {
        self.world.web(&self.profile)
    }
    fn set_web(&self, login: relay_core::cookie_store::CookieSnapshot) {
        self.world.set_web(&self.profile, login);
    }
    fn pair(&self, account_uuid: &str, n: i64) {
        self.vault
            .save(account_uuid, &sign_in_for(account_uuid, n))
            .unwrap();
        self.cookie_vault
            .save(account_uuid, &login_for(account_uuid, n))
            .unwrap();
    }
    fn switch(&self, account: &Account) {
        self.manager
            .switch_to(&account.id, DesktopSwitchOptions::default())
            .unwrap();
    }
    fn outcome_result(&self) -> Option<ExtensionResult> {
        self.manager.extension_outcome().map(|o| o.result)
    }
    fn outcome_reason(&self) -> Option<ExtensionReason> {
        self.manager.extension_outcome().and_then(|o| o.reason)
    }
    fn active(&self) -> Option<String> {
        self.manager.snapshot().unwrap().active_profile_id
    }
    /// The extension's sign-in with the record of a failed one added.
    fn failing(&self, sign_in: SignIn) -> SignIn {
        let mut sign_in = sign_in;
        sign_in.insert("lastAuthFailureReason", "\"session_expired\"".to_owned());
        sign_in
    }
    /// After every browser launch the extension records a failed sign-in.
    fn fail_after_launch(&self) {
        let (state, dir) = (self.world.state.clone(), self.dir.clone());
        self.world.state.lock().after_launch = Some(Arc::new(move || {
            let mut state = state.lock();
            if let Some(sign_in) = state.stored.get_mut(&dir) {
                sign_in.insert("lastAuthFailureReason", "\"session_expired\"".to_owned());
            }
        }));
    }
    fn broken_log(&self) -> Arc<Mutex<Vec<String>>> {
        let broken: Arc<Mutex<Vec<String>>> = Arc::default();
        let sink = broken.clone();
        self.manager.configure(move |h| {
            h.on_extension_broken = Some(Arc::new(move |account: &Account| {
                sink.lock().unwrap().push(account.name.clone())
            }));
        });
        broken
    }
}

fn uuid_of(a: &Account) -> String {
    a.desktop.as_ref().unwrap().account_uuid.clone()
}

#[test]
fn a_restarting_switch_puts_the_targets_extension_sign_in_in_place_before_claude_opens_quitting_and_reopening_a_running_browser()
 {
    let f = fixture(false);
    let a = f.account("A");
    let b = f.account("B"); // Claude is on B
    let (ua, ub) = (uuid_of(&a), uuid_of(&b));
    f.set_running(true);
    f.browser_running(true);
    f.pair(&ua, 1);
    f.store_sign_in(sign_in_for(&ub, 2));
    f.set_web(login_for(&ub, 2));
    f.switch(&a);
    assert_eq!(
        f.events(),
        ["claude-quit", "quit:brave", "launch:brave", "claude-launch"]
    );
    assert_eq!(f.stored(), Some(sign_in_for(&ua, 1)));
    assert_eq!(f.web(), Some(login_for(&ua, 1)));
    assert_eq!(
        f.cookie_vault.load(std::slice::from_ref(&ub)).unwrap(),
        Some(login_for(&ub, 2))
    );
    assert_eq!(
        f.vault.load(std::slice::from_ref(&ub)).unwrap(),
        Some(sign_in_for(&ub, 2))
    );
    assert_eq!(f.outcome_result(), Some(ExtensionResult::Switched));
    assert!(f.world.opened().iter().all(|(_, running)| !running));
}

#[test]
fn a_switch_that_keeps_claude_closed_never_quits_the_browser() {
    let f = fixture(false);
    let a = f.account("A");
    let b = f.account("B");
    let (ua, ub) = (uuid_of(&a), uuid_of(&b));
    f.set_running(false);
    f.browser_running(true);
    f.store_sign_in(sign_in_for(&ub, 2));
    f.pair(&ua, 1);
    f.set_web(login_for(&ub, 2));
    let closed = |expected: &Account| DesktopSwitchOptions {
        closed_only: true,
        expected_active_profile_id: Some(expected.id.clone()),
        ..DesktopSwitchOptions::default()
    };
    f.manager.switch_to(&a.id, closed(&b)).unwrap();
    assert!(f.events().is_empty());
    assert_eq!(f.outcome_result(), Some(ExtensionResult::Skipped));
    assert_eq!(f.outcome_reason(), Some(ExtensionReason::BrowserRunning));
    assert_eq!(f.active(), Some(a.id.clone()));
    // The browser is closed: the same kind of switch swaps.
    f.browser_running(false);
    f.store_sign_in(sign_in_for(&ua, 3));
    f.set_web(login_for(&ua, 3));
    f.pair(&ub, 4);
    f.manager.switch_to(&b.id, closed(&a)).unwrap();
    assert_eq!(f.outcome_result(), Some(ExtensionResult::Switched));
    assert_eq!(f.stored(), Some(sign_in_for(&ub, 4)));
    assert_eq!(f.web(), Some(login_for(&ub, 4)));
}

#[test]
fn an_extension_step_that_fails_never_fails_the_switch() {
    let f = fixture(false);
    let a = f.account("A");
    f.account("B");
    f.world.state.lock().fail_read = Some("disk on fire".into());
    f.switch(&a);
    assert_eq!(f.active(), Some(a.id.clone()));
    assert_eq!(f.outcome_result(), Some(ExtensionResult::Failed));
    assert_eq!(f.manager.snapshot().unwrap().error, None);
    // Without the extension port it does not either.
    f.manager.configure(|h| h.extension = None);
    let c = f.account("C");
    f.switch(&c);
}

#[test]
fn mode_off_leaves_the_extension_and_the_browser_alone_no_extension_port_does_too() {
    let f = fixture(false);
    let a = f.account("A");
    f.account("B");
    f.browser_running(true);
    set_mode(&f.store, ExtensionMode::Off, None);
    f.switch(&a);
    assert_eq!(f.outcome_reason(), Some(ExtensionReason::Off));
    assert!(!f.events().iter().any(|e| e.contains("brave")));
    assert!(f.world.opened().is_empty());
}

#[test]
fn a_switch_that_does_not_change_the_claude_account_does_not_run_the_extension_step() {
    let f = fixture(false);
    let a = f.account("A");
    f.switch(&a);
    f.world.state.lock().opened.clear();
    let before = f.manager.extension_outcome();
    f.switch(&a);
    assert!(f.world.opened().is_empty());
    assert_eq!(f.manager.extension_outcome(), before);
}

#[test]
fn sync_now_runs_the_step_for_the_active_account_and_quits_a_running_browser_the_status_lists_what_is_saved()
 {
    let f = fixture(false);
    let a = f.account("A");
    let b = f.account("B"); // active
    let (ua, ub) = (uuid_of(&a), uuid_of(&b));
    f.browser_running(true);
    f.store_sign_in(sign_in_for(&ua, 2));
    f.set_web(login_for(&ua, 2));
    f.pair(&ub, 7);
    assert_eq!(
        f.manager.extension_quits_browser().as_deref(),
        Some("Brave")
    );
    let outcome = f.manager.sync_extension().unwrap();
    assert_eq!(outcome.result, ExtensionResult::Switched);
    assert_eq!(f.stored(), Some(sign_in_for(&ub, 7)));
    assert_eq!(f.events(), ["quit:brave", "launch:brave"]);
    let status = f.manager.extension_status().unwrap();
    assert_eq!(status.setting.mode, ExtensionMode::Restart);
    assert_eq!(
        status.target.as_ref().map(|t| t.app),
        Some(BrowserApp::Brave)
    );
    assert_eq!(status.restores_tabs, Some(false));
    let sorted = |mut list: Vec<String>| {
        list.sort();
        list
    };
    let both = sorted(vec![ua.clone(), ub.clone()]);
    assert_eq!(
        sorted(
            status
                .saved
                .iter()
                .map(|s| s.account_uuid.clone())
                .collect()
        ),
        both
    );
    assert_eq!(
        sorted(
            status
                .cookies_saved
                .unwrap()
                .iter()
                .map(|s| s.account_uuid.clone())
                .collect()
        ),
        both
    );
    assert_eq!(
        status.last.map(|l| l.result),
        Some(ExtensionResult::Switched)
    );
    // Claude was not touched.
    assert!(!f.events().contains(&"claude-quit".to_owned()));
    // Mode "closed" and a running browser: nothing is quit, and nothing is announced.
    set_mode(&f.store, ExtensionMode::Closed, None);
    assert_eq!(f.manager.extension_quits_browser(), None);
}

#[test]
fn a_build_without_the_leveldb_library_never_announces_or_quits_a_browser() {
    let f = fixture(false);
    let a = f.account("A");
    f.account("B");
    {
        let mut state = f.world.state.lock();
        state.available = false;
        state.running = true;
    }
    assert_eq!(f.manager.extension_quits_browser(), None);
    f.switch(&a);
    assert_eq!(f.outcome_reason(), Some(ExtensionReason::Unavailable));
    assert!(!f.events().iter().any(|e| e.contains("brave")));
}

#[test]
fn sync_now_needs_claude_on_a_saved_account_and_is_not_available_without_the_extension_port() {
    let f = fixture(false);
    let error = f.manager.sync_extension().unwrap_err();
    assert!(error.to_string().contains("saved account first"), "{error}");
    f.account("A");
    f.manager.configure(|h| h.extension = None);
    let error = f.manager.sync_extension().unwrap_err();
    assert!(error.to_string().contains("not supported here"), "{error}");
    assert_eq!(f.manager.extension_status(), None);
}

#[test]
fn without_a_saved_choice_relay_only_guides_nothing_is_written_and_no_browser_is_quit() {
    let f = fixture(true);
    let a = f.account("A");
    let b = f.account("B");
    let (ua, ub) = (uuid_of(&a), uuid_of(&b));
    f.set_running(true);
    f.browser_running(true);
    f.store_sign_in(sign_in_for(&ub, 2));
    f.set_web(login_for(&ub, 2));
    f.pair(&ua, 1);
    assert_eq!(f.manager.extension_quits_browser(), None);
    f.switch(&a);
    assert_eq!(f.events(), ["claude-quit", "claude-launch"]);
    assert_eq!(f.outcome_reason(), Some(ExtensionReason::GuideMismatch));
    assert_eq!(f.stored(), Some(sign_in_for(&ub, 2)));
    assert_eq!(f.web(), Some(login_for(&ub, 2)));
    assert_eq!(
        f.manager.extension_status().unwrap().setting.mode,
        ExtensionMode::Guide
    );
}

#[test]
fn in_mode_guide_the_panel_is_offered_the_extension_and_sync_now_brings_it_along_quitting_and_reopening_the_browser()
 {
    let f = fixture(true);
    let a = f.account("A");
    let b = f.account("B");
    let (ua, ub) = (uuid_of(&a), uuid_of(&b));
    f.browser_running(true);
    f.store_sign_in(sign_in_for(&ub, 2));
    f.set_web(login_for(&ub, 2));
    f.pair(&ua, 1);
    // Before Relay has seen anything, there is nothing to offer.
    assert_eq!(f.manager.extension_offer(), None);
    f.switch(&a);
    assert_eq!(f.outcome_reason(), Some(ExtensionReason::GuideMismatch));
    assert_eq!(
        f.manager.extension_offer(),
        Some(ExtensionOffer {
            account_id: a.id.clone(),
            to: "A".into(),
            on: Some("B".into()),
            signed_out: None,
            expired: None,
            reconnect: None,
            browser: "Brave".into(),
        })
    );
    f.world.state.lock().events.clear();
    let outcome = f.manager.sync_extension().unwrap();
    assert_eq!(outcome.result, ExtensionResult::Switched);
    assert_eq!(f.events(), ["quit:brave", "launch:brave"]);
    assert_eq!(f.stored(), Some(sign_in_for(&ua, 1)));
    assert_eq!(f.web(), Some(login_for(&ua, 1)));
    // The setting stays "guide", and the offer is gone.
    assert_eq!(
        f.manager.extension_status().unwrap().setting.mode,
        ExtensionMode::Guide
    );
    assert_eq!(f.manager.extension_offer(), None);
}

#[test]
fn no_extension_offer_without_the_accounts_saved_pair_in_mode_off_or_once_a_check_finds_it_on_the_account()
 {
    let f = fixture(true);
    let a = f.account("A");
    let b = f.account("B");
    let (ua, ub) = (uuid_of(&a), uuid_of(&b));
    f.store_sign_in(sign_in_for(&ub, 2));
    f.set_web(login_for(&ub, 2));
    // Only the extension's hints are saved for A: half a pair cannot be put in place.
    f.vault.save(&ua, &sign_in_for(&ua, 1)).unwrap();
    f.switch(&a);
    assert_eq!(f.outcome_reason(), Some(ExtensionReason::GuideMismatch));
    assert_eq!(f.manager.extension_offer(), None);
    f.cookie_vault.save(&ua, &login_for(&ua, 1)).unwrap();
    assert_eq!(
        f.manager.extension_offer().and_then(|o| o.on).as_deref(),
        Some("B")
    );
    set_mode(&f.store, ExtensionMode::Off, None);
    assert_eq!(f.manager.extension_offer(), None);
    // Sync now does not override "off".
    assert_eq!(
        f.manager.sync_extension().unwrap().reason,
        Some(ExtensionReason::Off)
    );
    set_mode(&f.store, ExtensionMode::Guide, None);
    // The user signs the extension in to A by hand and checks.
    f.store_sign_in(sign_in_for(&ua, 3));
    f.manager.check_extension(None).unwrap();
    assert_eq!(f.manager.extension_offer(), None);
}

#[test]
fn the_extension_check_logs_who_it_saw_how_many_instances_there_are_which_one_and_whether_it_was_opened()
 {
    let f = fixture(true);
    let a = f.account("A");
    let ua = uuid_of(&a);
    let logged: Arc<Mutex<Vec<Value>>> = Arc::default();
    let sink = logged.clone();
    f.manager.configure(move |h| {
        h.on_draft_event = Some(Arc::new(
            move |event: &str, fields: Option<&Map<String, Value>>| {
                if event == "extension-check" {
                    sink.lock()
                        .unwrap()
                        .push(Value::Object(fields.cloned().unwrap_or_default()));
                }
            },
        ));
    });
    let last = || logged.lock().unwrap().pop().unwrap();
    f.store_sign_in(sign_in_for(&ua, 1));
    f.manager.check_extension(None).unwrap();
    assert_eq!(
        last(),
        json!({ "state": "signed-in", "known": true, "other": false, "account": &ua[..8], "instances": 1, "target": "brave:Default", "opened": true })
    );
    // Another claude.ai account: `other`, and no account id.
    f.store_sign_in(sign_in_for(&uuid::Uuid::new_v4().to_string(), 1));
    f.manager.check_extension(None).unwrap();
    assert_eq!(
        last(),
        json!({ "state": "signed-in", "known": false, "other": true, "instances": 1, "target": "brave:Default", "opened": true })
    );
    // Only an unopened one, chosen: signed out, and it says so.
    f.world
        .install_with(BrowserApp::Chrome, "Default", "Kişi 1", false);
    set_mode(
        &f.store,
        ExtensionMode::Guide,
        Some(ExtensionTarget {
            app: BrowserApp::Chrome,
            profile: "Default".into(),
        }),
    );
    f.manager.check_extension(None).unwrap();
    assert_eq!(
        last(),
        json!({ "state": "signed-out", "instances": 2, "target": "chrome:Default", "opened": false })
    );
    let current = f.manager.extension_status().unwrap().current;
    assert!(
        matches!(
            current,
            Some(ExtensionCurrent::SignedOut {
                unopened: Some(true),
                ..
            })
        ),
        "{current:?}"
    );
    // An unopened extension has nothing to bring along: no offer.
    f.vault.save(&ua, &sign_in_for(&ua, 1)).unwrap();
    f.cookie_vault.save(&ua, &login_for(&ua, 1)).unwrap();
    assert_eq!(f.manager.extension_offer(), None);
    // None at all: "none".
    fs::remove_dir_all(f.world.support.join("BraveSoftware")).unwrap();
    fs::remove_dir_all(f.world.support.join("Google")).unwrap();
    f.manager.check_extension(None).unwrap();
    assert_eq!(last(), json!({ "state": "none", "instances": 0 }));
}

#[test]
fn an_extension_on_desktops_account_whose_sign_in_expired_is_offered_a_fix_and_syncing_removes_the_record()
 {
    let f = fixture(true);
    let a = f.account("A");
    f.switch(&a);
    let ua = uuid_of(&a);
    f.store_sign_in(f.failing(sign_in_for(&ua, 2)));
    f.set_web(login_for(&ua, 2));
    f.cookie_vault.save(&ua, &login_for(&ua, 2)).unwrap();
    f.manager.check_extension(None).unwrap();
    assert_eq!(
        f.manager.extension_offer(),
        Some(ExtensionOffer {
            account_id: a.id.clone(),
            to: "A".into(),
            on: None,
            signed_out: None,
            expired: Some(true),
            reconnect: None,
            browser: "Brave".into(),
        })
    );
    let outcome = f.manager.sync_extension().unwrap();
    assert_eq!(
        (outcome.result, outcome.reason, outcome.cleared),
        (
            ExtensionResult::Unchanged,
            Some(ExtensionReason::AlreadyThere),
            Some(true)
        )
    );
    assert_eq!(f.stored(), Some(sign_in_for(&ua, 2)));
    assert_eq!(f.manager.extension_offer(), None);
    // Settings and the account page stop saying it expired without waiting for another check.
    match f.manager.extension_status().unwrap().current {
        Some(ExtensionCurrent::SignedIn {
            account_uuid,
            expired,
            ..
        }) => {
            assert_eq!(account_uuid, Some(ua.to_lowercase()));
            assert_eq!(expired, None);
        }
        other => panic!("{other:?}"),
    }
}

/// A, B saved; Claude on B; A's pair saved, the browser on B's pair; checks right away.
fn verify_fixture(offline: bool) -> (F, Account, String) {
    let f = fixture(false);
    let a = f.account("A");
    let b = f.account("B");
    let (ua, ub) = (uuid_of(&a), uuid_of(&b));
    f.manager.configure(move |h| {
        h.extension_verify_ms = 0;
        h.extension_offline = Arc::new(move || offline);
    });
    f.set_running(true);
    f.browser_running(true);
    f.pair(&ua, 1);
    f.store_sign_in(sign_in_for(&ub, 2));
    f.set_web(login_for(&ub, 2));
    (f, a, ua)
}

#[test]
fn after_a_switch_an_extension_that_cannot_sign_in_with_the_login_put_in_place_is_caught_the_login_is_forgotten_and_reconnecting_clears_it()
 {
    let (f, a, ua) = verify_fixture(false);
    let broken = f.broken_log();
    // The login Relay kept for A is not A's: the extension's silent sign-in fails at start.
    f.fail_after_launch();
    f.switch(&a);
    assert_eq!(f.outcome_result(), Some(ExtensionResult::Switched));
    f.manager.wait_extension_verified();
    assert_eq!(*broken.lock().unwrap(), ["A"]);
    assert_eq!(
        f.cookie_vault.load(std::slice::from_ref(&ua)).unwrap(),
        None,
        "the login that failed is forgotten"
    );
    assert_eq!(
        f.vault.load(std::slice::from_ref(&ua)).unwrap(),
        Some(sign_in_for(&ua, 1)),
        "A's hints stay"
    );
    let status = f.manager.extension_status().unwrap();
    assert_eq!(
        status.broken.map(|b| b.account_uuid),
        Some(ua.to_lowercase())
    );
    assert_eq!(
        f.manager.extension_offer(),
        Some(ExtensionOffer {
            account_id: a.id.clone(),
            to: "A".into(),
            on: None,
            signed_out: None,
            expired: Some(true),
            reconnect: Some(true),
            browser: "Brave".into(),
        })
    );
    // The user signs in to claude.ai with A and to the extension: a check sees it and keeps both.
    f.world.state.lock().after_launch = None;
    f.store_sign_in(sign_in_for(&ua, 3));
    f.set_web(login_for(&ua, 3));
    let after = f.manager.check_extension(None).unwrap().unwrap();
    assert_eq!(after.broken, None);
    assert!(matches!(
        after.current,
        Some(ExtensionCurrent::SignedIn { expired: None, .. })
    ));
    assert_eq!(
        f.cookie_vault.load(std::slice::from_ref(&ua)).unwrap(),
        Some(login_for(&ua, 3))
    );
    assert_eq!(f.manager.extension_offer(), None);
}

#[test]
fn a_switch_whose_extension_signs_in_fine_forgets_nothing() {
    let (f, a, ua) = verify_fixture(false);
    let broken = f.broken_log();
    f.switch(&a);
    f.manager.wait_extension_verified();
    assert!(broken.lock().unwrap().is_empty(), "nothing is broken");
    assert_eq!(
        f.cookie_vault.load(std::slice::from_ref(&ua)).unwrap(),
        Some(login_for(&ua, 1))
    );
    assert_eq!(f.manager.extension_status().unwrap().broken, None);
}

#[test]
fn a_failed_sign_in_while_anthropic_cannot_be_reached_forgets_nothing() {
    let (f, a, ua) = verify_fixture(true);
    let broken = f.broken_log();
    f.fail_after_launch();
    f.switch(&a);
    f.manager.wait_extension_verified();
    assert!(broken.lock().unwrap().is_empty(), "offline proves nothing");
    assert_eq!(
        f.cookie_vault.load(std::slice::from_ref(&ua)).unwrap(),
        Some(login_for(&ua, 1))
    );
}

#[test]
fn open_claude_ai_opens_it_in_the_managed_browser() {
    let f = fixture(false);
    f.manager.open_claude_web().unwrap();
    assert_eq!(f.events(), ["open:brave:Default:https://claude.ai/"]);
}

fn until(ok: impl Fn() -> bool) {
    let end = Instant::now() + Duration::from_secs(5);
    while !ok() && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn a_login_claude_ai_refuses_minutes_after_the_switch_is_caught_by_a_later_look() {
    let (f, a, ua) = verify_fixture(false);
    f.manager.configure(|h| h.extension_recheck_ms = vec![40]);
    let broken = f.broken_log();
    f.switch(&a);
    f.manager.wait_extension_verified();
    assert!(broken.lock().unwrap().is_empty(), "fine at the first look");
    // claude.ai refuses the login later: the extension records it.
    let failing = f.failing(f.stored().unwrap());
    f.store_sign_in(failing);
    until(|| !broken.lock().unwrap().is_empty());
    assert_eq!(*broken.lock().unwrap(), ["A"]);
    assert_eq!(
        f.cookie_vault.load(std::slice::from_ref(&ua)).unwrap(),
        None
    );
    assert_eq!(
        f.manager
            .extension_status()
            .unwrap()
            .broken
            .map(|b| b.account_uuid),
        Some(ua.to_lowercase())
    );
}

#[test]
fn the_background_look_tells_a_sign_in_that_dropped_long_after_a_switch_once_while_it_waits() {
    let f = fixture(false);
    let a = f.account("A");
    let ua = uuid_of(&a);
    f.manager
        .configure(|h| h.extension_offline = Arc::new(|| false));
    let broken = f.broken_log();
    f.browser_running(true);
    f.cookie_vault.save(&ua, &login_for(&ua, 1)).unwrap();
    f.store_sign_in(sign_in_for(&ua, 1));
    f.set_web(login_for(&ua, 1));
    f.manager.extension_health();
    assert!(broken.lock().unwrap().is_empty(), "working: nothing to say");
    f.store_sign_in(f.failing(sign_in_for(&ua, 1)));
    f.manager.extension_health();
    f.manager.extension_health();
    assert_eq!(*broken.lock().unwrap(), ["A"]);
    assert_eq!(
        f.cookie_vault.load(std::slice::from_ref(&ua)).unwrap(),
        None
    );
    // Signed in again: it waits no more, and a later drop is told again.
    f.store_sign_in(sign_in_for(&ua, 2));
    f.set_web(login_for(&ua, 2));
    f.manager.extension_health();
    assert_eq!(f.manager.extension_status().unwrap().broken, None);
    f.store_sign_in(f.failing(sign_in_for(&ua, 2)));
    f.manager.extension_health();
    assert_eq!(*broken.lock().unwrap(), ["A", "A"]);
}
