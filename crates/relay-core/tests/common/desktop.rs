//! A fake Claude host and a Desktop fixture, as the TS tests build them (`tests/desktop.test.ts`'s
//! fixture and `tests/cli-fixture.ts`'s host): Claude's folder, a Relay store and a host whose
//! Claude only flips a flag.
// Each test binary uses part of the fixture; the fake's hooks are spelled out where they live.
#![allow(dead_code, clippy::type_complexity)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use base64::Engine;
use relay_core::desktop::{
    AnswerGuard, DesktopError, DesktopHost, DesktopManager, DesktopResult, LaunchOptions,
};
use relay_core::desktop_files::{json_bytes, write_bytes};
use relay_core::desktop_instances::ClaudeWindowProcess;
use relay_core::desktop_launch::{ClaudeSignOut, LaunchWatch};
use relay_core::draft_transfer::{DraftJob, DraftResult};
use relay_core::shared::types::{Account, AccountKind, CreateAccount};
use relay_core::store::{Store, StoreOptions};
use relay_core::vault_crypto::Sealer;
use serde_json::{Value, json};

pub type Hook<T> = Mutex<Option<Arc<T>>>;

fn get<T: ?Sized>(hook: &Hook<T>) -> Option<Arc<T>> {
    hook.lock().unwrap().clone()
}

/// How the fake host seals: the TS tests' marker encoding, or a real vault sealer.
pub enum Sealing {
    Test,
    Real(Arc<Sealer>),
}

const MARK: &str = "TEST-ENCRYPTED:";

/// `Buffer.from("TEST-ENCRYPTED:" + base64(text))`.
pub fn test_seal(text: &str) -> Vec<u8> {
    format!(
        "{MARK}{}",
        base64::engine::general_purpose::STANDARD.encode(text)
    )
    .into_bytes()
}

pub fn test_unseal(data: &[u8]) -> String {
    let text = String::from_utf8_lossy(data);
    let body = text.get(MARK.len()..).unwrap_or_default();
    String::from_utf8(
        base64::engine::general_purpose::STANDARD
            .decode(body)
            .unwrap_or_default(),
    )
    .unwrap_or_default()
}

#[derive(Default)]
pub struct FakeState {
    pub running: bool,
    pub quits: u32,
    pub starts: u32,
    /// The message every quit fails with while set.
    pub fail_quit: Option<String>,
    /// The answer each quit was given for Claude's own question, in order.
    pub quit_answers: Vec<Option<bool>>,
    pub launches: Vec<Option<LaunchOptions>>,
    /// What the host did, in order: "quit", "launch", "launch:quic-off", "watch", "wait:<x>",
    /// "readDrafts:start", "readDrafts:end".
    pub order: Vec<String>,
    pub jobs: Vec<DraftJob>,
    pub signed_out: Option<bool>,
    pub sign_outs: Option<Vec<ClaudeSignOut>>,
    pub uptime: Option<i64>,
    pub scratch: Option<PathBuf>,
    pub reads_drafts: bool,
    // Separate windows.
    pub windows: Vec<ClaudeWindowProcess>,
    pub launched: Vec<(PathBuf, bool)>,
    pub quit_pids: Vec<i64>,
    pub shown: Vec<i64>,
    pub next_pid: i64,
    /// A window that ignores its quit: Claude asks about work left running.
    pub stubborn: bool,
}

