//! Port of tests/antigravity-switch.test.ts. The fakes act out the Keychain item, the app's
//! settings, its processes and the waits; a wait takes a millisecond here (an event-loop turn
//! in the TS), so a cancel lands before the background wait for a sign-in times out.

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock, mpsc};
use std::time::{Duration, Instant};

use base64::Engine;
use indexmap::IndexMap;
use relay_core::antigravity_switch::{
    AntigravityCurrent, AntigravityProcesses, AntigravitySaved, AntigravityStore,
    AntigravitySwitchPorts, AntigravitySwitcher, AntigravityVault, SignIn, SignInEntry,
    antigravity_processes, parse_sign_in, write_antigravity_settings,
};
use relay_core::shared::terminal_identity::TerminalReason;
use relay_core::shared::types::{
    Account, AccountAuth, AccountProvider, AntigravityAppResult, AntigravityBusy,
    AntigravityResultKind as Kind, AntigravityResultReason as Reason,
};
use relay_core::terminal_identity::{TerminalError, TerminalKeychain};
use serde_json::{Value, json};

const G1: &str = "11111111-1111-4111-8111-111111111111";
const G2: &str = "22222222-2222-4222-8222-222222222222";

fn accounts() -> Vec<Account> {
    [(G1, "One@Example.test"), (G2, "two@example.test")]
        .into_iter()
        .map(|(id, email)| {
            let mut account = Account::new(id, id);
            account.provider = Some(AccountProvider::Antigravity);
            account.auth = Some(AccountAuth {
                logged_in: true,
                email: Some(email.into()),
                checked_at: "2026-11-20T00:00:00Z".into(),
                ..AccountAuth::default()
            });
            account
        })
        .collect()
}

fn b64(text: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(text)
}

/// A sign-in as Antigravity 2.x stores it: go-keyring's prefix and base64 JSON.
fn sign_in_with(email: &str, refresh: &str, access: &str) -> String {
    let data = json!({
        "token": {
            "access_token": access, "token_type": "Bearer", "refresh_token": refresh,
            "expiry": "2026-11-20T01:00:00Z", "expires_in": 3599
        },
        "auth_method": "consumer",
        "id_token_email": email,
        "writer_id": "w",
    });
    format!("go-keyring-base64:{}", b64(&data.to_string()))
}

fn sign_in(email: &str) -> String {
    sign_in_with(email, &format!("r-{email}"), "a")
}

#[derive(Default)]
struct World {
    item: Option<String>,
    open: bool,
    agy: u32,
    settings: serde_json::Map<String, Value>,
    /// What the app writes into the Keychain as it quits (an old token written back).
    on_quit: Option<String>,
    /// The app ignores quit (a confirmation is open).
    stuck: bool,
    /// What the user signs in with on the app's sign-in screen, after this many polls.
    sign_in_after: Option<(u32, String)>,
    polls: u32,
    log: Vec<&'static str>,
}

type Shared = Arc<Mutex<World>>;
type ReadFn = Arc<dyn Fn() -> Result<Option<String>, TerminalError> + Send + Sync>;
type WriteFn = Arc<dyn Fn(&str) -> Result<(), TerminalError> + Send + Sync>;

/// The Keychain item, with each step replaceable.
struct FakeKeychain {
    read: ReadFn,
    write: WriteFn,
    remove: Arc<dyn Fn() -> Result<(), TerminalError> + Send + Sync>,
}

impl TerminalKeychain for FakeKeychain {
    fn read(&self) -> Result<Option<String>, TerminalError> {
        (self.read)()
    }
    fn write(&self, text: &str) -> Result<(), TerminalError> {
        (self.write)(text)
    }
    fn remove(&self) -> Result<(), TerminalError> {
        (self.remove)()
    }
}

fn keychain_read(world: &Shared) -> ReadFn {
    let world = world.clone();
    Arc::new(move || Ok(world.lock().unwrap().item.clone()))
}

fn keychain_write(world: &Shared) -> WriteFn {
    let world = world.clone();
    Arc::new(move |text: &str| {
        let mut w = world.lock().unwrap();
        w.log.push("write");
        w.item = Some(text.to_owned());
        Ok(())
    })
}

