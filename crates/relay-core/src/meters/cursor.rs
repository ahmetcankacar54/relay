//! Port of `electron/core/meters/cursor.ts`: Cursor's monthly usage, from
//! `cursor.com/api/usage-summary`, the call cursor.com's own dashboard makes. It takes the
//! dashboard's session cookie, which is the Cursor app's access token with its user id in front,
//! so the meter reads the token the app saved in its `state.vscdb` and sends it only while it is
//! valid. Relay never renews it, and never opens the "Cursor Safe Storage" Keychain item a token
//! encrypted with it needs.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use rusqlite::{Connection, OpenFlags, types::ValueRef};
use serde_json::Value;

use super::common::{
    Json, MeterError, MeterRead, MeterReaderOptions, buffer_from_base64, clamp_percent, iso_date,
    num, object, plain_label, request_json,
};
use crate::relay_paths::Platform;
use crate::shared::meters::{MeterIssue, MeterUnit, MeterWindow, MeterWindowKind, MeterWindowName};
use crate::shared::types::js::{date_parse, iso};

pub const CURSOR_ORIGIN: &str = "https://cursor.com";
const TOKEN_KEY: &str = "cursorAuth/accessToken";
/// CodexBar's margin: a token this close to its end is not sent.
const EXPIRY_MARGIN_MS: f64 = 60_000.0;

/// Where the Cursor app keeps its state: the VS Code layout under the system's app-data folder.
pub fn cursor_state_path(
    home: &Path,
    env: &BTreeMap<String, String>,
    platform: Platform,
) -> PathBuf {
    let set = |key: &str| env.get(key).filter(|v| !v.is_empty()).map(PathBuf::from);
    let base = match platform {
        Platform::MacOs => home.join("Library").join("Application Support"),
        Platform::Windows => set("APPDATA").unwrap_or_else(|| home.join("AppData").join("Roaming")),
        Platform::Linux => set("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config")),
    };
    base.join("Cursor")
        .join("User")
        .join("globalStorage")
        .join("state.vscdb")
}

/// A value of `ItemTable`: the token as text, or JSON text holding it.
fn item_text(value: ValueRef) -> Option<String> {
    let text = match value {
        ValueRef::Text(bytes) | ValueRef::Blob(bytes) => {
            String::from_utf8_lossy(bytes).into_owned()
        }
        _ => return None,
    };
    if text.is_empty() {
        return None;
    }
    if text.starts_with('"') {
        return match serde_json::from_str::<Value>(&text) {
            Ok(Value::String(s)) => Some(s),
            _ => None,
        };
    }
    Some(text)
}

fn query_token(file: &Path, read_only: bool) -> rusqlite::Result<Option<String>> {
    let flags = if read_only {
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX
    } else {
        OpenFlags::default()
    };
    let db = Connection::open_with_flags(file, flags)?;
    let mut statement = db.prepare("select value from ItemTable where key = ?")?;
    let mut rows = statement.query([TOKEN_KEY])?;
    Ok(match rows.next()? {
        Some(row) => item_text(row.get_ref(0)?),
        None => None,
    })
}

/// The app's access token from `state.vscdb`, opened read-only in place. When that fails (a
/// write-ahead log the read-only open cannot use), from a private copy of the database and its
/// log.
pub fn read_cursor_state_token(file: &Path) -> Option<String> {
    if fs::metadata(file).is_err() {
        return None;
    }
    if let Ok(token) = query_token(file, true) {
        return token;
    }
    let dir = std::env::temp_dir().join(format!("relay-meter-{}", uuid::Uuid::new_v4()));
    crate::fs_util::create_private_dir(&dir).ok()?;
    for suffix in ["", "-wal", "-shm"] {
        let mut from = file.as_os_str().to_owned();
        from.push(suffix);
        let _ = fs::copy(&from, dir.join(format!("state.vscdb{suffix}")));
    }
    let token = query_token(&dir.join("state.vscdb"), false).ok().flatten();
    let _ = fs::remove_dir_all(&dir);
    token
}

/// The `cursor-agent` sign-in on Linux: `~/.config/cursor/auth.json`'s `accessToken`.
fn read_agent_token(home: &Path, env: &BTreeMap<String, String>) -> Option<String> {
    let config = env
        .get("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map_or_else(|| home.join(".config"), PathBuf::from);
    let value: Value =
        serde_json::from_slice(&fs::read(config.join("cursor").join("auth.json")).ok()?).ok()?;
    value.get("accessToken")?.as_str().map(str::to_owned)
}

/// A JWT's claims, unverified: only to tell its user and its end, never to trust it.
pub fn jwt_claims(token: &str) -> Option<Json> {
    let part = token.split('.').nth(1).filter(|p| !p.is_empty())?;
    let bytes = buffer_from_base64(part);
    match serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)) {
        Ok(Value::Object(claims)) => Some(claims),
        _ => None,
    }
}

