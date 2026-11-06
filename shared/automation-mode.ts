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
  label: [tr: string, en: string];
  description: [tr: string, en: string];
}[] = [
  {
    value: "off",
    label: ["Kapalı", "Off"],
    description: [
      "Relay hesabı kendiliğinden değiştirmez.",
      "Relay does not switch accounts automatically.",
    ],
  },
  {
    value: "after-exit",
    label: ["Claude uygulaması kapanınca", "When the Claude app quits"],
    description: [
      "Limit dolunca, Claude uygulamasını kapattığında sıradaki hesabı hazırlar.",
      "At the limit, Relay prepares the next account when you quit the Claude app.",
    ],
  },
  {
    value: "quota",
    label: ["Limit dolunca", "When the limit is reached"],
    description: [
      "Limit dolunca Claude uygulamasını sıradaki hesapla açar ve duran konuşmaları sürdürür.",
      "At the limit, Relay opens the Claude app on the next account and continues stopped conversations.",
    ],
  },
];
