//! Claude Code usage sign-ins: `claude auth login --claudeai` run per account, its page handed to
//! the system browser or Relay's own window, then verified against the profile.
//! OAuth URLs and CLI output stay in this process and are never persisted or sent over IPC.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Condvar, LazyLock, Mutex, MutexGuard, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use indexmap::IndexMap;
use regex::Regex;

use crate::clock::now_ms;
use crate::fs_util::iso_timestamp;
use crate::host::{SignInWindow, Webviews};
use crate::profile_lock::{ProfileLockError, ProfileLockGuard};
use crate::shared::types::{AuthFlow, AuthFlowStatus};

/// Whether a sign-in is still running: starting, waiting for approval, or verifying.
pub fn auth_pending(flow: Option<&AuthFlow>) -> bool {
    flow.is_some_and(|f| {
        matches!(
            f.status,
            AuthFlowStatus::Starting | AuthFlowStatus::Waiting | AuthFlowStatus::Verifying
        )
    })
}

static VT_CONTROL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"[\x1B\x{9B}][\[\]()#;?]*",
        r"(?:(?:(?:(?:;[-a-zA-Z0-9/#&.:=?%@~_]+)*",
        r"|[a-zA-Z0-9]+(?:;[-a-zA-Z0-9/#&.:=?%@~_]*)*)?",
        r"(?:\x07|\x1B\x5C|\x{9C}))",
        r"|(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><~]))"
    ))
    .unwrap()
});

/// Node's `util.stripVTControlCharacters`.
pub fn strip_vt_control_characters(text: &str) -> String {
    VT_CONTROL.replace_all(text, "").into_owned()
}

static HTTPS_LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"https://[^\s<>"']+"#).unwrap());

/// The first official Claude authorization page in `text`, normalized; `None` when there is none.
pub fn authorization_url(text: &str) -> Option<String> {
    let text = strip_vt_control_characters(text);
    for found in HTTPS_LINK.find_iter(&text) {
        // An incomplete stream chunk does not parse.
        let Ok(url) = url::Url::parse(found.as_str()) else {
            continue;
        };
        let host = url.host_str().unwrap_or("");
        let path = url.path();
        let official = (["claude.ai", "console.anthropic.com", "platform.claude.com"]
            .contains(&host)
            && ["/oauth/authorize", "/oauth/authorize/"].contains(&path))
            || (host == "claude.com"
                && ["/cai/oauth/authorize", "/cai/oauth/authorize/"].contains(&path));
        let has = |key: &str| url.query_pairs().any(|(k, _)| k == key);
        if url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && official
            && has("client_id")
            && has("state")
            && has("redirect_uri")
        {
            return Some(url.as_str().to_owned());
        }
    }
    None
}

/// How Relay gets the sign-in page from the CLI, and its own window for the page. The CLI runs
/// the program in `BROWSER` with the page's address, so `env` points it at a small script that
/// writes the address where `take` reads it. That page sends the approval back to the CLI on
/// localhost, so nothing has to be pasted. Relay then opens it in the system browser, where the
/// user's sign-ins and password manager are; `show` opens it in Relay's own window for the
/// account instead, when the browser is signed in to another Claude account.
pub trait AuthBrowser: Send + Sync {
    fn env(&self, attempt_id: &str) -> Vec<(String, String)>;
    /// The page the CLI handed over for this attempt, once, then forgotten; `None` before.
    fn take(&self, attempt_id: &str) -> Option<String>;
    fn show(&self, account_id: &str, url: &str);
    fn close(&self, account_id: &str);
}

/// Writes the page the CLI hands to BROWSER into the file Relay named for that attempt.
const HANDOFF_SCRIPT: &str = "#!/bin/sh\n[ -n \"$RELAY_AUTH_PAGE_FILE\" ] && printf '%s' \"$1\" > \"$RELAY_AUTH_PAGE_FILE\"\n";

