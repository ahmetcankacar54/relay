//! The Rust port of `shared/remote-notify.ts`, delegating to `relay_core::shared::remote_notify`.

#![forbid(unsafe_code)]

use relay_core::shared::remote_notify;
use relay_core::shared::types::RemoteNotifySettings;
use serde_json::{Map, Value};

/// JS `{ ...target, ...value }` into `target`; `undefined`, `null` and non-objects copy nothing.
fn spread(target: &mut Map<String, Value>, value: Option<&Value>) {
    if let Some(Value::Object(source)) = value.filter(|v| !crate::js::is_undefined(v)) {
        for (key, item) in source {
            target.insert(key.clone(), item.clone());
        }
    }
}

/// The settings as the TS object: `kind`, `events`, then `url` when saved.
fn to_js(settings: &RemoteNotifySettings) -> Result<Map<String, Value>, String> {
    let mut out = Map::new();
    out.insert(
        "kind".into(),
        serde_json::to_value(settings.kind).map_err(|e| e.to_string())?,
    );
    out.insert(
        "events".into(),
        serde_json::to_value(settings.events).map_err(|e| e.to_string())?,
    );
    if let Some(url) = &settings.url {
        out.insert("url".into(), Value::String(url.clone()));
    }
    Ok(out)
}

/// Port of `remoteNotifySettings` (`shared/remote-notify.ts:16`). The Rust function takes a
/// whole saved group or none; a partial one (which the Rust types cannot hold) is spread over the
/// Rust defaults here as the TS spreads it.
pub fn remote_notify_settings(settings: Value) -> Result<Value, String> {
    if settings.is_null() || crate::js::is_undefined(&settings) {
        let what = if settings.is_null() {
            "null"
        } else {
            "undefined"
        };
        return Err(format!(
            "TypeError: Cannot read properties of {what} (reading 'remoteNotify')"
        ));
    }
    let saved = settings.get("remoteNotify");
    if let Some(Ok(whole)) =
        saved.map(|v| serde_json::from_value::<RemoteNotifySettings>(v.clone()))
    {
        return to_js(&remote_notify::remote_notify_settings(Some(&whole))).map(Value::Object);
    }
    let mut out = to_js(&remote_notify::remote_notify_settings(None))?;
    let mut events = Map::new();
    spread(&mut events, out.get("events"));
    spread(&mut out, saved);
    spread(&mut events, saved.and_then(|s| s.get("events")));
    out.insert("events".into(), Value::Object(events));
    Ok(Value::Object(out))
}

/// Port of `remoteNotifyUrl` (`shared/remote-notify.ts:40`). The TS returns a WHATWG `URL`, which
/// has no own enumerable keys, so the recorder sees `{}`: a URL crosses as that empty object.
pub fn remote_notify_url(raw: Option<String>) -> Result<Value, String> {
    Ok(match remote_notify::remote_notify_url(raw.as_deref()) {
        Some(_) => Value::Object(Map::new()),
        None => crate::js::undefined(),
    })
}
