//! Port of `electron/core/antigravity-switch.ts`: moving Google's Antigravity app (and the `agy`
//! CLI) from one Google account to another, the way Relay moves the Claude app: each account's
//! sign-in is kept sealed in Relay's vault, and a switch closes the app, puts the other sign-in
//! in its place and opens the app again.
//!
//! Antigravity 2.x keeps its sign-in in one Keychain item, service `gemini`, account
//! `antigravity`, which the app and `agy` share: `go-keyring-base64:` and the base64 of a JSON
//! object holding the OAuth token and `id_token_email`. Both read it when they start, so a
//! running `agy` stays on the account it started with. The app may write its own sign-in back
//! while it shuts down, so the new one is written only once every Antigravity process has gone.
//!
//! Relay never signs out inside the app (that may end the sign-in at Google) and never talks to
//! Google with these tokens: the official app does, as it always would. Google's FAQ says
//! automated account rotation is not supported on consumer plans, so a switch only ever starts
//! from a click.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use indexmap::{IndexMap, IndexSet};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::antigravity_app::{ANTIGRAVITY_BUNDLE_ID, EMAIL, MAX_SETTINGS_BYTES, app_launch_env};
use crate::clock::now_ms;
use crate::desktop_files::{read_bytes, write_bytes};
use crate::detached_exec::{ExecOptions, run_detached};
use crate::meters::common::buffer_from_base64;
use crate::shared::types::js::iso;
use crate::shared::types::{
    Account, AccountProvider, AntigravityAppResult, AntigravityBusy, AntigravityResultKind,
    AntigravityResultReason,
};
use crate::terminal_identity::{SealFn, TerminalKeychain, UnsealFn, security_keychain};

pub const ANTIGRAVITY_SERVICE: &str = "gemini";
pub const ANTIGRAVITY_ITEM_ACCOUNT: &str = "antigravity";
const PREFIX: &str = "go-keyring-base64:";
const MAX_ITEM_BYTES: usize = 64 * 1024;
const DIR: &str = "antigravity-app";

/// The app's settings keys that record which account last accepted its terms (`agy.` and older
/// `jetski.`).
static ONBOARDING_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z]+\.onboarding\.lastLogin[A-Za-z]*$").expect("valid regex"));
static UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        .expect("valid regex")
});

/// What a sign-in says about itself.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SignIn {
    /// Its Google account, lower-cased, when it names a valid one.
    pub email: Option<String>,
    pub valid: bool,
}

fn json_of(bytes: &[u8]) -> Option<Value> {
    serde_json::from_str(&String::from_utf8_lossy(bytes)).ok()
}

/// What a sign-in says about itself: its Google account, when the item is one Relay
/// understands.
pub fn parse_sign_in(raw: Option<&str>) -> SignIn {
    let invalid = SignIn::default();
    let Some(raw) = raw.filter(|r| !r.is_empty()) else {
        return invalid;
    };
    if raw.encode_utf16().count() > MAX_ITEM_BYTES || !raw.starts_with(PREFIX) {
        return invalid;
    }
    let Some(data) = json_of(&buffer_from_base64(&raw[PREFIX.len()..])) else {
        return invalid;
    };
    let refresh = data
        .get("token")
        .and_then(|t| t.get("refresh_token"))
        .and_then(Value::as_str);
    if refresh.is_none_or(str::is_empty) {
        return invalid;
    }
    let mut email = data
        .get("id_token_email")
        .and_then(Value::as_str)
        .filter(|e| !e.is_empty())
        .map(str::to_owned);
    if email.is_none()
        && let Some(id_token) = data.get("id_token").and_then(Value::as_str)
    {
        let part = id_token.split('.').nth(1).unwrap_or("");
        // An id_token whose claims are not JSON makes the item one Relay does not understand.
        let Some(claims) = json_of(&buffer_from_base64(part)) else {
            return invalid;
        };
        email = claims
            .get("email")
            .and_then(Value::as_str)
            .map(str::to_owned);
    }
    SignIn {
        email: email
            .filter(|e| EMAIL.is_match(e))
            .map(|e| e.to_lowercase()),
        valid: true,
    }
}

/// One account's saved sign-in, sealed in the vault.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravitySaved {
    #[serde(default)]
    pub email: String,
    pub raw: String,
    /// The app's terms-acceptance keys as they stood for this account, put back at a switch to
    /// it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub onboarding: Option<IndexMap<String, String>>,
    #[serde(default)]
    pub saved_at: String,
}

/// What a sign-in is saved with, before its time is added.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignInEntry {
    pub email: String,
    pub raw: String,
    pub onboarding: Option<IndexMap<String, String>>,
}

