//! Port of `tests/cli-switch.test.ts`: `relay switch` and `relay recover`. macOS only, as the TS
//! skips elsewhere.
#![cfg(target_os = "macos")]

mod common;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use common::{Fixture, Options, cli_fixture};
use relay_cli::io::{Signal, SignalHandler};
use relay_core::browser_system::BrowserSystem;
use relay_core::desktop::ExtensionPorts;
use relay_core::desktop_files::{JsonObject, json_bytes, read_object, write_bytes};
use relay_core::extension_storage::{ExtensionStorage, StorageError, StorageReason};
use relay_core::shared::browser_extension::{BrowserApp, CLAUDE_EXTENSION_ID, browser};
use relay_core::shared::extension_auth::SignIn;
use relay_core::terminal_identity::{
    TerminalConfig, TerminalError, TerminalKeychain, TerminalPorts,
};
use serde_json::json;

fn identity(claude: &Path) -> Option<String> {
    read_object(claude, "config.json").unwrap().and_then(|o| {
        o.get("lastKnownAccountUuid")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
    })
}

fn tty(answer: &str) -> Options {
    Options {
        tty: true,
        answers: vec![Some(answer.into())],
        ..Options::default()
    }
}

/// A fixture with A and B saved; Desktop is signed in to B.
fn with_two(options: Options) -> Fixture {
    let f = cli_fixture(options);
    f.saved("A", None);
    f.saved("B", None);
    f
}

/// The extension world of `tests/extension-world.ts`, as the TS CLI fixture sets it up: browsers
/// in a home of their own, and an extension storage the shipped CLI cannot use (no LevelDB).
#[derive(Default)]
struct ExtState {
    running: bool,
    events: Vec<String>,
    opened: Vec<PathBuf>,
    stored: HashMap<PathBuf, SignIn>,
}

struct FakeSystem {
    support: PathBuf,
    state: Arc<Mutex<ExtState>>,
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
    fn modified_at(&self, _: &Path) -> Option<f64> {
        None
    }
    fn read_link(&self, _: &Path) -> Option<String> {
        None
    }
    fn alive(&self, _: i64) -> bool {
        false
    }
    fn processes(&self) -> Result<String, String> {
        Ok(if self.state.lock().unwrap().running {
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser\n".into()
        } else {
            String::new()
        })
    }
    fn quit(&self, app: BrowserApp) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        state.events.push(format!("quit:{}", app.as_str()));
        state.running = false;
        Ok(())
    }
    fn launch(&self, app: BrowserApp) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        state.events.push(format!("launch:{}", app.as_str()));
        state.running = true;
        Ok(())
    }
    fn open_url(&self, app: BrowserApp, url: &str, profile: &str) -> Result<(), String> {
        self.state
            .lock()
            .unwrap()
            .events
            .push(format!("open:{}:{profile}:{url}", app.as_str()));
        Ok(())
    }
    fn sleep(&self, _: u64) {}
}

struct FakeStorage {
    state: Arc<Mutex<ExtState>>,
}

impl ExtensionStorage for FakeStorage {
    fn available(&self) -> bool {
        false
    }
    fn read(&self, dir: &Path) -> Result<Vec<(String, String)>, StorageError> {
        let mut state = self.state.lock().unwrap();
        state.opened.push(dir.to_path_buf());
        Ok(state
            .stored
            .get(dir)
            .map(|s| s.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default())
    }
    fn write(&self, dir: &Path, _: &SignIn) -> Result<(), StorageError> {
        self.state.lock().unwrap().opened.push(dir.to_path_buf());
        Err(StorageError::new(
            StorageReason::Failed,
            "the fixture never writes",
        ))
    }
}

struct Extension {
    support: PathBuf,
    state: Arc<Mutex<ExtState>>,
}

impl Extension {
    /// Sets the world up as `f.deps.extension`.
    fn attach(f: &mut Fixture) -> Extension {
        let support = f
            .temp()
            .join("home")
            .join("Library")
            .join("Application Support");
        let state = Arc::new(Mutex::new(ExtState::default()));
        f.deps.extension = Some(ExtensionPorts {
            system: Arc::new(FakeSystem {
                support: support.clone(),
                state: state.clone(),
            }),
            storage: Arc::new(FakeStorage {
                state: state.clone(),
            }),
            cookies: None,
        });
        Extension { support, state }
    }

