//! Port of `electron/core/desktop-usage.ts`: usage read through the Claude app's own sign-in,
//! for an account with no Claude Code sign-in.
//!
//! Claude keeps its claude.ai login as cookies in its `Cookies` database. Their values are
//! encrypted with "Claude Safe Storage", a Keychain item Claude created. Relay reads that item
//! through `/usr/bin/security`, decrypts the session cookies in memory and asks claude.ai for the
//! usage the app's Settings → Usage page shows. Nothing decrypted is ever written or logged.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use aes::Aes128;
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockModeDecrypt, KeyIvInit};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::clock::now_ms;
use crate::linux_safe_storage::{LINUX_V10_KEY, linux_cookie_key};
use crate::relay_paths::Platform;
use crate::shared::types::js::number_value;
use crate::shared::types::{Account, UsageIssue};
use crate::usage::{http_client, network_detail, retry_time};
use crate::usage_credentials::UsageError;
use crate::vault_key::DEFAULT_SECURITY_TOOL;

pub const SAFE_STORAGE_SERVICE: &str = "Claude Safe Storage";
pub const SAFE_STORAGE_ACCOUNT: &str = "Claude";
/// Exit status of `security find-generic-password` when no item matches.
const ITEM_NOT_FOUND: i32 = 44;
/// claude.ai's own hosts in a cookie database.
const HOSTS: [&str; 2] = [".claude.ai", "claude.ai"];
/// The login cookies a request carries: the session and the hints that route it.
const SENT: [&str; 6] = [
    "sessionKey",
    "sessionKeyLC",
    "sessionKeyV3",
    "sessionKeyV3LC",
    "routingHint",
    "lastActiveOrg",
];
/// In Relay's data folder: the user allowed the Safe Storage read. Never the password itself.
pub const DESKTOP_USAGE_MARKER: &str = "desktop-usage-keychain.json";
const MAX_BODY: usize = 262_144;

/// Whether limits can be read through the Claude app's sign-in. macOS asks the Keychain when
/// needed, so always; Linux only once a keyring read has succeeded.
pub fn desktop_usage_readable(data_dir: &Path, platform: Platform) -> bool {
    match platform {
        Platform::MacOs => true,
        Platform::Windows => false,
        Platform::Linux => fs::read(data_dir.join(DESKTOP_USAGE_MARKER))
            .ok()
            .and_then(|b| serde_json::from_str::<Value>(&String::from_utf8_lossy(&b)).ok())
            .is_some_and(|v| v.get("allowed") == Some(&Value::Bool(true))),
    }
}

/// Chromium's macOS cookie key: PBKDF2-SHA1 of the Safe Storage password.
pub fn cookie_key(password: &str) -> [u8; 16] {
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password.as_bytes(), b"saltysalt", 1003, &mut key);
    key
}

/// The AES key for each value prefix: macOS has only `v10`; Linux `v10` and `v11`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CookieKeys {
    pub v10: Option<[u8; 16]>,
    pub v11: Option<[u8; 16]>,
}

fn prefix_of(encrypted: &[u8]) -> &[u8] {
    &encrypted[..encrypted.len().min(3)]
}

