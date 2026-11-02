// Kept free of React and browser-only imports so it can be unit tested under Node.
import type { RelayAPI } from "../../shared/types";
import {
  automationModeWrites,
  type AutomationMode,
} from "../../shared/automation-mode";

/**
 * Writes one automatic-switching choice to its two records, skipping the
 * ones already right. The record being turned on goes first, so a refused
 * first write changes nothing, and a moment with both on still reads as
 * "Kota dolunca" (the fleet wins). Turning the fleet on can be refused (for
 * example Keychain access was denied); prepare-on-quit then stays as it was.
 */
export async function applyAutomationMode(
  api: Pick<
    RelayAPI,
    "setFleetContinuation" | "updateSettings" | "disarmContinuation"
  >,
  mode: AutomationMode,
  current: {
    fleetEnabled: boolean;
    autoSwitchMode: "off" | "after-exit";
    /** The legacy single-conversation watch is armed. */
    legacyWatch: boolean;
  },
): Promise<void> {
  const writes = automationModeWrites(mode);
  // Main already disarms the legacy watch when the fleet turns on.
  if (current.legacyWatch && mode !== "quota") await api.disarmContinuation();
  const fleet = async () => {
    if (writes.fleet !== current.fleetEnabled)
      await api.setFleetContinuation(writes.fleet);
  };
  const prepare = async () => {
    if (writes.autoSwitchMode !== current.autoSwitchMode)
      await api.updateSettings({ autoSwitchMode: writes.autoSwitchMode });
  };
  // Only after-exit turns prepare-on-quit on; quota and off start with the fleet.
  const order = mode === "after-exit" ? [prepare, fleet] : [fleet, prepare];
  for (const write of order) await write();
}
