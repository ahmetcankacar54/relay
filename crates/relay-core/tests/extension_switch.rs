//! Port of `tests/extension-switch.test.ts`.

#[path = "common/browser.rs"]
mod browser;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use browser::{World, extension_world, login_at, login_for, sign_in, sign_in_for};
use relay_core::cookie_store::{CookieSnapshot, CookieStoreReason, CookieValue};
use relay_core::cookie_vault::CookieVault;
use relay_core::draft_vault::{Clock, Seal, Unseal};
use relay_core::extension_storage::StorageReason;
use relay_core::extension_switch::{
    CheckRequest, ExtensionPorts, ExtensionRequest, ExtensionSwitcher,
};
use relay_core::extension_vault::ExtensionVault;
use relay_core::shared::browser_extension::{
    BrowserApp, ExtensionCurrent, ExtensionMode, ExtensionReason, ExtensionResult,
    ExtensionSetting, ExtensionTarget, default_extension,
};
use relay_core::shared::extension_auth::SignIn;
use relay_core::vault_crypto::Sealer;
use tempfile::TempDir;

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn sealer() -> (Seal, Unseal) {
    let sealer = Arc::new(Sealer::new(&[7u8; 32]).unwrap());
    let s = sealer.clone();
    (
        Arc::new(move |text: &str| Ok(s.seal(text))),
        Arc::new(move |data: &[u8]| sealer.unseal(data).map_err(|e| e.to_string())),
    )
}

fn vaults(root: &Path, now: Option<Clock>) -> (Arc<ExtensionVault>, Arc<CookieVault>) {
    let (seal, unseal) = sealer();
    (
        Arc::new(ExtensionVault::new(
            root.join("vault"),
            seal.clone(),
            unseal.clone(),
            now.clone(),
        )),
        Arc::new(CookieVault::new(root.join("vault"), seal, unseal, now)),
    )
}

fn ports_for(
    world: &World,
    vault: &Arc<ExtensionVault>,
    cookie_vault: &Arc<CookieVault>,
    scratch: &Path,
) -> ExtensionPorts {
    let mut ports = ExtensionPorts::new(
        world.system.clone(),
        world.storage.clone(),
        vault.clone(),
        scratch,
    );
    ports.cookies = Some(world.cookies.clone());
    ports.cookie_vault = Some(cookie_vault.clone());
    ports
}

struct S {
    temp: TempDir,
    world: World,
    dir: PathBuf,
    profile: PathBuf,
    vault: Arc<ExtensionVault>,
    cookie_vault: Arc<CookieVault>,
    scratch: PathBuf,
    switcher: ExtensionSwitcher,
    a: String,
    b: String,
}

fn setup() -> S {
    setup_with(|_| {})
}

fn setup_with(change: impl FnOnce(&mut ExtensionPorts)) -> S {
    let temp = tempfile::Builder::new()
        .prefix("relay-ext-switch-")
        .tempdir()
        .unwrap();
    let world = extension_world(temp.path());
    let dir = world.install(BrowserApp::Brave);
    let (vault, cookie_vault) = vaults(temp.path(), None);
    let scratch = temp.path().join("scratch");
    let mut ports = ports_for(&world, &vault, &cookie_vault, &scratch);
    change(&mut ports);
    let switcher = ExtensionSwitcher::new(ports);
    let profile = dir.parent().unwrap().parent().unwrap().to_path_buf();
    S {
        temp,
        world,
        dir,
        profile,
        vault,
        cookie_vault,
        scratch,
        switcher,
        a: uuid(),
        b: uuid(),
    }
}

fn setting(mode: ExtensionMode) -> ExtensionSetting {
    ExtensionSetting {
        mode,
        browser: None,
    }
}

impl S {
    fn request(&self) -> ExtensionRequest {
        ExtensionRequest {
            setting: setting(ExtensionMode::Restart),
            may_quit: true,
            target: vec![self.b.clone()],
            known: vec![self.a.clone(), self.b.clone()],
            orgs: None,
            groups: None,
        }
    }
    fn check(&self, setting: ExtensionSetting, known: &[&String]) -> Option<ExtensionCurrent> {
        self.switcher.check(&check_request(setting, known))
    }
    fn stored(&self) -> Option<SignIn> {
        self.world.stored(&self.dir)
    }
    fn store(&self, sign_in: SignIn) {
        self.world.set_stored(&self.dir, Some(sign_in));
    }
    fn web(&self) -> Option<CookieSnapshot> {
        self.world.web(&self.profile)
    }
    fn set_web(&self, login: CookieSnapshot) {
        self.world.set_web(&self.profile, login);
    }
    fn load(&self, account: &str) -> Option<SignIn> {
        self.vault.load(&[account.to_owned()]).unwrap()
    }
    fn load_login(&self, account: &str) -> Option<CookieSnapshot> {
        self.cookie_vault.load(&[account.to_owned()]).unwrap()
    }
    /// Saves a complete pair for `account`.
    fn pair(&self, account: &str, n: i64) {
        self.vault.save(account, &sign_in_for(account, n)).unwrap();
        self.cookie_vault
            .save(account, &login_for(account, n))
            .unwrap();
    }
    fn running(&self, running: bool) {
        self.world.state.lock().running = running;
    }
    fn peek(&self) -> PathBuf {
        PathBuf::from(format!("{}-peek", self.scratch.display()))
    }
    fn cookie_scratch(&self) -> PathBuf {
        PathBuf::from(format!("{}-cookies", self.scratch.display()))
    }
    fn data_txt(&self) -> String {
        fs::read_to_string(self.dir.join("data.txt")).unwrap()
    }
}

fn check_request(setting: ExtensionSetting, known: &[&String]) -> CheckRequest {
    CheckRequest {
        setting,
        known: known.iter().map(|k| (*k).clone()).collect(),
        orgs: None,
        groups: None,
        claim: None,
    }
}

fn signed_in_account(current: &Option<ExtensionCurrent>) -> Option<String> {
    match current {
        Some(ExtensionCurrent::SignedIn { account_uuid, .. }) => account_uuid.clone(),
        _ => None,
    }
}

fn signed_in_known(current: &Option<ExtensionCurrent>) -> Option<bool> {
    match current {
        Some(ExtensionCurrent::SignedIn { known, .. }) => Some(*known),
        _ => None,
    }
}

fn state_of(current: &Option<ExtensionCurrent>) -> &'static str {
    match current {
        Some(ExtensionCurrent::SignedIn { .. }) => "signed-in",
        Some(ExtensionCurrent::SignedOut { .. }) => "signed-out",
        Some(ExtensionCurrent::Unreadable { .. }) => "unreadable",
        None => "none",
    }
}

fn orgs(pairs: &[(&String, &str)]) -> Option<HashMap<String, String>> {
    Some(
        pairs
            .iter()
            .map(|(k, v)| ((*k).clone(), (*v).to_owned()))
            .collect(),
    )
}

#[test]
fn a_closed_browser_the_extensions_sign_in_is_saved_for_its_account_and_the_targets_is_put_in_place()
 {
    let s = setup();
    s.store(sign_in_for(&s.a, 1));
    s.pair(&s.b, 5);
    let outcome = s.switcher.run(&s.request());
    assert_eq!(outcome.result, ExtensionResult::Switched);
    assert!(outcome.saved);
    assert!(!outcome.restarted);
    assert_eq!(s.stored(), Some(sign_in_for(&s.b, 5)));
    // The snapshot on leave: A's sign-in, as it was, is in the vault.
    assert_eq!(s.load(&s.a), Some(sign_in_for(&s.a, 1)));
    assert!(s.world.events().is_empty());
    assert!(!s.scratch.exists(), "the backup is removed");
}

#[test]
fn a_rotated_refresh_token_is_kept_the_next_switch_away_saves_the_newer_copy() {
    let s = setup();
    s.vault.save(&s.a, &sign_in_for(&s.a, 1)).unwrap();
    s.pair(&s.b, 1);
    s.store(sign_in_for(&s.a, 2));
    s.switcher.run(&s.request());
    assert_eq!(s.load(&s.a), Some(sign_in_for(&s.a, 2)));
}

#[test]
fn the_first_sign_in_is_captured_at_the_switch_away_when_the_target_has_none_saved() {
    let s = setup();
    s.store(sign_in_for(&s.a, 1));
    let outcome = s.switcher.run(&s.request());
    assert_eq!(outcome.result, ExtensionResult::Saved);
    assert_eq!(outcome.reason, Some(ExtensionReason::NoSavedLogin));
    assert!(outcome.saved);
    assert_eq!(s.stored(), Some(sign_in_for(&s.a, 1)));
    assert_eq!(s.load(&s.a), Some(sign_in_for(&s.a, 1)));
}

