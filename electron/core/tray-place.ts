/**
 * Where the menu bar item sits on macOS. AppKit lays status items out right to left in the order
 * they were made, so an item without a saved place lands leftmost each time Relay starts. On a
 * crowded MacBook menu bar that is under the camera notch, where it cannot be seen (measured
 * 2026-10-26 on a 1800 pt wide screen: a new item at x 942–994, the notch about 810–990). Given a
 * stable id, AppKit keeps the item's place in Relay's defaults ("NSStatusItem Preferred Position
 * <id>") and keeps a place the user Cmd-drags it to; Relay writes a place right of the notch
 * once, before the item is first made.
 */

/** The menu bar item's id: AppKit's autosave name for it. Never change it, or its place is lost. */
export const TRAY_GUID = "4f5e2b1a-8c3d-4e7f-9a6b-2d1c0e3f5a7b";
/** Where Relay's item starts out: as far from the right edge as a few items, clear of the notch. */
export const TRAY_START_POSITION = 300;

/** The defaults AppKit keeps the place in, as Electron's systemPreferences reads and writes them. */
export interface TrayDefaults {
  getUserDefault(key: string, type: "float"): number;
  setUserDefault(key: string, type: "float", value: number): void;
}

/** Gives the item its first place unless it has one, from an earlier start or the user's drag. */
export function placeTray(defaults: TrayDefaults, id = TRAY_GUID): void {
  const key = `NSStatusItem Preferred Position ${id}`;
  try {
    const saved = defaults.getUserDefault(key, "float");
    if (Number.isFinite(saved) && saved > 0) return;
    defaults.setUserDefault(key, "float", TRAY_START_POSITION);
  } catch {
    // Unplaced, the item lands where AppKit puts a new one.
  }
}
