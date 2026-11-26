//! Port of `electron/core/window-space.ts`: whether a window that is on screen is on the Space the
//! user is looking at, from the `window-space` native addon. The host loads the addon (`load`, the
//! TS `require`); without it a panel that macOS puts on no Space stays unseen until Relay
//! restarts, as before the addon.

use std::fmt::Display;
use std::path::Path;

use serde_json::Value;

/// Whether the window with this native handle is on the active Space; `None` when it cannot tell
/// (the window is not on screen, the handle is not a view).
pub type ActiveSpaceCheck = Box<dyn Fn(&[u8]) -> Option<bool> + Send + Sync>;

/// The addon's `onActiveSpace(handle)`; its answer is any JavaScript value.
pub type OnActiveSpace = Box<dyn Fn(&[u8]) -> Value + Send + Sync>;

/// The loaded addon's exports.
#[derive(Default)]
pub struct WindowSpaceAddon {
    pub on_active_space: Option<OnActiveSpace>,
}

/// Loads `window-space.node` from `dir`. `None` off macOS, and where the addon is missing, cannot
/// load or has no `onActiveSpace` (with a warning).
pub fn load_window_space<E: Display>(
    dir: &Path,
    load: impl FnOnce(&Path) -> Result<WindowSpaceAddon, E>,
) -> Option<ActiveSpaceCheck> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let check = match load(&dir.join("window-space.node")) {
        Ok(WindowSpaceAddon {
            on_active_space: Some(check),
        }) => check,
        Ok(_) => return warn("no onActiveSpace"),
        Err(error) => return warn(error),
    };
    Some(Box::new(move |handle| match check(handle) {
        Value::Bool(answer) => Some(answer),
        _ => None,
    }))
}

fn warn(error: impl Display) -> Option<ActiveSpaceCheck> {
    eprintln!("Relay cannot check which Space its menu bar panel is on. {error}");
    None
}