fn keychain(world: &Shared, read: ReadFn, write: WriteFn) -> Arc<FakeKeychain> {
    let remover = world.clone();
    Arc::new(FakeKeychain {
        read,
        write,
        remove: Arc::new(move || {
            let mut w = remover.lock().unwrap();
            w.log.push("remove");
            w.item = None;
            Ok(())
        }),
    })
}

struct Start {
    item: Option<String>,
    open: bool,
    agy: u32,
    settings: Value,
}

impl Default for Start {
    fn default() -> Self {
        Start {
            item: None,
            open: true,
            agy: 0,
            settings: json!({}),
        }
    }
}

fn fakes(start: Start) -> (Shared, AntigravitySwitchPorts) {
    let world: Shared = Arc::new(Mutex::new(World {
        item: start.item,
        open: start.open,
        agy: start.agy,
        settings: start.settings.as_object().unwrap().clone(),
        ..World::default()
    }));
    let w = |world: &Shared| world.clone();
    let (settings_r, settings_w, procs, quit, launch, sleep) = (
        w(&world),
        w(&world),
        w(&world),
        w(&world),
        w(&world),
        w(&world),
    );
    let ports = AntigravitySwitchPorts {
        keychain: keychain(&world, keychain_read(&world), keychain_write(&world)),
        read_settings: Arc::new(move || Ok(Some(settings_r.lock().unwrap().settings.clone()))),
        write_settings: Arc::new(move |values: &IndexMap<String, String>| {
            let mut w = settings_w.lock().unwrap();
            w.log.push("settings");
            for (k, v) in values {
                w.settings.insert(k.clone(), Value::String(v.clone()));
            }
            Ok(())
        }),
        processes: Arc::new(move || {
            let w = procs.lock().unwrap();
            Ok(AntigravityProcesses {
                app: w.open,
                agy: w.agy,
            })
        }),
        quit: Arc::new(move || {
            let mut w = quit.lock().unwrap();
            w.log.push("quit");
            if w.stuck {
                return;
            }
            if let Some(item) = w.on_quit.clone() {
                w.item = Some(item);
            }
            w.open = false;
        }),
        launch: Arc::new(move || {
            let mut w = launch.lock().unwrap();
            w.log.push("launch");
            w.open = true;
            Ok(())
        }),
        sleep: Arc::new(move |_ms| {
            std::thread::sleep(Duration::from_millis(1));
            let mut w = sleep.lock().unwrap();
            w.polls += 1;
            if let Some((polls, item)) = w.sign_in_after.clone()
                && w.polls >= polls
                && w.item.is_none()
            {
                w.item = Some(item);
            }
        }),
    };
    (world, ports)
}

fn vault_in(dir: &Path) -> Arc<AntigravityVault> {
    Arc::new(AntigravityVault::new(
        dir,
        Arc::new(|text: &str| Ok(text.as_bytes().to_vec())),
        Arc::new(|data: &[u8]| Ok(String::from_utf8_lossy(data).into_owned())),
        None,
    ))
}

fn switcher(
    ports: AntigravitySwitchPorts,
    vault: Arc<dyn AntigravityStore>,
) -> AntigravitySwitcher {
    AntigravitySwitcher::new(ports, vault, Arc::new(accounts), None, None)
}

fn entry(email: &str, raw: String) -> SignInEntry {
    SignInEntry {
        email: email.into(),
        raw,
        onboarding: None,
    }
}

/// Waits, up to five seconds, until the switcher's background wait is over.
fn idle(switcher: &AntigravitySwitcher) {
    let until = Instant::now() + Duration::from_secs(5);
    while switcher.state().busy.is_some() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn temp() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("agy-switch-")
        .tempdir()
        .unwrap()
}

fn item(world: &Shared) -> Option<String> {
    world.lock().unwrap().item.clone()
}

fn log(world: &Shared) -> Vec<&'static str> {
    world.lock().unwrap().log.clone()
}

fn account(id: &str) -> AntigravityCurrent {
    AntigravityCurrent {
        account_id: Some(id.into()),
        ..AntigravityCurrent::default()
    }
}

