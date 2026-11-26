//! `tests/cli-fixture.ts`: a Relay data folder, a Claude folder and a fake Claude host for running
//! the CLI in-process, plus the `security` stand-in of `tests/fake-security.ts`.
#![allow(dead_code, clippy::type_complexity)]

use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use relay_cli::deps::{CliDeps, default_deps};
use relay_cli::host::CliHost;
use relay_cli::io::{CliIo, Env, Signal, SignalHandler};
use relay_core::desktop::{
    AnswerGuard, DesktopError, DesktopHost, DesktopManager, DesktopResult, LaunchOptions,
};
use relay_core::desktop_files::{json_bytes, write_bytes};
use relay_core::process_lock::LockBy;
use relay_core::relay_paths::Platform;
use relay_core::shared::types::{Account, AccountKind, CreateAccount};
use relay_core::store::{Store, StoreOptions};
use relay_core::usage::UsageEndpoint;
use relay_core::usage_credentials::UsageError;
use relay_core::vault_crypto::Sealer;
use relay_core::vault_key::{LoadVaultKey, load_vault_key};
use relay_core::vault_migration::mark_vault_format;
use serde_json::json;

const FAKE_SECURITY: &str = r#"#!/bin/sh
dir="$(dirname "$0")"
echo "$*" >> "$dir/argv.log"
svc=""; prev=""
for a in "$@"; do if [ "$prev" = "-s" ]; then svc="$a"; fi; prev="$a"; done
key="$(printf '%s' "$svc" | tr -c 'A-Za-z0-9' '_')"
if [ "$1" = "-i" ]; then
  input="$(cat)"
  printf '%s\n' "$input" >> "$dir/stdin.log"
  value="$(printf '%s\n' "$input" | grep add-generic-password | sed -E 's/.* -w ([^ ]+).*/\1/' | head -1)"
  if [ ! -f "$dir/item-Relay_Vault_Key" ] && [ -n "$value" ]; then printf '%s' "$value" > "$dir/item-Relay_Vault_Key"; fi
  exit 0
fi
if [ "$1" = "find-generic-password" ]; then
  [ -f "$dir/force-exit" ] && exit "$(cat "$dir/force-exit")"
  if [ "$key" = "Relay_Vault_Key" ] && [ -f "$dir/race" ] && [ ! -f "$dir/race-done" ]; then touch "$dir/race-done"; cp "$dir/race" "$dir/item-Relay_Vault_Key"; exit 44; fi
  [ -f "$dir/item-$key" ] || exit 44
  cat "$dir/item-$key"; echo
  exit 0
fi
exit 9
"#;

/// A stand-in for /usr/bin/security in a temp folder: it logs argv and stdin, and serves a
/// one-item "keychain" file. Never the real tool.
pub struct FakeSecurity {
    dir: tempfile::TempDir,
    pub tool: PathBuf,
}

impl FakeSecurity {
    pub fn new(stored: Option<&str>) -> FakeSecurity {
        let dir = tempfile::Builder::new()
            .prefix("relay-fake-security-")
            .tempdir()
            .unwrap();
        let tool = dir.path().join("security");
        fs::write(&tool, FAKE_SECURITY).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&tool, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let security = FakeSecurity { dir, tool };
        if let Some(stored) = stored {
            fs::write(security.item_file("Relay Vault Key"), stored).unwrap();
        }
        security
    }
    fn read(&self, name: &str) -> String {
        fs::read_to_string(self.dir.path().join(name)).unwrap_or_default()
    }
    fn item_file(&self, service: &str) -> PathBuf {
        let name: String = service
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect();
        self.dir.path().join(format!("item-{name}"))
    }
    pub fn argv_log(&self) -> String {
        self.read("argv.log")
    }
    pub fn stdin_log(&self) -> String {
        self.read("stdin.log")
    }
    pub fn stored(&self) -> String {
        self.read("item-Relay_Vault_Key")
    }
    /// Stores a generic password for `service`, as another tool would have.
    pub fn set_item(&self, service: &str, value: &str) {
        fs::write(self.item_file(service), value).unwrap();
    }
    pub fn remove_item(&self, service: &str) {
        let _ = fs::remove_file(self.item_file(service));
    }
    /// Every `find-generic-password` exits with `code`.
    pub fn force_exit(&self, code: i32) {
        fs::write(self.dir.path().join("force-exit"), code.to_string()).unwrap();
    }
}