#[test]
fn a_signed_out_extension_takes_the_targets_saved_sign_in_and_saves_nothing() {
    let s = setup();
    s.pair(&s.b, 5);
    let outcome = s.switcher.run(&s.request());
    assert_eq!(outcome.result, ExtensionResult::Switched);
    assert!(!outcome.saved);
    assert_eq!(s.stored(), Some(sign_in_for(&s.b, 5)));
}

#[test]
fn signed_out_with_nothing_saved_for_the_target_changes_nothing() {
    let s = setup();
    let outcome = s.switcher.run(&s.request());
    assert_eq!(outcome.result, ExtensionResult::Unchanged);
    assert_eq!(outcome.reason, Some(ExtensionReason::NoSavedLogin));
    assert_eq!(s.stored(), None);
}

#[test]
fn the_extension_already_on_the_target_is_left_and_its_newer_copy_is_saved() {
    let s = setup();
    s.pair(&s.b, 1);
    s.store(sign_in_for(&s.b, 3));
    let outcome = s.switcher.run(&s.request());
    assert_eq!(outcome.result, ExtensionResult::Unchanged);
    assert_eq!(outcome.reason, Some(ExtensionReason::AlreadyThere));
    assert!(outcome.saved);
    assert_eq!(s.load(&s.b), Some(sign_in_for(&s.b, 3)));
    assert_eq!(s.stored(), Some(sign_in_for(&s.b, 3)));
}

#[test]
fn a_running_browser_is_quit_left_closed_while_the_database_is_used_and_opened_again() {
    let s = setup();
    s.running(true);
    s.store(sign_in_for(&s.a, 1));
    s.pair(&s.b, 5);
    let outcome = s.switcher.run(&s.request());
    assert_eq!(outcome.result, ExtensionResult::Switched);
    assert!(outcome.restarted);
    assert_eq!(outcome.reopened, Some(true));
    assert_eq!(s.world.events(), ["quit:brave", "launch:brave"]);
    // Never opened while the browser ran: every use of the storage saw it closed.
    let opened = s.world.opened();
    assert!(!opened.is_empty());
    assert!(opened.iter().all(|(_, running)| !running));
    assert!(s.world.state.lock().running);
}

#[test]
fn the_browser_is_opened_again_even_when_the_swap_failed() {
    let s = setup();
    s.running(true);
    s.store(sign_in_for(&s.a, 1));
    s.pair(&s.b, 5);
    s.world.state.lock().fail_write = Some(StorageReason::Failed);
    let outcome = s.switcher.run(&s.request());
    assert_eq!(outcome.result, ExtensionResult::Failed);
    assert_eq!(outcome.reason, Some(ExtensionReason::WriteFailed));
    assert_eq!(s.world.events(), ["quit:brave", "launch:brave"]);
}

#[test]
fn a_failed_write_puts_the_folder_back_from_the_backup_a_mismatch_says_so() {
    let s = setup();
    s.store(sign_in_for(&s.a, 1));
    s.pair(&s.b, 5);
    s.world.state.lock().fail_write = Some(StorageReason::Failed);
    assert_eq!(
        s.switcher.run(&s.request()).reason,
        Some(ExtensionReason::WriteFailed)
    );
    assert_eq!(s.data_txt(), "ORIGINAL");
    s.world.state.lock().fail_write = Some(StorageReason::Mismatch);
    let outcome = s.switcher.run(&s.request());
    assert_eq!(outcome.reason, Some(ExtensionReason::VerifyFailed));
    assert_eq!(s.data_txt(), "ORIGINAL");
    assert!(!s.scratch.exists());
}

/// The restore cannot run: the folder is gone after every write.
fn remove_dir_after_write(s: &S) {
    s.world.state.lock().after_write = Some(Arc::new(|dir: &Path| {
        let _ = fs::remove_dir_all(dir);
    }));
}

#[test]
fn a_failed_restore_keeps_the_backup_and_says_so() {
    let s = setup();
    s.store(sign_in_for(&s.a, 1));
    s.pair(&s.b, 5);
    s.world.state.lock().fail_write = Some(StorageReason::Failed);
    remove_dir_after_write(&s);
    let outcome = s.switcher.run(&s.request());
    assert_eq!(outcome.result, ExtensionResult::Failed);
    assert_eq!(outcome.reason, Some(ExtensionReason::RestoreFailed));
    assert!(s.scratch.exists(), "the backup stays");
}

fn names_but_kept(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n != ".kept")
        .collect();
    names.sort();
    names
}

#[test]
fn the_backups_of_a_failed_restore_survive_the_next_switch() {
    let s = setup();
    s.store(sign_in_for(&s.a, 1));
    s.pair(&s.b, 5);
    s.world.state.lock().fail_write = Some(StorageReason::Failed);
    remove_dir_after_write(&s);
    assert_eq!(
        s.switcher.run(&s.request()).reason,
        Some(ExtensionReason::RestoreFailed)
    );
    let kept = names_but_kept(&s.scratch);
    assert_eq!(kept.len(), 1);
    // A later, healthy switch must not take the only copy away.
    {
        let mut state = s.world.state.lock();
        state.after_write = None;
        state.fail_write = None;
    }
    fs::create_dir_all(&s.dir).unwrap();
    s.store(sign_in_for(&s.a, 1));
    s.switcher.run(&s.request());
    assert!(
        s.scratch.join(&kept[0]).exists(),
        "the earlier backup stays"
    );
    assert_eq!(
        names_but_kept(&s.scratch),
        kept,
        "this run's own backup is gone"
    );
}

#[test]
fn after_an_interrupted_swap_nothing_is_saved_from_the_profile_and_the_next_swap_mends_it() {
    let s = setup();
    s.store(sign_in_for(&s.a, 1));
    s.pair(&s.a, 7);
    s.pair(&s.b, 5);
    let saved_a = s.load(&s.a);
    let saved_login_a = s.load_login(&s.a);
    s.vault.mark_swap().unwrap();
    assert!(s.vault.swap_interrupted());
    let outcome = s.switcher.run(&s.request());
    assert_eq!(outcome.result, ExtensionResult::Switched);
    assert!(!outcome.saved, "the doubtful pair is not saved");
    assert_eq!(s.load(&s.a), saved_a);
    assert_eq!(s.load_login(&s.a), saved_login_a);
    assert!(
        !s.vault.swap_interrupted(),
        "the mark goes once the pair is in place"
    );
}

#[test]
fn a_browser_that_does_not_quit_is_left_alone_and_the_extension_is_not_touched() {
    let s = setup();
    {
        let mut state = s.world.state.lock();
        state.running = true;
        state.stuck = true;
    }
    s.store(sign_in_for(&s.a, 1));
    s.pair(&s.b, 5);
    let outcome = s.switcher.run(&s.request());
    assert_eq!(outcome.result, ExtensionResult::Skipped);
    assert_eq!(outcome.reason, Some(ExtensionReason::BrowserDidNotQuit));
    assert!(!outcome.restarted);
    assert_eq!(
        s.world.events(),
        ["quit:brave"],
        "asked once, never forced, never launched"
    );
    assert!(s.world.opened().is_empty());
    assert_eq!(s.stored(), Some(sign_in_for(&s.a, 1)));
}

#[test]
fn a_browser_that_cannot_be_opened_again_is_reported() {
    let s = setup();
    {
        let mut state = s.world.state.lock();
        state.running = true;
        state.fail_launch = true;
    }
    s.pair(&s.b, 5);
    let outcome = s.switcher.run(&s.request());
    assert_eq!(outcome.result, ExtensionResult::Switched);
    assert!(outcome.restarted);
    assert_eq!(outcome.reopened, Some(false));
}

#[test]
fn a_running_browser_is_left_alone_in_mode_closed_and_when_the_switch_may_not_quit_it() {
    let s = setup();
    s.running(true);
    s.store(sign_in_for(&s.a, 1));
    s.pair(&s.b, 5);
    let closed = ExtensionRequest {
        setting: setting(ExtensionMode::Closed),
        ..s.request()
    };
    let no_quit = ExtensionRequest {
        may_quit: false,
        ..s.request()
    };
    for request in [closed, no_quit] {
        let outcome = s.switcher.run(&request);
        assert_eq!(outcome.result, ExtensionResult::Skipped);
        assert_eq!(outcome.reason, Some(ExtensionReason::BrowserRunning));
    }
    assert!(s.world.events().is_empty());
    assert!(s.world.opened().is_empty());
    assert_eq!(s.stored(), Some(sign_in_for(&s.a, 1)));
}