#[test]
fn a_sign_in_names_its_google_account_from_id_token_email_or_from_the_id_token_and_only_antigravitys_format_counts()
 {
    assert_eq!(
        parse_sign_in(Some(&sign_in("One@Example.test"))),
        SignIn {
            valid: true,
            email: Some("one@example.test".into())
        }
    );
    let claims = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(json!({ "email": "two@example.test" }).to_string());
    let jwt = format!("x.{claims}.y");
    let old = format!(
        "go-keyring-base64:{}",
        b64(&json!({ "token": { "refresh_token": "r" }, "id_token": jwt }).to_string())
    );
    assert_eq!(
        parse_sign_in(Some(&old)),
        SignIn {
            valid: true,
            email: Some("two@example.test".into())
        }
    );
    assert_eq!(parse_sign_in(Some(r#"{"token":{}}"#)), SignIn::default());
    assert_eq!(
        parse_sign_in(Some(&format!(
            "go-keyring-base64:{}",
            b64(r#"{"token":{}}"#)
        ))),
        SignIn::default()
    );
    assert_eq!(parse_sign_in(None), SignIn::default());
}

#[test]
fn the_apps_account_is_read_from_the_keychain_item_and_its_sign_in_is_kept_for_that_relay_account()
{
    let dir = temp();
    let (_world, ports) = fakes(Start {
        item: Some(sign_in("one@example.test")),
        settings: json!({
            "agy.onboarding.lastLoginUsername": "one@example.test",
            "agy.onboarding.lastLoginIsGcpTos": "false"
        }),
        ..Start::default()
    });
    let vault = vault_in(dir.path());
    let switcher = switcher(ports, vault.clone());
    assert_eq!(switcher.current(), account(G1));
    let saved = vault.load(G1).unwrap();
    assert_eq!(saved.raw, sign_in("one@example.test"));
    let onboarding: IndexMap<String, String> = [
        ("agy.onboarding.lastLoginUsername", "one@example.test"),
        ("agy.onboarding.lastLoginIsGcpTos", "false"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v.to_owned()))
    .collect();
    assert_eq!(saved.onboarding, Some(onboarding));
    assert_eq!(switcher.state().saved, vec![G1.to_owned()]);
}

#[test]
fn a_switch_closes_the_app_keeps_what_it_wrote_on_the_way_out_puts_the_other_sign_in_in_sets_its_terms_keys_and_opens_it_again()
 {
    let dir = temp();
    let (world, ports) = fakes(Start {
        item: Some(sign_in_with("one@example.test", "r1", "a1")),
        agy: 2,
        ..Start::default()
    });
    let vault = vault_in(dir.path());
    vault
        .save(
            G2,
            SignInEntry {
                onboarding: Some(
                    [(
                        "agy.onboarding.lastLoginUsername".to_owned(),
                        "two@example.test".to_owned(),
                    )]
                    .into_iter()
                    .collect(),
                ),
                ..entry("two@example.test", sign_in("two@example.test"))
            },
        )
        .unwrap();
    // The app refreshes its token while quitting and writes it back.
    world.lock().unwrap().on_quit = Some(sign_in_with("one@example.test", "r1", "a2"));
    let switcher = AntigravitySwitcher::new(
        ports,
        vault.clone(),
        Arc::new(accounts),
        Some(Arc::new(|| {})),
        Some(Arc::new(|| 1000.0)),
    );
    let result = switcher.switch_to(G2).unwrap();
    assert_eq!(
        result,
        AntigravityAppResult {
            kind: Kind::Switched,
            account_id: G2.into(),
            reason: None,
            agy_running: Some(2.0),
            at: 1000.0
        }
    );
    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        json!({ "kind": "switched", "accountId": G2, "agyRunning": 2, "at": 1000 })
    );
    assert_eq!(item(&world), Some(sign_in("two@example.test")));
    assert!(world.lock().unwrap().open);
    assert_eq!(
        world.lock().unwrap().settings["agy.onboarding.lastLoginUsername"],
        "two@example.test"
    );
    // The newest copy of the account it left, written during the quit, is the one kept.
    assert_eq!(
        vault.load(G1).unwrap().raw,
        sign_in_with("one@example.test", "r1", "a2")
    );
    assert_eq!(log(&world), vec!["quit", "write", "settings", "launch"]);
}

#[test]
fn a_switch_leaves_a_closed_app_closed_and_does_nothing_when_the_app_is_already_on_the_account() {
    let dir = temp();
    let (world, ports) = fakes(Start {
        item: Some(sign_in("one@example.test")),
        open: false,
        ..Start::default()
    });
    let vault = vault_in(dir.path());
    vault
        .save(G2, entry("two@example.test", sign_in("two@example.test")))
        .unwrap();
    let switcher = switcher(ports, vault);
    assert_eq!(switcher.switch_to(G2).unwrap().kind, Kind::Switched);
    assert!(!world.lock().unwrap().open);
    assert_eq!(log(&world), vec!["write"]);
    world.lock().unwrap().log.clear();
    assert_eq!(switcher.switch_to(G2).unwrap().kind, Kind::Switched);
    assert!(log(&world).is_empty());
}

#[test]
fn a_switch_stops_without_touching_the_keychain_when_the_app_will_not_close_or_the_account_has_no_saved_sign_in()
 {
    let dir = temp();
    let (world, ports) = fakes(Start {
        item: Some(sign_in("one@example.test")),
        ..Start::default()
    });
    world.lock().unwrap().stuck = true;
    let vault = vault_in(dir.path());
    let switcher = switcher(ports, vault.clone());
    assert_eq!(
        switcher.switch_to(G2).unwrap().reason,
        Some(Reason::NotSaved)
    );
    vault
        .save(G2, entry("two@example.test", sign_in("two@example.test")))
        .unwrap();
    let result = switcher.switch_to(G2).unwrap();
    assert_eq!(result.kind, Kind::Failed);
    assert_eq!(result.reason, Some(Reason::StillRunning));
    assert_eq!(item(&world), Some(sign_in("one@example.test")));
    assert!(!log(&world).contains(&"write"));
}

#[test]
fn a_sign_in_of_a_google_account_relay_does_not_have_is_kept_aside_before_a_switch_overwrites_it() {
    let dir = temp();
    let (_world, ports) = fakes(Start {
        item: Some(sign_in("stranger@example.test")),
        ..Start::default()
    });
    let vault = vault_in(dir.path());
    vault
        .save(G2, entry("two@example.test", sign_in("two@example.test")))
        .unwrap();
    let switcher = switcher(ports, vault);
    assert_eq!(
        switcher.current(),
        AntigravityCurrent {
            other: Some(true),
            ..AntigravityCurrent::default()
        }
    );
    assert_eq!(switcher.switch_to(G2).unwrap().kind, Kind::Switched);
    // Its own slot, named by its e-mail's hash.
    let folder = dir.path().join("antigravity-app");
    let slot = fs::read_dir(&folder)
        .unwrap()
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .find(|n| n.starts_with("other-"))
        .unwrap();
    let other: Value = serde_json::from_slice(&fs::read(folder.join(slot)).unwrap()).unwrap();
    assert_eq!(other["raw"], sign_in("stranger@example.test"));
}

#[test]
fn saving_another_accounts_sign_in_takes_the_current_one_off_this_mac_without_signing_out_waits_for_the_new_one_and_keeps_it()
 {
    let dir = temp();
    let (world, ports) = fakes(Start {
        item: Some(sign_in("one@example.test")),
        ..Start::default()
    });
    world.lock().unwrap().sign_in_after = Some((3, sign_in("two@example.test")));
    let vault = vault_in(dir.path());
    let changes = Arc::new(Mutex::new(0));
    let counter = changes.clone();
    let switcher = AntigravitySwitcher::new(
        ports,
        vault.clone(),
        Arc::new(accounts),
        Some(Arc::new(move || *counter.lock().unwrap() += 1)),
        None,
    );
    switcher.begin_sign_in(G2).unwrap();
    assert_eq!(log(&world)[..3], ["quit", "remove", "launch"]);
    // The wait runs on after the call returns.
    idle(&switcher);
    let state = switcher.state();
    assert_eq!(state.busy, None);
    assert_eq!(state.result.unwrap().kind, Kind::Saved);
    let mut saved = state.saved;
    saved.sort();
    assert_eq!(saved, vec![G1.to_owned(), G2.to_owned()]);
    assert_eq!(vault.load(G1).unwrap().raw, sign_in("one@example.test"));
    assert_eq!(vault.load(G2).unwrap().raw, sign_in("two@example.test"));
    assert!(*changes.lock().unwrap() > 0);
}

#[test]
fn cancelling_a_sign_in_puts_the_earlier_one_back_and_opens_the_app_on_it() {
    let dir = temp();
    let (world, ports) = fakes(Start {
        item: Some(sign_in("one@example.test")),
        ..Start::default()
    });
    let switcher = switcher(ports, vault_in(dir.path()));
    switcher.begin_sign_in(G2).unwrap();
    assert_eq!(item(&world), None);
    assert_eq!(switcher.state().busy, Some(AntigravityBusy::SigningIn));
    switcher.cancel_sign_in();
    idle(&switcher);
    assert_eq!(switcher.state().result.unwrap().kind, Kind::Cancelled);
    assert_eq!(item(&world), Some(sign_in("one@example.test")));
    assert!(world.lock().unwrap().open);
}

#[test]
fn one_antigravity_step_at_a_time() {
    let dir = temp();
    let (_world, ports) = fakes(Start {
        item: Some(sign_in("one@example.test")),
        ..Start::default()
    });
    let switcher = switcher(ports, vault_in(dir.path()));
    switcher.begin_sign_in(G2).unwrap();
    assert_eq!(switcher.switch_to(G1).unwrap_err(), Reason::Busy);
    switcher.cancel_sign_in();
    idle(&switcher);
}

#[test]
fn antigravitys_processes_are_told_apart_in_a_ps_listing_the_app_bundles_and_each_agy() {
    let ps = [
        "    1 /sbin/launchd",
        "  200 /Applications/Antigravity.app/Contents/MacOS/Antigravity",
        "  201 /Applications/Antigravity.app/Contents/Resources/bin/language_server",
        "  300 /Users/u/.local/bin/agy",
        "  301 agy",
        "  302 /Users/u/.gemini/antigravity/bin/agentapi",
        "  400 /usr/bin/agyx",
    ]
    .join("\n");
    let procs = |app, agy| AntigravityProcesses { app, agy };
    assert_eq!(antigravity_processes(&ps), procs(true, 2));
    assert_eq!(
        antigravity_processes(
            "    1 /sbin/launchd\n  201 /Applications/Antigravity.app/Contents/Resources/bin/language_server"
        ),
        procs(true, 0)
    );
    assert_eq!(
        antigravity_processes("    1 /sbin/launchd"),
        procs(false, 0)
    );
    // The app's helper started from its own folder keeps it counted as running; agy's own
    // helpers do not.
    assert_eq!(
        antigravity_processes(
            "  302 /Users/u/.gemini/antigravity/bin/agentapi\n  303 /Users/u/.gemini/antigravity-cli/bin/agentapi"
        ),
        procs(true, 0)
    );
}

#[test]
fn the_apps_settings_file_keeps_every_other_key_and_only_terms_keys_are_written() {
    let dir = temp();
    let file = dir.path().join("app_storage.json");
    fs::write(
        &file,
        json!({ "keep": "1", "agy.onboarding.lastLoginUsername": "one@example.test" }).to_string(),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let values: IndexMap<String, String> = [
        ("agy.onboarding.lastLoginUsername", "two@example.test"),
        ("other", "no"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v.to_owned()))
    .collect();
    write_antigravity_settings(&file, &values).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&file).unwrap()).unwrap(),
        json!({ "keep": "1", "agy.onboarding.lastLoginUsername": "two@example.test" })
    );
    // Windows has no Unix modes and needs rights for a symlink; the app this writes for is
    // macOS-only.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::os::unix::fs::symlink(&file, dir.path().join("link.json")).unwrap();
        assert!(
            write_antigravity_settings(&dir.path().join("link.json"), &IndexMap::new()).is_err()
        );
    }
}