/// Where the switcher keeps sign-ins: `AntigravityVault`, or a stand-in.
pub trait AntigravityStore: Send + Sync {
    fn save(&self, account_id: &str, entry: SignInEntry) -> Result<(), String>;
    /// The sign-in saved for an account; None when there is none or it cannot be opened.
    fn load(&self, account_id: &str) -> Option<AntigravitySaved>;
    fn save_other(&self, raw: &str) -> Result<(), String>;
    fn save_pending(&self, raw: &str) -> Result<(), String>;
    fn load_pending(&self) -> Result<Option<String>, String>;
    fn clear_pending(&self) -> Result<(), String>;
    fn remove(&self, account_id: &str) -> Result<(), String>;
    /// The accounts with a sign-in saved.
    fn list(&self) -> Vec<String>;
}

/// The sign-ins sealed in Relay's vault, under `antigravity-app/`.
pub struct AntigravityVault {
    vault: PathBuf,
    seal: SealFn,
    unseal: UnsealFn,
    now: Arc<dyn Fn() -> f64 + Send + Sync>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedOther<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<&'a str>,
    raw: &'a str,
    saved_at: String,
}

impl AntigravityVault {
    pub fn new(
        vault: impl Into<PathBuf>,
        seal: SealFn,
        unseal: UnsealFn,
        now: Option<Arc<dyn Fn() -> f64 + Send + Sync>>,
    ) -> Self {
        AntigravityVault {
            vault: vault.into(),
            seal,
            unseal,
            now: now.unwrap_or_else(|| Arc::new(|| now_ms() as f64)),
        }
    }

    fn file(account_id: &str) -> Result<String, String> {
        if !UUID.is_match(account_id) {
            return Err("Invalid account id.".into());
        }
        Ok(format!("{DIR}/{}.bin", account_id.to_lowercase()))
    }

    fn write(&self, relative: &str, text: &str) -> Result<(), String> {
        let sealed = (self.seal)(text)?;
        write_bytes(&self.vault, relative, Some(&sealed)).map_err(|e| e.to_string())
    }
}

impl AntigravityStore for AntigravityVault {
    fn save(&self, account_id: &str, entry: SignInEntry) -> Result<(), String> {
        let saved = AntigravitySaved {
            email: entry.email,
            raw: entry.raw,
            onboarding: entry.onboarding,
            saved_at: iso((self.now)()),
        };
        let text = serde_json::to_string(&saved).expect("strings serialize");
        self.write(&Self::file(account_id)?, &text)
    }

    fn load(&self, account_id: &str) -> Option<AntigravitySaved> {
        let data = read_bytes(&self.vault, &Self::file(account_id).ok()?).ok()??;
        let saved: AntigravitySaved = serde_json::from_str(&(self.unseal)(&data).ok()?).ok()?;
        parse_sign_in(Some(&saved.raw)).valid.then_some(saved)
    }

    /// The last sign-in of a Google account Relay does not have (or cannot read), kept so a
    /// switch never loses it: one slot per such account (named by a hash of its e-mail, or of
    /// the item when it names none), so a second one never overwrites the first.
    fn save_other(&self, raw: &str) -> Result<(), String> {
        let email = parse_sign_in(Some(raw)).email;
        let digest = Sha256::digest(email.as_deref().unwrap_or(raw).as_bytes());
        let key: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
        let saved = SavedOther {
            email: email.as_deref(),
            raw,
            saved_at: iso((self.now)()),
        };
        let text = serde_json::to_string(&saved).expect("strings serialize");
        self.write(&format!("{DIR}/other-{key}.bin"), &text)
    }

    /// The sign-in taken off this Mac while a new one is awaited, kept until it is back or
    /// replaced.
    fn save_pending(&self, raw: &str) -> Result<(), String> {
        self.write(&format!("{DIR}/pending.bin"), raw)
    }

    fn load_pending(&self) -> Result<Option<String>, String> {
        match read_bytes(&self.vault, &format!("{DIR}/pending.bin")).map_err(|e| e.to_string())? {
            Some(data) => (self.unseal)(&data).map(Some),
            None => Ok(None),
        }
    }

    fn clear_pending(&self) -> Result<(), String> {
        write_bytes(&self.vault, &format!("{DIR}/pending.bin"), None).map_err(|e| e.to_string())
    }

    fn remove(&self, account_id: &str) -> Result<(), String> {
        write_bytes(&self.vault, &Self::file(account_id)?, None).map_err(|e| e.to_string())
    }

    fn list(&self) -> Vec<String> {
        let Ok(entries) = fs::read_dir(self.vault.join(DIR)) else {
            return Vec::new();
        };
        entries
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter_map(|name| {
                let id = name.strip_suffix(".bin")?;
                (!id.is_empty() && UUID.is_match(id)).then(|| id.to_owned())
            })
            .collect()
    }
}

