//! Port of `electron/core/cookie-store.ts`: the claude.ai login rows of a Chromium profile's
//! cookie database, read from a copy or a closed browser and written back while it is closed.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use base64::Engine;
use indexmap::IndexMap;
use regex::Regex;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::fs_util::{create_private_dir, create_private_dir_all, mtime_ms, set_mode};
use crate::shared::browser_extension::CLAUDE_EXTENSION_ID;

/// Why a browser's cookie database could not be used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CookieStoreReason {
    /// A browser holds it.
    Locked,
    Missing,
    Failed,
    /// A write did not read back.
    Mismatch,
    /// It is not laid out as Relay expects (a newer Chromium).
    SchemaChanged,
    /// It was not closed cleanly.
    JournalPending,
}

impl CookieStoreReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            CookieStoreReason::Locked => "locked",
            CookieStoreReason::Missing => "missing",
            CookieStoreReason::Failed => "failed",
            CookieStoreReason::Mismatch => "mismatch",
            CookieStoreReason::SchemaChanged => "schema-changed",
            CookieStoreReason::JournalPending => "journal-pending",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct CookieStoreError {
    pub reason: CookieStoreReason,
    pub message: String,
    /// For the log: what did not match (names and versions only, never cookie values).
    pub detail: Option<IndexMap<String, String>>,
}

impl CookieStoreError {
    pub fn new(reason: CookieStoreReason, message: impl Into<String>) -> CookieStoreError {
        CookieStoreError {
            reason,
            message: message.into(),
            detail: None,
        }
    }

    fn with_detail(mut self, detail: &[(&str, String)]) -> CookieStoreError {
        self.detail = Some(
            detail
                .iter()
                .map(|(k, v)| ((*k).to_owned(), v.clone()))
                .collect(),
        );
        self
    }
}

/// The extension's own (partitioned) cookies carry this top-frame site.
fn extension_partition() -> String {
    format!("chrome-extension://{CLAUDE_EXTENSION_ID}")
}

/// One row of "the account's claude.ai login".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginRow {
    pub host: &'static str,
    /// "" (not partitioned) or the extension's partition.
    pub partition: String,
    pub name: &'static str,
}

/// The rows that are "the account's claude.ai login": an allow-list, never every claude.ai row.
/// The device's identity (`anthropic-device-id`), Cloudflare's bot management and the page's
/// preferences stay where they are. Device-bound session credentials are not moved: the swap
/// deletes the site's row in `Device Bound Sessions` instead.
pub static LOGIN_ROWS: LazyLock<Vec<LoginRow>> = LazyLock::new(|| {
    let mut rows = Vec::new();
    for name in [
        "sessionKey",
        "sessionKeyLC",
        "sessionKeyV3",
        "sessionKeyV3LC",
        "routingHint",
        "lastActiveOrg",
    ] {
        rows.push(LoginRow {
            host: ".claude.ai",
            partition: String::new(),
            name,
        });
    }
    for name in [
        "__Host-sessionBinding",
        "__Host-sessionBindingGrace",
        // claude.ai's third binding cookie (seen 2026-11-27); like its siblings, the account's.
        "__Host-sessionBindingMiss",
        "__Host-ant_trusted_device",
        "activitySessionId",
    ] {
        rows.push(LoginRow {
            host: "claude.ai",
            partition: String::new(),
            name,
        });
    }
    rows.push(LoginRow {
        host: "claude.ai",
        partition: extension_partition(),
        name: "lastActiveOrg",
    });
    rows
});
/// The site row of Chromium's `Device Bound Sessions` that belongs to the login.
const DBSC_KEY: &str = "https://claude.ai";
const SESSION_NAME: &str = "sessionKey";
/// claude.ai cookies that look like a login but are not listed: the layout changed.
static LOGIN_LIKE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("(?i-u:session|auth|token|login|credential)").expect("static"));
/// Cookies that match LOGIN_LIKE but are not the login: a connector's OAuth round trip leaves
/// `mcp_oauth_state_<id>`.
static NOT_LOGIN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("^(?i-u:mcp_oauth_state_)").expect("static"));
const WEB_HOSTS: [&str; 2] = ["claude.ai", ".claude.ai"];