/// The vault with `save` and `save_pending` failing, as a full disk would.
struct Broken(Arc<AntigravityVault>);

impl AntigravityStore for Broken {
    fn save(&self, _: &str, _: SignInEntry) -> Result<(), String> {
        Err("disk full".into())
    }
    fn load(&self, id: &str) -> Option<AntigravitySaved> {
        self.0.load(id)
    }
    fn save_other(&self, raw: &str) -> Result<(), String> {
        self.0.save_other(raw)
    }
    fn save_pending(&self, _: &str) -> Result<(), String> {
        Err("disk full".into())
    }
    fn load_pending(&self) -> Result<Option<String>, String> {
        self.0.load_pending()
    }
    fn clear_pending(&self) -> Result<(), String> {
        self.0.clear_pending()
    }
    fn remove(&self, id: &str) -> Result<(), String> {
        self.0.remove(id)
    }
    fn list(&self) -> Vec<String> {
        self.0.list()
    }
}

#[test]
fn nothing_is_overwritten_or_removed_when_the_sign_in_in_use_cannot_be_kept_first() {
    let dir = temp();
    let (world, ports) = fakes(Start {
        item: Some(sign_in("one@example.test")),
        ..Start::default()
    });
    let vault = vault_in(dir.path());
    vault
        .save(G2, entry("two@example.test", sign_in("two@example.test")))
        .unwrap();
    let switcher = switcher(ports, Arc::new(Broken(vault)));
    let result = switcher.switch_to(G2).unwrap();
    assert_eq!(
        (result.kind, result.reason),
        (Kind::Failed, Some(Reason::Save))
    );
    assert_eq!(item(&world), Some(sign_in("one@example.test")));
    assert!(!log(&world).contains(&"write") && !log(&world).contains(&"quit"));
    // A new account's sign-in does not start either.
    world.lock().unwrap().item = Some(sign_in_with("one@example.test", "fresh", "a"));
    switcher.begin_sign_in(G2).unwrap();
    assert_eq!(switcher.state().result.unwrap().reason, Some(Reason::Save));
    assert_eq!(
        item(&world),
        Some(sign_in_with("one@example.test", "fresh", "a"))
    );
    assert!(!log(&world).contains(&"remove"));
}

