//! The Rust port of `shared/i18n/translate.ts`, delegating the formatting to `relay_i18n`.
//!
//! `tFor` stays in TypeScript for rust-anything (it returns a function); `relay_i18n::translate`
//! is its port, checked by `crates/relay-i18n/tests/golden.rs`. The functions here keep the
//! module's catalog registry, which the Rust crate replaces with catalogs embedded at build time.
//! Locales and ids are strings and values are strings or numbers, as the TS types say.

#![forbid(unsafe_code)]

use std::sync::{LazyLock, Mutex};

use relay_i18n::{Args, Error, Locale, catalog, format_message_rich};
use serde_json::Value;

/// `catalogs`: the registered catalog per locale key, English from the start.
static CATALOGS: LazyLock<Mutex<Vec<(Value, Value)>>> =
    LazyLock::new(|| Mutex::new(vec![(Value::from("en"), embedded(Locale::En))]));

fn embedded(locale: Locale) -> Value {
    Value::Object(
        catalog(locale)
            .iter()
            .map(|(k, v)| (k.clone(), Value::from(v.as_str())))
            .collect(),
    )
}

/// `Map` key equality for the primitive keys the TS types allow (objects compare by identity, so
/// they never match).
fn same_key(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Object(_) | Value::Array(_), _) => false,
        _ => a == b,
    }
}

fn registered(locale: &Value, id: &str) -> Option<String> {
    let catalogs = CATALOGS.lock().unwrap_or_else(|e| e.into_inner());
    let (_, catalog) = catalogs.iter().find(|(key, _)| same_key(key, locale))?;
    catalog.get(id)?.as_str().map(str::to_string)
}

fn has(locale: &Value) -> bool {
    CATALOGS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .any(|(key, _)| same_key(key, locale))
}

/// Port of `registerCatalog` (`shared/i18n/translate.ts:16`).
pub fn register_catalog(locale: Value, catalog: Value) -> Result<Value, String> {
    let mut catalogs = CATALOGS.lock().unwrap_or_else(|e| e.into_inner());
    match catalogs.iter_mut().find(|(key, _)| same_key(key, &locale)) {
        Some(slot) => slot.1 = catalog,
        None => catalogs.push((locale, catalog)),
    }
    Ok(crate::js::undefined())
}

/// Port of `setPseudo` (`shared/i18n/translate.ts:22`): pseudo text applies to `tFor` only, which
/// the CLI never switches on, so the flag has no Rust counterpart.
pub fn set_pseudo(enabled: bool) -> Result<Value, String> {
    let _ = enabled;
    Ok(crate::js::undefined())
}

/// `format(locale, id, true).format(values)`: the registered text, else English, else the id;
/// a translation that does not parse is replaced by English in English conventions.
fn format_in(locale: &Value, id: &str, args: &Args) -> Result<String, Error> {
    let english = catalog(Locale::En).get(id).map_or(id, String::as_str);
    let source = registered(locale, id);
    let conventions = locale
        .as_str()
        .and_then(Locale::parse)
        .unwrap_or(Locale::En);
    match format_message_rich(source.as_deref().unwrap_or(english), conventions, args, &[]) {
        Err(Error::Syntax(_)) => format_message_rich(english, Locale::En, args, &[]),
        other => other,
    }
}

/// Port of `formatRich` (`shared/i18n/translate.ts:66`). JSON carries no functions, so every
/// `<tag>` fails as it does in TS without a renderer, and the English message stands in.
pub fn format_rich(locale: Value, id: Value, values: Value) -> Result<Vec<Value>, String> {
    let Some(id) = id.as_str() else {
        return Err("formatRich: the id must be a string".into());
    };
    let args = Args::from_json(&values);
    let text = format_in(&locale, id, &args)
        .or_else(|_| format_in(&Value::from("en"), id, &args))
        .map_err(|e| e.to_string())?;
    Ok(vec![Value::String(text)])
}

/// Port of `loadCatalog` (`shared/i18n/translate.ts:94`): registers the embedded catalog.
pub async fn load_catalog(locale: Value) -> Result<Value, String> {
    if has(&locale) || locale == "en" {
        return Ok(crate::js::undefined());
    }
    match locale.as_str().and_then(Locale::parse) {
        Some(known) => register_catalog(locale, embedded(known)),
        None => Err("LOADERS[locale] is not a function".into()),
    }
}