/// The usage sign-in in Relay's own window, one per account, each with its own claude.ai
/// session: whichever account the system browser is signed in to cannot approve the wrong one,
/// and a renewal finds the account still signed in. macOS and Linux (the handoff is a shell
/// script). Port of `electron/auth-window.ts` `authWindows`.
pub struct WebviewAuthBrowser {
    dir: PathBuf,
    script: PathBuf,
    title: String,
    webviews: Arc<dyn Webviews>,
}

impl WebviewAuthBrowser {
    pub fn new(data_dir: &Path, title: &str, webviews: Arc<dyn Webviews>) -> std::io::Result<Self> {
        let dir = data_dir.join("auth-pages");
        let script = data_dir.join("auth-browser.sh");
        crate::fs_util::create_private_dir_all(&dir)?;
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o700);
        options
            .open(&script)?
            .write_all(HANDOFF_SCRIPT.as_bytes())?;
        crate::fs_util::set_mode(&script, 0o700)?;
        Ok(Self {
            dir,
            script,
            title: title.to_owned(),
            webviews,
        })
    }

    fn file(&self, attempt_id: &str) -> PathBuf {
        let name: String = attempt_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
            .collect();
        self.dir.join(format!("{name}.url"))
    }
}

impl AuthBrowser for WebviewAuthBrowser {
    fn env(&self, attempt_id: &str) -> Vec<(String, String)> {
        vec![
            ("BROWSER".into(), self.script.to_string_lossy().into_owned()),
            (
                "RELAY_AUTH_PAGE_FILE".into(),
                self.file(attempt_id).to_string_lossy().into_owned(),
            ),
        ]
    }

    fn take(&self, attempt_id: &str) -> Option<String> {
        let file = self.file(attempt_id);
        let url = fs::read_to_string(&file).ok()?.trim().to_owned();
        let _ = fs::remove_file(&file);
        (!url.is_empty()).then_some(url)
    }

    fn show(&self, account_id: &str, url: &str) {
        self.webviews
            .show_sign_in(SignInWindow::new(account_id, url, &self.title));
    }

    fn close(&self, account_id: &str) {
        self.webviews.close_sign_in(account_id);
    }
}

/// How long the CLI gets to hand its page to `BROWSER` before the printed one is shown instead.
const HANDOFF_MS: u64 = 5_000;
const HANDOFF_POLL: Duration = Duration::from_millis(250);
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AuthError {
    /// A sign-in cannot start now for a passing reason: another runs, or the account is in use.
    #[error("{0}")]
    Busy(String),
    #[error("{0}")]
    Failed(String),
}

impl AuthError {
    fn failed(message: &str) -> Self {
        Self::Failed(message.to_owned())
    }
}

/// Whether the finished sign-in is the account's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Yes,
    /// Not signed in.
    No,
    /// Why it does not fit the profile, shown as the flow's error.
    Reason(String),
}

/// Shows the page instead of the system browser: a background renewal's hidden window.
pub type Present = Arc<dyn Fn(&str) + Send + Sync>;

/// A sign-in Relay starts by itself: its page goes to `present`, never to the user's browser.
#[derive(Clone)]
pub struct BackgroundSignIn {
    pub present: Present,
}

pub type Verify = dyn Fn(&str) -> Result<Verdict, String> + Send + Sync;
pub type EmitFlow = dyn Fn(AuthFlow) + Send + Sync;
pub type OpenUrl = dyn Fn(&str) -> Result<(), String> + Send + Sync;
/// Takes the account's exclusive profile lock, shared with Relay's other processes.
pub type ProfileLockFn = dyn Fn(&str) -> Result<ProfileLockGuard, ProfileLockError> + Send + Sync;

/// The flow of one attempt once it ends (connected, failed or cancelled).
#[derive(Clone, Default)]
pub struct AuthSettled(Arc<(Mutex<Option<AuthFlow>>, Condvar)>);

impl AuthSettled {
    fn set(&self, flow: AuthFlow) {
        let (slot, cond) = &*self.0;
        let mut slot = slot.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_none() {
            *slot = Some(flow);
        }
        cond.notify_all();
    }