#[test]
fn a_switch_that_moved_the_sign_in_but_could_not_open_the_app_again_says_so() {
    let dir = temp();
    let (world, mut ports) = fakes(Start {
        item: Some(sign_in("one@example.test")),
        ..Start::default()
    });
    ports.launch = Arc::new(|| Err("open failed".into()));
    let vault = vault_in(dir.path());
    vault
        .save(G2, entry("two@example.test", sign_in("two@example.test")))
        .unwrap();
    let result = switcher(ports, vault).switch_to(G2).unwrap();
    assert_eq!(
        (result.kind, result.reason),
        (Kind::Failed, Some(Reason::Launch))
    );
    assert_eq!(item(&world), Some(sign_in("two@example.test")));
}

#[test]
fn a_cancel_while_the_app_is_still_closing_stops_before_the_sign_in_is_taken_off_this_mac() {
    let dir = temp();
    let (world, mut ports) = fakes(Start {
        item: Some(sign_in("one@example.test")),
        ..Start::default()
    });
    let me: Arc<OnceLock<AntigravitySwitcher>> = Arc::new(OnceLock::new());
    let quit = ports.quit.clone();
    let cancel = me.clone();
    ports.quit = Arc::new(move || {
        cancel.get().unwrap().cancel_sign_in();
        quit();
    });
    let switcher = switcher(ports, vault_in(dir.path()));
    me.set(switcher.clone()).ok().unwrap();
    switcher.begin_sign_in(G2).unwrap();
    let state = switcher.state();
    assert_eq!(state.busy, None);
    assert_eq!(state.result.unwrap().kind, Kind::Cancelled);
    assert_eq!(item(&world), Some(sign_in("one@example.test")));
    assert!(!log(&world).contains(&"remove"));
    assert!(world.lock().unwrap().open);
}