/// Whether any Antigravity app process runs (the app, its helpers, its language server), and
/// how many `agy` do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AntigravityProcesses {
    pub app: bool,
    pub agy: u32,
}

/// The app's settings file, as a JSON object.
pub type JsonObject = serde_json::Map<String, Value>;

/// Sets keys in the app's settings file.
pub type WriteSettings = Arc<dyn Fn(&IndexMap<String, String>) -> Result<(), String> + Send + Sync>;

/// What the switcher does to the system; tests act it out.
#[derive(Clone)]
pub struct AntigravitySwitchPorts {
    pub keychain: Arc<dyn TerminalKeychain>,
    /// The app's settings file (`app_storage.json`).
    pub read_settings: Arc<dyn Fn() -> Result<Option<JsonObject>, String> + Send + Sync>,
    /// Sets these keys, keeping every other one; only while the app is closed.
    pub write_settings: WriteSettings,
    pub processes: Arc<dyn Fn() -> Result<AntigravityProcesses, String> + Send + Sync>,
    /// Asks the app to quit, as the user would; returns once asked.
    pub quit: Arc<dyn Fn() + Send + Sync>,
    pub launch: Arc<dyn Fn() -> Result<(), String> + Send + Sync>,
    pub sleep: Arc<dyn Fn(u64) + Send + Sync>,
}

/// Why a switch or a sign-in stopped.
pub type AntigravitySwitchReason = AntigravityResultReason;

const QUIT_WAIT_MS: u64 = 30_000;
const SIGN_IN_WAIT_MS: u64 = 10 * 60_000;
const POLL_MS: u64 = 1_000;
const SIGN_IN_POLL_MS: u64 = 2_000;
const PEEK_TTL_MS: f64 = 15_000.0;

/// Which Antigravity account the app and `agy` use now, read from the Keychain item itself.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityCurrent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// Signed in with a Google account Relay does not have.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub other: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signed_out: Option<bool>,
}

impl AntigravityCurrent {
    fn account(id: &str) -> Self {
        AntigravityCurrent {
            account_id: Some(id.to_owned()),
            ..Self::default()
        }
    }
}

/// What the snapshot carries: saved accounts, the operation under way, the last outcome.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AntigravitySwitchState {
    pub saved: Vec<String>,
    pub busy: Option<AntigravityBusy>,
    pub sign_in_for: Option<String>,
    pub result: Option<AntigravityAppResult>,
}

/// A reading under way, shared by every caller that has no earlier one to show.
type Peek = Arc<(Mutex<Option<AntigravityCurrent>>, Condvar)>;

#[derive(Default)]
struct St {
    op: Option<AntigravityBusy>,
    sign_in_for: Option<String>,
    cancel_requested: bool,
    result: Option<AntigravityAppResult>,
    saved: Option<IndexSet<String>>,
    peeked: Option<(f64, AntigravityCurrent)>,
    peeking: Option<Peek>,
    /// After a failed read (a locked keychain), the next one waits until then.
    retry_at: f64,
    /// Moves at each operation's start and end: a reading begun before it is not saved.
    generation: u64,
}

struct Inner {
    ports: AntigravitySwitchPorts,
    vault: Arc<dyn AntigravityStore>,
    accounts: Arc<dyn Fn() -> Vec<Account> + Send + Sync>,
    on_change: Arc<dyn Fn() + Send + Sync>,
    now: Arc<dyn Fn() -> f64 + Send + Sync>,
    st: Mutex<St>,
}

/// The switcher. Clones share it.
#[derive(Clone)]
pub struct AntigravitySwitcher(Arc<Inner>);

type Reason = AntigravityResultReason;

impl AntigravitySwitcher {
    pub fn new(
        ports: AntigravitySwitchPorts,
        vault: Arc<dyn AntigravityStore>,
        accounts: Arc<dyn Fn() -> Vec<Account> + Send + Sync>,
        on_change: Option<Arc<dyn Fn() + Send + Sync>>,
        now: Option<Arc<dyn Fn() -> f64 + Send + Sync>>,
    ) -> Self {
        AntigravitySwitcher(Arc::new(Inner {
            ports,
            vault,
            accounts,
            on_change: on_change.unwrap_or_else(|| Arc::new(|| {})),
            now: now.unwrap_or_else(|| Arc::new(|| now_ms() as f64)),
            st: Mutex::new(St::default()),
        }))
    }

    fn st(&self) -> MutexGuard<'_, St> {
        self.0.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn now(&self) -> f64 {
        (self.0.now)()
    }

    fn changed(&self) {
        (self.0.on_change)();
    }