#[test]
fn a_closed_browser_is_used_in_mode_closed_and_when_the_switch_may_not_quit_it() {
    let s = setup();
    s.pair(&s.b, 5);
    let closed = ExtensionRequest {
        setting: setting(ExtensionMode::Closed),
        ..s.request()
    };
    let no_quit = ExtensionRequest {
        may_quit: false,
        ..s.request()
    };
    for request in [closed, no_quit] {
        s.store(sign_in_for(&s.a, 1));
        assert_eq!(s.switcher.run(&request).result, ExtensionResult::Switched);
    }
    assert!(s.world.events().is_empty());
}

#[test]
fn mode_off_touches_nothing_and_reads_nothing() {
    let s = setup();
    s.running(true);
    let outcome = s.switcher.run(&ExtensionRequest {
        setting: setting(ExtensionMode::Off),
        ..s.request()
    });
    assert_eq!(outcome.result, ExtensionResult::Skipped);
    assert_eq!(outcome.reason, Some(ExtensionReason::Off));
    assert!(s.world.events().is_empty());
    assert!(s.world.opened().is_empty());
}

#[test]
fn an_extension_signed_in_to_an_account_relay_does_not_have_is_never_overwritten_or_saved() {
    let s = setup();
    let stranger = uuid();
    s.store(sign_in_for(&stranger, 1));
    s.pair(&s.b, 5);
    let outcome = s.switcher.run(&s.request());
    assert_eq!(outcome.result, ExtensionResult::Skipped);
    assert_eq!(outcome.reason, Some(ExtensionReason::UnknownAccount));
    assert!(!outcome.saved);
    assert_eq!(s.stored(), Some(sign_in_for(&stranger, 1)));
    assert_eq!(s.load(&stranger), None);
}

#[test]
fn the_target_is_found_by_either_of_its_accounts_uuids() {
    let s = setup();
    let own = uuid();
    s.store(sign_in_for(&s.a, 1));
    s.pair(&own, 9);
    let request = ExtensionRequest {
        target: vec![s.b.clone(), own.clone()],
        known: vec![s.a.clone(), s.b.clone(), own.clone()],
        ..s.request()
    };
    let outcome = s.switcher.run(&request);
    assert_eq!(outcome.result, ExtensionResult::Switched);
    assert_eq!(s.stored(), Some(sign_in_for(&own, 9)));
}

#[test]
fn no_extension_installed_and_several_browser_profiles_without_a_choice_do_nothing() {
    let none = tempfile::Builder::new()
        .prefix("relay-ext-none-")
        .tempdir()
        .unwrap();
    let world = extension_world(none.path());
    let (vault, cookie_vault) = vaults(none.path(), None);
    let switcher = ExtensionSwitcher::new(ports_for(
        &world,
        &vault,
        &cookie_vault,
        &none.path().join("scratch"),
    ));
    let request = ExtensionRequest {
        setting: setting(ExtensionMode::Restart),
        may_quit: true,
        target: vec![uuid()],
        known: vec![],
        orgs: None,
        groups: None,
    };
    world.state.lock().running = true;
    assert_eq!(
        switcher.run(&request).reason,
        Some(ExtensionReason::NotInstalled)
    );
    assert!(
        world.events().is_empty(),
        "nothing is quit when there is no extension"
    );

    let brave_dir = world.install(BrowserApp::Brave);
    let chrome_dir = world.install(BrowserApp::Chrome);
    let outcome = switcher.run(&request);
    assert_eq!(outcome.reason, Some(ExtensionReason::ChooseInstance));
    assert!(world.events().is_empty());
    // Chosen: that one is used, the other is not.
    let sign = uuid();
    let with_choice = ExtensionRequest {
        setting: ExtensionSetting {
            mode: ExtensionMode::Closed,
            browser: Some(ExtensionTarget {
                app: BrowserApp::Chrome,
                profile: "Default".into(),
            }),
        },
        target: vec![sign.clone()],
        known: vec![sign.clone()],
        ..request
    };
    world.state.lock().running = false;
    vault.save(&sign, &sign_in_for(&sign, 4)).unwrap();
    cookie_vault.save(&sign, &login_for(&sign, 4)).unwrap();
    assert_eq!(switcher.run(&with_choice).result, ExtensionResult::Switched);
    assert_eq!(world.stored(&chrome_dir), Some(sign_in_for(&sign, 4)));
    assert_eq!(world.stored(&brave_dir), None);
}

#[test]
fn a_damaged_vault_file_fails_the_step_never_throws_and_the_browser_is_opened_again() {
    let s = setup();
    s.running(true);
    s.store(sign_in_for(&s.a, 1));
    s.pair(&s.b, 5);
    let file = s
        .temp
        .path()
        .join("vault")
        .join("extension")
        .join(format!("{}.bin", s.b));
    fs::write(&file, "not sealed at all").unwrap();
    let outcome = s.switcher.run(&s.request());
    assert_eq!(outcome.result, ExtensionResult::Failed);
    assert_eq!(outcome.reason, Some(ExtensionReason::Unreadable));
    assert_eq!(s.world.events(), ["quit:brave", "launch:brave"]);
    assert_eq!(s.stored(), Some(sign_in_for(&s.a, 1)));
}

#[test]
fn an_outcome_never_carries_a_token() {
    let s = setup();
    s.store(sign_in_for(&s.a, 1));
    s.pair(&s.b, 5);
    let text = serde_json::to_string(&s.switcher.run(&s.request())).unwrap();
    assert!(!text.contains("SECRET"));
}

#[test]
fn the_vault_keeps_each_sign_in_under_the_account_it_names_sealed() {
    let s = setup();
    let signed = sign_in_for(&s.a, 1);
    s.vault.save(&s.a, &signed).unwrap();
    let dir = s.temp.path().join("vault").join("extension");
    let file = dir.join(format!("{}.bin", s.a));
    let bytes = fs::read(&file).unwrap();
    assert_eq!(&bytes[..4], b"RLY2");
    assert!(!String::from_utf8_lossy(&bytes).contains("SECRET"));
    assert_eq!(s.load(&s.a.to_uppercase()), Some(signed));
    assert_eq!(s.load(&s.b), None);
    let listed: Vec<String> = s.vault.list().into_iter().map(|x| x.account_uuid).collect();
    assert_eq!(listed, [s.a.as_str()]);
    // A file copied under another account's name is refused.
    fs::copy(&file, dir.join(format!("{}.bin", s.b))).unwrap();
    let error = s.vault.load(std::slice::from_ref(&s.b)).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("Invalid saved extension sign-in")
    );
    // A sign-in without an account is not saved.
    let error = s
        .vault
        .save("not-a-uuid", &sign_in(&[("accessToken", "\"x\"")]))
        .unwrap_err();
    assert!(error.to_string().contains("names no account"));
}

#[test]
fn without_the_leveldb_library_nothing_is_quit_read_or_written() {
    let s = setup();
    {
        let mut state = s.world.state.lock();
        state.available = false;
        state.running = true;
    }
    s.store(sign_in_for(&s.a, 1));
    s.pair(&s.b, 5);
    let outcome = s.switcher.run(&s.request());
    assert_eq!(outcome.result, ExtensionResult::Skipped);
    assert_eq!(outcome.reason, Some(ExtensionReason::Unavailable));
    assert!(!outcome.restarted);
    assert!(s.world.events().is_empty());
    assert!(s.world.opened().is_empty());
    assert_eq!(s.stored(), Some(sign_in_for(&s.a, 1)));
}