/// Printable ASCII, `count` characters (`/^[\x21-\x7e]{1,max}$/`).
fn printable(text: &str, max: usize) -> bool {
    (1..=max).contains(&text.len()) && text.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

/// One cookie value as Chromium stores it: a prefix naming the key, then AES-128-CBC with a
/// blank IV. From database version 24 the plain text starts with the SHA-256 of the cookie's
/// host. None when the value is not one Relay can read.
pub fn decrypt_cookie(
    encrypted: &[u8],
    keys: &CookieKeys,
    host: &str,
    db_version: f64,
) -> Option<String> {
    let key = match prefix_of(encrypted) {
        b"v10" => keys.v10?,
        b"v11" => keys.v11?,
        _ => return None,
    };
    if encrypted.len() < 3 + 16 {
        return None;
    }
    let mut buf = encrypted[3..].to_vec();
    let plain = cbc::Decryptor::<Aes128>::new(&key.into(), &[0x20u8; 16].into())
        .decrypt_padded::<Pkcs7>(&mut buf)
        .ok()?;
    let mut plain = plain;
    if db_version >= 24.0 {
        let digest = Sha256::digest(host.as_bytes());
        if plain.len() < 32 || plain[..32] != digest[..] {
            return None;
        }
        plain = &plain[32..];
    }
    let text = String::from_utf8_lossy(plain);
    // A cookie value is printable ASCII; anything else is a wrong key that padded by chance.
    printable(&text, 4096).then(|| text.into_owned())
}

/// A claude.ai cookie row of a Cookies database.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct EncryptedCookie {
    pub host: String,
    pub name: String,
    /// Set only by databases that keep a value unencrypted.
    pub value: String,
    pub encrypted: Vec<u8>,
    /// When the cookie ends (ms since the epoch); None for one that lasts the browser's run.
    pub expires_ms: Option<f64>,
    pub path: Option<String>,
    pub secure: Option<bool>,
    pub http_only: Option<bool>,
    /// Chromium's value: -1 unspecified, 0 none, 1 lax, 2 strict.
    pub same_site: Option<f64>,
    /// Seconds since 1970; None for a session cookie.
    pub expires: Option<f64>,
    /// When the cookie was first set, seconds since 1970.
    pub created: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SameSite {
    #[serde(rename = "unspecified")]
    Unspecified,
    #[serde(rename = "no_restriction")]
    NoRestriction,
    #[serde(rename = "lax")]
    Lax,
    #[serde(rename = "strict")]
    Strict,
}

/// A claude.ai cookie as the hidden renewal window sets it: its value and attributes.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlainCookie {
    pub host: String,
    pub name: String,
    pub value: String,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: SameSite,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<f64>,
}

/// A cookie database's files by name (`Cookies`, `Cookies-journal`, `Network/Cookies`, …).
pub type CookieFiles = HashMap<String, Option<Vec<u8>>>;

/// The rows and the database's `meta` version.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CookieRows {
    pub version: f64,
    pub rows: Vec<EncryptedCookie>,
}

const EPOCH_DELTA_MS: f64 = 11_644_473_600_000.0;
const EPOCH_DELTA_S: i64 = 11_644_473_600;

/// Chromium time (microseconds from 1601-01-01) as ms since the epoch; None for none.
fn chromium_ms(micros: &rusqlite::types::Value) -> Option<f64> {
    use rusqlite::types::Value as V;
    let n = match micros {
        V::Integer(i) => (i / 1000) as f64,
        V::Real(r) => r / 1000.0,
        _ => f64::NAN,
    };
    (n.is_finite() && n > 0.0).then(|| n.floor() - EPOCH_DELTA_MS)
}

fn present(files: &CookieFiles, name: &str) -> bool {
    // A Buffer is truthy even when empty.
    matches!(files.get(name), Some(Some(_)))
}

/// A private temporary folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(prefix: &str) -> std::io::Result<TempDir> {
        let dir = std::env::temp_dir().join(format!("{prefix}{}", uuid::Uuid::new_v4().simple()));
        crate::fs_util::create_private_dir(&dir)?;
        Ok(TempDir(dir))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// claude.ai's login rows from a copy of a Cookies database. The copy is written to a private
/// temporary folder, read and removed.
pub fn read_cookie_rows(files: &CookieFiles) -> Result<CookieRows, UsageError> {
    let main = if present(files, "Network/Cookies") {
        "Network/Cookies"
    } else if present(files, "Cookies") {
        "Cookies"
    } else {
        return Err(UsageError::with_detail(
            UsageIssue::CredentialsMissing,
            "desktop: no cookie database",
        ));
    };
    read_rows_from(files, main).map_err(|_| {
        UsageError::with_detail(
            UsageIssue::Unavailable,
            "desktop: cookie database unreadable",
        )
    })
}

