//! The Rust port of `shared/tray.ts`, delegating to `relay_core::shared::tray`.
//!
//! Only argument and result conversion lives here: the JSON the bindings carry becomes the
//! relay-core types, and their results become what the TS returns. The TS defaults are filled in:
//! a missing `language` is `"en"`, a missing `now` is `Date.now()` (read from the pinned clock
//! while rust-anything records and diffs), a missing `max` is `TRAY_NAME_MAX` and a missing `name`
//! is `"Max"`.

#![forbid(unsafe_code)]

mod args;
mod pinned;

use relay_core::shared::tray::{self, TRAY_NAME_MAX, TraySnapshot};
use relay_core::shared::types::{AccountUsage, Locale, MenuBarItem};
use serde::Serialize;
use serde_json::Value;

use args::{arg, opt_arg, plain};

fn out(value: impl Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

/// `now = Date.now()`.
fn now_or_clock(now: Option<Value>) -> Result<f64, String> {
    match now.and_then(plain) {
        None => Ok(pinned::now_ms()),
        Some(n) => crate::js::as_number(&n).ok_or_else(|| format!("TypeError: now is {n}")),
    }
}

/// `language = "en"`.
fn language(language: Option<Value>) -> Result<Locale, String> {
    match language.and_then(plain) {
        None => Ok(Locale::En),
        Some(Value::String(text)) => {
            Locale::parse(&text).ok_or_else(|| format!("RangeError: unknown language {text}"))
        }
        Some(other) => Err(format!("TypeError: language is {other}")),
    }
}

fn string(text: String) -> Value {
    Value::String(text)
}

/// A `TraySnapshot`. An account cast from a partial object (`{ id, name } as Account`, as
/// `menuBarPreview` builds one) gets empty values for the fields the tray never reads.
fn snapshot_arg(value: Value) -> Result<TraySnapshot, String> {
    let mut value = value;
    if let Some(accounts) = value.get_mut("accounts").and_then(Value::as_array_mut) {
        for account in accounts.iter_mut().filter_map(Value::as_object_mut) {
            account
                .entry("kind")
                .or_insert_with(|| Value::from("personal"));
            for key in ["group", "color", "createdAt"] {
                account.entry(key).or_insert_with(|| Value::from(""));
            }
        }
    }
    arg(value)
}

/// Port of `trayAccountName` (`shared/tray.ts:83`).
pub fn tray_account_name(name: String) -> Result<serde_json::Value, String> {
    Ok(string(tray::tray_account_name(&name)))
}

/// Port of `trayUsageLabel` (`shared/tray.ts:99`).
pub fn tray_usage_label(
    account_id: String,
    usage: Option<serde_json::Value>,
    language_value: Option<serde_json::Value>,
    now: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let usage: Option<AccountUsage> = opt_arg(usage)?;
    Ok(string(tray::tray_usage_label(
        &account_id,
        usage.as_ref(),
        language(language_value)?,
        now_or_clock(now)?,
    )))
}

/// Port of `canRequestTraySwitch` (`shared/tray.ts:140`).
pub fn can_request_tray_switch(
    snapshot: serde_json::Value,
    profile_id: String,
) -> Result<serde_json::Value, String> {
    let snapshot = snapshot_arg(snapshot)?;
    Ok(Value::Bool(tray::can_request_tray_switch(
        &snapshot,
        &profile_id,
    )))
}

/// Port of `unavailableTrayMenu` (`shared/tray.ts:158`).
pub fn unavailable_tray_menu(
    language_value: Option<serde_json::Value>,
) -> Result<Vec<serde_json::Value>, String> {
    tray::unavailable_tray_menu(language(language_value)?)
        .iter()
        .map(out)
        .collect()
}

/// Port of `buildTrayMenu` (`shared/tray.ts:172`).
pub fn build_tray_menu(
    snapshot: serde_json::Value,
    language_value: Option<serde_json::Value>,
    now: Option<serde_json::Value>,
) -> Result<Vec<serde_json::Value>, String> {
    let snapshot = snapshot_arg(snapshot)?;
    tray::build_tray_menu(&snapshot, language(language_value)?, now_or_clock(now)?)
        .iter()
        .map(out)
        .collect()
}

fn item_names(items: &[MenuBarItem]) -> Vec<String> {
    items.iter().map(|i| i.as_str().to_string()).collect()
}

/// Port of `menuBarItems` (`shared/tray.ts:253`).
pub fn menu_bar_items(value: serde_json::Value) -> Result<Vec<String>, String> {
    let value = plain(value);
    Ok(item_names(&tray::menu_bar_items(value.as_ref())))
}

/// Port of `trayTokens` (`shared/tray.ts:323`).
pub fn tray_tokens(
    tokens: f64,
    language_value: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    Ok(string(tray::tray_tokens(tokens, language(language_value)?)))
}

/// Port of `trayCost` (`shared/tray.ts:336`).
pub fn tray_cost(
    cost: f64,
    language_value: Option<serde_json::Value>,
    estimated: Option<bool>,
) -> Result<serde_json::Value, String> {
    Ok(string(tray::tray_cost(
        cost,
        language(language_value)?,
        estimated.unwrap_or(false),
    )))
}

/// Port of `trayShortName` (`shared/tray.ts:378`).
pub fn tray_short_name(
    name: String,
    max: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let max = match max.and_then(plain) {
        None => TRAY_NAME_MAX,
        Some(n) => match crate::js::as_number(&n) {
            Some(n) if n >= 0.0 && n.fract() == 0.0 => n as usize,
            _ => return Err(format!("TypeError: max is {n}")),
        },
    };
    Ok(string(tray::tray_short_name(&name, max)))
}

/// Port of `trayResetClock` (`shared/tray.ts:387`).
pub fn tray_reset_clock(
    resets_at: Option<String>,
    now: f64,
    language_value: Option<serde_json::Value>,
    time_zone: Option<String>,
) -> Result<Option<String>, String> {
    Ok(tray::tray_reset_clock(
        resets_at.as_deref(),
        now,
        language(language_value)?,
        time_zone.as_deref(),
    ))
}

/// Port of `trayCountdown` (`shared/tray.ts:422`).
pub fn tray_countdown(resets_at: Option<String>, now: f64) -> Result<serde_json::Value, String> {
    Ok(tray::tray_countdown(resets_at.as_deref(), now).map_or_else(crate::js::undefined, string))
}

/// Port of `trayTooltip` (`shared/tray.ts:443`).
pub fn tray_tooltip(
    snapshot: serde_json::Value,
    language_value: Option<serde_json::Value>,
    now: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let snapshot = snapshot_arg(snapshot)?;
    Ok(string(tray::tray_tooltip(
        &snapshot,
        language(language_value)?,
        now_or_clock(now)?,
    )))
}

/// Port of `trayTitle` (`shared/tray.ts:515`).
pub fn tray_title(
    snapshot: serde_json::Value,
    now: Option<serde_json::Value>,
    language_value: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let snapshot = snapshot_arg(snapshot)?;
    Ok(string(tray::tray_title(
        &snapshot,
        now_or_clock(now)?,
        language(language_value)?,
    )))
}

/// Port of `menuBarPreview` (`shared/tray.ts:583`).
pub fn menu_bar_preview(
    items: Vec<String>,
    language_value: Option<serde_json::Value>,
    name: Option<String>,
    now: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let items: Vec<MenuBarItem> = arg(Value::from(items))?;
    Ok(string(tray::menu_bar_preview(
        &items,
        language(language_value)?,
        name.as_deref().unwrap_or("Max"),
        now_or_clock(now)?,
    )))
}
