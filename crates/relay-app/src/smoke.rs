//! The boot smoke check (cargo feature `smoke`, scripts/smoke-boot.mjs). Once the main page is
//! up, a script in it measures the page's isolation and then calls `snapshot` through the
//! bridge (as the Electron smoke ran `window.relay.snapshot()` in the page). That answer writes
//! `RELAY_SMOKE_RESULT` as `{ok, accounts, rendererIsolated}` and Relay exits 0.

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Value, json};
use tauri::Manager;

static ASKED: AtomicBool = AtomicBool::new(false);
static WRITTEN: AtomicBool = AtomicBool::new(false);

/// The key of the smoke's own `snapshot` argument; the page's calls carry none.
const MARK: &str = "relaySmokeIsolation";

/// Run in the main page. Isolated means: no `window.__TAURI__` global (`withGlobalTauri` off),
/// and Tauri refuses commands outside the capability. The probes have no effect even if
/// allowed: reading the app version and the clipboard. Then the bridge's `relay_invoke` asks
/// for `snapshot`, carrying what was measured.
const PROBE: &str = r#"(async () => {
  const internals = window.__TAURI_INTERNALS__;
  const refused = async (cmd, args) => {
    try {
      await internals.invoke(cmd, args);
      return false;
    } catch {
      return true;
    }
  };
  const checks = {
    noGlobalTauri: typeof window.__TAURI__ === "undefined",
    noNode: typeof window.require === "undefined" && typeof window.process === "undefined",
    appVersionRefused: await refused("plugin:app|version", {}),
    clipboardRefused: await refused("plugin:clipboard-manager|read_text", {}),
  };
  await internals.invoke("relay_invoke", {
    channel: "relay:snapshot",
    args: [{ relaySmokeIsolation: checks }],
  });
})()"#;

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
    if let Err(error) = window.eval(PROBE) {
        eprintln!("relay smoke: could not run the isolation probe in the page: {error}");
    }
}

/// The page is isolated when every check of `PROBE` held.
fn isolated(checks: &Value) -> bool {
    checks
        .as_object()
        .is_some_and(|checks| !checks.is_empty() && checks.values().all(|v| *v == json!(true)))
}

/// A `snapshot` call from the main page answered `snapshot`; the smoke's own call carries the
/// probe's checks as its argument.
pub fn snapshot_called(snapshot: &Value, argument: &Value) {
    let Some(checks) = argument.get(MARK) else {
        return;
    };
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
    let renderer_isolated = isolated(checks);
    if !renderer_isolated {
        eprintln!("relay smoke: the page is not isolated: {checks}");
    }
    let result = json!({
        "ok": true,
        "accounts": accounts,
        "rendererIsolated": renderer_isolated,
        "isolation": checks,
    });
    if let Err(error) = std::fs::write(&file, result.to_string()) {
        eprintln!("relay smoke: could not write the result: {error}");
    }
    crate::state::STATE.set_quitting(true);
    if let Some(app) = crate::state::app() {
        app.exit(0);
    }
}
