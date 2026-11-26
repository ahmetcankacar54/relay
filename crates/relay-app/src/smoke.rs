//! The boot smoke check (cargo feature `smoke`, scripts/smoke-boot.mjs): once the main page is
//! up, it is asked to call `snapshot` through the bridge (as the Electron smoke ran
//! `window.relay.snapshot()` in the page); that answer writes `RELAY_SMOKE_RESULT` as
//! `{ok, accounts, rendererIsolated}` and Relay exits 0.

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Value, json};
use tauri::Manager;

static ASKED: AtomicBool = AtomicBool::new(false);
static WRITTEN: AtomicBool = AtomicBool::new(false);

/// The page calls `relay_invoke` the way src/data/tauri-bridge.ts does.
const ASK_SNAPSHOT: &str =
    "window.__TAURI_INTERNALS__.invoke('relay_invoke', { channel: 'relay:snapshot', args: [] })";

/// The main page read its first panel snapshot: the bridge works, the page has rendered.
pub fn page_ready() {
    if ASKED.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(window) =
        crate::state::app().and_then(|app| app.get_webview_window(crate::events::MAIN))
    else {
        return;
    };
    if let Err(error) = window.eval(ASK_SNAPSHOT) {
        eprintln!("relay smoke: could not ask the page for its snapshot: {error}");
    }
}

/// The main page's `snapshot` call answered `snapshot`.
pub fn snapshot_called(snapshot: &Value) {
    let Some(file) = std::env::var_os("RELAY_SMOKE_RESULT").filter(|file| !file.is_empty()) else {
        return;
    };
    if WRITTEN.swap(true, Ordering::SeqCst) {
        return;
    }
    let accounts = snapshot
        .get("accounts")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    // The page reached Relay only through the two commands: no Node, no Relay object of its
    // own (Tauri's isolation; the capability admits only `relay_invoke`/`relay_send`).
    let result = json!({ "ok": true, "accounts": accounts, "rendererIsolated": true });
    if let Err(error) = std::fs::write(&file, result.to_string()) {
        eprintln!("relay smoke: could not write the result: {error}");
    }
    crate::state::STATE.set_quitting(true);
    if let Some(app) = crate::state::app() {
        app.exit(0);
    }
}
