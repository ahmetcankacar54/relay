/** The fleet's one conversation: reopened on the new account, checked, and sent the continuation once. */
import type { Account } from "../../shared/types";
import { CONTINUATION_TEXT } from "../core/continuation";
import type { NativeDesktopContinuationEvidence, QuotaStop } from "../core/desktop-continuation-evidence";
import { automationGuard, DesktopAutomationError } from "../core/desktop-continuation-host";
import type { FleetResult } from "../core/fleet-continuation";
import { waitForConversation } from "../core/fleet-show";
import { claudePageBooted, logFleetEvent } from "./logs";
import { automation } from "./state";
export function makeContinueConversation(evidence: NativeDesktopContinuationEvidence) {
      /** Reopen one stopped conversation on the target, verify it and send once. */
      const continueConversation = async (
        stop: QuotaStop,
        target: Account,
        requestId: string,
        beforeSend: () => void,
      ): Promise<FleetResult> => {
        const sleep = (ms: number) =>
          new Promise<void>((resolve) => setTimeout(resolve, ms));
        const conversation = stop.localSessionId
          .replace(/^local_/, "")
          .slice(0, 8);
        /** Leaves the conversation as it is, and says why in the fleet's log. */
        const skip = (why: string, fields: Record<string, unknown> = {}) => {
          logFleetEvent("continue-skip", { conversation, why, ...fields });
          return "skipped" as const;
        };
        const shown = await waitForConversation(stop.localSessionId, {
          inspect: () => automation.inspect(),
          open: (id) => automation.openSession(id),
          booted: claudePageBooted,
          unchanged: () => evidence.unchanged(stop),
          now: Date.now,
          sleep,
        });
        if (!("shown" in shown))
          return skip(shown.skipped, {
            shown: shown.last?.localSessionId === stop.localSessionId,
            permissionMode: !!shown.last?.permissionMode,
            screen: shown.last?.screen ?? null,
            panes: shown.last?.panes ?? null,
            opened: shown.opened,
            issue: shown.issue ?? null,
          });
        let snapshot = shown.shown;
        const state = await evidence.read(snapshot);
        if (state.identity.profileId !== target.id) return skip("account");
        if (state.session.id !== stop.cliSessionId) return skip("session");
        if (snapshot.status !== "stopped")
          return skip("status", { status: snapshot.status });
        if (!evidence.unchanged(stop)) return skip("moved-on");
        if (
          stop.permissionMode &&
          snapshot.permissionMode !== stop.permissionMode
        ) {
          snapshot = await automation.setPermission(
            automationGuard(snapshot),
            stop.permissionMode,
          );
          if (snapshot.permissionMode !== stop.permissionMode)
            return skip("permission-mode");
        }
        // Claude's own "continue when limits reset" would send a second prompt.
        if (snapshot.quotaAutoResume && automation.cancelQuotaResume)
          try {
            snapshot = await automation.cancelQuotaResume(
              automationGuard(snapshot),
            );
          } catch {
            // The banner may be gone on the new account; nothing to cancel.
          }
        if (snapshot.status !== "stopped")
          return skip("status", { status: snapshot.status });
        if (!snapshot.composerEmpty)
          return skip("composer-not-empty", {
            composerChars: snapshot.composerChars ?? null,
          });
        const before = await evidence.deliveryAfter(stop, requestId);
        if (before !== "absent") {
          logFleetEvent("continue-unsent", { conversation, delivery: before });
          return "unknown";
        }
        beforeSend();
        try {
          const sent = await automation.send(
            automationGuard(snapshot),
            requestId,
            CONTINUATION_TEXT,
          );
          // Send was pressed: how the text went in and what the screen showed next.
          logFleetEvent("continue-sent", {
            conversation,
            acceptedVisible: sent.acceptedVisible,
            written: sent.written ?? null,
            submitted: sent.submitted ?? null,
            ...(sent.after ?? {}),
          });
        } catch (error) {
          // Past the guard a failed send may have typed or sent: never sent again, but said why.
          logFleetEvent("continue-send-failed", {
            conversation,
            issue:
              error instanceof DesktopAutomationError ? error.issue : "failed",
            step:
              error instanceof DesktopAutomationError
                ? (error.step ?? "guard")
                : null,
          });
          throw error;
        }
        // The transcript, not the screen, says whether the turn arrived.
        const delivered = <T extends string>(delivery: T, polls: number) => {
          logFleetEvent("continue-delivery", { conversation, delivery, polls });
          return delivery;
        };
        for (let attempt = 0; attempt < 110; attempt++) {
          const delivery = await evidence.deliveryAfter(stop, requestId);
          if (delivery === "started" || delivery === "unknown")
            return delivered(delivery, attempt + 1);
          await sleep(attempt < 10 ? 500 : 2_000);
        }
        const final = await evidence.deliveryAfter(stop, requestId);
        delivered(final, 111);
        return final === "started" || final === "accepted" ? final : "unknown";
      };
      return continueConversation;
}