#[test]
fn a_cancel_puts_the_earlier_sign_in_back_even_when_the_app_will_not_close_and_a_relay_that_quit_mid_way_puts_it_back_at_start()
 {
    let dir = temp();
    let (world, ports) = fakes(Start {
        item: Some(sign_in("one@example.test")),
        ..Start::default()
    });
    let vault = vault_in(dir.path());
    let first = switcher(ports.clone(), vault.clone());
    first.begin_sign_in(G2).unwrap();
    world.lock().unwrap().stuck = true;
    first.cancel_sign_in();
    idle(&first);
    assert_eq!(first.state().result.unwrap().kind, Kind::Cancelled);
    assert_eq!(item(&world), Some(sign_in("one@example.test")));
    assert_eq!(vault.load_pending().unwrap(), None);

    // Relay quit during a wait: the item is gone and the pending copy is on disk.
    vault.save_pending(&sign_in("one@example.test")).unwrap();
    world.lock().unwrap().item = None;
    switcher(ports.clone(), vault.clone()).recover();
    assert_eq!(item(&world), Some(sign_in("one@example.test")));
    assert_eq!(vault.load_pending().unwrap(), None);
    // A sign-in made since is left alone.
    vault.save_pending(&sign_in("one@example.test")).unwrap();
    world.lock().unwrap().item = Some(sign_in("two@example.test"));
    switcher(ports, vault).recover();
    assert_eq!(item(&world), Some(sign_in("two@example.test")));
}