pub struct FakeHost {
    pub state: Mutex<FakeState>,
    pub sealing: Sealing,
    pub windows_supported: AtomicBool,
    pub available: Hook<dyn Fn() -> bool + Send + Sync>,
    /// Told before `running` answers; may change the state (Claude opening meanwhile).
    pub on_running: Hook<dyn Fn(&FakeHost) + Send + Sync>,
    /// Replaces `running` whole.
    pub running_hook: Hook<dyn Fn(&FakeHost) -> DesktopResult<bool> + Send + Sync>,
    /// Replaces `seems_running` whole.
    pub seems_hook: Hook<dyn Fn(&FakeHost) -> DesktopResult<bool> + Send + Sync>,
    /// Asked first by every quit, with its number (1-based): an error fails that quit.
    pub quit_hook: Hook<dyn Fn(u32) -> DesktopResult<()> + Send + Sync>,
    /// Asked first by every seal: an error fails it.
    pub seal_hook: Hook<dyn Fn(&str) -> DesktopResult<()> + Send + Sync>,
    /// Runs before every unseal: may block, holding an operation inside it.
    pub unseal_gate: Hook<dyn Fn() + Send + Sync>,
    pub read_drafts: Hook<dyn Fn(&DraftJob) -> DraftResult + Send + Sync>,
    pub drafts_blocked: Hook<dyn Fn(&FakeHost) -> DesktopResult<Option<String>> + Send + Sync>,
    pub watch_launch: Hook<dyn Fn(&FakeHost) -> Option<Box<dyn LaunchWatch>> + Send + Sync>,
    /// Runs before a window launches.
    pub before_launch_window: Hook<dyn Fn() + Send + Sync>,
}

impl FakeHost {
    pub fn new(sealing: Sealing) -> FakeHost {
        FakeHost {
            state: Mutex::new(FakeState {
                next_pid: 500,
                ..FakeState::default()
            }),
            sealing,
            windows_supported: AtomicBool::new(false),
            available: Mutex::new(None),
            on_running: Mutex::new(None),
            running_hook: Mutex::new(None),
            seems_hook: Mutex::new(None),
            quit_hook: Mutex::new(None),
            seal_hook: Mutex::new(None),
            unseal_gate: Mutex::new(None),
            read_drafts: Mutex::new(None),
            drafts_blocked: Mutex::new(None),
            watch_launch: Mutex::new(None),
            before_launch_window: Mutex::new(None),
        }
    }

    pub fn st(&self) -> MutexGuard<'_, FakeState> {
        self.state.lock().unwrap()
    }

    pub fn set<T: ?Sized>(hook: &Hook<T>, value: Arc<T>) {
        *hook.lock().unwrap() = Some(value);
    }

    pub fn plain_running(&self) -> bool {
        if let Some(hook) = get(&self.on_running) {
            hook(self);
        }
        self.st().running
    }

    fn record(&self, event: impl Into<String>) {
        self.st().order.push(event.into());
    }
}

impl DesktopHost for FakeHost {
    fn available(&self) -> bool {
        get(&self.available).is_none_or(|available| available())
    }

    fn running(&self) -> DesktopResult<bool> {
        match get(&self.running_hook) {
            Some(hook) => hook(self),
            None => Ok(self.plain_running()),
        }
    }

    fn seems_running(&self) -> DesktopResult<bool> {
        match get(&self.seems_hook) {
            Some(hook) => hook(self),
            None => self.running(),
        }
    }

    fn quit(&self, answer_guard: Option<&AnswerGuard>) -> DesktopResult<()> {
        let n = {
            let mut st = self.st();
            st.quits += 1;
            st.order.push("quit".into());
            st.quits
        };
        let answer = answer_guard.map(|guard| guard().unwrap_or(false));
        self.st().quit_answers.push(answer);
        if let Some(hook) = get(&self.quit_hook) {
            hook(n)?;
        }
        let mut st = self.st();
        if let Some(message) = &st.fail_quit {
            return Err(DesktopError::new(message.clone()));
        }
        st.running = false;
        Ok(())
    }

    fn launch(&self, options: Option<LaunchOptions>) -> DesktopResult<()> {
        let mut st = self.st();
        let quic_off = options.is_some_and(|o| o.quic_off);
        st.launches.push(options);
        st.order.push(
            if quic_off {
                "launch:quic-off"
            } else {
                "launch"
            }
            .into(),
        );
        st.running = true;
        st.starts += 1;
        Ok(())
    }

    fn seal(&self, data: &str) -> DesktopResult<Vec<u8>> {
        if let Some(hook) = get(&self.seal_hook) {
            hook(data)?;
        }
        Ok(match &self.sealing {
            Sealing::Test => test_seal(data),
            Sealing::Real(sealer) => sealer.seal(data),
        })
    }