#[derive(Default)]
pub struct HostState {
    pub running: bool,
    pub quits: u32,
    pub starts: u32,
    pub fail_quit: Option<String>,
    pub on_quit: Option<Arc<dyn Fn() + Send + Sync>>,
    pub on_write: Option<Arc<dyn Fn() + Send + Sync>>,
}

/// The fixture's Claude: available, and quitting or starting only flips a flag.
pub struct FakeHost {
    pub state: Arc<Mutex<HostState>>,
}

impl DesktopHost for FakeHost {
    fn available(&self) -> bool {
        true
    }
    fn running(&self) -> DesktopResult<bool> {
        let hook = self.state.lock().unwrap().on_write.clone();
        if let Some(hook) = hook {
            hook();
        }
        Ok(self.state.lock().unwrap().running)
    }
    fn quit(&self, _: Option<&AnswerGuard>) -> DesktopResult<()> {
        let hook = {
            let mut st = self.state.lock().unwrap();
            st.quits += 1;
            st.on_quit.clone()
        };
        if let Some(hook) = hook {
            hook();
        }
        let mut st = self.state.lock().unwrap();
        if let Some(message) = st.fail_quit.clone() {
            return Err(DesktopError::new(message));
        }
        st.running = false;
        Ok(())
    }
    fn launch(&self, _: Option<LaunchOptions>) -> DesktopResult<()> {
        let mut st = self.state.lock().unwrap();
        st.running = true;
        st.starts += 1;
        Ok(())
    }
    fn seal(&self, _: &str) -> DesktopResult<Vec<u8>> {
        Err(DesktopError::new("the fixture host never seals"))
    }
    fn unseal(&self, _: &[u8]) -> DesktopResult<String> {
        Err(DesktopError::new("the fixture host never unseals"))
    }
}