#[test]
fn several_browser_profiles_without_a_choice_the_one_whose_extension_was_used_last_is_managed() {
    let temp = tempfile::Builder::new()
        .prefix("relay-ext-recent-")
        .tempdir()
        .unwrap();
    let world = extension_world(temp.path());
    let (vault, cookie_vault) = vaults(temp.path(), None);
    let switcher = ExtensionSwitcher::new(ports_for(
        &world,
        &vault,
        &cookie_vault,
        &temp.path().join("scratch"),
    ));
    let brave_dir = world.install(BrowserApp::Brave);
    let chrome_dir = world.install(BrowserApp::Chrome);
    world
        .state
        .lock()
        .modified
        .insert(brave_dir.clone(), 2_000.0);
    world
        .state
        .lock()
        .modified
        .insert(chrome_dir.clone(), 1_000.0);
    let sign = uuid();
    vault.save(&sign, &sign_in_for(&sign, 4)).unwrap();
    cookie_vault.save(&sign, &login_for(&sign, 4)).unwrap();
    let outcome = switcher.run(&ExtensionRequest {
        setting: setting(ExtensionMode::Restart),
        may_quit: true,
        target: vec![sign.clone()],
        known: vec![sign.clone()],
        orgs: None,
        groups: None,
    });
    assert_eq!(outcome.result, ExtensionResult::Switched);
    assert_eq!(world.stored(&brave_dir), Some(sign_in_for(&sign, 4)));
    assert_eq!(world.stored(&chrome_dir), None);
}

#[test]
fn a_check_reads_a_copy_while_the_browser_runs_links_a_known_account_and_quits_nothing() {
    let s = setup();
    s.running(true);
    s.store(sign_in_for(&s.a, 3));
    let current = s.check(default_extension(), &[&s.a, &s.b]);
    assert_eq!(state_of(&current), "signed-in");
    assert_eq!(signed_in_account(&current), Some(s.a.to_lowercase()));
    assert_eq!(signed_in_known(&current), Some(true));
    assert_eq!(
        s.load(&s.a),
        Some(sign_in_for(&s.a, 3)),
        "linked: saved in the vault"
    );
    assert!(s.world.events().is_empty(), "the browser is left running");
    assert!(
        s.world.opened().is_empty(),
        "the live folder is never opened"
    );
    assert!(!s.peek().exists(), "the copy is removed");
    assert_eq!(s.data_txt(), "ORIGINAL");
}

#[test]
fn a_check_of_an_unknown_account_a_signed_out_extension_or_mode_off_saves_nothing() {
    let s = setup();
    let stranger = uuid();
    s.store(sign_in_for(&stranger, 1));
    let unknown = s.check(default_extension(), &[&s.a]);
    assert_eq!(signed_in_known(&unknown), Some(false));
    assert_eq!(s.load(&stranger), None);
    s.world.set_stored(&s.dir, None);
    assert_eq!(
        state_of(&s.check(default_extension(), &[&s.a])),
        "signed-out"
    );
    s.store(sign_in_for(&s.a, 1));
    assert_eq!(s.check(setting(ExtensionMode::Off), &[&s.a]), None);
    assert_eq!(s.load(&s.a), None);
}

#[test]
fn a_check_that_finds_no_account_of_relays_reports_the_key_names_it_saw_never_a_value() {
    let s = setup();
    let seen: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
    let sink = seen.clone();
    let mut ports = ExtensionPorts::new(
        s.world.system.clone(),
        s.world.storage.clone(),
        s.vault.clone(),
        &s.scratch,
    );
    ports.on_unknown_layout = Some(Box::new(move |names: &[String]| {
        sink.lock().unwrap().push(names.to_vec())
    }));
    let switcher = ExtensionSwitcher::new(ports);
    s.store(sign_in(&[
        ("settings", "{\"x\":1}"),
        ("oauthState", "\"abc\""),
    ]));
    assert_eq!(
        state_of(&switcher.check(&check_request(default_extension(), &[&s.a]))),
        "signed-out"
    );
    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen, [vec!["settings".to_owned(), "oauthState".to_owned()]]);
    let text = serde_json::to_string(&seen).unwrap();
    assert!(!text.contains("abc") && !text.contains("\"x\""));
}

fn bare(n: i64) -> SignIn {
    sign_in(&[(
        "oauth",
        &serde_json::json!({ "access_token": format!("sk-ant-oat01-SECRET{n}AAAAAA") }).to_string(),
    )])
}

#[test]
fn data_naming_no_account_the_users_claim_links_it_and_relay_then_remembers_who_it_put_in_place() {
    let s = setup();
    // Tokens only, no account uuid anywhere.
    s.store(bare(1));
    let unknown = s.check(default_extension(), &[&s.a, &s.b]);
    assert_eq!(
        (state_of(&unknown), signed_in_known(&unknown)),
        ("signed-in", Some(false))
    );
    // A claim for an account Relay does not have is ignored.
    let mut stray = check_request(default_extension(), &[&s.a, &s.b]);
    stray.claim = Some(uuid());
    assert_eq!(signed_in_known(&s.switcher.check(&stray)), Some(false));
    let mut claimed = check_request(default_extension(), &[&s.a, &s.b]);
    claimed.claim = Some(s.a.clone());
    assert_eq!(
        signed_in_account(&s.switcher.check(&claimed)),
        Some(s.a.to_lowercase())
    );
    assert_eq!(s.load(&s.a), Some(bare(1)));
    // A switch to B: the bare sign-in is saved as A's (the owner), B's is put in, B becomes the owner.
    s.vault.save(&s.b, &bare(5)).unwrap();
    s.cookie_vault.save(&s.b, &login_for(&s.b, 5)).unwrap();
    s.set_web(login_for(&s.a, 2));
    s.store(bare(2));
    assert_eq!(
        s.switcher.run(&s.request()).result,
        ExtensionResult::Switched
    );
    assert_eq!(s.load(&s.a), Some(bare(2)));
    assert_eq!(s.stored(), Some(bare(5)));
    assert_eq!(s.vault.owner().unwrap(), Some(s.b.to_lowercase()));
    // And back: B's rotated copy is kept, A's is put in.
    s.store(bare(6));
    let back = ExtensionRequest {
        target: vec![s.a.clone()],
        ..s.request()
    };
    assert_eq!(s.switcher.run(&back).result, ExtensionResult::Switched);
    assert_eq!(s.load(&s.b), Some(bare(6)));
    assert_eq!(s.stored(), Some(bare(2)));
}

#[test]
fn a_sign_in_naming_another_account_is_never_taken_for_the_remembered_one() {
    let s = setup();
    s.vault.set_owner(&s.a).unwrap();
    let stranger = uuid();
    s.store(sign_in_for(&stranger, 1));
    let mut request = check_request(default_extension(), &[&s.a, &s.b]);
    request.claim = Some(s.a.clone());
    assert_eq!(signed_in_known(&s.switcher.check(&request)), Some(false));
    assert_eq!(s.load(&s.a), None);
    s.pair(&s.b, 5);
    assert_eq!(
        s.switcher.run(&s.request()).reason,
        Some(ExtensionReason::UnknownAccount)
    );
    assert_eq!(s.stored(), Some(sign_in_for(&stranger, 1)));
}

#[test]
fn the_pair_the_profiles_claude_ai_login_is_saved_for_the_account_the_hints_name_and_the_targets_pair_is_put_in_place()
 {
    let s = setup();
    s.store(sign_in_for(&s.a, 1));
    s.set_web(login_for(&s.a, 1));
    s.pair(&s.b, 5);
    let outcome = s.switcher.run(&s.request());
    assert_eq!(outcome.result, ExtensionResult::Switched);
    assert_eq!(s.stored(), Some(sign_in_for(&s.b, 5)));
    assert_eq!(s.web(), Some(login_for(&s.b, 5)));
    // The snapshot on leave: A's login, as the profile held it, is sealed in the vault.
    assert_eq!(s.load_login(&s.a), Some(login_for(&s.a, 1)));
    assert!(!s.scratch.exists());
    assert!(!s.cookie_scratch().exists());
}

#[test]
fn a_login_is_sealed_no_cookie_byte_or_account_uuid_is_readable_in_the_vault_file() {
    let s = setup();
    s.cookie_vault.save(&s.a, &login_for(&s.a, 1)).unwrap();
    let dir = s.temp.path().join("vault").join("extension-cookies");
    let raw = fs::read(dir.join(format!("{}.bin", s.a.to_lowercase()))).unwrap();
    let text = String::from_utf8_lossy(&raw);
    assert!(
        !text.contains("SESSION-SECRET")
            && !text.contains("sessionKey")
            && !text.contains("claude.ai")
    );
    let listed: Vec<String> = s
        .cookie_vault
        .list()
        .into_iter()
        .map(|x| x.account_uuid)
        .collect();
    assert_eq!(listed, [s.a.to_lowercase()]);
    // Another account's file is not opened for this one.
    fs::copy(
        dir.join(format!("{}.bin", s.a.to_lowercase())),
        dir.join(format!("{}.bin", s.b.to_lowercase())),
    )
    .unwrap();
    assert!(s.cookie_vault.load(std::slice::from_ref(&s.b)).is_err());
}

