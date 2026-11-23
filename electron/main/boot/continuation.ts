/** Continuing a conversation at the limit, and the automatic switch that waits for it. */
import { app } from "electron";
import os from "node:os";
import path from "node:path";
import { AutoSwitchManager } from "../../core/auto-switch";
import { ContinuationEngine } from "../../core/continuation";
import { FileContinuationJournal } from "../../core/continuation-journal";
import { DesktopContinuationManager, FileDesktopContinuationPersistence } from "../../core/desktop-continuation";
import { NativeDesktopContinuationEvidence } from "../../core/desktop-continuation-evidence";
import { DesktopAutomationError, DesktopContinuationHost } from "../../core/desktop-continuation-host";
import { pendingAuth, withDesktopLock } from "../desktop-lock";
import { remoteAutoSwitched } from "../notifications";
import { automation, continuation, desktop, fleet, observedDesktop, service, set, usage } from "../state";
import { broadcastChanged } from "../windows";
import type { UsageBoot } from "./usage";
export function bootContinuation({ currentTempoRate }: UsageBoot): NativeDesktopContinuationEvidence {
      const evidence = new NativeDesktopContinuationEvidence({
        store: service.store,
        desktop,
        automation,
        claudeRoot: path.join(app.getPath("appData"), "Claude"),
        transcriptRoot: path.join(os.homedir(), ".claude"),
      });
      const continuationHost = new DesktopContinuationHost(
        automation,
        evidence,
      );
      set.continuation(new DesktopContinuationManager({
        capabilities: continuationHost.capabilities,
        engine: new ContinuationEngine(
          continuationHost,
          new FileContinuationJournal(
            path.join(app.getPath("userData"), "continuation-journal"),
          ),
        ),
        persistence: new FileDesktopContinuationPersistence(
          path.join(app.getPath("userData"), "continuation"),
        ),
        observe: async () => {
          if (process.platform !== "darwin")
            throw new DesktopAutomationError("desktop-ui-unsupported");
          const state = await continuationHost.readState();
          return {
            state,
            quotaStop: state.quotaStop,
            ownQuotaWakeup: state.ownQuotaWakeup,
          };
        },
        prepareQuotaStop: async (observation) => {
          const state = await continuationHost.cancelQuotaResume(
            observation.state.contextRevision,
          );
          return {
            state,
            quotaStop: state.quotaStop,
            ownQuotaWakeup: state.ownQuotaWakeup,
          };
        },
        snapshot: () => ({
          accounts: service.store.state.accounts,
          settings: service.store.state.settings,
          usage: usage.snapshot(),
          tempoRate: currentTempoRate(),
        }),
        withDesktopLock,
        pendingAuth: () => pendingAuth() || !!observedDesktop?.pendingProfileId,
        changed: broadcastChanged,
      }));
      set.autoSwitch(new AutoSwitchManager(service.store, desktop, usage, {
        withDesktopLock,
        tempoRate: currentTempoRate,
        // Continue at quota owns conversations stopped at quota while it or a
        // continuation is on; preparing waits for it, with its own reason.
        continuationOwns: () =>
          !!fleet?.enabled ||
          continuation.snapshot().enabled ||
          continuation.snapshot().status === "reconciliation-required" ||
          continuation.snapshot().reason === "continuation-state-unreadable",
        pendingAuth: () => pendingAuth(),
        changed: broadcastChanged,
        switched: remoteAutoSwitched,
      }));
      return evidence;
}