    /// A Default profile with the extension installed and opened; its storage folder.
    fn install(&self, app: BrowserApp) -> PathBuf {
        let data = self.support.join(browser(app).data_dir);
        fs::create_dir_all(&data).unwrap();
        fs::write(
            data.join("Local State"),
            json!({ "profile": { "info_cache": { "Default": { "name": "Default" } } } })
                .to_string(),
        )
        .unwrap();
        fs::create_dir_all(
            data.join("Default/Extensions")
                .join(CLAUDE_EXTENSION_ID)
                .join("1.0.102_0"),
        )
        .unwrap();
        let dir = data
            .join("Default/Local Extension Settings")
            .join(CLAUDE_EXTENSION_ID);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("data.txt"), "ORIGINAL").unwrap();
        fs::write(dir.join("source.txt"), dir.to_string_lossy().as_bytes()).unwrap();
        fs::write(
            data.join("Default/Cookies"),
            data.join("Default").to_string_lossy().as_bytes(),
        )
        .unwrap();
        dir
    }
}

/// `signInFor` of `tests/extension-world.ts`: the extension's stored sign-in for an account.
fn sign_in_for(account_uuid: &str, n: i64) -> SignIn {
    let mut sign_in = SignIn::new();
    sign_in.insert("accountUuid", account_uuid.to_owned());
    sign_in.insert("token", format!("ext-{n}"));
    sign_in
}

/// A signed-out terminal in memory: nothing real is read or written.
struct NoKeychain;
impl TerminalKeychain for NoKeychain {
    fn read(&self) -> Result<Option<String>, TerminalError> {
        Ok(None)
    }
    fn write(&self, _: &str) -> Result<(), TerminalError> {
        Ok(())
    }
    fn remove(&self) -> Result<(), TerminalError> {
        Ok(())
    }
}
struct EmptyConfig;
impl TerminalConfig for EmptyConfig {
    fn read(&self) -> Result<Option<JsonObject>, TerminalError> {
        Ok(Some(JsonObject::new()))
    }
    fn write_account(&self, _: Option<&JsonObject>) -> Result<(), TerminalError> {
        Ok(())
    }
}
fn memory_terminal() -> TerminalPorts {
    TerminalPorts {
        keychain: Arc::new(NoKeychain),
        config: Arc::new(EmptyConfig),
        lock: Arc::new(|action: &mut dyn FnMut()| {
            action();
            Ok(())
        }),
        owner: None,
    }
}

#[test]
fn switch_yes_quits_claude_once_swaps_the_sign_in_and_reopens_it() {
    let f = cli_fixture(Options::default());
    let (a, _) = f.saved("A", None);
    f.saved("B", None);
    assert_eq!(f.run(&["switch", "a", "--yes"]), 0);
    assert_eq!(f.quits(), 1);
    assert_eq!(f.starts(), 1);
    assert_eq!(identity(&f.claude), Some(a.desktop.unwrap().account_uuid));
    assert!(f.out().contains("Switched to A"));
    assert!(!(f.out() + &f.err()).contains("FIXTURE-SECRET"));
}

#[test]
fn without_a_terminal_and_without_yes_it_exits_4_and_quits_nothing() {
    let f = with_two(Options::default());
    assert_eq!(f.run(&["switch", "A"]), 4);
    assert_eq!(f.quits(), 0);
    assert!(f.err().contains("--yes"));
}

#[test]
fn in_a_terminal_the_prompt_says_what_happens_declining_quits_nothing() {
    let f = with_two(tty("n"));
    assert_eq!(f.run(&["switch", "A"]), 1);
    assert_eq!(f.quits(), 0);
    let out = f.out();
    assert!(
        out.contains("The Claude app will quit and reopen signed in as A"),
        "{out}"
    );
    assert!(out.contains("Code sessions will stop"));
    assert!(out.contains("drafts"));
    assert!(out.contains("Code history"));
    let g = with_two(tty("y"));
    assert_eq!(g.run(&["switch", "A"]), 0);
    assert_eq!(g.quits(), 1);
}

