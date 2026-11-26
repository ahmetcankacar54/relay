//! Port of `electron/core/tray-place.ts`: where the menu bar item sits on macOS. AppKit lays
//! status items out right to left in the order they were made, so an item without a saved place
//! lands leftmost each time Relay starts. On a crowded MacBook menu bar that is under the camera
//! notch, where it cannot be seen (measured 2026-10-26 on a 1800 pt wide screen: a new item at x
//! 942–994, the notch about 810–990). Given a stable id, AppKit keeps the item's place in Relay's
//! defaults ("NSStatusItem Preferred Position <id>") and keeps a place the user Cmd-drags it to;
//! Relay writes a place right of the notch once, before the item is first made.

/// The menu bar item's id: AppKit's autosave name for it. Never change it, or its place is lost.
pub const TRAY_GUID: &str = "4f5e2b1a-8c3d-4e7f-9a6b-2d1c0e3f5a7b";
/// Where Relay's item starts out: as far from the right edge as a few items, clear of the notch.
pub const TRAY_START_POSITION: f64 = 300.0;

/// The defaults AppKit keeps the place in, read and written as floats (`"float"` in Electron's
/// systemPreferences). A float never set reads 0.
pub trait TrayDefaults {
    type Error;
    fn get_user_default(&mut self, key: &str) -> Result<f64, Self::Error>;
    fn set_user_default(&mut self, key: &str, value: f64) -> Result<(), Self::Error>;
}

/// Gives the item its first place unless it has one, from an earlier start or the user's drag
/// (`id` is TRAY_GUID in the TS default).
pub fn place_tray(defaults: &mut impl TrayDefaults, id: &str) {
    let key = format!("NSStatusItem Preferred Position {id}");
    // Unplaced (the defaults failed), the item lands where AppKit puts a new one.
    let Ok(saved) = defaults.get_user_default(&key) else {
        return;
    };
    if saved.is_finite() && saved > 0.0 {
        return;
    }
    let _ = defaults.set_user_default(&key, TRAY_START_POSITION);
}