/// One column of a `cookies` row, as the database holds it.
#[derive(Debug, Clone, PartialEq)]
pub enum CookieValue {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl CookieValue {
    fn text(&self) -> Option<&str> {
        match self {
            CookieValue::Text(text) => Some(text),
            _ => None,
        }
    }

    /// JS `String(value)`.
    fn js_string(&self) -> String {
        match self {
            CookieValue::Null => "null".to_owned(),
            CookieValue::Integer(n) => n.to_string(),
            CookieValue::Real(n) => {
                serde_json::Number::from_f64(*n).map_or_else(|| n.to_string(), |n| n.to_string())
            }
            CookieValue::Text(text) => text.clone(),
            CookieValue::Blob(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        }
    }

    /// JS `Number(value) === 1`.
    fn is_one(&self) -> bool {
        match self {
            CookieValue::Integer(n) => *n == 1,
            CookieValue::Real(n) => *n == 1.0,
            CookieValue::Text(text) => text.trim().parse::<f64>() == Ok(1.0),
            _ => false,
        }
    }

    fn from_ref(value: ValueRef<'_>) -> CookieValue {
        match value {
            ValueRef::Null => CookieValue::Null,
            ValueRef::Integer(n) => CookieValue::Integer(n),
            ValueRef::Real(n) => CookieValue::Real(n),
            ValueRef::Text(bytes) => CookieValue::Text(String::from_utf8_lossy(bytes).into_owned()),
            ValueRef::Blob(bytes) => CookieValue::Blob(bytes.to_vec()),
        }
    }

    fn to_sql(&self) -> rusqlite::types::Value {
        use rusqlite::types::Value as V;
        match self {
            CookieValue::Null => V::Null,
            CookieValue::Integer(n) => V::Integer(*n),
            CookieValue::Real(n) => V::Real(*n),
            CookieValue::Text(text) => V::Text(text.clone()),
            CookieValue::Blob(bytes) => V::Blob(bytes.clone()),
        }
    }
}

/// One `cookies` row, each column as the database holds it, in the table's column order.
pub type CookieRow = IndexMap<String, CookieValue>;

/// The login rows of a cookie database, with what is needed to put them back.
#[derive(Debug, Clone, PartialEq)]
pub struct CookieSnapshot {
    /// `meta.version` of the database the rows came from.
    pub version: String,
    /// The `cookies` table's columns, in order.
    pub columns: Vec<String>,
    pub rows: Vec<CookieRow>,
    /// Names of claude.ai cookies that look like login cookies and are not in `LOGIN_ROWS`.
    pub unlisted: Vec<String>,
}

fn column<'a>(row: &'a CookieRow, name: &str) -> Option<&'a CookieValue> {
    row.get(name)
}

fn text_is(row: &CookieRow, name: &str, want: &str) -> bool {
    column(row, name).and_then(CookieValue::text) == Some(want)
}

fn is_login_row(row: &CookieRow) -> bool {
    LOGIN_ROWS.iter().any(|l| {
        text_is(row, "host_key", l.host)
            && text_is(row, "top_frame_site_key", &l.partition)
            && text_is(row, "name", l.name)
    })
}

pub fn has_web_login(snapshot: &CookieSnapshot) -> bool {
    snapshot
        .rows
        .iter()
        .any(|row| text_is(row, "name", SESSION_NAME) && text_is(row, "host_key", ".claude.ai"))
}

fn unpartitioned<'a>(snapshot: &'a CookieSnapshot, name: &str) -> Option<&'a CookieRow> {
    snapshot.rows.iter().find(|r| {
        let partition = match column(r, "top_frame_site_key") {
            None | Some(CookieValue::Null) => true,
            Some(value) => value.text() == Some(""),
        };
        text_is(r, "name", name)
            && partition
            && (text_is(r, "host_key", ".claude.ai") || text_is(r, "host_key", "claude.ai"))
    })
}

