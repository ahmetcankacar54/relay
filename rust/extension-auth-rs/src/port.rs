//! The Rust port of `shared/extension-auth.ts`, delegating to `relay_core::shared::extension_auth`.
//!
//! Arguments arrive as JSON and are read the way JS reads them: entries are anything iterable
//! (an array, a string, a `Map` as `{"$map": [...]}`) of `[key, value]` pairs, and an entry JS
//! cannot destructure, or a value that is no string where the original calls a string method on
//! it, throws where JS throws (unless the original returned before). Keys are read as JS turns
//! them into text; records go to relay-core with stand-in values and come back as the caller's
//! own. A string with a lone surrogate (`{"$utf16": [...]}`) crosses lossily, which no pattern
//! here can tell apart.

#![forbid(unsafe_code)]

use relay_core::shared::extension_auth::{self as auth, SignIn};
use relay_core::shared::types::js::{number_string, number_value};
use serde_json::{Map, Value};

use crate::js::{is_undefined, string_units, undefined, utf16_string};

// ---- JS values

fn marker<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    value.as_object().filter(|o| o.len() == 1)?.get(name)
}

fn is_nullish(value: &Value) -> bool {
    value.is_null() || is_undefined(value)
}

/// A JS string's UTF-16 code units, plain or marked.
fn units(value: &Value) -> Option<Vec<u16>> {
    match value {
        Value::String(_) => string_units(value),
        _ => marker(value, "$utf16").and(string_units(value)),
    }
}

/// A JS string, lone surrogates replaced.
fn js_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        other => units(other).map(|u| String::from_utf16_lossy(&u)),
    }
}

/// `String(value)`.
fn js_text(value: &Value) -> String {
    if let Some(s) = js_string(value) {
        return s;
    }
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::Array(items) => items
            .iter()
            .map(|v| {
                if is_nullish(v) {
                    String::new()
                } else {
                    js_text(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        v if is_undefined(v) => "undefined".into(),
        v => match (marker(v, "$num"), marker(v, "$map"), marker(v, "$set")) {
            (Some(Value::String(n)), _, _) => number_string(number_value(n)),
            (_, Some(_), _) => "[object Map]".into(),
            (_, _, Some(_)) => "[object Set]".into(),
            _ => "[object Object]".into(),
        },
    }
}

/// A string's code points, as JS iterates it (a lone surrogate on its own).
fn code_points(units: &[u16]) -> Vec<Value> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < units.len() {
        let pair = (0xD800..0xDC00).contains(&units[i])
            && units
                .get(i + 1)
                .is_some_and(|u| (0xDC00..0xE000).contains(u));
        let n = if pair { 2 } else { 1 };
        out.push(utf16_string(&units[i..i + n]));
        i += n;
    }
    out
}

const NOT_ITERABLE: &str = "TypeError: object is not iterable";

/// `[...value]`.
fn iterate(value: &Value) -> Result<Vec<Value>, String> {
    if let Some(units) = units(value) {
        return Ok(code_points(&units));
    }
    match (value, marker(value, "$map"), marker(value, "$set")) {
        (Value::Array(items), _, _) => Ok(items.clone()),
        (_, Some(Value::Array(items)), _) | (_, _, Some(Value::Array(items))) => Ok(items.clone()),
        _ => Err(NOT_ITERABLE.into()),
    }
}

/// `const [key, value] = entry`.
fn destructure(entry: &Value) -> Result<(Value, Value), String> {
    let mut items = iterate(entry)?.into_iter();
    Ok((
        items.next().unwrap_or_else(undefined),
        items.next().unwrap_or_else(undefined),
    ))
}

/// `entry[1]`.
fn second(entry: &Value) -> Result<Value, String> {
    if is_nullish(entry) {
        return Err("TypeError: Cannot read properties of undefined (reading '1')".into());
    }
    if let Some(units) = units(entry) {
        return Ok(units.get(1).map_or_else(undefined, |u| utf16_string(&[*u])));
    }
    Ok(match entry {
        Value::Array(items) => items.get(1).cloned().unwrap_or_else(undefined),
        Value::Object(o)
            if ["$map", "$set", "$num", "$date"]
                .iter()
                .all(|m| marker(entry, m).is_none()) =>
        {
            o.get("1").cloned().unwrap_or_else(undefined)
        }
        _ => undefined(),
    })
}

/// `Object.entries(value)`.
fn object_entries(value: &Value) -> Result<Vec<(String, Value)>, String> {
    if is_nullish(value) {
        return Err("TypeError: Cannot convert undefined or null to object".into());
    }
    if let Some(units) = units(value) {
        return Ok(units
            .iter()
            .enumerate()
            .map(|(i, u)| (i.to_string(), utf16_string(&[*u])))
            .collect());
    }
    Ok(match value {
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v.clone()))
            .collect(),
        Value::Object(o)
            if ["$map", "$set", "$num", "$date"]
                .iter()
                .all(|m| marker(value, m).is_none()) =>
        {
            let order: SignIn = o.keys().map(|k| (k.clone(), String::new())).collect();
            order
                .keys()
                .map(|k| (k.clone(), o[k.as_str()].clone()))
                .collect()
        }
        _ => Vec::new(),
    })
}