#[test]
fn a_vault_record_holding_rows_that_are_not_a_login_is_refused_on_save_and_on_load() {
    let s = setup();
    let mut bad = login_for(&s.a, 1);
    let mut row = bad.rows[0].clone();
    row.insert("host_key".into(), CookieValue::Text(".bank.example".into()));
    row.insert("name".into(), CookieValue::Text("session".into()));
    bad.rows.push(row);
    assert!(s.cookie_vault.save(&s.a, &bad).is_err());
    assert!(
        s.cookie_vault
            .save("not-a-uuid", &login_for(&s.a, 1))
            .is_err()
    );
}

#[test]
fn a_target_with_hints_but_no_saved_login_is_not_half_swapped() {
    let s = setup();
    s.store(sign_in_for(&s.a, 1));
    s.set_web(login_for(&s.a, 1));
    s.vault.save(&s.b, &sign_in_for(&s.b, 5)).unwrap();
    let outcome = s.switcher.run(&s.request());
    assert_eq!(outcome.result, ExtensionResult::Saved);
    assert_eq!(outcome.reason, Some(ExtensionReason::NoSavedLogin));
    assert_eq!(s.stored(), Some(sign_in_for(&s.a, 1)));
    assert_eq!(s.web(), Some(login_for(&s.a, 1)));
    // Both of A's halves were kept.
    assert_eq!(s.load_login(&s.a), Some(login_for(&s.a, 1)));
}

#[test]
fn a_failed_cookie_write_puts_both_the_hints_and_the_cookie_files_back() {
    for (fail, reason) in [
        (CookieStoreReason::Mismatch, ExtensionReason::VerifyFailed),
        (
            CookieStoreReason::SchemaChanged,
            ExtensionReason::SchemaChanged,
        ),
        (
            CookieStoreReason::JournalPending,
            ExtensionReason::JournalPending,
        ),
        (CookieStoreReason::Locked, ExtensionReason::Locked),
        (CookieStoreReason::Failed, ExtensionReason::WriteFailed),
    ] {
        let s = setup();
        s.store(sign_in_for(&s.a, 1));
        s.set_web(login_for(&s.a, 1));
        s.pair(&s.b, 5);
        s.world.state.lock().fail_cookie_write = Some(fail);
        let outcome = s.switcher.run(&s.request());
        assert_eq!(outcome.result, ExtensionResult::Failed);
        assert_eq!(outcome.reason, Some(reason));
        assert_eq!(
            fs::read_to_string(s.profile.join("Cookies")).unwrap(),
            s.profile.to_string_lossy(),
            "the cookie file is back"
        );
        assert_eq!(s.data_txt(), "ORIGINAL");
        assert!(!s.cookie_scratch().exists());
    }
}

#[test]
fn a_failed_restore_keeps_both_backups() {
    let s = setup();
    s.store(sign_in_for(&s.a, 1));
    s.set_web(login_for(&s.a, 1));
    s.pair(&s.b, 5);
    let mut state = s.world.state.lock();
    state.fail_cookie_write = Some(CookieStoreReason::Mismatch);
    // The cookie file becomes a folder, so putting it back fails.
    state.after_cookie_write = Some(Arc::new(|dir: &Path| {
        let _ = fs::remove_file(dir.join("Cookies"));
        fs::create_dir(dir.join("Cookies")).unwrap();
    }));
    drop(state);
    let outcome = s.switcher.run(&s.request());
    assert_eq!(outcome.reason, Some(ExtensionReason::RestoreFailed));
    assert!(s.cookie_scratch().exists());
}

#[test]
fn a_web_login_nobody_can_name_is_never_overwritten() {
    let s = setup();
    // The extension is signed out, yet the profile is logged in to claude.ai as someone.
    s.set_web(login_for(&uuid(), 1));
    s.pair(&s.b, 5);
    let outcome = s.switcher.run(&s.request());
    assert_eq!(outcome.result, ExtensionResult::Skipped);
    assert_eq!(outcome.reason, Some(ExtensionReason::UnknownAccount));
    assert_eq!(s.stored(), None);
    assert_ne!(s.web(), Some(login_for(&s.b, 5)));
}

#[test]
fn a_web_login_newer_than_the_hints_is_not_saved_under_the_hints_account() {
    let s = setup();
    s.store(sign_in_for(&s.a, 1));
    s.world
        .state
        .lock()
        .modified
        .insert(s.dir.clone(), 1_700_000_000_000.0);
    // Created an hour after the hints were last written: the user signed in to claude.ai again.
    s.set_web(login_at(&s.a, 1, 1_700_000_000_000 + 3_600_000));
    s.pair(&s.b, 5);
    let outcome = s.switcher.run(&s.request());
    assert_eq!(outcome.result, ExtensionResult::Skipped);
    assert_eq!(outcome.reason, Some(ExtensionReason::AmbiguousOwner));
    assert_eq!(s.load_login(&s.a), None);
    assert_eq!(s.stored(), Some(sign_in_for(&s.a, 1)));
}