fn read_rows_from(
    files: &CookieFiles,
    main: &str,
) -> Result<CookieRows, Box<dyn std::error::Error>> {
    use rusqlite::types::Value as V;
    let dir = TempDir::new("relay-usage-")?;
    for suffix in ["", "-journal", "-wal", "-shm"] {
        if let Some(Some(data)) = files.get(&format!("{main}{suffix}")) {
            let mut file =
                crate::fs_util::create_new_private(&dir.0.join(format!("Cookies{suffix}")))?;
            file.write_all(data)?;
        }
    }
    // Not read-only: a journal left behind must be rolled back before the rows can be read.
    let db = rusqlite::Connection::open(dir.0.join("Cookies"))?;
    let version: Option<V> =
        match db.query_row("select value from meta where key = 'version'", [], |r| {
            r.get::<_, V>(0)
        }) {
            Ok(v) => Some(v),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(e) => return Err(e.into()),
        };
    let version = match version {
        Some(V::Integer(i)) => i as f64,
        Some(V::Real(r)) => r,
        Some(V::Text(t)) => number_value(&t),
        Some(V::Null) => 0.0,
        _ => f64::NAN,
    };
    let mut statement = db.prepare("select * from cookies where host_key in (?, ?)")?;
    let names: Vec<String> = statement
        .column_names()
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    let mut rows = Vec::new();
    let mut query = statement.query(rusqlite::params![HOSTS[0], HOSTS[1]])?;
    while let Some(row) = query.next()? {
        let mut r: HashMap<&str, V> = HashMap::new();
        for (i, name) in names.iter().enumerate() {
            r.insert(name.as_str(), row.get::<_, V>(i)?);
        }
        let null = V::Null;
        let get = |k: &str| r.get(k).unwrap_or(&null);
        let string = |v: &V| match v {
            V::Text(t) => t.clone(),
            V::Integer(i) => i.to_string(),
            V::Real(f) => crate::shared::types::js::number_string(*f),
            V::Null => "null".into(),
            V::Blob(b) => String::from_utf8_lossy(b).into_owned(),
        };
        let int = |v: &V| match v {
            V::Integer(i) => Some(*i as f64),
            V::Real(f) => Some(*f),
            _ => None,
        };
        let seconds = |v: &V| match v {
            V::Integer(i) if *i > 0 => {
                Some((i / 1_000_000 - EPOCH_DELTA_S) as f64).filter(|s| *s > 0.0)
            }
            _ => None,
        };
        let has_expires = match get("has_expires") {
            V::Integer(i) => *i as f64,
            V::Real(f) => *f,
            V::Text(t) => number_value(t),
            V::Null => 0.0,
            V::Blob(_) => f64::NAN,
        };
        rows.push(EncryptedCookie {
            host: r.get("host_key").map_or("undefined".into(), string),
            name: r.get("name").map_or("undefined".into(), string),
            value: match get("value") {
                V::Text(t) => t.clone(),
                _ => String::new(),
            },
            encrypted: match get("encrypted_value") {
                V::Blob(b) => b.clone(),
                _ => Vec::new(),
            },
            path: match get("path") {
                V::Text(t) => Some(t.clone()),
                _ => None,
            },
            secure: int(get("is_secure")).map(|v| v == 1.0),
            http_only: int(get("is_httponly")).map(|v| v == 1.0),
            same_site: int(get("samesite")),
            expires_ms: if has_expires == 1.0 {
                chromium_ms(get("expires_utc"))
            } else {
                None
            },
            expires: seconds(get("expires_utc")),
            created: seconds(get("creation_utc")),
        });
    }
    Ok(CookieRows {
        version: if version.is_finite() { version } else { 0.0 },
        rows,
    })
}

fn sendable(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|b| (0x21..=0x7e).contains(&b))
        && !value.contains([';', ','])
}

/// The login cookies by name, in row order, from the login rows; None without a session.
pub fn session_cookies(
    rows: &[EncryptedCookie],
    keys: &CookieKeys,
    db_version: f64,
) -> Option<Vec<(String, String)>> {
    let mut values: Vec<(String, String)> = Vec::new();
    for row in rows {
        if !SENT.contains(&row.name.as_str()) || values.iter().any(|(n, _)| *n == row.name) {
            continue;
        }
        let value = if row.value.is_empty() {
            decrypt_cookie(&row.encrypted, keys, &row.host, db_version)
        } else {
            Some(row.value.clone())
        };
        if let Some(value) = value.filter(|v| sendable(v)) {
            values.push((row.name.clone(), value));
        }
    }
    values
        .iter()
        .any(|(n, _)| n == "sessionKey")
        .then_some(values)
}

/// The `Cookie` header for claude.ai, from the login rows; None without a session.
pub fn cookie_header(
    rows: &[EncryptedCookie],
    keys: &CookieKeys,
    db_version: f64,
) -> Option<String> {
    let values = session_cookies(rows, keys, db_version)?;
    Some(
        values
            .iter()
            .map(|(name, value)| format!("{name}={value}"))
            .collect::<Vec<_>>()
            .join("; "),
    )
}

