//! Port of `shared/extension-auth.ts`: finding the Claude extension's sign-in among the entries
//! of its `chrome.storage.local` (a LevelDB whose values are JSON text) without knowing its key
//! names. See the TS module for what was observed in which extension version.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use super::model_prices::js_trim;
use super::types::js::JsMap;

/// A sign-in: each key's value as the extension stored it (JSON text), in JS object key order.
pub type SignIn = JsMap<String>;

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("static pattern")
}

// JS regexes without the `u` flag: `\d`, `\b` and `i` are ASCII-only there, so the Rust patterns
// spell digits as [0-9], fold case on ASCII only (`(?i-u:…)`), and use an ASCII `\b`.
const HEX_UUID: &str = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
/// JS `\s`: Unicode white space plus U+FEFF.
const JS_SPACE: &str = r"[\s\x{FEFF}]";

static UUID: LazyLock<Regex> = LazyLock::new(|| re(&format!("^{HEX_UUID}$")));
static UUID_IN: LazyLock<Regex> = LazyLock::new(|| re(HEX_UUID));
/// A key that names part of a sign-in.
static SIGN_IN_NAME: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?i-u:token|auth|account|user|session|oauth|credential|login|expir|refresh|identity|organi[sz]ation|\borg)")
});
/// A key whose name says it holds a token.
static TOKEN_NAME: LazyLock<Regex> = LazyLock::new(|| re("(?i-u:token|credential|oauth)"));
/// A value holding a token, nested or not: a token field, or a Claude OAuth token itself.
static TOKEN_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r#""(?i-u:access|refresh|id)_?(?i-u:token)"{JS_SPACE}*:{JS_SPACE}*"[^"]{{8,}}|(?i-u:sk-ant-[a-z]{{2,4}})[0-9]{{0,2}}-[A-Za-z0-9_-]{{8,}}"#
    ))
});
static PASSING_FAILURE: LazyLock<Regex> = LazyLock::new(|| re("(?i-u:network|timeout|offline|unavailable)"));
/// A key that holds the signed-in account's own uuid and nothing else, like `accountUuid`.
static ACCOUNT_ID_NAME: LazyLock<Regex> = LazyLock::new(|| re("^(?i-u:(?:account|user)[_-]?(?:uuid|id))$"));
static NAMED_KEY: LazyLock<Regex> = LazyLock::new(|| re(r"(?i-u:account|user|identity|profile|\bme\b)"));
static ACCOUNT_OR_USER: LazyLock<Regex> = LazyLock::new(|| re("(?i-u:account|user)"));
static ACCOUNT_FIELD: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(r#""(?i-u:(?:account|user)[_-]?(?:uuid|id))"{JS_SPACE}*:{JS_SPACE}*"({HEX_UUID})""#))
});
static OBJECT_KEY_AFTER: LazyLock<Regex> = LazyLock::new(|| re(&format!("^\"{JS_SPACE}*:")));

pub fn is_account_uuid(value: &str) -> bool {
    UUID.is_match(value)
}

/// Values that hold nothing.
const EMPTY: [&str; 9] = ["", "null", "undefined", "false", "true", "0", "\"\"", "{}", "[]"];

fn filled(value: &str) -> bool {
    let trimmed = js_trim(value);
    !EMPTY.contains(&trimmed) && trimmed.encode_utf16().count() >= 12
}

/// The extension's records of its own last failed attempts (extension 1.0.105, read 2026-11-04).
/// None is kept with an account nor put back: a write removes them.
pub const FAILURE_KEYS: [&str; 3] = ["lastAuthFailureReason", "startupReauthState", "pairingOrgMismatch"];

fn is_failure_key(key: &str) -> bool {
    FAILURE_KEYS.contains(&key)
}

/// `sign_in` without the extension's record of a failed sign-in.
pub fn without_failure(sign_in: &SignIn) -> SignIn {
    sign_in.iter().filter(|(key, _)| !is_failure_key(key)).map(|(k, v)| (k.clone(), v.clone())).collect()
}

/// Whether the extension recorded a failed sign-in: it then refuses browser tools until one
/// works. Any reason but a passing one (no network) counts, so an unknown record never reads as
/// healthy.
pub fn session_expired<'a>(entries: impl IntoIterator<Item = (&'a str, Option<&'a str>)>) -> bool {
    for (key, value) in entries {
        if key == "lastAuthFailureReason"
            && let Some(value) = value
        {
            return match serde_json::from_str::<Value>(value) {
                Ok(Value::String(reason)) => !js_trim(&reason).is_empty() && !PASSING_FAILURE.is_match(&reason),
                _ => false,
            };
        }
    }
    false
}

/// Sign-in keys the name pattern misses (extension 1.0.105).
const SIGN_IN_KEYS: [&str; 6] = ["lastActiveOrgHint", "codeVerifier", "signInState", "lastAuthFailureReason", "startupReauthState", "pairingOrgMismatch"];

/// Whether this entry is part of a sign-in, by its name or by holding a token.
pub fn is_sign_in_entry(key: &str, value: &str) -> bool {
    SIGN_IN_KEYS.contains(&key) || SIGN_IN_NAME.is_match(key) || TOKEN_VALUE.is_match(value)
}