#[derive(Default)]
pub struct Options {
    pub tty: bool,
    pub answers: Vec<Option<String>>,
    pub env: Vec<(&'static str, String)>,
    pub app_version: Option<String>,
    /// `None` is a desktop session.
    pub gui: Option<bool>,
}

pub struct Fixture {
    temp: tempfile::TempDir,
    pub base: PathBuf,
    pub home: PathBuf,
    pub claude: PathBuf,
    pub security: FakeSecurity,
    pub state: Arc<Mutex<HostState>>,
    pub io: CliIo,
    pub deps: CliDeps,
    out: Arc<Mutex<Vec<String>>>,
    err: Arc<Mutex<Vec<String>>>,
    handler: Arc<Mutex<Option<SignalHandler>>>,
    sealer: Mutex<Option<Arc<Sealer>>>,
}

pub fn cli_fixture(options: Options) -> Fixture {
    let temp = tempfile::Builder::new()
        .prefix("relay-cli-")
        .tempdir()
        .unwrap();
    let base = relay_core::fs_util::real_path(temp.path()).unwrap();
    let home = base.join("Relay");
    let claude = base.join("Claude");
    fs::create_dir_all(&claude).unwrap();
    // An empty stand-in bundle, so checks that look for Claude.app find one.
    fs::create_dir_all(base.join("Claude.app/Contents/MacOS")).unwrap();
    fs::write(base.join("Claude.app/Contents/MacOS/Claude"), "").unwrap();
    let security = FakeSecurity::new(None);
    let state = Arc::new(Mutex::new(HostState::default()));
    let out = Arc::new(Mutex::new(Vec::new()));
    let err = Arc::new(Mutex::new(Vec::new()));
    let answers = Arc::new(Mutex::new(
        options.answers.into_iter().collect::<VecDeque<_>>(),
    ));
    let handler: Arc<Mutex<Option<SignalHandler>>> = Arc::new(Mutex::new(None));
    let mut env = Env::new();
    env.insert("RELAY_HOME".into(), home.to_string_lossy().into_owned());
    env.insert(
        "RELAY_CLAUDE_DIR".into(),
        claude.to_string_lossy().into_owned(),
    );
    env.insert(
        "RELAY_CLAUDE_APP".into(),
        base.join("Claude.app").to_string_lossy().into_owned(),
    );
    env.insert("LANG".into(), "en_US.UTF-8".into());
    for (k, v) in options.env {
        env.insert(k.into(), v);
    }
    let (o, e, prompted, h) = (out.clone(), err.clone(), out.clone(), handler.clone());
    let io = CliIo {
        stdout: Arc::new(move |line| o.lock().unwrap().push(line.to_owned())),
        stderr: Arc::new(move |line| e.lock().unwrap().push(line.to_owned())),
        is_tty: options.tty,
        prompt: Arc::new(move |question| {
            prompted.lock().unwrap().push(question.to_owned());
            answers.lock().unwrap().pop_front().flatten()
        }),
        read_input: None,
        env,
        cwd: base.clone(),
        now: Arc::new(relay_core::clock::now_ms),
        pid: std::process::id(),
        on_signal: Arc::new(move |next| *h.lock().unwrap() = next),
    };
    let host_state = state.clone();
    let app_version = options.app_version.clone();
    let gui = options.gui.unwrap_or(true);
    let deps = CliDeps {
        host: Arc::new(move |_| {
            Arc::new(FakeHost {
                state: host_state.clone(),
            }) as Arc<dyn DesktopHost>
        }),
        security_tool: security.tool.clone(),
        request: Arc::new(
            |_: UsageEndpoint, _: &str| -> Result<serde_json::Value, UsageError> {
                Err(UsageError::with_detail(
                    relay_core::shared::types::UsageIssue::Unavailable,
                    "no network in tests",
                ))
            },
        ),
        claude: Arc::new(|_| None),
        process_list: Arc::new(|| Ok(String::new())),
        relay_app_version: Arc::new(move || app_version.clone()),
        gui_session: Arc::new(move || gui),
        self_exe: base.join("relay-cli"),
        transcript_root: base.join(".claude"),
        // As the shipped CLI on this machine: the extension and the terminal step never run here.
        extension: None,
        terminal: None,
        platform: Platform::current(),
        ..default_deps()
    };
    Fixture {
        temp,
        base,
        home,
        claude,
        security,
        state,
        io,
        deps,
        out,
        err,
        handler,
        sealer: Mutex::new(None),
    }
}

impl Fixture {
    pub fn run(&self, argv: &[&str]) -> i32 {
        let argv: Vec<String> = argv.iter().map(|a| (*a).to_owned()).collect();
        relay_cli::run_cli(&argv, &self.io, &self.deps)
    }
    pub fn out(&self) -> String {
        self.out.lock().unwrap().join("\n")
    }
    pub fn err(&self) -> String {
        self.err.lock().unwrap().join("\n")
    }
    pub fn clear(&self) {
        self.out.lock().unwrap().clear();
        self.err.lock().unwrap().clear();
    }
    pub fn signal(&self, signal: Signal) {
        let handler = self.handler.lock().unwrap().clone();
        if let Some(handler) = handler {
            handler(signal);
        }
    }
    pub fn has_signal_handler(&self) -> bool {
        self.handler.lock().unwrap().is_some()
    }
    pub fn quits(&self) -> u32 {
        self.state.lock().unwrap().quits
    }
    pub fn starts(&self) -> u32 {
        self.state.lock().unwrap().starts
    }
    pub fn vault(&self) -> PathBuf {
        self.home.join("desktop-vault")
    }
    /// The registry as the CLI opens it.
    pub fn store(&self) -> Store {
        Store::open(
            &self.home,
            StoreOptions {
                backup_on_open: false,
                migrate_on_open: false,
                by: LockBy::Cli,
                ..StoreOptions::default()
            },
        )
        .unwrap()
    }