/// A claude.ai answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebResponse {
    pub status: u16,
    pub content_type: String,
    pub retry_after: Option<String>,
    pub body: String,
    /// Cloudflare's `cf-mitigated` header (`challenge` when the client was not let through).
    pub cf_mitigated: Option<String>,
}

/// A current Safari's user agent: claude.ai's gateway accepts it like a browser's.
pub const SAFARI_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15";

/// A GET to claude.ai carrying exactly the `Cookie` header it is given, never following a
/// redirect (a 3xx is an error), bounded to 15 s; a body past 256 KiB comes back as a body
/// longer than that, which the reader refuses.
pub fn claude_web_request(url: &str, cookie: &str) -> Result<WebResponse, UsageError> {
    let failed =
        || UsageError::with_detail(UsageIssue::Unavailable, network_detail(Some("Error"), None));
    let mut response = http_client()
        .get(url)
        .timeout(Duration::from_secs(15))
        .header("Cookie", cookie)
        .header("Accept", "application/json")
        .header("User-Agent", SAFARI_USER_AGENT)
        .header("anthropic-client-platform", "web_claude_ai")
        .send()
        .map_err(|_| failed())?;
    let status = response.status().as_u16();
    if (300..400).contains(&status) {
        return Err(failed());
    }
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    let content_type = header("content-type").unwrap_or_default();
    let retry_after = header("retry-after");
    let cf_mitigated = header("cf-mitigated");
    let body = match crate::usage::read_capped(&mut response, MAX_BODY).map_err(|_| failed())? {
        Some(data) => String::from_utf8_lossy(&data).into_owned(),
        None => " ".repeat(MAX_BODY + 1),
    };
    Ok(WebResponse {
        status,
        content_type,
        retry_after,
        body,
        cf_mitigated,
    })
}

/// Reads the Safe Storage password; never opens a dialog unless `allow_prompt`.
pub trait SafeStoragePassword: Send + Sync {
    fn get(&self, allow_prompt: bool) -> Result<String, UsageError>;
    /// Drops the password kept in memory and between runs: it no longer opens the cookies, so
    /// the next read asks the Keychain.
    fn forget(&self) {}
}

impl<F: Fn(bool) -> Result<String, UsageError> + Send + Sync> SafeStoragePassword for F {
    fn get(&self, allow_prompt: bool) -> Result<String, UsageError> {
        self(allow_prompt)
    }
}

/// Keeps the password in Relay's sealed vault.
pub type StorePassword = Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>;

/// Where a password read once is kept between runs (Relay's sealed vault).
#[derive(Clone)]
pub struct SavedPassword {
    pub load: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    pub store: StorePassword,
    pub clear: Arc<dyn Fn() + Send + Sync>,
}

#[derive(Clone)]
pub struct SafeStorageOptions {
    pub allowed: Arc<dyn Fn() -> bool + Send + Sync>,
    pub remember: Arc<dyn Fn(bool) + Send + Sync>,
    pub tool: Option<PathBuf>,
    pub saved: Option<SavedPassword>,
}

type ReadResult = Result<String, UsageError>;

/// One read under way: the reads asked meanwhile wait for its answer.
struct Reading {
    prompts: bool,
    result: Mutex<Option<ReadResult>>,
    done: Condvar,
}

impl Reading {
    fn wait(&self) -> ReadResult {
        let mut result = self.result.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if let Some(r) = result.as_ref() {
                return r.clone();
            }
            result = self.done.wait(result).unwrap_or_else(|e| e.into_inner());
        }
    }
}

#[derive(Default)]
struct PasswordState {
    cached: Option<String>,
    reading: Option<Arc<Reading>>,
}

/// "Claude Safe Storage" through `security`, read at most once at a time.
pub struct MacSafeStoragePassword {
    options: SafeStorageOptions,
    state: Mutex<PasswordState>,
}

/// Reads "Claude Safe Storage" through `security`. A background read is only tried once the user
/// has allowed it, so Relay never opens a Keychain dialog on its own; reads asked together share
/// one, so macOS asks once.
pub fn safe_storage_password(options: SafeStorageOptions) -> MacSafeStoragePassword {
    MacSafeStoragePassword {
        options,
        state: Mutex::new(PasswordState::default()),
    }
}

