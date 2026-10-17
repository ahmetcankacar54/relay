// Kept free of React and browser-only imports so it can be unit tested under Node.
import type { RelayAPI } from "../../shared/types";
import {
  automationModeWrites,
  type AutomationMode,
} from "../../shared/automation-mode";

/**
 * Writes one automatic-switching choice to its two records, skipping the
 * ones already right. The fleet goes first: when it is refused (for example
 * Keychain access was denied), prepare-on-quit stays as it was.
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
  if (writes.fleet !== current.fleetEnabled)
    await api.setFleetContinuation(writes.fleet);
  if (writes.autoSwitchMode !== current.autoSwitchMode)
    await api.updateSettings({ autoSwitchMode: writes.autoSwitchMode });
}