    fn saved_set(&self) -> IndexSet<String> {
        if let Some(saved) = self.st().saved.clone() {
            return saved;
        }
        let listed: IndexSet<String> = self.0.vault.list().into_iter().collect();
        self.st().saved.get_or_insert(listed).clone()
    }

    /// What the snapshot carries: saved accounts, the operation under way, the last outcome.
    pub fn state(&self) -> AntigravitySwitchState {
        let saved = self.saved_set();
        let ids: Vec<String> = (self.0.accounts)()
            .into_iter()
            .filter(|a| a.provider == Some(AccountProvider::Antigravity))
            .map(|a| a.id)
            .collect();
        let st = self.st();
        AntigravitySwitchState {
            saved: saved.into_iter().filter(|id| ids.contains(id)).collect(),
            busy: st.op,
            sign_in_for: st.sign_in_for.clone(),
            result: st.result.clone(),
        }
    }

    /// An account removed from Relay: its saved app sign-in goes with it (the Mac's own item
    /// stays).
    pub fn forget(&self, account_id: &str) -> Result<(), String> {
        self.0.vault.remove(account_id)?;
        if let Some(saved) = self.st().saved.as_mut() {
            saved.shift_remove(account_id);
        }
        self.changed();
        Ok(())
    }

    fn match_email(&self, email: Option<&str>) -> Option<Account> {
        let email = email?;
        (self.0.accounts)().into_iter().find(|a| {
            a.provider == Some(AccountProvider::Antigravity)
                && a.auth
                    .as_ref()
                    .and_then(|auth| auth.email.as_deref())
                    .is_some_and(|e| e.to_lowercase() == email)
        })
    }