impl MacSafeStoragePassword {
    fn lock(&self) -> std::sync::MutexGuard<'_, PasswordState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn read_password(&self, allow_prompt: bool) -> ReadResult {
        if let Some(cached) = self.lock().cached.clone() {
            return Ok(cached);
        }
        if let Some(kept) = self
            .options
            .saved
            .as_ref()
            .and_then(|s| (s.load)())
            .filter(|k| !k.is_empty())
        {
            self.lock().cached = Some(kept.clone());
            return Ok(kept);
        }
        if !allow_prompt && !(self.options.allowed)() {
            return Err(UsageError::with_detail(
                UsageIssue::KeychainLocked,
                "desktop: Keychain not allowed yet",
            ));
        }
        let tool = self
            .options
            .tool
            .clone()
            .unwrap_or_else(|| PathBuf::from(DEFAULT_SECURITY_TOOL));
        let (code, stdout) = crate::usage_credentials::exec_tool(
            &tool,
            &[
                "find-generic-password",
                "-s",
                SAFE_STORAGE_SERVICE,
                "-a",
                SAFE_STORAGE_ACCOUNT,
                "-w",
            ],
            Duration::from_millis(if allow_prompt { 120_000 } else { 15_000 }),
            4096,
        );
        use crate::usage_credentials::ToolCode;
        if code == ToolCode::Exit(ITEM_NOT_FOUND) {
            return Err(UsageError::with_detail(
                UsageIssue::CredentialsMissing,
                "desktop: no Claude Safe Storage item",
            ));
        }
        let password = stdout.strip_suffix('\n').unwrap_or(&stdout).to_owned();
        if code != ToolCode::Ok || password.is_empty() {
            (self.options.remember)(false);
            let shown = if code == ToolCode::Ok {
                "undefined".to_owned()
            } else {
                code.to_string()
            };
            return Err(UsageError::with_detail(
                UsageIssue::KeychainLocked,
                format!("desktop: security exit {shown}"),
            ));
        }
        self.lock().cached = Some(password.clone());
        (self.options.remember)(true);
        // A vault that cannot keep it costs only the next run's prompt, never this read.
        if let Some(saved) = &self.options.saved {
            let _ = (saved.store)(&password);
        }
        Ok(password)
    }
}

impl SafeStoragePassword for MacSafeStoragePassword {
    fn get(&self, allow_prompt: bool) -> ReadResult {
        let mine = {
            let mut state = self.lock();
            loop {
                if let Some(cached) = state.cached.clone() {
                    return Ok(cached);
                }
                // A read under way answers this one too; only one that may not prompt is
                // followed, when it fails, by this one's prompting read.
                let Some(running) = state.reading.clone() else {
                    break;
                };
                drop(state);
                match running.wait() {
                    Ok(password) => return Ok(password),
                    Err(error) if !allow_prompt || running.prompts => return Err(error),
                    Err(_) => {}
                }
                state = self.lock();
                if state
                    .reading
                    .as_ref()
                    .is_some_and(|r| Arc::ptr_eq(r, &running))
                {
                    break;
                }
            }
            if let Some(cached) = state.cached.clone() {
                return Ok(cached);
            }
            let mine = Arc::new(Reading {
                prompts: allow_prompt,
                result: Mutex::new(None),
                done: Condvar::new(),
            });
            state.reading = Some(mine.clone());
            mine
        };
        let result = self.read_password(allow_prompt);
        {
            let mut state = self.lock();
            if state
                .reading
                .as_ref()
                .is_some_and(|r| Arc::ptr_eq(r, &mine))
            {
                state.reading = None;
            }
        }
        *mine.result.lock().unwrap_or_else(|e| e.into_inner()) = Some(result.clone());
        mine.done.notify_all();
        result
    }

    fn forget(&self) {
        self.lock().cached = None;
        if let Some(saved) = &self.options.saved {
            (saved.clear)();
        }
    }
}

pub type CookieFilesFn = Arc<dyn Fn(&str) -> Result<CookieFiles, String> + Send + Sync>;
pub type WebRequestFn = Arc<dyn Fn(&str, &str) -> Result<WebResponse, UsageError> + Send + Sync>;
pub type ReadRowsFn = Arc<dyn Fn(&CookieFiles) -> Result<CookieRows, UsageError> + Send + Sync>;

