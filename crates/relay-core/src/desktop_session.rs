//! Port of `electron/core/desktop-session.ts`: whether a copy of the Claude app's cookie files
//! holds a claude.ai session.
//!
//! Claude's sign-in is two things: the account its `config.json` names, and the `sessionKey`
//! cookies in its cookie database. They part ways when Claude quits within 30 s of a sign-in
//! (Chromium writes cookies every 30 s), and when claude.ai refuses a session and Claude drops
//! the cookies while `config.json` keeps naming the account.

use crate::desktop_usage::{CookieFiles, read_cookie_rows};

/// `Unknown` when the database cannot be read here: callers then do what they did before this
/// check existed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionPresence {
    Present,
    Absent,
    Unknown,
}

fn has_database(files: &CookieFiles) -> bool {
    ["Network/Cookies", "Cookies"]
        .iter()
        .any(|name| matches!(files.get(*name), Some(Some(_))))
}

pub fn session_presence(files: &CookieFiles) -> SessionPresence {
    if !has_database(files) {
        return SessionPresence::Unknown;
    }
    match read_cookie_rows(files) {
        Ok(read) => {
            if read.rows.iter().any(|row| {
                row.name.starts_with("sessionKey")
                    && (!row.encrypted.is_empty() || !row.value.is_empty())
            }) {
                SessionPresence::Present
            } else {
                SessionPresence::Absent
            }
        }
        Err(_) => SessionPresence::Unknown,
    }
}

/// When a copy of the Claude app's cookie files stops holding a session (ms since the epoch):
/// the latest end of its `sessionKey` cookies. None when that cannot be told.
pub fn session_ends_ms(files: &CookieFiles) -> Option<f64> {
    if !has_database(files) {
        return None;
    }
    let read = read_cookie_rows(files).ok()?;
    let sessions: Vec<_> = read
        .rows
        .iter()
        .filter(|row| row.name.starts_with("sessionKey"))
        .collect();
    if sessions.is_empty() || sessions.iter().any(|row| row.expires_ms.is_none()) {
        return None;
    }
    sessions
        .iter()
        .filter_map(|row| row.expires_ms)
        .reduce(f64::max)
}

/// Raised before Claude is quit: its sign-in is not in the cookie file yet, so nothing was touched.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Claude has not finished saving this sign-in yet. Relay tries again in a moment.")]
pub struct SignInNotSettled;

pub const SIGN_IN_WITHOUT_SESSION: &str = "This Claude sign-in holds no session, so it was not saved. Sign in to the Claude app again, wait half a minute, then save.";
pub const CLAUDE_SIGNED_OUT: &str = "The Claude app is signed out. Sign in to it first, then save.";
