/** Continuing every conversation at the limit (the fleet), then the planner's window keeper. */
import { app, Notification } from "electron";
import path from "node:path";
import { PACE_WINDOW_MS } from "../../../shared/adaptive-plan";
import { automationMode, automationModeWrites } from "../../../shared/automation-mode";
import { planningIdentity } from "../../../shared/planning";
import { routineFailureNotice } from "../../../shared/routine-failure";
import type { NativeDesktopContinuationEvidence } from "../../core/desktop-continuation-evidence";
import { DesktopAutomationError } from "../../core/desktop-continuation-host";
import { FleetContinuation } from "../../core/fleet-continuation";
import { runQuotaStarter } from "../../core/routine-runner";
import { WindowKeeper } from "../../core/window-keeper";
import { getAppLocale, say } from "../../i18n";
import { makeContinueConversation } from "../continue-conversation";
import { desktopLock, pendingAuth, withDesktopLock } from "../desktop-lock";
import { logFleetEvent } from "../logs";
import { notifies, notifyAdapted, notifyFleet } from "../notifications";
import {
  automation,
  continuation,
  desktop,
  fleet,
  keeperAbort,
  observedDesktop,
  service,
  set,
  tempo,
  usage,
  usageHistory,
} from "../state";
import { broadcastChanged } from "../windows";
import type { UsageBoot } from "./usage";
export async function bootFleetKeeper(evidence: NativeDesktopContinuationEvidence, { currentTempoRate, readUsageCredential }: UsageBoot) {
      const continueConversation = makeContinueConversation(evidence);
      set.fleet(new FleetContinuation({
        directory: path.join(app.getPath("userData"), "fleet-continuation"),
        snapshot: () => ({
          accounts: service.store.state.accounts,
          settings: service.store.state.settings,
          usage: usage.snapshot(),
          tempoRate: currentTempoRate(),
        }),
        desktop: async () => ({
          ...(set.observedDesktop(await desktop.snapshot())),
          busy: desktop.isBusy || desktopLock.active,
        }),
        busy: () =>
          pendingAuth() ||
          continuation.snapshot().enabled ||
          continuation.snapshot().status === "executing" ||
          continuation.snapshot().status === "reconciliation-required",
        // A stop after the last reading: read again now, past the one-minute success cache.
        refreshUsage: (id) => usage.refreshAfterRequest(id),
        stops: (account) => evidence.quotaStops(account),
        quiet: (stops) => evidence.quietExcept(stops),
        quietSync: (stops) => evidence.quietExceptSync(stops),
        unchanged: (stop) => evidence.unchanged(stop),
        automationReady: async () => {
          if (process.platform !== "darwin") return "desktop-ui-unsupported";
          try {
            await automation.inspect();
            return undefined;
          } catch (error) {
            const issue =
              error instanceof DesktopAutomationError
                ? error.issue
                : "desktop-ui-unsupported";
            // Claude being closed is fine: the switch launches it.
            return issue === "claude-not-running" ? undefined : issue;
          }
        },
        switchTo: (targetId, guards) => desktop.switchTo(targetId, guards),
        continueOne: continueConversation,
        withDesktopLock,
        changed: broadcastChanged,
        log: logFleetEvent,
        quietDetail: () => evidence.quietDetail(),
        finished: notifyFleet,
        // What the stopped sessions left running (dev servers, builds), stopped at the switch.
        backgroundCommands: () => evidence.backgroundCommands(),
        stopBackground: (allowed) => evidence.stopBackground(allowed),
        answerQuitGuard: async () => {
          try {
            return (await automation.answerQuitGuard?.()) === true;
          } catch {
            return false;
          }
        },
      }));
      // Before the single choice both records could be saved on. The fleet wins,
      // as the mode reads; turning it off later must not leave prepare-on-quit on.
      const savedMode = automationModeWrites(
        automationMode(service.store.state.settings, fleet.snapshot()),
      ).autoSwitchMode;
      if (savedMode !== service.store.state.settings.autoSwitchMode)
        try {
          service.store.update((s) => {
            s.settings.autoSwitchMode = savedMode;
          });
        } catch {
          // A refused write keeps the pair; the fleet still wins while it is on.
        }
      set.observedDesktop(await desktop.snapshot());
      const keeperBlocked = () =>
        !observedDesktop ||
        desktopLock.active ||
        observedDesktop.busy ||
        observedDesktop.recoveryRequired ||
        !!observedDesktop.pendingProfileId ||
        pendingAuth() ||
        ["switching", "continuing"].includes(fleet.snapshot().status) ||
        continuation.snapshot().status === "executing";
      /** The last hour of raw usage: today's pace; none without the ledger. */
      const recentUsageSamples = () => {
        try {
          return usageHistory.recentSamples(Date.now() - PACE_WINDOW_MS);
        } catch {
          return [];
        }
      };
      set.keeper(new WindowKeeper({
        directory: path.join(app.getPath("userData"), "window-keeper"),
        state: () => ({
          settings: service.store.state.settings.planning,
          accounts: service.store.state.accounts,
          usage: usage.snapshot(),
          tempo: tempo.currentOrFallback(),
          blocked: keeperBlocked(),
          busyAccountIds: service.runner
            .list()
            .filter((run) => run.status === "running")
            .map((run) => run.accountId),
          recentSamples: recentUsageSamples(),
          activeId: observedDesktop?.activeProfileId,
        }),
        refresh: (id) => usage.refresh(id),
        refreshAfterStart: (id) => usage.refreshAfterRequest(id),
        start: async (account) => {
          set.observedDesktop(await desktop.snapshot());
          const identity = planningIdentity(account);
          await runQuotaStarter(service.store, account, readUsageCredential, {
            signal: keeperAbort.signal,
            guard: async () => {
              set.observedDesktop(await desktop.snapshot());
              return (
                service.store.state.settings.planning.autoStart &&
                !keeperBlocked() &&
                planningIdentity(service.store.account(account.id)) === identity
              );
            },
          });
        },
        notify: (account, reason) => {
          if (!Notification.isSupported() || !notifies("earlyStart")) return;
          new Notification({
            title: say("electronMain.earlyStartFailed"),
            body: routineFailureNotice(account.name, reason, getAppLocale()),
          }).show();
        },
        adapted: notifyAdapted,
        changed: broadcastChanged,
      }));
}