#[test]
fn a_claude_ai_login_cookie_this_build_does_not_list_stops_the_swap() {
    type Layouts = Arc<Mutex<Vec<Vec<(String, String)>>>>;
    let layouts: Layouts = Arc::default();
    let sink = layouts.clone();
    let s = setup_with(|ports| {
        ports.on_cookie_layout = Some(Box::new(move |detail| {
            sink.lock()
                .unwrap()
                .push(detail.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        }));
    });
    s.store(sign_in_for(&s.a, 1));
    let mut web = login_for(&s.a, 1);
    web.unlisted = vec!["sessionKeyV9".into()];
    s.set_web(web);
    s.pair(&s.b, 5);
    let outcome = s.switcher.run(&s.request());
    assert_eq!(outcome.reason, Some(ExtensionReason::SchemaChanged));
    assert_eq!(s.stored(), Some(sign_in_for(&s.a, 1)));
    // The log learns which cookie it was, by name.
    assert_eq!(
        *layouts.lock().unwrap(),
        [vec![
            ("why".to_owned(), "unlisted".to_owned()),
            ("names".to_owned(), "sessionKeyV9".to_owned())
        ]]
    );
}

#[test]
fn without_sqlite_nothing_is_quit_read_or_written() {
    let s = setup();
    {
        let mut state = s.world.state.lock();
        state.running = true;
        state.cookies_available = false;
    }
    s.store(sign_in_for(&s.a, 1));
    let outcome = s.switcher.run(&s.request());
    assert_eq!(outcome.reason, Some(ExtensionReason::Unavailable));
    assert!(s.world.events().is_empty());
    assert!(s.world.opened().is_empty());
}

#[test]
fn a_switcher_built_without_the_cookie_ports_changes_nothing() {
    let s = setup();
    let bare = ExtensionSwitcher::new(ExtensionPorts::new(
        s.world.system.clone(),
        s.world.storage.clone(),
        s.vault.clone(),
        &s.scratch,
    ));
    s.store(sign_in_for(&s.a, 1));
    assert_eq!(
        bare.run(&s.request()).reason,
        Some(ExtensionReason::Unavailable)
    );
    assert_eq!(s.stored(), Some(sign_in_for(&s.a, 1)));
}

#[test]
fn the_cookie_database_is_only_opened_with_the_browser_closed_and_the_browser_comes_back() {
    let s = setup();
    s.running(true);
    s.store(sign_in_for(&s.a, 1));
    s.set_web(login_for(&s.a, 1));
    s.pair(&s.b, 5);
    let outcome = s.switcher.run(&s.request());
    assert_eq!(outcome.result, ExtensionResult::Switched);
    assert_eq!(s.world.events(), ["quit:brave", "launch:brave"]);
    let opened = s.world.opened();
    assert!(opened.iter().any(|(dir, _)| *dir == s.profile));
    assert!(opened.iter().all(|(_, running)| !running));
}

#[test]
fn mode_guide_writes_nothing_and_quits_nothing_it_says_when_the_extension_is_on_another_account() {
    let s = setup();
    s.running(true);
    s.store(sign_in_for(&s.a, 1));
    s.set_web(login_for(&s.a, 1));
    s.pair(&s.b, 5);
    let guide = ExtensionRequest {
        setting: setting(ExtensionMode::Guide),
        ..s.request()
    };
    let off = s.switcher.run(&guide);
    assert_eq!(off.result, ExtensionResult::Skipped);
    assert_eq!(off.reason, Some(ExtensionReason::GuideMismatch));
    assert!(!off.restarted);
    assert!(s.world.events().is_empty());
    assert_eq!(s.stored(), Some(sign_in_for(&s.a, 1)));
    assert_eq!(s.web(), Some(login_for(&s.a, 1)));
    // What the check saw is kept, so switching modes later needs no new sign-in.
    assert_eq!(s.load(&s.a), Some(sign_in_for(&s.a, 1)));
    assert_eq!(s.load_login(&s.a), Some(login_for(&s.a, 1)));
    // On the target already: nothing to say.
    let there = s.switcher.run(&ExtensionRequest {
        target: vec![s.a.clone()],
        ..guide.clone()
    });
    assert_eq!(there.result, ExtensionResult::Unchanged);
    // Signed out also reads as "not on the target".
    s.world.set_stored(&s.dir, None);
    assert_eq!(
        s.switcher.run(&guide).reason,
        Some(ExtensionReason::GuideMismatch)
    );
}

#[test]
fn a_check_keeps_the_profiles_login_and_replaces_a_saved_one_only_with_a_newer_one_the_extension_works_with()
 {
    let s = setup();
    s.running(true);
    let restart = || setting(ExtensionMode::Restart);
    s.store(sign_in_for(&s.a, 1));
    s.set_web(login_for(&s.a, 2));
    assert_eq!(state_of(&s.check(restart(), &[&s.a, &s.b])), "signed-in");
    assert_eq!(s.load_login(&s.a), Some(login_for(&s.a, 2)));
    // A copy that lags the running browser (an older login) never replaces the saved one.
    s.set_web(login_for(&s.a, 1));
    s.check(restart(), &[&s.a, &s.b]);
    assert_eq!(s.load_login(&s.a), Some(login_for(&s.a, 2)));
    // Nor does a newer one while the extension records a failed sign-in with it.
    let mut failing = sign_in_for(&s.a, 1);
    failing.insert("lastAuthFailureReason", "\"session_expired\"".to_owned());
    s.store(failing);
    s.set_web(login_for(&s.a, 3));
    s.check(restart(), &[&s.a, &s.b]);
    assert_eq!(s.load_login(&s.a), Some(login_for(&s.a, 2)));
    // Working again, the newer login is kept.
    s.store(sign_in_for(&s.a, 1));
    s.check(restart(), &[&s.a, &s.b]);
    assert_eq!(s.load_login(&s.a), Some(login_for(&s.a, 3)));
    assert!(s.world.events().is_empty());
    assert!(!s.peek().exists());
}

#[test]
fn a_login_that_is_not_the_extensions_accounts_newer_than_the_hints_is_not_kept_by_a_check() {
    let s = setup();
    s.store(sign_in_for(&s.a, 1));
    s.world
        .state
        .lock()
        .modified
        .insert(s.dir.clone(), 1_700_000_000_000.0);
    s.set_web(login_at(&s.a, 1, 1_700_000_000_000 + 3_600_000));
    s.check(setting(ExtensionMode::Restart), &[&s.a, &s.b]);
    assert_eq!(s.load_login(&s.a), None);
}

#[test]
fn arc_chrome_beta_dev_and_canary_dia_and_comet_are_looked_in_each_in_its_own_folder() {
    let s = setup();
    let arc = s
        .world
        .install_with(BrowserApp::Arc, "Default", "Arc", true);
    let canary = s
        .world
        .install_with(BrowserApp::ChromeCanary, "Profile 1", "Canary", true);
    s.world.install(BrowserApp::ChromeBeta);
    s.world.install(BrowserApp::ChromeDev);
    s.world.install(BrowserApp::Dia);
    s.world.install(BrowserApp::Comet);
    assert_eq!(
        arc,
        s.world
            .support
            .join("Arc")
            .join("User Data")
            .join("Default")
            .join("Local Extension Settings")
            .join("fcoeoabgfenejglbffodgkkbkcdhcgfn")
    );
    assert!(
        canary.starts_with(
            s.world
                .support
                .join("Google")
                .join("Chrome Canary")
                .join("Profile 1")
        )
    );
    let listed: Vec<String> = s
        .switcher
        .instances()
        .iter()
        .map(|i| format!("{}:{}:{}", i.app.as_str(), i.profile, i.opened))
        .collect();
    assert_eq!(
        listed,
        [
            "brave:Default:true",
            "arc:Default:true",
            "chrome-beta:Default:true",
            "chrome-dev:Default:true",
            "chrome-canary:Profile 1:true",
            "dia:Default:true",
            "comet:Default:true",
        ]
    );
    // A chosen one of them is read like any other.
    s.world.set_stored(&arc, Some(sign_in_for(&s.a, 2)));
    let chosen = ExtensionSetting {
        mode: ExtensionMode::Guide,
        browser: Some(ExtensionTarget {
            app: BrowserApp::Arc,
            profile: "Default".into(),
        }),
    };
    assert_eq!(
        signed_in_account(&s.check(chosen, &[&s.a])),
        Some(s.a.to_lowercase())
    );
}

#[test]
fn an_extension_installed_but_never_opened_is_listed_reads_as_signed_out_and_is_never_swapped() {
    let s = setup();
    let dir = s
        .world
        .install_with(BrowserApp::Chrome, "Default", "Kişi 1", false);
    // A profile without the extension at all is not listed.
    let local_state = s
        .world
        .support
        .join("Google")
        .join("Chrome")
        .join("Local State");
    let mut local: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&local_state).unwrap()).unwrap();
    local["profile"]["info_cache"]["Profile 2"] = serde_json::json!({ "name": "Bare" });
    fs::write(&local_state, local.to_string()).unwrap();
    fs::create_dir_all(
        s.world
            .support
            .join("Google")
            .join("Chrome")
            .join("Profile 2"),
    )
    .unwrap();
    let instances = s.switcher.instances();
    let listed: Vec<String> = instances
        .iter()
        .map(|i| format!("{}:{}:{}", i.app.as_str(), i.profile, i.opened))
        .collect();
    assert_eq!(listed, ["chrome:Default:false", "brave:Default:true"]);
    assert_eq!(instances[0].used_at, None);
    let chrome = ExtensionTarget {
        app: BrowserApp::Chrome,
        profile: "Default".into(),
    };
    let current = s.check(
        ExtensionSetting {
            mode: ExtensionMode::Guide,
            browser: Some(chrome.clone()),
        },
        &[&s.a, &s.b],
    );
    let at = match &current {
        Some(ExtensionCurrent::SignedOut { at, .. }) => at.clone(),
        other => panic!("{other:?}"),
    };
    assert_eq!(
        current,
        Some(ExtensionCurrent::SignedOut {
            unopened: Some(true),
            at
        })
    );
    assert!(s.world.opened().is_empty(), "nothing is opened for it");
    // A swap leaves it alone, even with a complete pair saved and the browser running.
    s.pair(&s.b, 5);
    s.running(true);
    let swap = s.switcher.run(&ExtensionRequest {
        setting: ExtensionSetting {
            mode: ExtensionMode::Restart,
            browser: Some(chrome.clone()),
        },
        ..s.request()
    });
    assert_eq!(
        (swap.result, swap.reason, swap.restarted),
        (
            ExtensionResult::Skipped,
            Some(ExtensionReason::NotOpened),
            false
        )
    );
    assert!(s.world.events().is_empty(), "the browser is not quit");
    assert!(s.world.opened().is_empty());
    assert!(!dir.exists(), "no storage is made for it");
    // Mode "guide" says so too, with what it saw.
    let guide = s.switcher.run(&ExtensionRequest {
        setting: ExtensionSetting {
            mode: ExtensionMode::Guide,
            browser: Some(chrome),
        },
        ..s.request()
    });
    assert_eq!(guide.reason, Some(ExtensionReason::NotOpened));
    assert!(matches!(
        guide.current,
        Some(ExtensionCurrent::SignedOut {
            unopened: Some(true),
            ..
        })
    ));
    // The only one found is managed: Brave gone, Chrome is still left alone.
    fs::remove_dir_all(s.world.support.join("BraveSoftware")).unwrap();
    assert_eq!(
        s.switcher.run(&s.request()).reason,
        Some(ExtensionReason::NotOpened)
    );
}