/// A key equal to another exactly when the values are `===`; objects and NaN equal nothing.
fn strict_key(value: &Value, unique: &mut usize) -> String {
    let mut own = || {
        *unique += 1;
        format!("o{unique}")
    };
    let number = |n: f64| {
        if n.is_nan() {
            None
        } else {
            Some(format!("n{}", n + 0.0))
        }
    };
    if let Some(units) = units(value) {
        return format!("s{units:?}");
    }
    match value {
        Value::Null => "l".into(),
        Value::Bool(b) => format!("b{b}"),
        Value::Number(n) => number(n.as_f64().unwrap_or(f64::NAN)).unwrap_or_else(own),
        v if is_undefined(v) => "u".into(),
        v => match marker(v, "$num") {
            Some(Value::String(n)) => number(number_value(n)).unwrap_or_else(own),
            _ => own(),
        },
    }
}

// ---- Entries

/// A destructured entry: its key as text, its value when that is a string, and the value as
/// the caller sent it.
struct Entry {
    key: String,
    /// The key itself when it is a string (`===` compares it).
    string_key: Option<String>,
    value: Option<String>,
    raw: Value,
}

impl Entry {
    fn new(key: &Value, raw: Value) -> Self {
        Entry {
            key: js_text(key),
            string_key: js_string(key),
            value: js_string(&raw),
            raw,
        }
    }

    /// The value as the original's string methods see it: `String(value)` where it coerces.
    fn text(&self) -> String {
        self.value.clone().unwrap_or_else(|| js_text(&self.raw))
    }
}

/// The entries up to the first that JS cannot destructure, and that error; `Err` when `entries`
/// is not iterable.
fn destructured(entries: &Value) -> Result<(Vec<Entry>, Option<String>), String> {
    let mut out = Vec::new();
    for item in iterate(entries)? {
        match destructure(&item) {
            Ok((key, value)) => out.push(Entry::new(&key, value)),
            Err(e) => return Ok((out, Some(e))),
        }
    }
    Ok((out, None))
}

/// `known` as the original maps it with `toLowerCase`: strings only.
fn known_of(known: &Value) -> Result<Vec<String>, String> {
    match known {
        Value::Array(items) => items
            .iter()
            .map(|k| {
                js_string(k).ok_or_else(|| "TypeError: k.toLowerCase is not a function".into())
            })
            .collect(),
        _ => Err("TypeError: known.map is not a function".into()),
    }
}

const NO_STRING: &str = "TypeError: Cannot read properties of a value that is no string";

/// `TOKEN_VALUE.test(text)`, through `holdsToken` (no key names a token).
fn token_value(text: &str) -> bool {
    auth::holds_token([("", text)])
}

/// `TOKEN_NAME.test(key)`, through `holdsToken` (twelve letters fill a value and hold no token).
fn token_name(key: &str) -> bool {
    auth::holds_token([(key, "aaaaaaaaaaaa")])
}

// ---- Exports

/// Port of `isAccountUuid` (`shared/extension-auth.ts:24`).
pub fn is_account_uuid(value: Value) -> Result<bool, String> {
    Ok(value.as_str().is_some_and(auth::is_account_uuid))
}

/// Port of `withoutFailure` (`shared/extension-auth.ts:62`): relay-core filters the keys of a
/// record whose values stand for the caller's.
pub fn without_failure(sign_in: Value) -> Result<Value, String> {
    let entries = object_entries(&sign_in)?;
    let stand_in: SignIn = entries
        .iter()
        .enumerate()
        .map(|(i, (k, _))| (k.clone(), i.to_string()))
        .collect();
    let mut out = Map::new();
    for (key, index) in auth::without_failure(&stand_in).iter() {
        let raw = index.parse::<usize>().ok().and_then(|i| entries.get(i));
        out.insert(key.clone(), raw.map_or(Value::Null, |(_, v)| v.clone()));
    }
    Ok(Value::Object(out))
}

/// Port of `sessionExpired` (`shared/extension-auth.ts:73`): the loop returns at the first
/// failure record held as a string, so a later entry it cannot destructure never throws.
pub fn session_expired(entries: Value) -> Result<bool, String> {
    let (list, error) = destructured(&entries)?;
    let pairs = || {
        list.iter()
            .map(|e| (e.string_key.as_deref().unwrap_or(""), e.value.as_deref()))
    };
    if let Some(error) = error
        && !pairs().any(|(k, v)| k == auth::FAILURE_KEYS[0] && v.is_some())
    {
        return Err(error);
    }
    Ok(auth::session_expired(pairs()))
}

/// Port of `isSignInEntry` (`shared/extension-auth.ts:94`).
pub fn is_sign_in_entry(key: String, value: String) -> Result<bool, String> {
    Ok(auth::is_sign_in_entry(&key, &value))
}

