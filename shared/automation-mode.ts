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
      "Relay never switches accounts on its own.",
    ],
  },
  {
    value: "after-exit",
    label: ["Claude uygulaması kapanınca", "When the Claude app quits"],
    description: [
      "Kota dolunca, sen Claude uygulamasını kapattığında sıradaki hesabı hazırlar. Claude uygulamasını kendisi kapatmaz.",
      "When a quota runs out, prepares the next account once you quit the Claude app. Never quits the Claude app itself.",
    ],
  },
  {
    value: "quota",
    label: ["Kota dolunca", "At quota"],
    description: [
      "Kota dolunca, çalışan iş bitince Claude uygulamasını sıradaki hesapla yeniden açar ve kota yüzünden duran Code konuşmalarını devam ettirir.",
      "When a quota runs out and running work finishes, reopens the Claude app on the next account and continues the Code conversations that stopped at the limit.",
    ],
  },
];