    fn unseal(&self, data: &[u8]) -> DesktopResult<String> {
        if let Some(gate) = get(&self.unseal_gate) {
            gate();
        }
        match &self.sealing {
            Sealing::Test => Ok(test_unseal(data)),
            Sealing::Real(sealer) => sealer
                .unseal(data)
                .map_err(|e| DesktopError::new(e.to_string())),
        }
    }

    fn reads_drafts(&self) -> bool {
        self.st().reads_drafts
    }

    fn read_drafts(&self, job: &DraftJob) -> DraftResult {
        self.st().jobs.push(job.clone());
        self.record("readDrafts:start");
        let result = match get(&self.read_drafts) {
            Some(read) => read(job),
            None => DraftResult::Ok {
                drafts: Default::default(),
                sidebar: None,
            },
        };
        self.record("readDrafts:end");
        result
    }

    fn drafts_blocked(&self) -> DesktopResult<Option<String>> {
        match get(&self.drafts_blocked) {
            Some(hook) => hook(self),
            None => Ok(None),
        }
    }

    fn draft_scratch_dir(&self) -> Option<PathBuf> {
        self.st().scratch.clone()
    }

    fn claude_uptime_ms(&self) -> Option<i64> {
        self.st().uptime
    }

    fn watch_launch(&self) -> Option<Box<dyn LaunchWatch>> {
        get(&self.watch_launch).and_then(|hook| hook(self))
    }

    fn signed_out(&self) -> Option<bool> {
        self.st().signed_out
    }

    fn sign_outs(&self) -> Option<Vec<ClaudeSignOut>> {
        self.st().sign_outs.clone()
    }

    fn has_windows(&self) -> bool {
        self.windows_supported.load(Ordering::SeqCst)
    }

    fn windows(&self) -> DesktopResult<Vec<ClaudeWindowProcess>> {
        Ok(self.st().windows.clone())
    }

    fn launch_window(&self, dir: &Path, options: Option<LaunchOptions>) -> DesktopResult<()> {
        if let Some(hook) = get(&self.before_launch_window) {
            hook();
        }
        let mut st = self.st();
        st.launched
            .push((dir.to_path_buf(), options.is_some_and(|o| o.quic_off)));
        let pid = st.next_pid;
        st.next_pid += 1;
        st.windows.push(ClaudeWindowProcess {
            dir: dir.to_string_lossy().into_owned(),
            pid,
            pids: vec![pid],
        });
        Ok(())
    }

    fn quit_window(&self, pid: i64) -> DesktopResult<()> {
        let mut st = self.st();
        st.quit_pids.push(pid);
        if !st.stubborn {
            st.windows.retain(|w| w.pid != pid);
        }
        Ok(())
    }

    fn activate_window(&self, pid: i64) -> DesktopResult<()> {
        self.st().shown.push(pid);
        Ok(())
    }

    fn windows_seen(&self) -> usize {
        self.st().windows.len()
    }
}

/// A Claude folder, a Relay store, a fake host and a manager on them.
pub struct Fixture {
    pub temp: tempfile::TempDir,
    pub root: PathBuf,
    pub transcript_root: PathBuf,
    pub store: Arc<Store>,
    pub host: Arc<FakeHost>,
    pub manager: Arc<DesktopManager>,
}

impl Fixture {
    pub fn new() -> Fixture {
        Fixture::with(Sealing::Test)
    }

    pub fn with(sealing: Sealing) -> Fixture {
        let temp = tempfile::Builder::new()
            .prefix("relay-desktop-core-")
            .tempdir()
            .unwrap();
        let base = relay_core::fs_util::real_path(temp.path()).unwrap();
        let root = base.join("Claude");
        std::fs::create_dir_all(&root).unwrap();
        let store = Arc::new(Store::open(base.join("Relay"), StoreOptions::default()).unwrap());
        let host = Arc::new(FakeHost::new(sealing));
        // Swept at startup: never the real temp folder.
        host.st().scratch = Some(base.join("tmp"));
        let transcript_root = base.join(".claude");
        let manager = DesktopManager::new(
            &root,
            Arc::clone(&store),
            Arc::clone(&host) as Arc<dyn DesktopHost>,
            Some(transcript_root.clone()),
            None,
        );
        manager.initialize().unwrap();
        Fixture {
            temp,
            root,
            transcript_root,
            store,
            host,
            manager,
        }
    }