#[test]
fn the_prompt_and_the_result_say_that_the_terminal_s_claude_follows_the_account() {
    let mut f = with_two(tty("n"));
    f.deps.terminal = Some(memory_terminal());
    assert_eq!(f.run(&["switch", "A"]), 1);
    assert!(
        f.out()
            .contains("terminal claude’s sign-in (Keychain and ~/.claude.json) will move to A too"),
        "{}",
        f.out()
    );
    let mut g = with_two(tty("y"));
    g.deps.terminal = f.deps.terminal.clone();
    assert_eq!(g.run(&["switch", "A"]), 0);
    assert!(g.out().to_lowercase().contains("terminal"));
    // With the terminal left alone, the prompt does not mention it.
    let h = with_two(tty("n"));
    assert_eq!(h.run(&["switch", "A"]), 1);
    assert!(!h.out().contains("terminal claude"));
}

#[test]
fn switching_to_the_active_account_changes_nothing() {
    let f = cli_fixture(Options::default());
    f.saved("A", None);
    assert_eq!(f.run(&["switch", "A", "--yes"]), 0);
    assert_eq!(f.quits(), 0);
    assert!(f.out().contains("already"));
}

#[test]
fn a_pending_sign_in_or_an_interrupted_switch_exits_3_before_anything() {
    let f = cli_fixture(Options::default());
    let (a, _) = f.saved("A", None);
    f.saved("B", None);
    let vault = f.vault();
    let pending = json!({ "profileId": a.id, "startedAt": relay_core::fs_util::iso_timestamp(relay_core::clock::now_ms()) });
    write_bytes(&vault, "pending.json", Some(&json_bytes(&pending))).unwrap();
    assert_eq!(f.run(&["switch", "A", "--yes"]), 3);
    assert!(f.err().contains("relay add --resume"));
    write_bytes(&vault, "pending.json", None).unwrap();
    write_bytes(
        &vault,
        "journal.json",
        Some(&json_bytes(
            &json!({ "backup": "11111111-2222-4333-8444-555555555555" }),
        )),
    )
    .unwrap();
    f.clear();
    assert_eq!(f.run(&["switch", "A", "--yes"]), 3);
    assert!(f.err().contains("relay recover"));
    assert_eq!(f.quits(), 0);
}

#[test]
fn claude_opened_during_the_switch_leaves_the_journal_and_points_to_relay_recover_which_restores_it()
 {
    let f = cli_fixture(Options::default());
    f.saved("A", None);
    let (b, _) = f.saved("B", None);
    let calls = Arc::new(AtomicI64::new(-1));
    {
        let mut st = f.state.lock().unwrap();
        let on_quit = calls.clone();
        st.on_quit = Some(Arc::new(move || on_quit.store(0, Ordering::SeqCst)));
        let (on_write, state) = (calls.clone(), Arc::downgrade(&f.state));
        st.on_write = Some(Arc::new(move || {
            if on_write.load(Ordering::SeqCst) >= 0
                && on_write.fetch_add(1, Ordering::SeqCst) + 1 >= 2
            {
                state.upgrade().unwrap().lock().unwrap().running = true;
            }
        }));
    }
    assert_eq!(f.run(&["switch", "A", "--yes"]), 1);
    assert!(f.err().contains("relay recover"));
    assert!(f.vault().join("journal.json").exists());
    {
        let mut st = f.state.lock().unwrap();
        st.on_write = None;
        st.on_quit = None;
    }
    f.clear();
    assert_eq!(f.run(&["recover", "--yes"]), 0);
    assert!(!f.vault().join("journal.json").exists());
    assert_eq!(identity(&f.claude), Some(b.desktop.unwrap().account_uuid));
    f.clear();
    assert_eq!(f.run(&["recover", "--yes"]), 0);
    assert!(f.out().contains("No backup to restore"));
}

#[test]
fn without_a_desktop_session_it_exits_5_before_quitting() {
    let f = with_two(Options {
        gui: Some(false),
        ..Options::default()
    });
    assert_eq!(f.run(&["switch", "A", "--yes"]), 5);
    assert_eq!(f.quits(), 0);
}