    /// The account the Keychain item belongs to. The snapshot never waits on the Keychain once
    /// it has a reading: a reading older than 15 s is renewed in the background, one at a time,
    /// and a failed one (a locked keychain) is not tried again for a minute. A Relay account's
    /// sign-in is saved on the way, so the vault holds the latest one the app used.
    pub fn current(&self) -> AntigravityCurrent {
        let now = self.now();
        let (peek, owner) = {
            let mut st = self.st();
            let cached = st.peeked.as_ref().map(|(_, c)| c.clone());
            if st.op.is_some() {
                return cached.unwrap_or_default();
            }
            let fresh = st
                .peeked
                .as_ref()
                .is_some_and(|(at, _)| now - at < PEEK_TTL_MS);
            if fresh || now < st.retry_at {
                return cached.unwrap_or_default();
            }
            match (&st.peeking, cached) {
                (Some(_), Some(cached)) => return cached,
                (Some(peek), None) => (peek.clone(), false),
                (None, cached) => {
                    let peek: Peek = Arc::new((Mutex::new(None), Condvar::new()));
                    st.peeking = Some(peek.clone());
                    if let Some(cached) = cached {
                        let me = self.clone();
                        std::thread::spawn(move || me.run_peek(&peek));
                        return cached;
                    }
                    (peek, true)
                }
            }
        };
        if owner {
            return self.run_peek(&peek);
        }
        let (slot, done) = &*peek;
        let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if let Some(current) = guard.as_ref() {
                return current.clone();
            }
            guard = done.wait(guard).unwrap_or_else(|e| e.into_inner());
        }
    }

    fn run_peek(&self, peek: &Peek) -> AntigravityCurrent {
        let current = self.peek();
        *peek.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(current.clone());
        peek.1.notify_all();
        let mut st = self.st();
        if st.peeking.as_ref().is_some_and(|p| Arc::ptr_eq(p, peek)) {
            st.peeking = None;
        }
        current
    }

    fn peek(&self) -> AntigravityCurrent {
        let generation = self.st().generation;
        match self.capture(Some(generation)) {
            Ok((current, _)) => {
                // An operation started or ended meanwhile: this reading is from before it, so
                // it is not kept.
                let mut st = self.st();
                if generation == st.generation {
                    st.peeked = Some((self.now(), current.clone()));
                }
                current
            }
            Err(_) => {
                let mut st = self.st();
                if generation == st.generation {
                    st.retry_at = self.now() + 60_000.0;
                }
                st.peeked
                    .as_ref()
                    .map(|(_, c)| c.clone())
                    .unwrap_or_default()
            }
        }
    }

    /// Reads the item and keeps it: a Relay account's in its slot, when new or changed; during
    /// an operation, any other sign-in aside, so nothing Relay overwrites is lost. Fails
    /// (keychain, save) when it cannot read the item or keep it. A background reading
    /// (`generation`) saves only while no operation has started or ended since it began.
    fn capture(
        &self,
        generation: Option<u64>,
    ) -> Result<(AntigravityCurrent, Option<String>), Reason> {
        let raw = self.0.ports.keychain.read().map_err(|_| Reason::Keychain)?;
        let Some(raw) = raw else {
            return Ok((
                AntigravityCurrent {
                    signed_out: Some(true),
                    ..AntigravityCurrent::default()
                },
                None,
            ));
        };
        let sign = parse_sign_in(Some(&raw));
        let account = if sign.valid {
            self.match_email(sign.email.as_deref())
        } else {
            None
        };
        // Asked again after every step, since an operation can start during the reads below.
        let stale = || generation.is_some_and(|g| g != self.st().generation);
        let Some(account) = account else {
            if generation.is_none() {
                self.0.vault.save_other(&raw).map_err(|_| Reason::Save)?;
            }
            return Ok((
                AntigravityCurrent {
                    other: Some(true),
                    ..AntigravityCurrent::default()
                },
                Some(raw),
            ));
        };
        let current = AntigravityCurrent::account(&account.id);
        let before = if stale() {
            None
        } else {
            self.0.vault.load(&account.id)
        };
        if !stale() && before.as_ref().map(|b| &b.raw) != Some(&raw) {
            let email = sign.email.clone().unwrap_or_default();
            let onboarding = self.onboarding(&email);
            if stale() {
                return Ok((current, Some(raw)));
            }
            self.0
                .vault
                .save(
                    &account.id,
                    SignInEntry {
                        email,
                        raw: raw.clone(),
                        onboarding: onboarding.or_else(|| before.and_then(|b| b.onboarding)),
                    },
                )
                .map_err(|_| Reason::Save)?;
            let mut saved = self.saved_set();
            saved.insert(account.id.clone());
            self.st().saved = Some(saved);
        }
        Ok((current, Some(raw)))
    }

    /// The app's terms keys, when they name this e-mail (they were written for this account).
    fn onboarding(&self, email: &str) -> Option<IndexMap<String, String>> {
        let settings = (self.0.ports.read_settings)().ok()??;
        let keys: IndexMap<String, String> = settings
            .iter()
            .filter(|(key, _)| ONBOARDING_KEY.is_match(key))
            .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
            .collect();
        let named = keys
            .iter()
            .any(|(key, value)| key.ends_with("Username") && value.to_lowercase() == email);
        named.then_some(keys)
    }

    /// Starts an operation, or refuses when one runs.
    fn begin(&self, op: AntigravityBusy) -> Result<(), Reason> {
        {
            let mut st = self.st();
            if st.op.is_some() {
                return Err(Reason::Busy);
            }
            st.op = Some(op);
            st.generation += 1;
        }
        self.changed();
        Ok(())
    }

    /// Ends the operation: the next snapshot reads the item afresh.
    fn end(&self) {
        let mut st = self.st();
        st.op = None;
        st.sign_in_for = None;
        st.cancel_requested = false;
        st.generation += 1;
        st.peeked = None;
        st.retry_at = 0.0;
    }

    fn cancelled(&self) -> bool {
        self.st().cancel_requested
    }

    fn processes(&self) -> Result<AntigravityProcesses, Reason> {
        (self.0.ports.processes)().map_err(|_| Reason::Unexpected)
    }

    /// Closes the app and waits until every one of its processes is gone. Whether it was open.
    /// `asked` turns true once the quit is asked, so a caller whose close timed out still
    /// reopens the app.
    fn close_app(&self, asked: &mut bool) -> Result<bool, Reason> {
        if !self.processes()?.app {
            return Ok(false);
        }
        (self.0.ports.quit)();
        *asked = true;
        let mut waited = 0;
        while waited < QUIT_WAIT_MS {
            (self.0.ports.sleep)(POLL_MS);
            if !self.processes()?.app {
                return Ok(true);
            }
            waited += POLL_MS;
        }
        Err(Reason::StillRunning)
    }

    /// Writes a sign-in into the item and reads it back.
    fn put(&self, raw: &str) -> Result<(), Reason> {
        self.0
            .ports
            .keychain
            .write(raw)
            .map_err(|_| Reason::Keychain)?;
        let back = self.0.ports.keychain.read().ok().flatten();
        if back.as_deref() != Some(raw) {
            return Err(Reason::VerifyFailed);
        }
        Ok(())
    }

    fn finish(
        &self,
        kind: AntigravityResultKind,
        account_id: &str,
        reason: Option<Reason>,
        agy_running: Option<u32>,
    ) -> AntigravityAppResult {
        let result = AntigravityAppResult {
            kind,
            account_id: account_id.to_owned(),
            reason,
            agy_running: agy_running.map(f64::from),
            at: self.now(),
        };
        self.st().result = Some(result.clone());
        result
    }

    /// Moves the app and `agy` to a saved account: keeps the sign-in in use, closes the app,
    /// keeps what it wrote on the way out, puts the other sign-in in the Keychain, sets the
    /// app's terms keys for it, and opens the app again if it was open (also when a later step
    /// failed). Nothing is overwritten that could not be kept first. A running `agy` keeps its
    /// account until it restarts; the outcome counts them. Fails only with `Busy`.
    pub fn switch_to(&self, account_id: &str) -> Result<AntigravityAppResult, Reason> {
        self.begin(AntigravityBusy::Switching)?;
        let result = self.switch_now(account_id);
        if self.st().op == Some(AntigravityBusy::Switching) {
            self.end();
        }
        self.changed();
        Ok(result)
    }

    fn switch_now(&self, account_id: &str) -> AntigravityAppResult {
        let mut was_open = false;
        let mut asked = false;
        let mut moved = false;
        let steps = (|| -> Result<Option<AntigravityAppResult>, Reason> {
            let target = self.0.vault.load(account_id).ok_or(Reason::NotSaved)?;
            let (before, _) = self.capture(None)?;
            if before.account_id.as_deref() == Some(account_id) {
                // Already on it: nothing to close or write.
                return Ok(Some(self.finish(
                    AntigravityResultKind::Switched,
                    account_id,
                    None,
                    None,
                )));
            }
            was_open = self.close_app(&mut asked)?;
            // The app may have written its sign-in on the way out: keep that one, not the
            // earlier copy.
            self.capture(None)?;
            self.put(&target.raw)?;
            moved = true;
            if let Some(onboarding) = &target.onboarding {
                let _ = (self.0.ports.write_settings)(onboarding);
            }
            Ok(None)
        })();
        let mut last = match steps {
            Ok(Some(done)) => return done,
            Ok(None) => None,
            Err(reason) => Some(self.finish(
                AntigravityResultKind::Failed,
                account_id,
                Some(reason),
                None,
            )),
        };
        if (was_open || asked) && (self.0.ports.launch)().is_err() && moved {
            return self.finish(
                AntigravityResultKind::Failed,
                account_id,
                Some(Reason::Launch),
                None,
            );
        }
        if moved {
            let agy = self.processes().ok().map(|p| p.agy).filter(|n| *n > 0);
            last = Some(self.finish(AntigravityResultKind::Switched, account_id, None, agy));
        }
        last.expect("a switch either moved the sign-in or failed")
    }

    /// Saves another account's sign-in through the official app: keeps the one in use (also on
    /// disk, so a Relay that quits mid-way puts it back at its next start), closes the app,
    /// takes the sign-in off this Mac (no sign-out at Google), opens the app on its sign-in
    /// screen and waits up to 10 minutes in the background. The sign-in that appears is saved
    /// for the Relay account with its e-mail; a cancel or the timeout puts the earlier one
    /// back. Fails only with `Busy`.
    pub fn begin_sign_in(&self, account_id: &str) -> Result<(), Reason> {
        self.begin(AntigravityBusy::SigningIn)?;
        {
            let mut st = self.st();
            st.sign_in_for = Some(account_id.to_owned());
            st.result = None;
            st.cancel_requested = false;
        }
        let mut previous: Option<String> = None;
        let mut was_open = false;
        let mut asked = false;
        let mut removed = false;
        let steps = (|| -> Result<(), Reason> {
            previous = self.capture(None)?.1;
            was_open = self.close_app(&mut asked)?;
            if let Some(raw) = self.capture(None)?.1 {
                previous = Some(raw);
            }
            if let Some(previous) = &previous {
                self.0
                    .vault
                    .save_pending(previous)
                    .map_err(|_| Reason::Save)?;
            }
            if self.cancelled() {
                return Err(Reason::Cancelled);
            }
            self.0
                .ports
                .keychain
                .remove()
                .map_err(|_| Reason::Keychain)?;
            removed = true;
            if self.cancelled() {
                return Err(Reason::Cancelled);
            }
            (self.0.ports.launch)().map_err(|_| Reason::Unexpected)
        })();
        if let Err(reason) = steps {
            // The earlier sign-in goes back and is checked; only once it is back does its copy
            // on disk go, so a failed put-back is tried again at the next start (`recover`).
            let back = match (&previous, removed) {
                (Some(previous), true) => self.put(previous).is_ok(),
                _ => true,
            };
            if was_open || asked || removed {
                let _ = (self.0.ports.launch)();
            }
            if back {
                let _ = self.0.vault.clear_pending();
            }
            let cancelled = self.cancelled();
            self.end();
            if cancelled {
                self.finish(AntigravityResultKind::Cancelled, account_id, None, None);
            } else {
                self.finish(
                    AntigravityResultKind::Failed,
                    account_id,
                    Some(reason),
                    None,
                );
            }
            self.changed();
            return Ok(());
        }
        self.changed();
        // The wait runs on after the click returns; the snapshot shows it.
        let me = self.clone();
        let account_id = account_id.to_owned();
        std::thread::spawn(move || me.wait_for_sign_in(&account_id, previous));
        Ok(())
    }

    fn done(
        &self,
        kind: AntigravityResultKind,
        account_id: &str,
        reason: Option<Reason>,
        keep_pending: bool,
    ) {
        // The copy on disk stays while the earlier sign-in is not back, for `recover` to retry.
        if !keep_pending {
            let _ = self.0.vault.clear_pending();
        }
        self.end();
        self.finish(kind, account_id, reason, None);
        self.changed();
    }

    /// A sign-in appeared: keep it for its account.
    fn settle(&self, account_id: &str) {
        match self.capture(None) {
            Ok((current, _)) => match current.account_id {
                Some(found) => {
                    let kind = if found == account_id {
                        AntigravityResultKind::Saved
                    } else {
                        AntigravityResultKind::SavedOther
                    };
                    self.done(kind, &found, None, false);
                }
                None => self.done(AntigravityResultKind::Other, account_id, None, false),
            },
            Err(reason) => self.done(
                AntigravityResultKind::Failed,
                account_id,
                Some(reason),
                false,
            ),
        }
    }

    /// None was made (cancelled, or 10 minutes passed): the earlier sign-in goes back first,
    /// then the app, sitting on its sign-in screen, is restarted so it reads it.
    fn restore(
        &self,
        account_id: &str,
        previous: Option<&str>,
        kind: AntigravityResultKind,
        reason: Option<Reason>,
    ) {
        if matches!(self.0.ports.keychain.read(), Ok(Some(_))) {
            return self.settle(account_id);
        }
        if let Some(previous) = previous
            && let Err(failure) = self.put(previous)
        {
            return self.done(
                AntigravityResultKind::Failed,
                account_id,
                Some(failure),
                true,
            );
        }
        let mut asked = false;
        // The sign-in is back; if the app cannot be restarted it reads it at its next start.
        if self.close_app(&mut asked) == Ok(true) {
            let _ = (self.0.ports.launch)();
        }
        self.done(kind, account_id, reason, false);
    }

    fn wait_for_sign_in(&self, account_id: &str, previous: Option<String>) {
        let mut waited = 0;
        while waited < SIGN_IN_WAIT_MS {
            (self.0.ports.sleep)(SIGN_IN_POLL_MS);
            if self.cancelled() {
                return self.restore(
                    account_id,
                    previous.as_deref(),
                    AntigravityResultKind::Cancelled,
                    None,
                );
            }
            if matches!(self.0.ports.keychain.read(), Ok(Some(_))) {
                return self.settle(account_id);
            }
            waited += SIGN_IN_POLL_MS;
        }
        self.restore(
            account_id,
            previous.as_deref(),
            AntigravityResultKind::Failed,
            Some(Reason::Timeout),
        );
    }

    /// Stops waiting for a sign-in and puts the earlier one back when none was made.
    pub fn cancel_sign_in(&self) {
        let mut st = self.st();
        if st.op == Some(AntigravityBusy::SigningIn) {
            st.cancel_requested = true;
        }
    }

    /// At start: a sign-in Relay took off this Mac for a new account's sign-in and could not
    /// put back (Relay quit during the wait) goes back, unless a sign-in was made since.
    pub fn recover(&self) {
        let Ok(Some(pending)) = self.0.vault.load_pending() else {
            return;
        };
        let attempt = || -> Result<(), ()> {
            if self.0.ports.keychain.read().map_err(|_| ())?.is_none() {
                self.put(&pending).map_err(|_| ())?;
            }
            self.0.vault.clear_pending().map_err(|_| ())
        };
        // Tried again at the next start.
        let _ = attempt();
    }
}

