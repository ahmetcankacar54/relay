//! Port of `electron/core/widget-center.ts`: the hook that asks WidgetKit to reload Relay's
//! widgets. The native side (Electron's widget-center.node, the Swift `relay_reload_timelines`
//! linked into relay-app in Phase 5) is reached through `load`.

use std::path::Path;
use std::sync::Arc;

/// Reloads one widget kind's timelines, or every kind with `None`.
pub type ReloadTimelines = Arc<dyn Fn(Option<&str>) + Send + Sync>;

/// The native module's file in `dir`.
pub const WIDGET_CENTER_FILE: &str = "widget-center.node";

/// Loads the reload hook through `load`, which opens `<dir>/widget-center.node` and gives its
/// `reloadTimelines` (`Ok(None)` when the module has none). The call must come from Relay's own
/// process: chronod refuses it from a helper executable (ChronoCoreErrorDomain 10). `None` off
/// macOS and where the module is missing or cannot load; the widget then refreshes itself every
/// 15 minutes.
pub fn load_widget_center(
    dir: &Path,
    load: impl FnOnce(&Path) -> Result<Option<ReloadTimelines>, String>,
) -> Option<ReloadTimelines> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let error = match load(&dir.join(WIDGET_CENTER_FILE)) {
        Ok(Some(reload)) => return Some(reload),
        Ok(None) => "no reloadTimelines".to_string(),
        Err(error) => error,
    };
    eprintln!("Relay widget reloads are off; the widget refreshes itself. {error}");
    None
}