    /// The fixture's folder (symbolic links resolved).
    pub fn base(&self) -> PathBuf {
        self.root.parent().unwrap().to_path_buf()
    }

    pub fn vault(&self) -> PathBuf {
        self.store.root().join("desktop-vault")
    }

    /// Signs `name` in to Claude's folder as a new account, without saving it.
    pub fn sign_in(&self, name: &str) -> (String, String) {
        let account_uuid = uuid::Uuid::new_v4().to_string();
        let org_id = uuid::Uuid::new_v4().to_string();
        write_bytes(
            &self.root,
            "config.json",
            Some(&json_bytes(&json!({
                "oauth:tokenCacheV2": format!("encrypted:{name}"),
                "lastKnownAccountUuid": account_uuid,
                "preference": "preserved",
            }))),
        )
        .unwrap();
        std::fs::create_dir_all(
            self.root
                .join("claude-code-sessions")
                .join(&account_uuid)
                .join(&org_id),
        )
        .unwrap();
        write_bytes(
            &self.root,
            "Cookies",
            Some(format!("cookie-{name}").as_bytes()),
        )
        .unwrap();
        (account_uuid, org_id)
    }

    pub fn create(&self, name: &str, group: Option<&str>) -> Account {
        self.store
            .create(&CreateAccount {
                name: name.into(),
                kind: if group.is_some() {
                    AccountKind::Work
                } else {
                    AccountKind::Personal
                },
                group: group.map(str::to_string),
                provider: None,
            })
            .unwrap()
    }

    /// An account whose Claude app sign-in is saved; Claude is left on it.
    pub fn account(&self, name: &str, group: Option<&str>) -> Account {
        let a = self.create(name, group);
        let (_, org_id) = self.sign_in(name);
        self.manager.capture(&a.id, &org_id).unwrap();
        self.store.account(&a.id).unwrap()
    }

    pub fn set_running(&self, value: bool) {
        self.host.st().running = value;
    }

    pub fn set_fail_quit(&self) {
        self.host.st().fail_quit = Some("still running".into());
    }

    pub fn starts(&self) -> u32 {
        self.host.st().starts
    }

    pub fn quits(&self) -> u32 {
        self.host.st().quits
    }

    /// A manager of its own on the fixture's files.
    pub fn manager_with(
        &self,
        host: Arc<dyn DesktopHost>,
        now: Option<relay_core::desktop::Clock>,
    ) -> Arc<DesktopManager> {
        let manager = DesktopManager::new(
            &self.root,
            Arc::clone(&self.store),
            host,
            Some(self.transcript_root.clone()),
            now,
        );
        manager.initialize().unwrap();
        manager
    }
}

/// `<desktop scope>` of an account.
pub fn scope_dir(kind: &str, a: &Account) -> String {
    let d = a.desktop.as_ref().unwrap();
    format!("{kind}/{}/{}", d.account_uuid, d.org_id)
}

/// A Code session record of account `a`, as Claude writes one.
pub fn session(root: &Path, a: &Account, id: Option<&str>, extra: Value) -> (String, String) {
    let id = id.map_or_else(|| uuid::Uuid::new_v4().to_string(), str::to_string);
    let relative = format!("{}/local_{id}.json", scope_dir("claude-code-sessions", a));
    let mut record = json!({
        "sessionId": format!("local_{id}"),
        "cliSessionId": id,
        "cwd": root.to_string_lossy(),
        "title": "Fixture",
        "lastActivityAt": 42,
        "remoteMcpServersConfig": ["source-secret"],
        "alwaysAllowedReasons": ["grant"],
        "permissionMode": "bypassPermissions",
    });
    if let (Some(record), Value::Object(extra)) = (record.as_object_mut(), extra) {
        for (key, value) in extra {
            record.insert(key, value);
        }
    }
    write_bytes(root, &relative, Some(&json_bytes(&record))).unwrap();
    (id, relative)
}

pub fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}