    /// Blocks until the attempt ends.
    pub fn wait(&self) -> AuthFlow {
        let (slot, cond) = &*self.0;
        let guard = slot.lock().unwrap_or_else(|e| e.into_inner());
        let guard = cond
            .wait_while(guard, |flow| flow.is_none())
            .unwrap_or_else(|e| e.into_inner());
        guard.clone().expect("settled")
    }

    /// The ended flow, waiting at most `timeout`.
    pub fn wait_timeout(&self, timeout: Duration) -> Option<AuthFlow> {
        let (slot, cond) = &*self.0;
        let guard = slot.lock().unwrap_or_else(|e| e.into_inner());
        let (guard, _) = cond
            .wait_timeout_while(guard, timeout, |flow| flow.is_none())
            .unwrap_or_else(|e| e.into_inner());
        guard.clone()
    }
}

struct Entry {
    flow: AuthFlow,
    child: Option<Arc<Mutex<Child>>>,
    stdin: Option<ChildStdin>,
    output: String,
    url: Option<String>,
    /// The page the CLI printed, shown when it hands none to BROWSER.
    printed: Option<String>,
    /// Whether a browser handoff was set up when the attempt started.
    handoff: bool,
    closed: bool,
    stopping: bool,
    continued: bool,
    present: Option<Present>,
    ended: AuthSettled,
    profile: Option<ProfileLockGuard>,
}

enum Effect {
    Emit(AuthFlow),
    Close(Arc<dyn AuthBrowser>, String),
    Present(Present, String),
}

struct Inner {
    entries: Mutex<IndexMap<String, Entry>>,
    changed: Condvar,
    browser: RwLock<Option<Arc<dyn AuthBrowser>>>,
    verify: Box<Verify>,
    emit: Box<EmitFlow>,
    open: Box<OpenUrl>,
    timeout: Duration,
    profile_lock: Option<Box<ProfileLockFn>>,
}

/// Runs the CLI sign-ins, at most one per account and four pending at once.
#[derive(Clone)]
pub struct AuthManager(Arc<Inner>);

type Entries<'a> = MutexGuard<'a, IndexMap<String, Entry>>;

impl Inner {
    fn lock(&self) -> Entries<'_> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn browser(&self) -> Option<Arc<dyn AuthBrowser>> {
        self.browser
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn run(&self, effects: Vec<Effect>) {
        for effect in effects {
            match effect {
                Effect::Emit(flow) => (self.emit)(flow),
                Effect::Close(browser, account) => browser.close(&account),
                Effect::Present(present, url) => present(&url),
            }
        }
    }

    fn update(&self, e: &mut Entry, effects: &mut Vec<Effect>, patch: impl FnOnce(&mut AuthFlow)) {
        patch(&mut e.flow);
        effects.push(Effect::Emit(e.flow.clone()));
        self.changed.notify_all();
    }

    fn finish(
        &self,
        e: &mut Entry,
        effects: &mut Vec<Effect>,
        status: AuthFlowStatus,
        error: Option<&str>,
    ) {
        if e.flow.in_window == Some(true)
            && let Some(browser) = self.browser()
        {
            effects.push(Effect::Close(browser, e.flow.account_id.clone()));
        }
        e.output.clear();
        e.url = None;
        e.printed = None;
        self.update(e, effects, |flow| {
            flow.status = status;
            flow.error = error.map(str::to_owned);
            flow.browser_ready = false;
            flow.code_requested = false;
        });
        e.ended.set(e.flow.clone());
    }
}

/// The entry of `attempt`, while it is still the account's.
fn entry_of<'a>(
    entries: &'a mut Entries<'_>,
    account: &str,
    attempt: &str,
) -> Option<&'a mut Entry> {
    entries.get_mut(account).filter(|e| e.flow.id == attempt)
}

fn last_chars(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_owned();
    }
    text.chars().skip(count - max).collect()
}

static CODE_PROMPT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)paste (?:the )?(?:authorization )?code|enter (?:the )?(?:authorization )?code")
        .unwrap()
});
static LOGIN_SUCCESSFUL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)login successful").unwrap());
static CODE_FORBIDDEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\r\n\x00-\x1f\x7f]").unwrap());