/// Whether the stored entries hold a token: someone is signed in.
pub fn holds_token<'a>(entries: impl IntoIterator<Item = (&'a str, &'a str)>) -> bool {
    entries
        .into_iter()
        .any(|(key, value)| TOKEN_VALUE.is_match(value) || (TOKEN_NAME.is_match(key) && filled(value)))
}

/// The uuid (lower case) a key like `accountUuid` holds as its whole value.
fn account_id_of(key: &str, value: &str) -> Option<String> {
    if !ACCOUNT_ID_NAME.is_match(key) {
        return None;
    }
    match serde_json::from_str::<Value>(value) {
        Ok(Value::String(parsed)) if is_account_uuid(&parsed) => Some(parsed.to_lowercase()),
        _ => None,
    }
}

/// The account uuids keys like `accountUuid` hold, in first-seen order.
fn held_accounts(entries: &[(&str, &str)]) -> Vec<String> {
    let mut held: Vec<String> = Vec::new();
    for uuid in entries.iter().filter_map(|(k, v)| account_id_of(k, v)) {
        if !held.contains(&uuid) {
            held.push(uuid);
        }
    }
    held
}

/// The uuids (lower case) a value holds, leaving out those used as object keys.
fn value_uuids(value: &str) -> Vec<String> {
    UUID_IN
        .find_iter(value)
        .filter(|m| !OBJECT_KEY_AFTER.is_match(&value[m.end()..]))
        .map(|m| m.as_str().to_lowercase())
        .collect()
}

fn push_unique(set: &mut Vec<String>, value: String) {
    if !set.contains(&value) {
        set.push(value);
    }
}

/// Which of `known` (account uuids) the entries name. A key like `accountUuid` says it outright;
/// otherwise, when several are named, the one in a key named like an account or a user wins;
/// still several, none.
pub fn named_account<'a>(entries: impl IntoIterator<Item = (&'a str, &'a str)>, known: &[String]) -> Option<String> {
    let all: Vec<(&str, &str)> = entries.into_iter().collect();
    named_account_in(&all, known)
}

fn named_account_in(all: &[(&str, &str)], known: &[String]) -> Option<String> {
    let mut wanted: Vec<String> = Vec::new();
    for k in known.iter().map(|k| k.to_lowercase()).filter(|k| is_account_uuid(k)) {
        push_unique(&mut wanted, k);
    }
    let held = held_accounts(all);
    if held.len() == 1 {
        let uuid = held.into_iter().next()?;
        return wanted.contains(&uuid).then_some(uuid);
    }
    let mut anywhere: Vec<String> = Vec::new();
    let mut named: Vec<String> = Vec::new();
    for (key, value) in all {
        for uuid in value_uuids(value) {
            if wanted.contains(&uuid) {
                push_unique(&mut anywhere, uuid.clone());
                if NAMED_KEY.is_match(key) {
                    push_unique(&mut named, uuid);
                }
            }
        }
    }
    if anywhere.len() == 1 {
        return anywhere.into_iter().next();
    }
    if named.len() == 1 {
        return named.into_iter().next();
    }
    None
}

/// Whether the entries name, as an account, a uuid that is none of `known`. Such a sign-in is
/// someone else's and is never taken for the account Relay last put in place.
pub fn names_other_account<'a>(entries: impl IntoIterator<Item = (&'a str, &'a str)>, known: &[String]) -> bool {
    let mine: Vec<String> = known.iter().map(|k| k.to_lowercase()).collect();
    entries.into_iter().any(|(key, value)| {
        let found: Vec<String> = if ACCOUNT_OR_USER.is_match(key) {
            value_uuids(value)
        } else {
            ACCOUNT_FIELD.captures_iter(value).map(|c| c[1].to_string()).collect()
        };
        found.iter().any(|uuid| !mine.contains(&uuid.to_lowercase()))
    })
}

/// The sign-in found by `pick_sign_in`.
#[derive(Debug, Clone, PartialEq)]
pub struct PickedSignIn {
    pub sign_in: SignIn,
    /// The account it belongs to, when it is one of `known`.
    pub account: Option<String>,
    /// The data names an account that is not Relay's (only without `account`).
    pub other: bool,
}

/// The sign-in among stored entries, and the account it belongs to when it is one of `known`.
/// `None` is "not signed in".
pub fn pick_sign_in<'a>(entries: impl IntoIterator<Item = (&'a str, Option<&'a str>)>, known: &[String]) -> Option<PickedSignIn> {
    let all: Vec<(&str, &str)> = entries.into_iter().filter_map(|(k, v)| v.map(|v| (k, v))).collect();
    if !holds_token(all.iter().copied()) && held_accounts(&all).is_empty() {
        return None;
    }
    let account = named_account_in(&all, known);
    let mut sign_in = SignIn::new();
    for (key, value) in &all {
        if !is_failure_key(key)
            && (is_sign_in_entry(key, value) || account.as_ref().is_some_and(|a| value.to_lowercase().contains(a.as_str())))
        {
            sign_in.insert(*key, value.to_string());
        }
    }
    let other = account.is_none() && names_other_account(all.iter().copied(), known);
    Some(PickedSignIn { sign_in, account, other })
}

pub fn same_sign_in(a: &SignIn, b: &SignIn) -> bool {
    a.len() == b.len() && a.iter().all(|(key, value)| b.get(key) == Some(value))
}
