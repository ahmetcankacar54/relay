//! The Rust port of `shared/statusline.ts`, delegating to `relay_core::shared::statusline`.
//!
//! `statuslineAccount` and `renderStatusline` take callbacks and stay in TypeScript here; the
//! data-only wrappers below (`original.ts`) record them with a fixed sign-in and paint, so the
//! Rust line is checked against the original's.

#![forbid(unsafe_code)]

use relay_core::shared::statusline::{
    self, StatuslineRender, StatuslineStyle, parse_statusline_input as parse_input,
};
use relay_core::shared::terminal_identity::TerminalIdentity;
use serde_json::Value;

/// Port of `parseStatuslineInput` (`shared/statusline.ts:76`).
pub fn parse_statusline_input(text: Option<String>) -> Result<serde_json::Value, String> {
    Ok(Value::Object(parse_input(text.as_deref()).0))
}

/// Port of `parseStatuslineSnapshot` (`shared/statusline.ts:89`). The TS returns the parsed
/// object itself once it passes; the Rust one its typed reading of it.
pub fn parse_statusline_snapshot(text: Option<String>) -> Result<serde_json::Value, String> {
    Ok(statusline::parse_statusline_snapshot(text.as_deref())
        .and_then(|_| serde_json::from_str(text.as_deref()?).ok())
        .unwrap_or_else(crate::js::undefined))
}

/// Port of `claudeSignIn` (`shared/statusline.ts:110`).
pub fn claude_sign_in(text: Option<String>) -> Result<serde_json::Value, String> {
    Ok(statusline::claude_sign_in(text.as_deref()).map_or_else(
        crate::js::undefined,
        |who| serde_json::json!({ "accountUuid": who.account_uuid, "orgId": who.org_id }),
    ))
}

/// `signIn()`'s value as `statuslineAccount` reads it: falsy is no sign-in; any other value is
/// one, which matches an account only with string `accountUuid` and `orgId` (a field missing in
/// JS is `undefined`, equal to no identity's string, so the sentinel below never matches).
fn identity(value: &Value) -> Option<TerminalIdentity> {
    let truthy = match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    };
    if !truthy {
        return None;
    }
    let field = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
    Some(match (field("accountUuid"), field("orgId")) {
        (Some(account_uuid), Some(org_id)) => TerminalIdentity {
            account_uuid,
            org_id,
        },
        _ => TerminalIdentity {
            account_uuid: "\u{0}undefined".into(),
            org_id: "\u{0}undefined".into(),
        },
    })
}

/// `renderStatuslineLine` (original.ts): `renderStatusline` with `signIn` returning `sign_in`
/// and a paint that tags each style (`<bold>…</bold>`) when `color` is set.
pub fn render_statusline_line(
    snapshot_text: String,
    input_text: String,
    config_dir: Option<String>,
    sign_in: Value,
    now: f64,
    color: bool,
) -> Result<String, String> {
    let Some(snapshot) = statusline::parse_statusline_snapshot(Some(&snapshot_text)) else {
        return Ok(String::new());
    };
    let input = parse_input(Some(&input_text));
    let who = identity(&sign_in);
    let paint = |style: StatuslineStyle, text: &str| {
        if !color {
            return text.to_string();
        }
        let name = match style {
            StatuslineStyle::Bold => "bold",
            StatuslineStyle::Dim => "dim",
            StatuslineStyle::Green => "green",
            StatuslineStyle::Yellow => "yellow",
            StatuslineStyle::Red => "red",
        };
        format!("<{name}>{text}</{name}>")
    };
    Ok(statusline::render_statusline(StatuslineRender {
        snapshot: &snapshot,
        input: &input,
        config_dir: config_dir.as_deref(),
        sign_in: Box::new(move || who),
        now,
        paint: &paint,
    }))
}

/// `statuslineAccountId` (original.ts): `statuslineAccount` with a fixed sign-in, as
/// `{ accountId?, viaGateway }`.
pub fn statusline_account_id(
    snapshot_text: String,
    input_text: String,
    config_dir: Option<String>,
    sign_in: Value,
) -> Result<Option<Value>, String> {
    let Some(snapshot) = statusline::parse_statusline_snapshot(Some(&snapshot_text)) else {
        return Ok(None);
    };
    let input = parse_input(Some(&input_text));
    let who = identity(&sign_in);
    let found = statusline::statusline_account(&snapshot, &input, config_dir.as_deref(), || who);
    let mut out = serde_json::Map::new();
    if let Some(account) = found.account {
        out.insert("accountId".into(), Value::from(account.id.as_str()));
    }
    out.insert("viaGateway".into(), Value::from(found.via_gateway));
    Ok(Some(Value::Object(out)))
}