#[test]
fn a_background_reading_that_began_before_a_switch_does_not_save_over_what_the_switch_kept() {
    let dir = temp();
    let (world, mut ports) = fakes(Start {
        item: Some(sign_in_with("one@example.test", "r1", "old")),
        ..Start::default()
    });
    let vault = vault_in(dir.path());
    vault
        .save(G2, entry("two@example.test", sign_in("two@example.test")))
        .unwrap();
    let (entered, reading) = mpsc::channel::<()>();
    let (release, released) = mpsc::channel::<()>();
    let gate = Mutex::new(Some((entered, released)));
    let read = keychain_read(&world);
    // The first read holds its value until released.
    let held: ReadFn = Arc::new(move || {
        let value = read();
        let first = gate.lock().unwrap().take();
        if let Some((entered, released)) = first {
            entered.send(()).unwrap();
            released.recv().unwrap();
        }
        value
    });
    ports.keychain = keychain(&world, held, keychain_write(&world));
    let switcher = switcher(ports, vault.clone());
    let background = switcher.clone();
    let peek = std::thread::spawn(move || background.current());
    reading.recv().unwrap();
    {
        let mut w = world.lock().unwrap();
        w.on_quit = Some(sign_in_with("one@example.test", "r1", "new"));
        w.item = Some(sign_in_with("one@example.test", "r1", "new"));
    }
    assert_eq!(switcher.switch_to(G2).unwrap().kind, Kind::Switched);
    release.send(()).unwrap();
    peek.join().unwrap();
    assert_eq!(
        vault.load(G1).unwrap().raw,
        sign_in_with("one@example.test", "r1", "new")
    );
}

#[test]
fn removing_an_account_from_relay_deletes_its_saved_app_sign_in() {
    let dir = temp();
    let (_world, ports) = fakes(Start {
        item: Some(sign_in("one@example.test")),
        ..Start::default()
    });
    let vault = vault_in(dir.path());
    let switcher = switcher(ports, vault.clone());
    switcher.current();
    assert!(vault.load(G1).is_some());
    switcher.forget(G1).unwrap();
    assert!(vault.load(G1).is_none());
    assert!(switcher.state().saved.is_empty());
}

#[test]
fn two_google_accounts_relay_does_not_have_keep_a_sign_in_each_the_second_never_overwrites_the_first()
 {
    let dir = temp();
    let vault = vault_in(dir.path());
    vault.save_other(&sign_in("first@example.test")).unwrap();
    vault.save_other(&sign_in("second@example.test")).unwrap();
    vault
        .save_other(&sign_in_with("first@example.test", "r-newer", "a"))
        .unwrap();
    let others = fs::read_dir(dir.path().join("antigravity-app"))
        .unwrap()
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| n.starts_with("other-"))
        .count();
    assert_eq!(others, 2);
    // Still no account slot: list() names Relay accounts only.
    assert!(vault.list().is_empty());
}