static JWT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$").expect("valid regex")
});
static USER_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,128}$").expect("valid regex"));

/// The dashboard's session cookie for a token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CursorSession {
    pub cookie: String,
    pub user_id: String,
}

/// The dashboard's session cookie for a token: `WorkosCursorSessionToken=<user id>%3A%3A<token>`,
/// the user id being the part of the JWT's `sub` after `|`. Refuses a token that is not a JWT
/// or ends within a minute.
pub fn cursor_session_cookie(token: &str, now: f64) -> Result<CursorSession, MeterError> {
    let claims = jwt_claims(token)
        .filter(|_| JWT.is_match(token))
        .ok_or_else(|| {
            MeterError::new(MeterIssue::Unsupported, None, "cursor: token is not a JWT")
        })?;
    if let Some(exp) = num(claims.get("exp"))
        && exp * 1000.0 - now <= EXPIRY_MARGIN_MS
    {
        return Err(MeterError::new(
            MeterIssue::Expired,
            None,
            "cursor: token ended",
        ));
    }
    let sub = claims.get("sub").and_then(Value::as_str).unwrap_or("");
    let user_id = sub.rsplit_once('|').map_or(sub, |(_, id)| id);
    if !USER_ID.is_match(user_id) {
        return Err(MeterError::new(
            MeterIssue::Unsupported,
            None,
            "cursor: token names no user",
        ));
    }
    Ok(CursorSession {
        cookie: format!("WorkosCursorSessionToken={user_id}%3A%3A{token}"),
        user_id: user_id.to_owned(),
    })
}

/// The token found on this computer: the app's own, else the agent's on Linux.
pub fn find_cursor_token(options: &MeterReaderOptions) -> Option<String> {
    let home = options.home();
    let env = options.env();
    let platform = options.platform();
    if let Some(token) = read_cursor_state_token(&cursor_state_path(&home, &env, platform)) {
        return Some(token);
    }
    if platform == Platform::Linux {
        read_agent_token(&home, &env)
    } else {
        None
    }
}

/// Cents as dollars.
fn dollars(cents: f64) -> f64 {
    crate::shared::types::js::round(cents) / 100.0
}

fn monthly(name: MeterWindowName, used_percent: f64, resets_at: &Option<String>) -> MeterWindow {
    MeterWindow {
        name,
        kind: MeterWindowKind::Monthly,
        used_percent: Some(clamp_percent(used_percent)),
        used: None,
        limit: None,
        unit: MeterUnit::Dollars,
        resets_at: resets_at.clone(),
    }
}

/// The windows and plan in a `usage-summary` answer. Money is in cents, shares in percent.
pub fn parse_cursor_summary(value: &Value) -> Result<MeterRead, MeterError> {
    let Some(root) = value.as_object() else {
        return Err(MeterError::new(
            MeterIssue::Unsupported,
            None,
            "cursor: not an object",
        ));
    };
    let resets_at = iso_date(root.get("billingCycleEnd"));
    let empty = Json::new();
    let individual = object(root.get("individualUsage")).unwrap_or(&empty);
    let plan = object(individual.get("plan"));
    let mut windows = Vec::new();
    if let Some(plan) = plan
        && plan.get("enabled") != Some(&Value::Bool(false))
        && root.get("isUnlimited") != Some(&Value::Bool(true))
    {
        let used = num(plan.get("used"));
        let limit = num(plan.get("limit"));
        let total = num(plan.get("totalPercentUsed")).or_else(|| num(root.get("totalPercentUsed")));
        let used_percent = total.or(match (used, limit) {
            (Some(used), Some(limit)) if limit != 0.0 => Some(used / limit * 100.0),
            _ => None,
        });
        if let Some(used_percent) = used_percent {
            let mut window = monthly(MeterWindowName::Included, used_percent, &resets_at);
            if let (Some(used), Some(limit)) = (used, limit) {
                window.used = Some(dollars(used));
                window.limit = Some(dollars(limit));
            }
            windows.push(window);
        }
        for (name, key) in [
            (MeterWindowName::Auto, "autoPercentUsed"),
            (MeterWindowName::Api, "apiPercentUsed"),
        ] {
            if let Some(share) = num(plan.get(key)).or_else(|| num(root.get(key))) {
                windows.push(monthly(name, share, &resets_at));
            }
        }
    }
    let on_demand = object(individual.get("onDemand"));
    let demand_limit = on_demand
        .and_then(|d| num(d.get("limit")))
        .filter(|l| *l != 0.0);
    let demand_used = on_demand.and_then(|d| num(d.get("used")));
    if let (Some(on_demand), Some(limit), Some(used)) = (on_demand, demand_limit, demand_used)
        && on_demand.get("enabled") == Some(&Value::Bool(true))
    {
        let mut window = monthly(MeterWindowName::OnDemand, used / limit * 100.0, &resets_at);
        window.used = Some(dollars(used));
        window.limit = Some(dollars(limit));
        windows.push(window);
    }
    Ok(MeterRead {
        label: plain_label(root.get("membershipType")),
        windows,
    })
}

