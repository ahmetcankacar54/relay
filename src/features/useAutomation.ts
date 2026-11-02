import { useRelay } from "@/data/relay-context";
import {
  AUTOMATION_MODES,
  automationMode,
  type AutomationMode,
} from "../../shared/automation-mode";
import {
  automationStatus,
  type AutomationStatus,
  type AutomationTone,
} from "../../shared/automation-status";
import { applyAutomationMode } from "./automation-actions";

/** The status dot for each automation tone. */
export const AUTOMATION_DOT: Record<
  AutomationTone,
  "ok" | "warn" | "crit" | "off"
> = {
  ok: "ok",
  waiting: "warn",
  attention: "crit",
  off: "off",
};

/** The labels and description of one choice. */
export function automationModeCopy(mode: AutomationMode) {
  return AUTOMATION_MODES.find((m) => m.value === mode) ?? AUTOMATION_MODES[0];
}

/** The one automatic-switching choice, its status and how to change it. */
export function useAutomation(now?: number): {
  mode: AutomationMode;
  status: AutomationStatus;
  /** The choice cannot change right now. */
  locked: boolean;
  /** This platform can switch on its own. */
  supported: boolean;
  setMode(mode: AutomationMode): void;
} {
  const relay = useRelay();
  const { api, accounts, settings, data, desktop } = relay;
  const fleet = data?.fleet;
  const continuation = data?.continuation;
  const mode = automationMode(settings, fleet);
  const status = automationStatus({
    settings,
    fleet,
    autoSwitch: data?.autoSwitch,
    continuation,
    accounts,
    usage: data?.usage ?? {},
    desktop,
    now: now ?? Date.now(),
  });
  // A handoff in progress cannot be changed midway.
  const working =
    fleet?.status === "switching" || fleet?.status === "continuing";
  const platform = data?.diagnostics?.platform;
  return {
    mode,
    status,
    locked: !!relay.busy || !!desktop?.busy || working,
    supported: platform === "darwin" || platform === "preview",
    setMode(next) {
      void relay.action("automation", () =>
        applyAutomationMode(api, next, {
          fleetEnabled: !!fleet?.enabled,
          autoSwitchMode: settings.autoSwitchMode,
          // An interrupted handoff stays until it is resumed or cancelled.
          legacyWatch:
            !!continuation?.enabled &&
            continuation.status !== "reconciliation-required",
        }),
      );
    },
  };
}