#[test]
fn a_sign_in_that_cannot_be_put_back_keeps_its_copy_on_disk_and_the_next_start_puts_it_back() {
    let dir = temp();
    let (world, mut ports) = fakes(Start {
        item: Some(sign_in("one@example.test")),
        ..Start::default()
    });
    let writable = Arc::new(Mutex::new(true));
    let write = keychain_write(&world);
    let allowed = writable.clone();
    let failing: WriteFn = Arc::new(move |text: &str| {
        if !*allowed.lock().unwrap() {
            return Err(TerminalError(TerminalReason::Locked));
        }
        write(text)
    });
    ports.keychain = keychain(&world, keychain_read(&world), failing);
    // The app will not open on its sign-in screen: the step fails after the item was taken
    // off.
    ports.launch = Arc::new(|| Err("no app".into()));
    let vault = vault_in(dir.path());
    let first = switcher(ports.clone(), vault.clone());
    *writable.lock().unwrap() = false;
    first.begin_sign_in(G2).unwrap();
    assert_eq!(item(&world), None);
    assert_eq!(
        vault.load_pending().unwrap(),
        Some(sign_in("one@example.test"))
    );
    assert_eq!(first.state().result.unwrap().kind, Kind::Failed);
    // Next start, the Keychain works again: the sign-in goes back and its copy goes.
    *writable.lock().unwrap() = true;
    switcher(ports, vault.clone()).recover();
    assert_eq!(item(&world), Some(sign_in("one@example.test")));
    assert_eq!(vault.load_pending().unwrap(), None);
}

#[test]
fn a_background_reading_that_crossed_a_switch_neither_saves_its_older_sign_in_nor_stands_as_current()
 {
    let dir = temp();
    let (world, mut ports) = fakes(Start {
        item: Some(sign_in_with("one@example.test", "r-old", "a")),
        ..Start::default()
    });
    let (entered, reading) = mpsc::channel::<()>();
    let (release, released) = mpsc::channel::<()>();
    let gate = Mutex::new(Some((entered, released)));
    let read = keychain_read(&world);
    let gated: ReadFn = Arc::new(move || {
        let first = gate.lock().unwrap().take();
        match first {
            Some((entered, released)) => {
                let seen = read();
                entered.send(()).unwrap();
                released.recv().unwrap();
                seen
            }
            None => read(),
        }
    });
    ports.keychain = keychain(&world, gated, keychain_write(&world));
    let vault = vault_in(dir.path());
    vault
        .save(G2, entry("two@example.test", sign_in("two@example.test")))
        .unwrap();
    let switcher = switcher(ports, vault.clone());
    let background = switcher.clone();
    let peek = std::thread::spawn(move || background.current());
    reading.recv().unwrap();
    // Meanwhile the app renewed its token, and the user switches to the other account.
    world.lock().unwrap().item = Some(sign_in_with("one@example.test", "r-new", "a"));
    assert_eq!(switcher.switch_to(G2).unwrap().kind, Kind::Switched);
    release.send(()).unwrap();
    peek.join().unwrap();
    assert_eq!(
        vault.load(G1).unwrap().raw,
        sign_in_with("one@example.test", "r-new", "a")
    );
    assert_eq!(switcher.current(), account(G2));
}

#[test]
fn an_app_that_is_asked_to_quit_but_does_not_close_in_time_is_opened_again() {
    let dir = temp();
    let (world, ports) = fakes(Start {
        item: Some(sign_in("one@example.test")),
        ..Start::default()
    });
    world.lock().unwrap().stuck = true;
    let vault = vault_in(dir.path());
    vault
        .save(G2, entry("two@example.test", sign_in("two@example.test")))
        .unwrap();
    let result = switcher(ports, vault).switch_to(G2).unwrap();
    assert_eq!(result.reason, Some(Reason::StillRunning));
    assert_eq!(
        log(&world)
            .into_iter()
            .filter(|l| *l == "quit" || *l == "launch")
            .collect::<Vec<_>>(),
        vec!["quit", "launch"]
    );
    // Nothing was written: the sign-in in use stays.
    assert_eq!(item(&world), Some(sign_in("one@example.test")));
}

#[test]
fn a_failure_that_is_not_the_keychains_is_not_called_one() {
    let dir = temp();
    let (_world, mut ports) = fakes(Start {
        item: Some(sign_in("one@example.test")),
        ..Start::default()
    });
    ports.processes = Arc::new(|| Err("ps timed out".into()));
    let vault = vault_in(dir.path());
    vault
        .save(G2, entry("two@example.test", sign_in("two@example.test")))
        .unwrap();
    let result = switcher(ports, vault).switch_to(G2).unwrap();
    assert_eq!(result.kind, Kind::Failed);
    assert_eq!(result.reason, Some(Reason::Unexpected));
}