// --- macOS ----------------------------------------------------------------------------------

static PS_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*[0-9]+\s+(.+)$").expect("valid regex"));
static APP_PROCESS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"/Antigravity\.app/Contents/|/\.gemini/antigravity/bin/").expect("valid regex")
});
static PS_LISTING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\s*[0-9]+\s+\S").expect("valid regex"));

/// Antigravity's processes in a `ps -axo pid=,comm=` listing: the app bundle's, and the `agy`
/// CLI.
pub fn antigravity_processes(stdout: &str) -> AntigravityProcesses {
    let mut found = AntigravityProcesses::default();
    for line in stdout.split('\n') {
        let Some(comm) = PS_LINE
            .captures(line)
            .map(|m| crate::shared::types::js::trim(&m[1]).to_owned())
            .filter(|c| !c.is_empty())
        else {
            continue;
        };
        // The app's bundle, and the helpers it starts from its own folder (agentapi,
        // webm_encoder).
        if APP_PROCESS.is_match(&comm) {
            found.app = true;
        } else if comm.trim_end_matches('/').rsplit('/').next() == Some("agy") {
            found.agy += 1;
        }
    }
    found
}

fn unexpected() -> String {
    "Unexpected Antigravity settings file.".into()
}

/// Sets keys in the app's settings file, keeping every other key; refused for an odd file.
pub fn write_antigravity_settings(
    file: &Path,
    values: &IndexMap<String, String>,
) -> Result<(), String> {
    let stat = fs::symlink_metadata(file).map_err(|e| e.to_string())?;
    if !stat.is_file() || stat.len() > MAX_SETTINGS_BYTES {
        return Err(unexpected());
    }
    let text = fs::read_to_string(file).map_err(|e| e.to_string())?;
    let mut data = match serde_json::from_str::<Value>(&text).map_err(|e| e.to_string())? {
        Value::Object(map) => map,
        _ => return Err(unexpected()),
    };
    for (key, value) in values {
        if ONBOARDING_KEY.is_match(key) {
            data.insert(key.clone(), Value::String(value.clone()));
        }
    }
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(format!(".relay-{}-{}", std::process::id(), now_ms()));
    let tmp = PathBuf::from(tmp);
    #[cfg(unix)]
    let mode = std::os::unix::fs::PermissionsExt::mode(&stat.permissions()) & 0o777;
    #[cfg(not(unix))]
    let mode = 0o666;
    let data = serde_json::to_vec(&Value::Object(data)).expect("JSON serializes");
    crate::mac_update::write_mode(&tmp, &data, mode).map_err(|e| e.to_string())?;
    fs::rename(&tmp, file).map_err(|e| e.to_string())
}