/// What extension 1.0.105 keeps after a failed sign-in: tools are refused until one works.
fn failed(mut signed: SignIn) -> SignIn {
    signed.insert("lastAuthFailureReason", "\"session_expired\"".to_owned());
    signed.insert(
        "startupReauthState",
        serde_json::json!({ "terminal": true, "stop": "definitive", "lastProbeAt": 1 }).to_string(),
    );
    signed.insert(
        "pairingOrgMismatch",
        serde_json::json!({ "org": "11111111-1111-4111-8111-111111111111" }).to_string(),
    );
    signed
}

#[test]
fn a_failed_sign_ins_record_is_never_saved_with_an_account_and_never_put_back() {
    let s = setup();
    s.store(failed(sign_in_for(&s.a, 1)));
    // A record Relay 0.14.1 kept for B along with its failure.
    let dir = s.temp.path().join("vault").join("extension");
    fs::create_dir_all(&dir).unwrap();
    let (seal, _) = sealer();
    let record = serde_json::json!({
        "accountUuid": s.b,
        "savedAt": "2026-11-02T20:12:07.000Z",
        "signIn": failed(sign_in_for(&s.b, 5)),
    });
    fs::write(
        dir.join(format!("{}.bin", s.b)),
        seal(&record.to_string()).unwrap(),
    )
    .unwrap();
    s.cookie_vault.save(&s.b, &login_for(&s.b, 5)).unwrap();
    let outcome = s.switcher.run(&s.request());
    assert_eq!(outcome.result, ExtensionResult::Switched);
    assert_eq!(
        s.stored(),
        Some(sign_in_for(&s.b, 5)),
        "B's record goes without its failure"
    );
    // A's pair failed to sign in: it is dead, and saving it would put it back at the next switch to A.
    assert_eq!(
        s.load(&s.a),
        None,
        "a pair the extension failed with is not saved"
    );
    assert_eq!(s.load(&s.b), Some(sign_in_for(&s.b, 5)));
}

#[test]
fn already_on_the_target_with_a_failed_sign_ins_record_the_record_goes_nothing_else_changes() {
    let s = setup();
    s.pair(&s.b, 1);
    s.set_web(login_for(&s.b, 2));
    s.store(failed(sign_in_for(&s.b, 3)));
    let outcome = s.switcher.run(&s.request());
    assert_eq!(
        (
            outcome.result,
            outcome.reason,
            outcome.cleared,
            outcome.saved
        ),
        (
            ExtensionResult::Unchanged,
            Some(ExtensionReason::AlreadyThere),
            Some(true),
            false
        )
    );
    assert_eq!(s.stored(), Some(sign_in_for(&s.b, 3)));
    assert_eq!(
        s.web(),
        Some(login_for(&s.b, 2)),
        "the claude.ai login is left as it is"
    );
    // The pair failed: the vault keeps B's older one.
    assert_eq!(s.load(&s.b), Some(sign_in_for(&s.b, 1)));
    // Without a record there is nothing to write.
    let opened = s.world.opened().len();
    let again = s.switcher.run(&s.request());
    assert_eq!(again.cleared, None);
    let reads = s.world.opened()[opened..]
        .iter()
        .filter(|(dir, _)| *dir == s.dir)
        .count();
    assert_eq!(reads, 1, "the folder is only read");
}

#[test]
fn the_record_goes_even_when_the_targets_claude_ai_login_was_never_saved() {
    let s = setup();
    s.store(failed(sign_in_for(&s.b, 3)));
    let outcome = s.switcher.run(&s.request());
    assert_eq!(
        (outcome.result, outcome.reason, outcome.cleared),
        (
            ExtensionResult::Unchanged,
            Some(ExtensionReason::AlreadyThere),
            Some(true)
        )
    );
    assert_eq!(s.stored(), Some(sign_in_for(&s.b, 3)));
}

#[test]
fn a_failed_removal_of_the_record_puts_the_folder_back() {
    let s = setup();
    s.pair(&s.b, 1);
    s.set_web(login_for(&s.b, 2));
    s.store(failed(sign_in_for(&s.b, 3)));
    s.world.state.lock().fail_write = Some(StorageReason::Failed);
    let outcome = s.switcher.run(&s.request());
    assert_eq!(
        (outcome.result, outcome.reason),
        (ExtensionResult::Failed, Some(ExtensionReason::WriteFailed))
    );
    assert_eq!(s.data_txt(), "ORIGINAL");
    assert!(!s.scratch.exists());
}

#[test]
fn a_check_says_when_the_extensions_sign_in_expired_and_saves_it_without_the_record() {
    let s = setup();
    s.running(true);
    s.store(failed(sign_in_for(&s.a, 3)));
    let current = s.check(default_extension(), &[&s.a, &s.b]);
    assert_eq!(signed_in_account(&current), Some(s.a.to_lowercase()));
    assert!(matches!(
        current,
        Some(ExtensionCurrent::SignedIn {
            expired: Some(true),
            ..
        })
    ));
    assert_eq!(s.load(&s.a), Some(sign_in_for(&s.a, 3)));
    s.store(sign_in_for(&s.a, 4));
    let fresh = s.check(default_extension(), &[&s.a, &s.b]);
    assert!(matches!(
        fresh,
        Some(ExtensionCurrent::SignedIn { expired: None, .. })
    ));
}

/// A login on an organization: the browser encrypts the same organization id to the same bytes.
fn on_org(login: CookieSnapshot, org: &str) -> CookieSnapshot {
    let mut login = login;
    let mut row = login.rows[0].clone();
    row.insert("name".into(), CookieValue::Text("lastActiveOrg".into()));
    row.insert(
        "encrypted_value".into(),
        CookieValue::Blob(format!("v10ORG-{org}").into_bytes()),
    );
    login.rows.push(row);
    login
}

#[test]
fn a_claude_ai_login_already_saved_for_another_account_is_never_kept_as_the_hints_accounts() {
    let told: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = told.clone();
    let s = setup_with(|ports| {
        ports.on_foreign_login = Some(Box::new(move |account, other, why| {
            sink.lock()
                .unwrap()
                .push(format!("{account}:{other}:{}", why.as_str()))
        }));
    });
    // The user signed in to claude.ai with B while the extension stayed on A: the login is B's.
    s.store(sign_in_for(&s.a, 1));
    s.set_web(login_for(&s.b, 5));
    s.pair(&s.b, 5);
    let outcome = s.switcher.run(&s.request());
    assert_eq!(outcome.result, ExtensionResult::Switched);
    assert_eq!(
        s.load(&s.a),
        Some(sign_in_for(&s.a, 1)),
        "A's hints are kept"
    );
    assert_eq!(s.load_login(&s.a), None, "B's login is not kept as A's");
    assert_eq!(
        *told.lock().unwrap(),
        [format!("{}:{}:same-login", s.a, s.b)]
    );
}

#[test]
fn a_login_on_another_accounts_organization_is_not_kept_when_their_organizations_differ() {
    let s = setup();
    s.store(sign_in_for(&s.a, 1));
    // A second claude.ai login of B (another session), on B's organization.
    s.set_web(on_org(login_for(&s.a, 9), "org-b"));
    s.vault.save(&s.b, &sign_in_for(&s.b, 5)).unwrap();
    s.cookie_vault
        .save(&s.b, &on_org(login_for(&s.b, 5), "org-b"))
        .unwrap();
    s.switcher.run(&ExtensionRequest {
        orgs: orgs(&[(&s.a, "org-a"), (&s.b, "org-b")]),
        ..s.request()
    });
    assert_eq!(s.load_login(&s.a), None);
    // Two seats of one organization share it: that says nothing, and the login is kept.
    let s2 = setup();
    s2.store(sign_in_for(&s2.a, 1));
    s2.set_web(on_org(login_for(&s2.a, 9), "org-team"));
    s2.vault.save(&s2.b, &sign_in_for(&s2.b, 5)).unwrap();
    s2.cookie_vault
        .save(&s2.b, &on_org(login_for(&s2.b, 5), "org-team"))
        .unwrap();
    s2.switcher.run(&ExtensionRequest {
        orgs: orgs(&[(&s2.a, "org-team"), (&s2.b, "org-team")]),
        ..s2.request()
    });
    assert_eq!(
        s2.load_login(&s2.a),
        Some(on_org(login_for(&s2.a, 9), "org-team"))
    );
}