/// What the reader needs.
#[derive(Clone)]
pub struct DesktopUsageDeps {
    /// The cookie files of the account's Claude app sign-in: live, or as saved in the vault.
    pub cookie_files: CookieFilesFn,
    pub password: Arc<dyn SafeStoragePassword>,
    /// A GET to claude.ai with this `Cookie` header; never follows a redirect.
    pub request: WebRequestFn,
    pub read_rows: Option<ReadRowsFn>,
    pub now: Option<Arc<dyn Fn() -> i64 + Send + Sync>>,
    /// Whose cookie scheme the rows use; this machine's by default.
    pub platform: Option<Platform>,
}

/// `/^[0-9a-f-]{36}$/i`.
fn org_shape(text: &str) -> bool {
    text.len() == 36 && text.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// Reads one account's usage the way claude.ai's Settings → Usage does. Answers with the same
/// shape as the CLI's usage endpoint (`five_hour`, `seven_day`, …), for `parse_usage`.
#[derive(Clone)]
pub struct DesktopUsageReader {
    deps: DesktopUsageDeps,
}

impl DesktopUsageReader {
    pub fn new(deps: DesktopUsageDeps) -> DesktopUsageReader {
        DesktopUsageReader { deps }
    }

    /// Whether this account has a Claude app sign-in to read through.
    pub fn usable(account: &Account) -> bool {
        account
            .desktop
            .as_ref()
            .is_some_and(|d| !d.account_uuid.is_empty() && !d.org_id.is_empty())
    }

    fn now(&self) -> i64 {
        self.deps.now.as_ref().map_or_else(now_ms, |now| now())
    }

    fn rows(&self, files: &CookieFiles) -> Result<CookieRows, UsageError> {
        match &self.deps.read_rows {
            Some(read) => read(files),
            None => read_cookie_rows(files),
        }
    }

    /// All of the account's claude.ai cookies with their attributes, in memory only: for the
    /// hidden window that renews its Claude Code sign-in. Never asks for the Keychain; None when
    /// there is no session.
    pub fn cookies(&self, account: &Account) -> Result<Option<Vec<PlainCookie>>, UsageError> {
        let Some(desktop) = account.desktop.as_ref().filter(|d| org_shape(&d.org_id)) else {
            return Ok(None);
        };
        let files = (self.deps.cookie_files)(&desktop.account_uuid).map_err(|_| {
            UsageError::with_detail(UsageIssue::Unavailable, network_detail(Some("Error"), None))
        })?;
        let CookieRows { version, rows } = self.rows(&files)?;
        let keys = self.keys(&rows, false)?;
        let now = self.now() as f64 / 1000.0;
        let mut cookies: Vec<PlainCookie> = Vec::new();
        let mut seen = HashSet::new();
        let mut undecryptable = false;
        for row in &rows {
            let value = if row.value.is_empty() {
                decrypt_cookie(&row.encrypted, &keys, &row.host, version)
            } else {
                Some(row.value.clone())
            };
            if value.is_none() && row.name == "sessionKey" {
                undecryptable = true;
            }
            let Some(value) = value.filter(|v| sendable(v)) else {
                continue;
            };
            if row.expires.is_some_and(|e| e <= now) {
                continue;
            }
            let id = format!(
                "{}|{}|{}",
                row.host,
                row.path.as_deref().unwrap_or("/"),
                row.name
            );
            if !seen.insert(id) {
                continue;
            }
            let same_site = match row.same_site {
                Some(0.0) => SameSite::NoRestriction,
                Some(1.0) => SameSite::Lax,
                Some(2.0) => SameSite::Strict,
                _ => SameSite::Unspecified,
            };
            cookies.push(PlainCookie {
                host: row.host.clone(),
                name: row.name.clone(),
                // The workspace the sign-in is for, whatever the Claude app last opened.
                value: if row.name == "lastActiveOrg" {
                    desktop.org_id.to_lowercase()
                } else {
                    value
                },
                path: row.path.clone().unwrap_or_else(|| "/".into()),
                secure: row.secure.unwrap_or(true),
                http_only: row
                    .http_only
                    .unwrap_or_else(|| row.name.starts_with("sessionKey")),
                same_site,
                expires: row.expires,
                created: row.created,
            });
        }
        if !cookies.iter().any(|c| c.name == "sessionKey") {
            // A session that cannot be decrypted means another key (see `read`).
            if undecryptable {
                self.deps.password.forget();
            }
            return Ok(None);
        }
        Ok(Some(cookies))
    }

    /// Asks macOS once to let Relay read the Claude app's sign-in ("Claude Safe Storage").
    pub fn allow_keychain(&self) -> Result<(), UsageError> {
        self.deps.password.get(true).map(|_| ())
    }

    pub fn read(&self, account: &Account, allow_prompt: bool) -> Result<Value, UsageError> {
        let Some(desktop) = account.desktop.as_ref().filter(|d| org_shape(&d.org_id)) else {
            return Err(UsageError::with_detail(
                UsageIssue::CredentialsMissing,
                "desktop: no Claude app sign-in",
            ));
        };
        let files = (self.deps.cookie_files)(&desktop.account_uuid).map_err(|_| {
            UsageError::with_detail(
                UsageIssue::CredentialsMissing,
                "desktop: no saved Claude app sign-in",
            )
        })?;
        let CookieRows { version, rows } = self.rows(&files)?;
        let keys = self.keys(&rows, allow_prompt)?;
        let Some(cookie) = cookie_header(&rows, &keys, version) else {
            // Rows that cannot be decrypted mean another key, not a signed-out app.
            let session = rows.iter().any(|r| r.name == "sessionKey");
            if session {
                self.deps.password.forget();
            }
            return Err(if session {
                UsageError::with_detail(
                    UsageIssue::Unsupported,
                    "desktop: session cookie not readable",
                )
            } else {
                UsageError::with_detail(UsageIssue::Expired, "desktop: no session cookie")
            });
        };
        let response = (self.deps.request)(
            &format!(
                "https://claude.ai/api/organizations/{}/usage",
                desktop.org_id.to_lowercase()
            ),
            &cookie,
        )?;
        let detail = format!("desktop usage {}", response.status);
        let json = response.content_type.to_lowercase().contains("json");
        match response.status {
            401 => return Err(UsageError::with_detail(UsageIssue::Expired, detail)),
            // A JSON refusal is claude.ai's own; an HTML one is a gateway and passes on its own.
            // Cloudflare's bot challenge is named, so usage-issues.json tells it from a sign-out.
            403 => {
                return Err(if json {
                    UsageError::with_detail(UsageIssue::Expired, detail)
                } else if response.cf_mitigated.as_deref() == Some("challenge") {
                    UsageError::with_detail(UsageIssue::Unavailable, format!("{detail} challenge"))
                } else {
                    UsageError::with_detail(UsageIssue::Unavailable, format!("{detail} html"))
                });
            }
            429 => {
                return Err(UsageError::with_retry(
                    UsageIssue::RateLimited,
                    Some(retry_time(
                        response.retry_after.as_deref(),
                        self.now() as f64,
                    )),
                    Some(detail),
                ));
            }
            200 if json => {}
            _ => return Err(UsageError::with_detail(UsageIssue::Unavailable, detail)),
        }
        if crate::usage_credentials::js_len(&response.body) > MAX_BODY {
            return Err(UsageError::with_detail(UsageIssue::Unsupported, detail));
        }
        serde_json::from_str(&response.body).map_err(|_| {
            UsageError::with_detail(UsageIssue::Unsupported, format!("{detail} not JSON"))
        })
    }

    /// macOS: the Keychain password's key for `v10`. Linux: `v10` has Chromium's fixed key, so
    /// the keyring is only asked when a login cookie is `v11`.
    fn keys(&self, rows: &[EncryptedCookie], allow_prompt: bool) -> Result<CookieKeys, UsageError> {
        if self.deps.platform.unwrap_or(Platform::current()) != Platform::Linux {
            return Ok(CookieKeys {
                v10: Some(cookie_key(&self.deps.password.get(allow_prompt)?)),
                v11: None,
            });
        }
        let keyring = rows.iter().any(|r| {
            SENT.contains(&r.name.as_str())
                && r.value.is_empty()
                && prefix_of(&r.encrypted) == b"v11"
        });
        Ok(CookieKeys {
            v10: Some(*LINUX_V10_KEY),
            v11: if keyring {
                Some(linux_cookie_key(&self.deps.password.get(allow_prompt)?))
            } else {
                None
            },
        })
    }
}
