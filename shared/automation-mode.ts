import type { MessageId } from "./i18n/translate";
import type { FleetContinuationState, RelaySettings } from "./types";

/**
 * The one automatic-switching choice. It sits on two records: the fleet
 * ("Continue at quota") and `settings.autoSwitchMode` (prepare on quit).
 */
export type AutomationMode = "off" | "after-exit" | "quota";

/** The fleet wins: the two records are never both on in a saved choice. */
export function automationMode(
  settings: Pick<RelaySettings, "autoSwitchMode">,
  fleet?: Pick<FleetContinuationState, "enabled">,
): AutomationMode {
  if (fleet?.enabled) return "quota";
  return settings.autoSwitchMode === "after-exit" ? "after-exit" : "off";
}

/** Both records a mode writes, so choosing one always turns the other off. */
export function automationModeWrites(mode: AutomationMode): {
  fleet: boolean;
  autoSwitchMode: "off" | "after-exit";
} {
  switch (mode) {
    case "quota":
      return { fleet: true, autoSwitchMode: "off" };
    case "after-exit":
      return { fleet: false, autoSwitchMode: "after-exit" };
    case "off":
      return { fleet: false, autoSwitchMode: "off" };
  }
}

export const AUTOMATION_MODES: {
  value: AutomationMode;
  label: MessageId;
  description: MessageId;
}[] = [
  {
    value: "off",
    label: "common.off",
    description: "automationMode.relayDoesNotSwitchAccounts",
  },
  {
    value: "after-exit",
    label: "automationMode.whenTheClaudeAppQuits",
    description: "automationMode.atTheLimitPreparesThe",
  },
  {
    value: "quota",
    label: "automationMode.whenTheLimitIsReached",
    description: "automationMode.opensTheNextAccountAnd",
  },
];