/// Decodes a byte stream as UTF-8 across chunk boundaries, like `setEncoding("utf8")`.
#[derive(Default)]
pub(crate) struct Utf8Stream(Vec<u8>);

impl Utf8Stream {
    pub(crate) fn push(&mut self, bytes: &[u8]) -> String {
        self.0.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.0) {
                Ok(text) => {
                    out.push_str(text);
                    self.0.clear();
                    return out;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.0[..valid]).unwrap_or_default());
                    match error.error_len() {
                        None => {
                            self.0.drain(..valid);
                            return out;
                        }
                        Some(len) => {
                            out.push('\u{FFFD}');
                            self.0.drain(..valid + len);
                        }
                    }
                }
            }
        }
    }
}

impl AuthManager {
    /// `verify`: whether the finished sign-in is the account's. `emit`: every flow change.
    /// `open`: the system browser. `timeout`: how long an attempt may run (10 minutes when
    /// `None`). `profile_lock`: the account's exclusive profile lock.
    pub fn new(
        verify: Box<Verify>,
        emit: Box<EmitFlow>,
        open: Box<OpenUrl>,
        timeout: Option<Duration>,
        profile_lock: Option<Box<ProfileLockFn>>,
    ) -> Self {
        Self(Arc::new(Inner {
            entries: Mutex::new(IndexMap::new()),
            changed: Condvar::new(),
            browser: RwLock::new(None),
            verify,
            emit,
            open,
            timeout: timeout.unwrap_or(DEFAULT_TIMEOUT),
            profile_lock,
        }))
    }

    /// Set by the app where it can show the sign-in page in its own window.
    pub fn set_browser(&self, browser: Option<Arc<dyn AuthBrowser>>) {
        *self.0.browser.write().unwrap_or_else(|e| e.into_inner()) = browser;
    }

    pub fn list(&self) -> Vec<AuthFlow> {
        self.0.lock().values().map(|e| e.flow.clone()).collect()
    }

    pub fn active(&self, id: &str) -> bool {
        self.0
            .lock()
            .get(id)
            .is_some_and(|e| auth_pending(Some(&e.flow)) || e.stopping)
    }