fn bytes(value: Option<&CookieValue>) -> Option<&[u8]> {
    match value {
        Some(CookieValue::Blob(bytes)) => Some(bytes),
        _ => None,
    }
}

/// Whether two snapshots hold the same web login: their `sessionKey` rows were created at the same
/// moment. The browser keeps a cookie's creation time when the site sets it again, so a login the
/// server renewed still matches; two separate logins never share the microsecond.
pub fn same_login(a: &CookieSnapshot, b: &CookieSnapshot) -> bool {
    let x = login_id(a);
    x.is_some() && x == login_id(b)
}

/// A web login's identity: its `sessionKey` row's creation time (see `same_login`).
pub fn login_id(snapshot: &CookieSnapshot) -> Option<String> {
    match column(unpartitioned(snapshot, SESSION_NAME)?, "creation_utc")? {
        CookieValue::Integer(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Whether two snapshots' web logins are on the same organization: their `lastActiveOrg`
/// cookies hold the same encrypted bytes (one key, a fixed IV: the same organization id gives the
/// same bytes). Nothing is decrypted.
pub fn same_organization(a: &CookieSnapshot, b: &CookieSnapshot) -> bool {
    let x = unpartitioned(a, "lastActiveOrg").and_then(|r| bytes(column(r, "encrypted_value")));
    let y = unpartitioned(b, "lastActiveOrg").and_then(|r| bytes(column(r, "encrypted_value")));
    matches!((x, y), (Some(x), Some(y)) if !x.is_empty() && x == y)
}

/// The organization a web login is on, as bytes that only compare (see `same_organization`):
/// its `lastActiveOrg` cookie's encrypted value, base64. None without one.
pub fn org_fingerprint(snapshot: &CookieSnapshot) -> Option<String> {
    let value = unpartitioned(snapshot, "lastActiveOrg")
        .and_then(|r| bytes(column(r, "encrypted_value")))?;
    (!value.is_empty()).then(|| base64::engine::general_purpose::STANDARD.encode(value))
}

/// Chromium time (microseconds from 1601-01-01) as ms since the epoch.
fn chromium_ms(micros: Option<&CookieValue>) -> Option<i64> {
    match micros {
        Some(CookieValue::Integer(n)) if *n > 0 => Some(n / 1000 - 11_644_473_600_000),
        _ => None,
    }
}

fn session_row(snapshot: &CookieSnapshot) -> Option<&CookieRow> {
    snapshot
        .rows
        .iter()
        .find(|r| text_is(r, "name", SESSION_NAME) && text_is(r, "host_key", ".claude.ai"))
}

/// When the web login's `sessionKey` cookie ends (ms since the epoch). None without one, or for a
/// cookie that lasts only as long as the browser runs.
pub fn session_expires_ms(snapshot: &CookieSnapshot) -> Option<i64> {
    let row = session_row(snapshot)?;
    if column(row, "has_expires") == Some(&CookieValue::Integer(0)) {
        return None;
    }
    chromium_ms(column(row, "expires_utc"))
}

/// When the web session was created (ms since the epoch), from `creation_utc`.
pub fn session_created_ms(snapshot: &CookieSnapshot) -> Option<i64> {
    chromium_ms(session_row(snapshot).and_then(|r| column(r, "creation_utc")))
}

/// The cookie database operations, on a browser profile folder. `read` works on a copy as well
/// as on a closed browser's folder; `write` only while the browser is not running. Never prints
/// or logs a value.
pub trait CookieStorage: Send + Sync {
    /// Whether SQLite can be used here; asked before a browser is quit.
    fn available(&self) -> bool;
    /// The login rows in `dir` (a profile folder or a copy of the cookie files).
    fn read(&self, dir: &Path) -> Result<CookieSnapshot, CookieStoreError>;
    /// Replaces the profile's login rows with `snapshot`'s, deletes the site's device-bound
    /// session row, then reads everything back: the rows equal, every other row unchanged, the
    /// database intact. Fails with a `CookieStoreError`; the caller restores its backup.
    fn write(&self, dir: &Path, snapshot: &CookieSnapshot) -> Result<(), CookieStoreError>;
}

/// The cookie database's place: a profile's `Network/Cookies` (newer browsers) or `Cookies`.
const COOKIE_CANDIDATES: [&str; 2] = ["Network/Cookies", "Cookies"];
const SIDE_SUFFIXES: [&str; 4] = ["", "-journal", "-wal", "-shm"];
const DBSC_NAME: &str = "Device Bound Sessions";

/// Every cookie file a backup copies: the cookie databases and the device-bound-session ones,
/// with their journals.
fn cookie_files() -> Vec<String> {
    let mut files = Vec::new();
    for f in COOKIE_CANDIDATES {
        for s in SIDE_SUFFIXES {
            files.push(format!("{f}{s}"));
        }
    }
    for d in ["Network/", ""] {
        for s in SIDE_SUFFIXES {
            files.push(format!("{d}{DBSC_NAME}{s}"));
        }
    }
    files
}

fn exists(file: &Path) -> bool {
    fs::symlink_metadata(file).is_ok()
}

fn cookies_file(dir: &Path) -> Result<PathBuf, CookieStoreError> {
    let mut best: Option<(PathBuf, f64)> = None;
    for rel in COOKIE_CANDIDATES {
        let file = dir.join(rel);
        let Ok(st) = fs::symlink_metadata(&file) else {
            continue;
        };
        // A real file only: a link could lead into somebody else's files.
        if !st.is_file() {
            return Err(CookieStoreError::new(
                CookieStoreReason::Failed,
                "The cookie database is not a file.",
            ));
        }
        let mtime = mtime_ms(&st).unwrap_or(0.0);
        if best.as_ref().is_none_or(|(_, m)| mtime > *m) {
            best = Some((file, mtime));
        }
    }
    best.map(|(file, _)| file).ok_or_else(|| {
        CookieStoreError::new(
            CookieStoreReason::Missing,
            "The cookie database is missing.",
        )
    })
}

fn side(file: &Path, suffix: &str) -> PathBuf {
    let mut name = file.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

fn assert_quiet(file: &Path) -> Result<(), CookieStoreError> {
    for suffix in ["-journal", "-wal"] {
        if fs::metadata(side(file, suffix)).is_ok_and(|st| st.len() > 0) {
            return Err(CookieStoreError::new(
                CookieStoreReason::JournalPending,
                "The cookie database was not closed cleanly.",
            ));
        }
    }
    Ok(())
}

fn fail(error: rusqlite::Error) -> CookieStoreError {
    let text = error.to_string().to_lowercase();
    CookieStoreError::new(
        if text.contains("locked") || text.contains("busy") {
            CookieStoreReason::Locked
        } else {
            CookieStoreReason::Failed
        },
        "The cookie database could not be used.",
    )
}

/// `node:sqlite`'s open: no busy wait, so a database another process holds fails at once.
fn open(file: &Path, read_only: bool) -> Result<Connection, CookieStoreError> {
    let flags = if read_only {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    } else {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let db = Connection::open_with_flags(file, flags).map_err(fail)?;
    db.busy_timeout(Duration::ZERO).map_err(fail)?;
    Ok(db)
}

/// The vault's JSON form of a value: integers and blobs as tagged strings.
fn encode_value(value: &CookieValue) -> Value {
    match value {
        CookieValue::Null => Value::Null,
        CookieValue::Integer(n) => json!({ "i": n.to_string() }),
        CookieValue::Real(n) => json!(n),
        CookieValue::Text(text) => Value::String(text.clone()),
        CookieValue::Blob(bytes) => {
            json!({ "b": base64::engine::general_purpose::STANDARD.encode(bytes) })
        }
    }
}

fn same_value(a: &CookieValue, b: &CookieValue) -> bool {
    encode_value(a) == encode_value(b)
}

fn row_key(row: &CookieRow) -> String {
    let mut keys: Vec<&String> = row.keys().collect();
    keys.sort();
    let pairs: Vec<Value> = keys
        .into_iter()
        .map(|c| json!([c, encode_value(&row[c])]))
        .collect();
    Value::Array(pairs).to_string()
}

struct Read {
    snapshot: CookieSnapshot,
    /// A digest of every row that is not part of the login.
    others: String,
    count: usize,
    quick: String,
}

fn table_columns(db: &Connection) -> rusqlite::Result<Vec<(String, bool, bool)>> {
    let mut statement = db.prepare("pragma table_info(cookies)")?;
    let rows = statement.query_map([], |row| {
        let name = CookieValue::from_ref(row.get_ref("name")?).js_string();
        let notnull = CookieValue::from_ref(row.get_ref("notnull")?).is_one();
        let default_null = matches!(row.get_ref("dflt_value")?, ValueRef::Null);
        Ok((name, notnull, default_null))
    })?;
    rows.collect()
}

/// The columns a saved login is written with when the browser changed its `cookies` table within
/// one database version: columns it dropped are left out, and a column it added is left to the
/// database only when it may be empty or has a default. Any other difference is refused.
pub fn writable_columns(
    db: &Connection,
    saved: &[String],
) -> Result<Vec<String>, CookieStoreError> {
    let table = table_columns(db).map_err(fail)?;
    let required: Vec<&str> = table
        .iter()
        .filter(|(name, notnull, default_null)| !saved.contains(name) && *notnull && *default_null)
        .map(|(name, _, _)| name.as_str())
        .collect();
    let names: Vec<&str> = table.iter().map(|(name, _, _)| name.as_str()).collect();
    if !required.is_empty() || !saved.iter().any(|c| c == "host_key") {
        return Err(CookieStoreError::new(
            CookieStoreReason::SchemaChanged,
            "The cookie database is not the one the login was saved from.",
        )
        .with_detail(&[
            ("why", "columns".to_owned()),
            ("missing", required.join(" ")),
            (
                "dropped",
                saved
                    .iter()
                    .filter(|c| !names.contains(&c.as_str()))
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(" "),
            ),
        ]));
    }
    Ok(saved
        .iter()
        .filter(|c| names.contains(&c.as_str()))
        .cloned()
        .collect())
}

fn read_database(db: &Connection) -> Result<Read, CookieStoreError> {
    let columns: Vec<String> = table_columns(db)
        .map_err(fail)?
        .into_iter()
        .map(|(name, _, _)| name)
        .collect();
    let version = db.query_row("select value from meta where key = 'version'", [], |row| {
        Ok(CookieValue::from_ref(row.get_ref(0)?))
    });
    let version = match version {
        Ok(value) => Some(value.js_string()),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(error) => return Err(fail(error)),
    };
    let (true, Some(version)) = (columns.iter().any(|c| c == "host_key"), version) else {
        return Err(CookieStoreError::new(
            CookieStoreReason::SchemaChanged,
            "The cookie database is not laid out as expected.",
        ));
    };
    let mut statement = db
        .prepare("select * from cookies order by host_key, top_frame_site_key, name, path, source_scheme, source_port, has_cross_site_ancestor")
        .map_err(fail)?;
    let names: Vec<String> = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect();
    let all: Vec<CookieRow> = statement
        .query_map([], |row| {
            let mut out = CookieRow::new();
            for (i, name) in names.iter().enumerate() {
                out.insert(name.clone(), CookieValue::from_ref(row.get_ref(i)?));
            }
            Ok(out)
        })
        .map_err(fail)?
        .collect::<rusqlite::Result<_>>()
        .map_err(fail)?;
    let mut rows = Vec::new();
    let mut unlisted = Vec::new();
    let mut hash = Sha256::new();
    let total = all.len();
    for row in all {
        if is_login_row(&row) {
            rows.push(row);
            continue;
        }
        let name = column(&row, "name")
            .map(CookieValue::js_string)
            .unwrap_or_else(|| "undefined".into());
        let host = column(&row, "host_key")
            .map(CookieValue::js_string)
            .unwrap_or_default();
        if WEB_HOSTS.contains(&host.as_str())
            && column(&row, "is_httponly").is_some_and(CookieValue::is_one)
            && column(&row, "is_secure").is_some_and(CookieValue::is_one)
            && LOGIN_LIKE.is_match(&name)
            && !NOT_LOGIN.is_match(&name)
        {
            unlisted.push(name);
        }
        hash.update(row_key(&row).as_bytes());
    }
    let quick = db
        .query_row("pragma quick_check", [], |row| {
            Ok(CookieValue::from_ref(row.get_ref(0)?).js_string())
        })
        .map_err(fail)?;
    let count = total - rows.len();
    Ok(Read {
        snapshot: CookieSnapshot {
            version,
            columns,
            rows,
            unlisted,
        },
        others: hex(&hash.finalize()),
        count,
        quick,
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

const IDENTITY: &str = "host_key = ? and top_frame_site_key = ? and name = ? and path = ? and source_scheme = ? and source_port = ? and has_cross_site_ancestor = ?";
const IDENTITY_COLUMNS: [&str; 7] = [
    "host_key",
    "top_frame_site_key",
    "name",
    "path",
    "source_scheme",
    "source_port",
    "has_cross_site_ancestor",
];

/// Whether the site's device-bound session row is present; false without the table.
fn dbsc_present(db: &Connection) -> rusqlite::Result<bool> {
    let table: Option<String> = db
        .query_row(
            "select name from sqlite_master where type = 'table' and name = 'dbsc_session_tbl'",
            [],
            |row| row.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            e => Err(e),
        })?;
    if table.is_none() {
        return Ok(false);
    }
    db.query_row(
        "select 1 from dbsc_session_tbl where key = ?",
        [DBSC_KEY],
        |_| Ok(()),
    )
    .map(|()| true)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(false),
        e => Err(e),
    })
}

/// Runs `body` inside `BEGIN IMMEDIATE`, committing it, or rolling back when it fails.
fn immediate(db: &Connection, body: impl FnOnce() -> rusqlite::Result<()>) -> rusqlite::Result<()> {
    db.execute_batch("BEGIN IMMEDIATE")?;
    match body().and_then(|()| db.execute_batch("COMMIT")) {
        Ok(()) => Ok(()),
        Err(error) => {
            // Nothing may be open.
            let _ = db.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// The cookie storage on SQLite (`rusqlite`, bundled).
#[derive(Debug, Clone, Copy, Default)]
pub struct SqliteCookieStorage;

impl CookieStorage for SqliteCookieStorage {
    fn available(&self) -> bool {
        // Bundled: always there.
        true
    }

    fn read(&self, dir: &Path) -> Result<CookieSnapshot, CookieStoreError> {
        let file = cookies_file(dir)?;
        let db = open(&file, true)?;
        let read = read_database(&db);
        let _ = db.close();
        Ok(read?.snapshot)
    }

    fn write(&self, dir: &Path, snapshot: &CookieSnapshot) -> Result<(), CookieStoreError> {
        if snapshot.rows.is_empty() || !snapshot.rows.iter().all(is_login_row) {
            return Err(CookieStoreError::new(
                CookieStoreReason::Failed,
                "The saved login holds rows that are not a login.",
            ));
        }
        let file = cookies_file(dir)?;
        assert_quiet(&file)?;
        let dbsc_file = crate::fs_util::dirname(&file).join(DBSC_NAME);
        let has_dbsc = exists(&dbsc_file);
        if has_dbsc {
            assert_quiet(&dbsc_file)?;
        }
        let (before, columns) = {
            let db = open(&file, false)?;
            let result = (|| {
                let before = read_database(&db)?;
                if before.quick != "ok" {
                    return Err(CookieStoreError::new(
                        CookieStoreReason::SchemaChanged,
                        "The cookie database failed its check.",
                    )
                    .with_detail(&[("why", "damaged".to_owned())]));
                }
                // Another database version may store values another way (Chromium 24 hashes the
                // host into the encrypted value), so a login saved under one is never written
                // under another.
                if before.snapshot.version != snapshot.version {
                    return Err(CookieStoreError::new(
                        CookieStoreReason::SchemaChanged,
                        "The cookie database is not the one the login was saved from.",
                    )
                    .with_detail(&[
                        ("why", "version".to_owned()),
                        ("saved", snapshot.version.clone()),
                        ("current", before.snapshot.version.clone()),
                    ]));
                }
                let columns = writable_columns(&db, &snapshot.columns)?;
                immediate(&db, || {
                    let mut remove =
                        db.prepare(&format!("delete from cookies where {IDENTITY}"))?;
                    for row in &before.snapshot.rows {
                        let values: Vec<rusqlite::types::Value> = IDENTITY_COLUMNS
                            .iter()
                            .map(|c| row.get(*c).unwrap_or(&CookieValue::Null).to_sql())
                            .collect();
                        remove.execute(rusqlite::params_from_iter(values))?;
                    }
                    let mut insert = db.prepare(&format!(
                        "insert into cookies ({}) values ({})",
                        columns.join(", "),
                        vec!["?"; columns.len()].join(", ")
                    ))?;
                    for row in &snapshot.rows {
                        let values: Vec<rusqlite::types::Value> = columns
                            .iter()
                            .map(|c| row.get(c).unwrap_or(&CookieValue::Null).to_sql())
                            .collect();
                        insert.execute(rusqlite::params_from_iter(values))?;
                    }
                    Ok(())
                })
                .map_err(fail)?;
                Ok((before, columns))
            })();
            let _ = db.close();
            result?
        };
        if has_dbsc {
            let dbsc = open(&dbsc_file, false)?;
            let result = (|| {
                if dbsc_present(&dbsc)? {
                    immediate(&dbsc, || {
                        dbsc.execute("delete from dbsc_session_tbl where key = ?", [DBSC_KEY])
                            .map(|_| ())
                    })?;
                }
                Ok(())
            })()
            .map_err(fail);
            let _ = dbsc.close();
            result?;
        }
        // A second, separate open: what the browser will read, not what this handle remembers.
        let after = {
            let reader = open(&file, true)?;
            let after = read_database(&reader);
            let _ = reader.close();
            after?
        };
        let still_there = if has_dbsc {
            let side = open(&dbsc_file, true)?;
            let present = dbsc_present(&side).map_err(fail);
            let _ = side.close();
            present?
        } else {
            false
        };
        let null = CookieValue::Null;
        let every_found = snapshot.rows.iter().all(|row| {
            after.snapshot.rows.iter().any(|r| {
                columns
                    .iter()
                    .all(|c| same_value(r.get(c).unwrap_or(&null), row.get(c).unwrap_or(&null)))
            })
        });
        if after.quick != "ok"
            || after.others != before.others
            || after.count != before.count
            || still_there
            || after.snapshot.rows.len() != snapshot.rows.len()
            || !every_found
        {
            return Err(CookieStoreError::new(
                CookieStoreReason::Mismatch,
                "The login did not read back.",
            ));
        }
        Ok(())
    }
}

/// The vault's JSON form of a snapshot: integers and blobs as tagged strings.
pub fn encode_snapshot(snapshot: &CookieSnapshot) -> Value {
    let null = CookieValue::Null;
    let rows: Vec<Value> = snapshot
        .rows
        .iter()
        .map(|row| {
            let mut out = Map::new();
            for c in &snapshot.columns {
                out.insert(c.clone(), encode_value(row.get(c).unwrap_or(&null)));
            }
            Value::Object(out)
        })
        .collect();
    json!({ "version": snapshot.version, "columns": snapshot.columns, "rows": rows })
}

/// Why a saved login could not be decoded.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Invalid saved claude.ai login.")]
pub struct InvalidSavedLogin;

/// The snapshot a vault record holds; fails unless every row is one of the login's.
pub fn decode_snapshot(value: &Value) -> Result<CookieSnapshot, InvalidSavedLogin> {
    static COLUMN: LazyLock<Regex> = LazyLock::new(|| Regex::new("^[a-z_]+$").expect("static"));
    let record = value.as_object().ok_or(InvalidSavedLogin)?;
    let version = record
        .get("version")
        .and_then(Value::as_str)
        .ok_or(InvalidSavedLogin)?;
    let columns: Vec<String> = record
        .get("columns")
        .and_then(Value::as_array)
        .ok_or(InvalidSavedLogin)?
        .iter()
        .map(|c| c.as_str().filter(|c| COLUMN.is_match(c)).map(str::to_owned))
        .collect::<Option<_>>()
        .ok_or(InvalidSavedLogin)?;
    let raw_rows = record
        .get("rows")
        .and_then(Value::as_array)
        .ok_or(InvalidSavedLogin)?;
    let mut rows = Vec::new();
    for raw in raw_rows {
        let mut row = CookieRow::new();
        for column in &columns {
            let v = raw
                .as_object()
                .and_then(|r| r.get(column))
                .ok_or(InvalidSavedLogin)?;
            let value = match v {
                Value::Null => CookieValue::Null,
                Value::String(text) => CookieValue::Text(text.clone()),
                Value::Object(tagged) => match (tagged.get("i"), tagged.get("b")) {
                    (Some(Value::String(i)), _) => {
                        CookieValue::Integer(i.trim().parse().map_err(|_| InvalidSavedLogin)?)
                    }
                    (_, Some(Value::String(b))) => CookieValue::Blob(
                        base64::engine::general_purpose::STANDARD
                            .decode(b)
                            .map_err(|_| InvalidSavedLogin)?,
                    ),
                    _ => return Err(InvalidSavedLogin),
                },
                _ => return Err(InvalidSavedLogin),
            };
            row.insert(column.clone(), value);
        }
        rows.push(row);
    }
    if rows.is_empty() || !rows.iter().all(is_login_row) {
        return Err(InvalidSavedLogin);
    }
    Ok(CookieSnapshot {
        version: version.to_owned(),
        columns,
        rows,
        unlisted: Vec::new(),
    })
}

/// Copies the cookie files that exist in a profile folder into a new folder in `scratch` (mode
/// 0700), keeping their relative places, and returns it. Used for a backup before a write and for
/// a copy of a running browser's database that a check reads.
pub fn backup_cookie_files(dir: &Path, scratch: &Path) -> io::Result<PathBuf> {
    create_private_dir_all(scratch)?;
    let backup = scratch.join(uuid::Uuid::new_v4().to_string());
    create_private_dir(&backup)?;
    for rel in cookie_files() {
        let source = dir.join(&rel);
        let Ok(st) = fs::symlink_metadata(&source) else {
            continue;
        };
        if !st.is_file() {
            return Err(io::Error::other(
                "The browser's cookie files hold a link or a folder.",
            ));
        }
        let target = backup.join(&rel);
        create_private_dir_all(crate::fs_util::dirname(&target))?;
        fs::copy(&source, &target)?;
        set_mode(&target, 0o600)?;
    }
    Ok(backup)
}

/// Puts a backup's cookie files back; a file the backup lacks is removed (a journal a write left).
pub fn restore_cookie_files(dir: &Path, backup: &Path) -> io::Result<()> {
    let became_link = || io::Error::other("A cookie file became a link.");
    for rel in cookie_files() {
        let target = dir.join(&rel);
        let saved = backup.join(&rel);
        let target_st = fs::symlink_metadata(&target).ok();
        if exists(&saved) {
            // Never through a link someone put in place.
            if target_st.as_ref().is_some_and(|st| !st.is_file()) {
                return Err(became_link());
            }
            fs::copy(&saved, &target)?;
        } else if let Some(st) = target_st {
            if !st.is_file() {
                return Err(became_link());
            }
            match fs::remove_file(&target) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
                _ => {}
            }
        }
    }
    Ok(())
}