/// An older request-based plan's month, from `/api/usage`: `gpt-4`'s requests out of its
/// maximum.
pub fn parse_cursor_legacy_usage(value: &Value) -> Vec<MeterWindow> {
    let premium = object(value.get("gpt-4"));
    let used =
        premium.and_then(|p| num(p.get("numRequests")).or_else(|| num(p.get("numRequestsTotal"))));
    let limit = premium
        .and_then(|p| num(p.get("maxRequestUsage")))
        .filter(|l| *l != 0.0);
    let (Some(used), Some(limit)) = (used, limit) else {
        return Vec::new();
    };
    let start = date_parse(
        value
            .get("startOfMonth")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    let resets_at = start.is_finite().then(|| iso(add_utc_month(start)));
    vec![MeterWindow {
        name: MeterWindowName::Requests,
        kind: MeterWindowKind::Monthly,
        used_percent: Some(clamp_percent(used / limit * 100.0)),
        used: Some(used),
        limit: Some(limit),
        unit: MeterUnit::Requests,
        resets_at,
    }]
}

/// `date.setUTCMonth(date.getUTCMonth() + 1)`: the same day and time a month on, a day past the
/// month's end rolling over as JavaScript's Date does.
fn add_utc_month(ms: f64) -> f64 {
    use chrono::{Datelike, Duration, NaiveDate, TimeZone, Utc};
    let Some(at) = Utc.timestamp_millis_opt(ms as i64).single() else {
        return f64::NAN;
    };
    let (year, month) = if at.month() == 12 {
        (at.year() + 1, 1)
    } else {
        (at.year(), at.month() + 1)
    };
    let Some(first) = NaiveDate::from_ymd_opt(year, month, 1) else {
        return f64::NAN;
    };
    let date = first + Duration::days(i64::from(at.day()) - 1);
    let moved = date.and_time(at.time()).and_utc();
    moved.timestamp_millis() as f64
}

/// Reads the usage of the Cursor sign-in found on this computer.
pub fn read_cursor(options: &MeterReaderOptions) -> Result<MeterRead, MeterError> {
    let Some(token) = find_cursor_token(options) else {
        return Err(MeterError::new(
            MeterIssue::NotSignedIn,
            None,
            "cursor: no saved sign-in",
        ));
    };
    // Encrypted with the app's Keychain key; reading that item could ask for the Keychain.
    if token.starts_with("cursor-safe-storage:") {
        return Err(MeterError::new(
            MeterIssue::Encrypted,
            None,
            "cursor: token encrypted",
        ));
    }
    let session = cursor_session_cookie(&token, options.now())?;
    let headers = [
        ("Accept", "application/json"),
        ("Cookie", session.cookie.as_str()),
    ];
    let summary = request_json(
        &format!("{CURSOR_ORIGIN}/api/usage-summary"),
        "GET",
        &headers,
        None,
        "cursor summary",
        options,
        None,
    )?;
    let read = parse_cursor_summary(&summary.body)?;
    if !read.windows.is_empty() || summary.body.get("isUnlimited") == Some(&Value::Bool(true)) {
        return Ok(read);
    }
    // A plan counted in requests, not dollars, has no budget in the summary.
    let legacy = request_json(
        // The user id is `[\w-]` only: nothing in it needs encoding.
        &format!("{CURSOR_ORIGIN}/api/usage?user={}", session.user_id),
        "GET",
        &headers,
        None,
        "cursor usage",
        options,
        None,
    )?;
    Ok(MeterRead {
        windows: parse_cursor_legacy_usage(&legacy.body),
        ..read
    })
}