    pub fn start(
        &self,
        account_id: &str,
        executable: &str,
        cwd: &Path,
        env: &HashMap<String, String>,
        background: Option<BackgroundSignIn>,
    ) -> Result<AuthFlow, AuthError> {
        let inner = &self.0;
        let mut entries = inner.lock();
        if let Some(previous) = entries.get(account_id)
            && (auth_pending(Some(&previous.flow)) || previous.stopping)
        {
            // The same kind asked again gets the running attempt; a background renewal never
            // takes over the user's sign-in, nor the user's request a hidden renewal.
            if (previous.flow.background == Some(true)) == background.is_some() {
                return Ok(previous.flow.clone());
            }
            return Err(AuthError::Busy(
                "another sign-in runs on this account".into(),
            ));
        }
        if entries
            .values()
            .filter(|e| auth_pending(Some(&e.flow)))
            .count()
            >= 4
        {
            return Err(AuthError::failed(
                "Finish one of the pending usage sign-ins first.",
            ));
        }
        let profile = match inner.profile_lock.as_ref().map(|lock| lock(account_id)) {
            None => None,
            Some(Ok(guard)) => Some(guard),
            Some(Err(ProfileLockError::Busy(_))) => {
                return Err(AuthError::failed(
                    "Another Relay process (in a terminal) is using this account. Try again when it ends.",
                ));
            }
            Some(Err(error)) => return Err(AuthError::Failed(error.to_string())),
        };
        let attempt_id = uuid::Uuid::new_v4().to_string();
        let browser = inner.browser();
        let mut command = Command::new(executable);
        command
            .args(["auth", "login", "--claudeai"])
            .current_dir(cwd)
            .env_clear()
            .envs(env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(browser) = &browser {
            command.envs(browser.env(&attempt_id));
        }
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
        let spawned = command.spawn();
        let mut entry = Entry {
            flow: AuthFlow {
                id: attempt_id.clone(),
                account_id: account_id.to_owned(),
                status: AuthFlowStatus::Starting,
                browser_ready: false,
                code_requested: false,
                in_window: None,
                window_available: (browser.is_some() && background.is_none()).then_some(true),
                started_at: iso_timestamp(now_ms()),
                error: None,
                background: background.is_some().then_some(true),
            },
            child: None,
            stdin: None,
            output: String::new(),
            url: None,
            printed: None,
            handoff: browser.is_some(),
            closed: false,
            stopping: false,
            continued: false,
            present: background.map(|b| b.present),
            ended: AuthSettled::default(),
            profile,
        };
        let started = entry.flow.clone();
        let mut effects = vec![Effect::Emit(started.clone())];
        match spawned {
            Err(_) => {
                entry.closed = true;
                entry.profile = None;
                inner.finish(
                    &mut entry,
                    &mut effects,
                    AuthFlowStatus::Failed,
                    Some("Could not start the usage sign-in. Check Claude Code CLI in Settings."),
                );
                entries.insert(account_id.to_owned(), entry);
            }
            Ok(mut child) => {
                entry.stdin = child.stdin.take();
                let readers: Vec<_> = [
                    child
                        .stdout
                        .take()
                        .map(|s| Box::new(s) as Box<dyn Read + Send>),
                    child
                        .stderr
                        .take()
                        .map(|s| Box::new(s) as Box<dyn Read + Send>),
                ]
                .into_iter()
                .flatten()
                .map(|mut stream| {
                    let this = self.clone();
                    let (account, attempt) = (account_id.to_owned(), attempt_id.clone());
                    thread::spawn(move || {
                        let mut decoder = Utf8Stream::default();
                        let mut buffer = [0u8; 8192];
                        while let Ok(n) = stream.read(&mut buffer) {
                            if n == 0 {
                                break;
                            }
                            let chunk = decoder.push(&buffer[..n]);
                            this.receive(&account, &attempt, &chunk);
                        }
                    })
                })
                .collect();
                let child = Arc::new(Mutex::new(child));
                entry.child = Some(child.clone());
                entries.insert(account_id.to_owned(), entry);
                let this = self.clone();
                let (account, attempt) = (account_id.to_owned(), attempt_id.clone());
                thread::spawn(move || {
                    for reader in readers {
                        let _ = reader.join();
                    }
                    let code = loop {
                        if let Ok(Some(status)) =
                            child.lock().unwrap_or_else(|e| e.into_inner()).try_wait()
                        {
                            break status.code();
                        }
                        thread::sleep(Duration::from_millis(20));
                    };
                    this.closed(&account, &attempt, code);
                });
                self.spawn_timer(account_id, &attempt_id);
                if let Some(browser) = browser {
                    self.spawn_handoff(account_id, &attempt_id, browser);
                }
            }
        }
        drop(entries);
        inner.run(effects);
        Ok(started)
    }

    fn spawn_timer(&self, account: &str, attempt: &str) {
        let this = self.clone();
        let (account, attempt) = (account.to_owned(), attempt.to_owned());
        thread::spawn(move || {
            let inner = &this.0;
            let pending = |entries: &mut IndexMap<String, Entry>| {
                entries.get(&account).is_some_and(|e| {
                    e.flow.id == attempt && auth_pending(Some(&e.flow)) && !e.stopping
                })
            };
            let entries = inner.lock();
            let (mut entries, timeout) = inner
                .changed
                .wait_timeout_while(entries, inner.timeout, |entries| pending(entries))
                .unwrap_or_else(|e| e.into_inner());
            if timeout.timed_out() && pending(&mut entries) {
                drop(entries);
                let _ = this.cancel_inner(&account, &attempt, true);
            }
        });
    }

    fn spawn_handoff(&self, account: &str, attempt: &str, browser: Arc<dyn AuthBrowser>) {
        let this = self.clone();
        let (account, attempt) = (account.to_owned(), attempt.to_owned());
        thread::spawn(move || {
            let inner = &this.0;
            let started = Instant::now();
            loop {
                thread::sleep(HANDOFF_POLL);
                {
                    let mut entries = inner.lock();
                    let Some(e) = entry_of(&mut entries, &account, &attempt) else {
                        return;
                    };
                    if e.stopping || !auth_pending(Some(&e.flow)) || e.closed {
                        return;
                    }
                    if e.url.is_some() {
                        return;
                    }
                }
                let handed = browser.take(&attempt);
                let mut effects = Vec::new();
                let url;
                let present;
                {
                    let mut entries = inner.lock();
                    let Some(e) = entry_of(&mut entries, &account, &attempt) else {
                        return;
                    };
                    let found = handed
                        .and_then(|h| authorization_url(&format!("{h}\n")))
                        .or_else(|| {
                            (started.elapsed() >= Duration::from_millis(HANDOFF_MS))
                                .then(|| e.printed.clone())
                                .flatten()
                        });
                    let Some(found) = found else { continue };
                    if e.url.is_some() || e.stopping || !auth_pending(Some(&e.flow)) {
                        return;
                    }
                    e.url = Some(found.clone());
                    inner.update(e, &mut effects, |flow| {
                        flow.status = AuthFlowStatus::Waiting;
                        flow.browser_ready = true;
                    });
                    url = found;
                    present = e.present.clone();
                }
                inner.run(effects);
                if let Some(present) = present {
                    present(&url);
                    return;
                }
                // The system browser first: Google and passkey sign-ins work there. A browser that
                // cannot be opened leaves Relay's own window.
                if (inner.open)(&url).is_err() {
                    let mut effects = Vec::new();
                    {
                        let mut entries = inner.lock();
                        let Some(e) = entry_of(&mut entries, &account, &attempt) else {
                            return;
                        };
                        if e.url.as_deref() != Some(url.as_str())
                            || e.stopping
                            || !auth_pending(Some(&e.flow))
                        {
                            return;
                        }
                        inner.update(e, &mut effects, |flow| flow.in_window = Some(true));
                    }
                    inner.run(effects);
                    browser.show(&account, &url);
                }
                return;
            }
        });
    }

    fn receive(&self, account: &str, attempt: &str, chunk: &str) {
        let inner = &self.0;
        let mut effects = Vec::new();
        {
            let mut entries = inner.lock();
            let Some(e) = entry_of(&mut entries, account, attempt) else {
                return;
            };
            if e.stopping || !auth_pending(Some(&e.flow)) {
                return;
            }
            e.output = last_chars(&(e.output.clone() + chunk), 32_768);
            // Require a delimiter to avoid accepting a truncated OAuth query at a chunk boundary.
            let end = e.output.rfind(['\n', '\r']).map_or(0, |i| i + 1);
            let url = authorization_url(&e.output[..end]);
            // With a handoff, the page the CLI hands to BROWSER wins; the printed one is the fallback.
            match url {
                Some(url) if e.url.is_none() && !e.handoff => {
                    e.url = Some(url.clone());
                    inner.update(e, &mut effects, |flow| {
                        flow.status = AuthFlowStatus::Waiting;
                        flow.browser_ready = true;
                    });
                    if let Some(present) = &e.present {
                        effects.push(Effect::Present(present.clone(), url));
                    }
                }
                Some(url) if e.printed.is_none() => e.printed = Some(url),
                _ => {}
            }
            if CODE_PROMPT.is_match(&strip_vt_control_characters(&e.output))
                && !e.flow.code_requested
            {
                inner.update(e, &mut effects, |flow| flow.code_requested = true);
            }
            // Some CLI versions ask for Enter after saving credentials.
            if LOGIN_SUCCESSFUL.is_match(&e.output) && !e.continued {
                e.continued = true;
                if let Some(stdin) = e.stdin.as_mut() {
                    // Exit can race with a final newline/code submission.
                    let _ = stdin.write_all(b"\n");
                }
            }
        }
        inner.run(effects);
    }

    fn closed(&self, account: &str, attempt: &str, code: Option<i32>) {
        let inner = &self.0;
        let mut effects = Vec::new();
        let verify;
        {
            let mut entries = inner.lock();
            let Some(e) = entry_of(&mut entries, account, attempt) else {
                return;
            };
            e.profile = None;
            e.closed = true;
            e.stdin = None;
            inner.changed.notify_all();
            if e.stopping || !auth_pending(Some(&e.flow)) {
                return;
            }
            e.output.clear();
            e.url = None;
            if code != Some(0) {
                inner.finish(
                    e,
                    &mut effects,
                    AuthFlowStatus::Failed,
                    Some("The usage sign-in did not finish. Try again and approve it in the browser."),
                );
                verify = false;
            } else {
                inner.update(e, &mut effects, |flow| {
                    flow.status = AuthFlowStatus::Verifying;
                    flow.browser_ready = false;
                    flow.code_requested = false;
                });
                verify = true;
            }
        }
        inner.run(effects);
        if verify {
            self.complete(account, attempt);
        }
    }

    fn complete(&self, account: &str, attempt: &str) {
        let inner = &self.0;
        let verdict = (inner.verify)(account);
        let mut effects = Vec::new();
        {
            let mut entries = inner.lock();
            let Some(e) = entry_of(&mut entries, account, attempt) else {
                return;
            };
            if e.stopping || !auth_pending(Some(&e.flow)) {
                return;
            }
            match verdict {
                Ok(Verdict::Yes) => inner.finish(e, &mut effects, AuthFlowStatus::Connected, None),
                Ok(Verdict::Reason(reason)) => {
                    inner.finish(e, &mut effects, AuthFlowStatus::Failed, Some(&reason))
                }
                Ok(Verdict::No) => inner.finish(
                    e,
                    &mut effects,
                    AuthFlowStatus::Failed,
                    Some("The browser approval came through, but the account could not be verified. Refresh limits; if it persists, renew the usage sign-in."),
                ),
                Err(_) => inner.finish(
                    e,
                    &mut effects,
                    AuthFlowStatus::Failed,
                    Some("The account could not be verified. Refresh limits; if it persists, renew the usage sign-in."),
                ),
            }
        }
        inner.run(effects);
    }

    /// The flow of this attempt once it ends; `None` for an attempt no longer kept.
    pub fn settled(&self, account_id: &str, attempt_id: &str) -> Option<AuthSettled> {
        self.0
            .lock()
            .get(account_id)
            .filter(|e| e.flow.id == attempt_id)
            .map(|e| e.ended.clone())
    }

    fn get<'a>(
        entries: &'a mut Entries<'_>,
        account: &str,
        attempt: &str,
    ) -> Result<&'a mut Entry, AuthError> {
        entry_of(entries, account, attempt)
            .ok_or_else(|| AuthError::failed("This sign-in attempt is no longer valid."))
    }

    /// Opens the sign-in page again: in Relay's window (`window`), or in the system browser.
    pub fn reopen(
        &self,
        account_id: &str,
        attempt_id: &str,
        window: bool,
    ) -> Result<(), AuthError> {
        let inner = &self.0;
        let mut effects = Vec::new();
        let browser = inner.browser();
        let url;
        {
            let mut entries = inner.lock();
            let e = Self::get(&mut entries, account_id, attempt_id)?;
            url = match (&e.url, e.stopping, e.flow.status) {
                (Some(url), false, AuthFlowStatus::Waiting) => url.clone(),
                _ => {
                    return Err(AuthError::failed(
                        "The sign-in page isn’t ready yet or has expired. Start the sign-in again.",
                    ));
                }
            };
            // From now on the flow owns that window: it closes when the sign-in ends.
            if window && browser.is_some() && e.flow.in_window != Some(true) {
                inner.update(e, &mut effects, |flow| flow.in_window = Some(true));
            }
        }
        inner.run(effects);
        match browser {
            Some(browser) if window => {
                browser.show(account_id, &url);
                Ok(())
            }
            _ => (inner.open)(&url).map_err(AuthError::Failed),
        }
    }

    pub fn submit_code(
        &self,
        account_id: &str,
        attempt_id: &str,
        code: &str,
    ) -> Result<(), AuthError> {
        let inner = &self.0;
        let mut effects = Vec::new();
        {
            let mut entries = inner.lock();
            let e = Self::get(&mut entries, account_id, attempt_id)?;
            if !auth_pending(Some(&e.flow)) || e.stopping || !e.flow.code_requested {
                return Err(AuthError::failed(
                    "This sign-in attempt is not waiting for a code.",
                ));
            }
            if code.trim().is_empty()
                || code.encode_utf16().count() > 4096
                || CODE_FORBIDDEN.is_match(code)
            {
                return Err(AuthError::failed(
                    "Paste the single-line code from the browser.",
                ));
            }
            if let Some(stdin) = e.stdin.as_mut() {
                let _ = stdin.write_all(format!("{}\n", code.trim()).as_bytes());
            }
            inner.update(e, &mut effects, |flow| flow.code_requested = false);
        }
        inner.run(effects);
        Ok(())
    }

    /// Stops the attempt and waits for its CLI to close.
    pub fn cancel(&self, account_id: &str, attempt_id: &str) -> Result<(), AuthError> {
        self.cancel_inner(account_id, attempt_id, false)
    }

    fn cancel_inner(
        &self,
        account_id: &str,
        attempt_id: &str,
        timed_out: bool,
    ) -> Result<(), AuthError> {
        let inner = &self.0;
        let child;
        {
            let mut entries = inner.lock();
            let e = Self::get(&mut entries, account_id, attempt_id)?;
            if !auth_pending(Some(&e.flow)) {
                return Ok(());
            }
            e.stopping = true;
            inner.changed.notify_all();
            child = e.child.clone();
        }
        if let Some(child) = &child {
            terminate(&mut child.lock().unwrap_or_else(|e| e.into_inner()));
        }
        let is_closed = |entries: &mut IndexMap<String, Entry>| {
            entries
                .get(account_id)
                .is_none_or(|e| e.flow.id != attempt_id || e.closed)
        };
        let entries = inner.lock();
        let (entries, waited) = inner
            .changed
            .wait_timeout_while(entries, Duration::from_millis(1_500), |e| !is_closed(e))
            .unwrap_or_else(|e| e.into_inner());
        let mut entries = if waited.timed_out() {
            drop(entries);
            if let Some(child) = &child {
                let _ = child.lock().unwrap_or_else(|e| e.into_inner()).kill();
            }
            let entries = inner.lock();
            inner
                .changed
                .wait_while(entries, |e| !is_closed(e))
                .unwrap_or_else(|e| e.into_inner())
        } else {
            entries
        };
        let mut effects = Vec::new();
        if let Some(e) = entry_of(&mut entries, account_id, attempt_id) {
            if timed_out {
                inner.finish(
                    e,
                    &mut effects,
                    AuthFlowStatus::Failed,
                    Some("The sign-in timed out. Start it again."),
                );
            } else {
                inner.finish(e, &mut effects, AuthFlowStatus::Cancelled, None);
            }
            e.stopping = false;
        }
        drop(entries);
        inner.run(effects);
        Ok(())
    }

    /// Cancels every pending attempt.
    pub fn dispose(&self) {
        for flow in self.list().into_iter().filter(|f| auth_pending(Some(f))) {
            let _ = self.cancel(&flow.account_id, &flow.id);
        }
    }
}

/// `ChildProcess.kill()`: SIGTERM on Unix; the process is ended at once elsewhere.
fn terminate(child: &mut Child) {
    #[cfg(unix)]
    {
        if let Ok(pid) = libc::pid_t::try_from(child.id()) {
            // SAFETY: plain kill(2) on our own child's pid.
            unsafe {
                libc::kill(pid, libc::SIGTERM);
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
}
