//! The Rust port of `shared/switch-scene.ts`, delegating to `relay_core::shared::switch_scene`.
//!
//! Only argument and result conversion lives here. `pickDisguise`, `switchScene`, `sceneLine`,
//! `sceneView` (they take functions) and the `SwitchStory` class stay in TypeScript here; their
//! ports are checked by the ported unit tests (crates/relay-core/tests/switch_scene.rs).

#![forbid(unsafe_code)]

mod args;

use relay_core::shared::switch_scene::{self as scene, SwitchSceneState, SwitchWindowState};
use serde::Deserialize;

use args::{arg, opt_arg};

/// The part of a view `switchWindowVisible` reads.
#[derive(Deserialize)]
struct View {
    #[serde(default)]
    visible: Option<bool>,
}

/// Port of `sceneDeadline` (`shared/switch-scene.ts:52`).
pub fn scene_deadline(state: serde_json::Value) -> Result<Option<f64>, String> {
    let state: SwitchSceneState = arg(state)?;
    Ok(scene::scene_deadline(&state))
}

/// Port of `switchWindowVisible` (`shared/switch-scene.ts:202`).
pub fn switch_window_visible(
    view: Option<serde_json::Value>,
    window: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let view: Option<View> = opt_arg(view)?;
    let window: SwitchWindowState = arg(window)?;
    Ok(serde_json::Value::Bool(scene::switch_window_visible(
        view.and_then(|v| v.visible),
        window,
    )))
}