#[test]
fn signals_during_the_switch_do_not_stop_it_one_wait_line_is_printed() {
    let mut f = cli_fixture(Options::default());
    let (a, _) = f.saved("A", None);
    f.saved("B", None);
    // The quit hook sends the signals through the handler the CLI holds, as `f.signal` does.
    let held: Arc<Mutex<Option<SignalHandler>>> = Arc::new(Mutex::new(None));
    let (keep, original) = (held.clone(), f.io.on_signal.clone());
    f.io.on_signal = Arc::new(move |next| {
        *keep.lock().unwrap() = next.clone();
        original(next);
    });
    f.state.lock().unwrap().on_quit = Some(Arc::new(move || {
        let handler = held.lock().unwrap().clone();
        if let Some(handler) = handler {
            handler(Signal::Int);
            handler(Signal::Hup);
        }
    }));
    assert_eq!(f.run(&["switch", "A", "--yes"]), 0);
    assert_eq!(identity(&f.claude), Some(a.desktop.unwrap().account_uuid));
    assert_eq!(
        f.err().split('\n').filter(|l| l.contains("wait")).count(),
        1
    );
    assert!(!f.has_signal_handler());
}

#[test]
fn a_refused_automation_permission_explains_where_to_grant_it() {
    let f = with_two(Options::default());
    f.state.lock().unwrap().fail_quit = Some(
        "Command failed: /usr/bin/osascript -e tell application id \"com.anthropic.claudefordesktop\" to quit\n0:62: execution error: Not authorized to send Apple events to Claude. (-1743)".into(),
    );
    assert_eq!(f.run(&["switch", "A", "--yes"]), 5);
    assert!(f.err().contains("Automation"));
}

#[test]
fn an_unknown_account_name_is_a_usage_error() {
    let f = cli_fixture(Options::default());
    f.saved("A", None);
    assert_eq!(f.run(&["switch", "Zed", "--yes"]), 2);
    assert_eq!(f.run(&["switch", "--yes"]), 2);
}

#[test]
fn relay_switch_leaves_the_claude_extension_and_its_browser_alone_and_says_where_to_sync_it() {
    let mut f = cli_fixture(Options::default());
    let (a, _) = f.saved("A", None);
    let (b, _) = f.saved("B", None);
    let extension = Extension::attach(&mut f);
    let dir = extension.install(BrowserApp::Brave);
    let b_uuid = b.desktop.unwrap().account_uuid;
    {
        let mut state = extension.state.lock().unwrap();
        state.stored.insert(dir.clone(), sign_in_for(&b_uuid, 2));
        state.running = true;
    }
    assert_eq!(f.run(&["switch", "A", "--yes"]), 0);
    // Nothing quit, nothing opened, nothing read or written.
    let state = extension.state.lock().unwrap();
    assert_eq!(state.events, Vec::<String>::new());
    assert_eq!(state.opened, Vec::<PathBuf>::new());
    assert!(state.stored.get(&dir) == Some(&sign_in_for(&b_uuid, 2)));
    let out = f.out();
    assert!(out.contains("Switched to A"));
    assert!(
        out.contains("This tool cannot change the Claude extension sign-in. In Relay.app, use Settings → Switching"),
        "{out}"
    );
    assert!(!(out + &f.err()).contains("SECRET"));
    assert_eq!(a.desktop.unwrap().account_uuid.len(), 36);
}

#[test]
fn relay_switch_says_nothing_about_the_extension_when_none_is_installed() {
    let mut f = with_two(Options::default());
    Extension::attach(&mut f);
    assert_eq!(f.run(&["switch", "A", "--yes"]), 0);
    assert!(!f.out().to_lowercase().contains("extension"));
}

#[test]
fn the_prompt_never_announces_a_browser_quit_since_the_cli_never_quits_one() {
    let mut f = with_two(tty("n"));
    let extension = Extension::attach(&mut f);
    extension.install(BrowserApp::Brave);
    extension.state.lock().unwrap().running = true;
    assert_eq!(f.run(&["switch", "A"]), 1);
    assert!(!f.out().contains("Brave"));
    assert_eq!(extension.state.lock().unwrap().events, Vec::<String>::new());
}