    /// Signs a new account in to the fixture's Claude folder; its secrets carry FIXTURE-SECRET.
    pub fn account_in_desktop(&self, org_count: usize) -> (String, Vec<String>) {
        static SECRET: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = SECRET.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let account_uuid = uuid::Uuid::new_v4().to_string();
        let orgs: Vec<String> = (0..org_count)
            .map(|_| uuid::Uuid::new_v4().to_string())
            .collect();
        let config = json!({ "oauth:tokenCacheV2": format!("FIXTURE-SECRET-{n}"), "lastKnownAccountUuid": account_uuid });
        write_bytes(&self.claude, "config.json", Some(&json_bytes(&config))).unwrap();
        write_bytes(
            &self.claude,
            "Cookies",
            Some(format!("FIXTURE-SECRET-cookie-{n}").as_bytes()),
        )
        .unwrap();
        for org in &orgs {
            fs::create_dir_all(
                self.claude
                    .join("claude-code-sessions")
                    .join(&account_uuid)
                    .join(org),
            )
            .unwrap();
        }
        (account_uuid, orgs)
    }

    pub fn vault_sealer(&self) -> Arc<Sealer> {
        let mut sealer = self.sealer.lock().unwrap();
        if let Some(s) = sealer.as_ref() {
            return s.clone();
        }
        let key = load_vault_key(&LoadVaultKey {
            tool: Some(&self.security.tool),
            may_create: true,
        })
        .unwrap();
        mark_vault_format(&self.vault()).unwrap();
        let made = Arc::new(Sealer::new(&key).unwrap());
        *sealer = Some(made.clone());
        made
    }

    /// A host that seals with the vault key, as the app's would.
    pub fn sealing_host(&self) -> Arc<dyn DesktopHost> {
        let key = load_vault_key(&LoadVaultKey {
            tool: Some(&self.security.tool),
            may_create: true,
        })
        .unwrap();
        self.vault_sealer();
        Arc::new(CliHost {
            inner: Arc::new(FakeHost {
                state: self.state.clone(),
            }),
            sealer: Some(Sealer::new(&key).unwrap()),
            closed: String::new(),
            draft_scratch_dir: self.home.join("cli-scratch"),
        })
    }

    /// Saves an account through the core, as an earlier `relay add` or the app would have.
    pub fn saved(&self, name: &str, group: Option<&str>) -> (Account, Vec<String>) {
        let (_, orgs) = self.account_in_desktop(1);
        let store = Arc::new(Store::open(&self.home, StoreOptions::default()).unwrap());
        let account = store
            .create(&CreateAccount {
                name: name.into(),
                kind: if group.is_some() {
                    AccountKind::Work
                } else {
                    AccountKind::Personal
                },
                group: group.map(str::to_owned),
                provider: None,
            })
            .unwrap();
        let manager = DesktopManager::new(
            &self.claude,
            store.clone(),
            self.sealing_host(),
            Some(self.base.join(".claude")),
            None,
        );
        manager.initialize().unwrap();
        manager.capture(&account.id, &orgs[0]).unwrap();
        {
            let mut st = self.state.lock().unwrap();
            st.quits = 0;
            st.starts = 0;
        }
        (self.store().account(&account.id).unwrap(), orgs)
    }

    pub fn path(&self, relative: &str) -> PathBuf {
        self.base.join(relative)
    }
    pub fn temp(&self) -> &Path {
        self.temp.path()
    }
}
