//! The push channels to Relay's pages (Electron's `webContents.send`): each payload is the JSON
//! array of the old send's arguments, emitted to one webview label, which the UI bridge
//! (src/data/tauri-bridge.ts) listens on.

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{Emitter, EventTarget};

use crate::state::app;

pub const MAIN: &str = "main";
pub const PANEL: &str = "panel";
pub const SWITCH: &str = "switch";

/// Sends `args` on `channel` to the webview `label` (none listening: nothing happens). Without
/// a running app (tests) nothing is sent.
pub fn emit(label: &str, channel: &str, args: Vec<Value>) {
    let Some(app) = app() else { return };
    let _ = app.emit_to(EventTarget::webview(label), channel, Value::Array(args));
}

fn to_value(value: impl Serialize) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// Tells every Relay renderer (main window and menu bar panel) that state changed.
pub fn changed() {
    emit(MAIN, "relay:changed", Vec::new());
    emit(PANEL, "relay:changed", Vec::new());
}

/// The main window goes to `target` (a page of src/app/routes.ts) with an optional intent.
pub fn navigate(target: &str, want: Option<&str>) {
    let want = want.map_or(Value::Null, |want| json!(want));
    emit(MAIN, "relay:navigate", vec![json!(target), want]);
}

/// A widget's switch link: the main window asks for its switch review.
pub fn switch_request() {
    emit(MAIN, "relay:switch-request", Vec::new());
}

/// A terminal's output, exit or state (`TerminalEvent`), to the main window.
pub fn terminal(event: impl Serialize) {
    emit(MAIN, "relay:terminal", vec![to_value(event)]);
}

/// A sign-in flow's progress (`AuthFlow`), to the main window.
pub fn auth(flow: impl Serialize) {
    emit(MAIN, "relay:auth", vec![to_value(flow)]);
}

/// The menu bar panel was shown or hidden.
pub fn panel_visibility(shown: bool) {
    emit(PANEL, "relay:panel-visibility", vec![json!(shown)]);
}

/// The switch window's next scene (`SwitchSceneView`).
pub fn switch_scene(view: impl Serialize) {
    emit(SWITCH, "relay:switch-scene", vec![to_value(view)]);
}
