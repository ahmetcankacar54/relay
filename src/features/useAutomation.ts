import { useRelay } from "@/data/relay-context";
import {
  automationMode,
  type AutomationMode,
} from "../../shared/automation-mode";
import {
  automationStatus,
  type AutomationStatus,
} from "../../shared/automation-status";
import { applyAutomationMode } from "./automation-actions";

/** The one automatic-switching choice, its status and its two actions. */
export function useAutomation(now?: number): {
  mode: AutomationMode;
  status: AutomationStatus;
  /** The choice cannot change right now. */
  locked: boolean;
  /** This platform can switch on its own. */
  supported: boolean;
  setMode(mode: AutomationMode): void;
  switchNow(): void;
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
    switchNow() {
      const target = accounts.find((a) => a.id === status.switchTo);
      if (target) relay.requestDesktop(target, "switch");
    },
  };
}