/// Port of `holdsToken` (`shared/extension-auth.ts:99`): the loop returns at the first token,
/// and throws at an entry it cannot destructure or whose value is no string under a token's
/// name (`filled` trims it).
pub fn holds_token(entries: Value) -> Result<bool, String> {
    let (list, error) = destructured(&entries)?;
    let throws = list
        .iter()
        .position(|e| e.value.is_none() && !token_value(&e.text()) && token_name(&e.key));
    let (prefix, error) = match throws {
        Some(i) => (&list[..i], Some(NO_STRING.to_string())),
        None => (&list[..], error),
    };
    let texts: Vec<(&str, String)> = prefix.iter().map(|e| (e.key.as_str(), e.text())).collect();
    let held = auth::holds_token(texts.iter().map(|(k, v)| (*k, v.as_str())));
    match error {
        Some(error) if !held => Err(error),
        _ => Ok(held),
    }
}

/// Port of `namedAccount` (`shared/extension-auth.ts:141`): every entry is destructured first,
/// and past a lone `accountUuid`-like key every value is searched as a string.
pub fn named_account(entries: Value, known: Value) -> Result<Value, String> {
    let known = known_of(&known)?;
    let (list, error) = destructured(&entries)?;
    if let Some(error) = error {
        return Err(error);
    }
    let texts: Vec<(&str, String)> = list.iter().map(|e| (e.key.as_str(), e.text())).collect();
    if list.iter().any(|e| e.value.is_none()) {
        let mut held: Vec<String> = texts
            .iter()
            .filter_map(|(k, v)| auth::account_id_of(k, v))
            .collect();
        held.sort();
        held.dedup();
        if held.len() != 1 {
            return Err(NO_STRING.into());
        }
    }
    Ok(
        auth::named_account(texts.iter().map(|(k, v)| (*k, v.as_str())), &known)
            .map_or_else(undefined, Value::String),
    )
}

/// Port of `namesOtherAccount` (`shared/extension-auth.ts:173`): the loop returns at the first
/// entry naming another account, and throws at one it cannot destructure or whose value is no
/// string.
pub fn names_other_account(entries: Value, known: Value) -> Result<bool, String> {
    let known = known_of(&known)?;
    let (list, error) = destructured(&entries)?;
    let (prefix, error) = match list.iter().position(|e| e.value.is_none()) {
        Some(i) => (&list[..i], Some(NO_STRING.to_string())),
        None => (&list[..], error),
    };
    let found = auth::names_other_account(
        prefix
            .iter()
            .filter_map(|e| Some((e.key.as_str(), e.value.as_deref()?))),
        &known,
    );
    match error {
        Some(error) if !found => Err(error),
        _ => Ok(found),
    }
}

/// Port of `pickSignIn` (`shared/extension-auth.ts:192`): `{ signIn, account }` or
/// `{ signIn, other: true }` or `{ signIn }`. Entries whose `[1]` is a string are kept; one of
/// those that cannot be destructured throws, and `known` is read only for a sign-in.
pub fn pick_sign_in(entries: Value, known: Value) -> Result<Value, String> {
    let mut kept = Vec::new();
    for item in iterate(&entries)? {
        if js_string(&second(&item)?).is_some() {
            let (key, value) = destructure(&item)?;
            kept.push(Entry::new(&key, value));
        }
    }
    let pairs = || kept.iter().map(|e| (e.key.as_str(), e.value.as_deref()));
    if auth::pick_sign_in(pairs(), &[]).is_none() {
        return Ok(undefined());
    }
    let known = known_of(&known)?;
    let Some(picked) = auth::pick_sign_in(pairs(), &known) else {
        return Ok(undefined());
    };
    let mut sign_in = Map::new();
    for (key, value) in picked.sign_in.iter() {
        // The caller's own value: the last entry for the key, as JS keeps the last one.
        let raw = kept
            .iter()
            .rev()
            .find(|e| e.key == *key && e.value.as_deref() == Some(value.as_str()))
            .map_or_else(|| Value::String(value.clone()), |e| e.raw.clone());
        sign_in.insert(key.clone(), raw);
    }
    let mut out = Map::new();
    out.insert("signIn".into(), Value::Object(sign_in));
    if let Some(account) = picked.account {
        out.insert("account".into(), Value::String(account));
    } else if picked.other {
        out.insert("other".into(), Value::Bool(true));
    }
    Ok(Value::Object(out))
}

/// Port of `sameSignIn` (`shared/extension-auth.ts:214`): relay-core compares records whose
/// values stand for the caller's by JS `===`. `key in b` throws on a string `b`.
pub fn same_sign_in(a: Value, b: Value) -> Result<bool, String> {
    let (a_entries, b_entries) = (object_entries(&a)?, object_entries(&b)?);
    if !a_entries.is_empty() && a_entries.len() == b_entries.len() && units(&b).is_some() {
        return Err("TypeError: Cannot use 'in' operator to search for a key in a string".into());
    }
    let mut unique = 0;
    let mut stand_in = |entries: &[(String, Value)]| -> SignIn {
        entries
            .iter()
            .map(|(k, v)| (k.clone(), strict_key(v, &mut unique)))
            .collect()
    };
    let (a, b) = (stand_in(&a_entries), stand_in(&b_entries));
    Ok(auth::same_sign_in(&a, &b))
}