/// The app and `agy` as they run on macOS: the Keychain item through `security` (`tool`,
/// `/usr/bin/security` unless given), the settings file in `data_dir`, `ps`, `osascript` and
/// `open`.
pub fn mac_antigravity_ports(
    data_dir: &Path,
    security_tool: Option<&Path>,
) -> AntigravitySwitchPorts {
    let settings_file = data_dir.join("app_storage.json");
    let read_file = settings_file.clone();
    // Read and written through security like the app and agy themselves (go-keyring), so the
    // item's access list stays as it is and no dialog appears.
    let keychain = security_keychain(
        Some(ANTIGRAVITY_ITEM_ACCOUNT),
        Some(security_tool.unwrap_or(Path::new("/usr/bin/security"))),
        Some(ANTIGRAVITY_SERVICE),
    );
    AntigravitySwitchPorts {
        keychain: Arc::new(keychain),
        read_settings: Arc::new(move || {
            let Ok(stat) = fs::symlink_metadata(&read_file) else {
                return Ok(None);
            };
            if !stat.is_file() || stat.len() > MAX_SETTINGS_BYTES {
                return Ok(None);
            }
            let text = fs::read_to_string(&read_file).map_err(|e| e.to_string())?;
            match serde_json::from_str::<Value>(&text).map_err(|e| e.to_string())? {
                Value::Object(map) => Ok(Some(map)),
                _ => Ok(None),
            }
        }),
        write_settings: Arc::new(move |values| write_antigravity_settings(&settings_file, values)),
        processes: Arc::new(|| {
            let out = run_detached(
                "/bin/ps",
                &["-axo".to_owned(), "pid=,comm=".to_owned()],
                &ExecOptions {
                    max_buffer: Some(8 * 1024 * 1024),
                    ..ExecOptions::timeout_ms(10_000)
                },
            )
            .map_err(|e| e.message)?;
            if !PS_LISTING.is_match(&out.stdout) {
                return Err("The process list could not be read.".into());
            }
            Ok(antigravity_processes(&out.stdout))
        }),
        quit: Arc::new(|| {
            // Guarded: `tell … to quit` on an app that is not running would start it first.
            let script = format!(
                "if application id \"{ANTIGRAVITY_BUNDLE_ID}\" is running then tell application id \"{ANTIGRAVITY_BUNDLE_ID}\" to quit"
            );
            let _ = run_detached(
                "/usr/bin/osascript",
                &["-e".to_owned(), script],
                &ExecOptions::timeout_ms(20_000),
            );
        }),
        launch: Arc::new(|| {
            run_detached(
                "/usr/bin/open",
                &["-b".to_owned(), ANTIGRAVITY_BUNDLE_ID.to_owned()],
                &ExecOptions {
                    env: Some(app_launch_env()),
                    ..ExecOptions::timeout_ms(15_000)
                },
            )
            .map(|_| ())
            .map_err(|e| e.message)
        }),
        sleep: Arc::new(|ms| std::thread::sleep(Duration::from_millis(ms))),
    }
}