#[test]
fn a_check_never_keeps_another_accounts_claude_ai_login_either() {
    let s = setup();
    s.running(true);
    s.store(sign_in_for(&s.a, 3));
    s.set_web(login_for(&s.b, 5));
    s.cookie_vault.save(&s.b, &login_for(&s.b, 5)).unwrap();
    let current = s.check(default_extension(), &[&s.a, &s.b]);
    assert_eq!(signed_in_account(&current), Some(s.a.to_lowercase()));
    assert_eq!(s.load_login(&s.a), None);
    // Its own login is kept.
    s.set_web(login_for(&s.a, 3));
    s.check(default_extension(), &[&s.a, &s.b]);
    assert_eq!(s.load_login(&s.a), Some(login_for(&s.a, 3)));
}

#[test]
fn a_rejected_login_is_forgotten_waits_for_a_reconnect_and_is_never_kept_for_that_account_again() {
    let s = setup();
    s.cookie_vault.save(&s.b, &login_for(&s.b, 5)).unwrap();
    s.cookie_vault.reject(&s.b).unwrap();
    assert_eq!(s.load_login(&s.b), None);
    assert!(
        s.cookie_vault.list().is_empty(),
        "the rejection file is not an account's"
    );
    assert_eq!(
        s.cookie_vault.waiting().map(|w| w.account_uuid),
        Some(s.b.to_lowercase())
    );
    assert!(s.cookie_vault.is_rejected(&s.b, &login_for(&s.b, 5)));
    assert!(
        !s.cookie_vault
            .is_rejected(&s.b, &login_at(&s.b, 5, 1_800_000_000_000))
    );
    assert!(!s.cookie_vault.is_rejected(&s.a, &login_for(&s.b, 5)));
    // The switch away from B saves B's hints, never that login again.
    s.store(sign_in_for(&s.b, 6));
    s.set_web(login_for(&s.b, 5));
    s.pair(&s.a, 1);
    s.switcher.run(&ExtensionRequest {
        target: vec![s.a.clone()],
        ..s.request()
    });
    assert_eq!(s.load(&s.b), Some(sign_in_for(&s.b, 6)));
    assert_eq!(s.load_login(&s.b), None);
    // Signed in fine again: no longer waiting; the login stays rejected.
    s.cookie_vault.reconnected(&s.b).unwrap();
    assert_eq!(s.cookie_vault.waiting(), None);
    assert!(s.cookie_vault.is_rejected(&s.b, &login_for(&s.b, 5)));
}

#[test]
fn a_login_saved_under_the_same_accounts_other_uuid_is_not_another_accounts() {
    let s = setup();
    let alias = uuid();
    s.store(sign_in_for(&s.a, 1));
    s.set_web(login_for(&s.a, 2));
    s.cookie_vault.save(&alias, &login_for(&s.a, 2)).unwrap();
    s.pair(&s.b, 5);
    s.switcher.run(&ExtensionRequest {
        known: vec![s.a.clone(), s.b.clone(), alias.clone()],
        groups: Some(vec![vec![s.a.clone(), alias.clone()], vec![s.b.clone()]]),
        ..s.request()
    });
    assert_eq!(s.load_login(&s.a), Some(login_for(&s.a, 2)));
}

/// `login` with its `sessionKey` ending at `ends_ms` (ms since the epoch).
fn ending_at(login: CookieSnapshot, ends_ms: i64) -> CookieSnapshot {
    let mut login = login;
    login
        .columns
        .extend(["expires_utc".to_owned(), "has_expires".to_owned()]);
    for row in &mut login.rows {
        row.insert(
            "expires_utc".into(),
            CookieValue::Integer((ends_ms + 11_644_473_600_000) * 1000),
        );
        row.insert("has_expires".into(), CookieValue::Integer(1));
    }
    login
}

#[test]
fn a_fresh_login_of_another_accounts_organization_is_kept_for_that_account_even_after_its_old_one_was_forgotten()
 {
    let fresh: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = fresh.clone();
    let s = setup_with(|ports| {
        ports.on_fresh_login = Some(Box::new(move |account, from| {
            sink.lock().unwrap().push(format!("{account}<{from}"))
        }));
    });
    let request = |s: &S| {
        let mut r = check_request(setting(ExtensionMode::Restart), &[&s.a, &s.b]);
        r.orgs = orgs(&[(&s.a, "org-a"), (&s.b, "org-b")]);
        r
    };
    // B's old login, on B's organization, was put in place once and failed: Relay forgot it.
    s.cookie_vault
        .save(&s.b, &on_org(login_at(&s.b, 1, 1_700_000_000_000), "org-b"))
        .unwrap();
    s.cookie_vault.reject(&s.b).unwrap();
    assert_eq!(s.load_login(&s.b), None);
    // The extension is on A; the user signed in to claude.ai with B in that profile.
    s.running(true);
    s.store(sign_in_for(&s.a, 1));
    let login = on_org(login_at(&s.b, 2, 1_700_000_500_000), "org-b");
    s.set_web(login.clone());
    s.switcher.check(&request(&s));
    assert_eq!(s.load_login(&s.b), Some(login.clone()), "kept for B");
    assert_eq!(s.load_login(&s.a), None, "never for A");
    assert_eq!(
        *fresh.lock().unwrap(),
        [format!("{}<{}", s.b.to_lowercase(), s.a.to_lowercase())]
    );
    // An older login of B's organization never replaces it.
    s.set_web(on_org(login_at(&s.b, 3, 1_700_000_100_000), "org-b"));
    s.switcher.check(&request(&s));
    assert_eq!(s.load_login(&s.b), Some(login));
}

#[test]
fn a_switch_keeps_a_fresh_login_of_the_targets_organization_for_it_even_while_the_extension_failed_with_it()
 {
    let s = setup();
    s.vault.save(&s.b, &sign_in_for(&s.b, 1)).unwrap();
    s.cookie_vault
        .save(&s.b, &on_org(login_at(&s.b, 1, 1_700_000_000_000), "org-b"))
        .unwrap();
    // On A, failing: the profile's login is B's (the user signed in with B on claude.ai).
    let mut failing = sign_in_for(&s.a, 1);
    failing.insert("lastAuthFailureReason", "\"session_expired\"".to_owned());
    s.store(failing);
    let login = on_org(login_at(&s.b, 2, 1_700_000_900_000), "org-b");
    s.set_web(login.clone());
    let outcome = s.switcher.run(&ExtensionRequest {
        orgs: orgs(&[(&s.a, "org-a"), (&s.b, "org-b")]),
        ..s.request()
    });
    assert_eq!(outcome.result, ExtensionResult::Switched);
    // The fresh login is the one put in place for B, not B's older one.
    assert_eq!(s.web(), Some(login.clone()));
    assert_eq!(s.load_login(&s.b), Some(login));
}

#[test]
fn a_saved_login_left_unused_until_its_cookie_ended_is_not_put_back_the_account_waits_for_a_reconnect()
 {
    let clock: Clock = Arc::new(|| 1_800_000_000_000);
    let s = setup_with(|ports| ports.now = Some(clock.clone()));
    s.vault.save(&s.b, &sign_in_for(&s.b, 1)).unwrap();
    s.cookie_vault
        .save(&s.b, &ending_at(login_for(&s.b, 1), 1_799_000_000_000))
        .unwrap();
    s.store(sign_in_for(&s.a, 1));
    s.set_web(login_for(&s.a, 1));
    let outcome = s.switcher.run(&s.request());
    assert_eq!(outcome.result, ExtensionResult::Skipped);
    assert_eq!(outcome.reason, Some(ExtensionReason::LoginExpired));
    assert!(outcome.saved, "A's pair is still saved on the way out");
    assert_eq!(
        s.stored(),
        Some(sign_in_for(&s.a, 1)),
        "the extension stays as it was"
    );
    assert_eq!(s.web(), Some(login_for(&s.a, 1)));
    assert_eq!(s.load_login(&s.b), None);
    assert!(s.cookie_vault.is_waiting(&s.b));
    // One that has not ended yet is put in place.
    let s2 = setup_with(|ports| ports.now = Some(clock.clone()));
    s2.vault.save(&s2.b, &sign_in_for(&s2.b, 1)).unwrap();
    s2.cookie_vault
        .save(&s2.b, &ending_at(login_for(&s2.b, 1), 1_801_000_000_000))
        .unwrap();
    s2.store(sign_in_for(&s2.a, 1));
    s2.set_web(login_for(&s2.a, 1));
    assert_eq!(
        s2.switcher.run(&s2.request()).result,
        ExtensionResult::Switched
    );
}
