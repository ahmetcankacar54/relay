import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useI18n, type MessageId, type T } from "@/data/i18n";
import { useRelay, type Relay } from "@/data/relay-context";
import type { DraftSummary } from "../../shared/types";
import { panelCard, panelEyebrow } from "./PanelActiveCard";

/** A draft Relay tried to type: it may be in its composer already. */
const MAYBE_TYPED: MessageId = "panelDrafts.possiblyInTheConversationAlreadyCheck";
const BUSY: MessageId = "panelDrafts.theConversationWasBusy";
const UNSUPPORTED: MessageId = "panelDrafts.theClaudeAppsInterfaceIsNot";

const REASONS: Record<string, MessageId> = {
  accessibility: "panelDrafts.accessibilityPermissionMissing",
  "composer-not-empty": "panelDrafts.theMessageBoxAlreadyHadText",
  "context-changed": "panelDrafts.theScreenChanged",
  changed: "panelDrafts.theScreenChanged",
  lost: "panelDrafts.theClaudeAppClearedTheDraft",
  busy: BUSY,
  "desktop-work-active": BUSY,
  manual: "panelDrafts.pasteItYourself",
  error: "panelDrafts.restoreFailed",
  "maybe-typed": MAYBE_TYPED,
  unconfirmed: MAYBE_TYPED,
  "delivery-ambiguous": MAYBE_TYPED,
  "no-composer": "panelDrafts.theMessageBoxDidNotLoad",
  loading: "panelDrafts.theClaudeAppWasNotLoaded",
  unsupported: UNSUPPORTED,
  "desktop-ui-unsupported": UNSUPPORTED,
  "exact-session-not-observed": "panelDrafts.theConversationDidNotOpen",
  "not-ready": "panelDrafts.theClaudeAppWasNotReady",
  moved: "panelDrafts.youWentToAnotherScreen",
  "claude-not-running": "panelDrafts.theClaudeAppWasNotRunning",
  budget: "panelDrafts.timeRanOut",
  "not-opened": "panelDrafts.youDidNotOpenTheConversation",
};
const UNKNOWN_REASON = REASONS.error;

/** A new-session draft goes to Code's new-session screen, not a conversation. */
const NEW_SESSION_MAYBE_TYPED: MessageId = "panelDrafts.possiblyOnTheNewSessionScreen";
const NEW_SESSION_BUSY: MessageId = "panelDrafts.theNewSessionScreenWasBusy";
const NEW_SESSION_REASONS: Record<string, MessageId> = {
  "maybe-typed": NEW_SESSION_MAYBE_TYPED,
  unconfirmed: NEW_SESSION_MAYBE_TYPED,
  "delivery-ambiguous": NEW_SESSION_MAYBE_TYPED,
  busy: NEW_SESSION_BUSY,
  "desktop-work-active": NEW_SESSION_BUSY,
  "exact-session-not-observed": "panelDrafts.theNewSessionScreenDidNot",
  "not-opened": "panelDrafts.youDidNotOpenTheNew",
};

/**
 * Why a draft is waiting for the user, worded for the new-session screen when it is that
 * screen's draft; a missing or unknown reason reads as a failed restore.
 */
export function draftReason(
  reason: string | undefined,
  t: T,
  newSession = false,
): string {
  const known = (table: Record<string, MessageId>) =>
    reason !== undefined && Object.hasOwn(table, reason)
      ? table[reason]
      : undefined;
  return t(
    (newSession ? known(NEW_SESSION_REASONS) : undefined) ??
      known(REASONS) ??
      UNKNOWN_REASON,
  );
}

export const copyDraftAction = (relay: Relay, id: string) =>
  relay.action(`draft-copy:${id}`, () => relay.api.copyDraft(id));

export const dismissDraftAction = (relay: Relay, id: string) =>
  relay.action(`draft-dismiss:${id}`, () => relay.api.dismissDraft(id));

export const allowAccessibilityAction = (relay: Relay) =>
  relay.action("draft-accessibility", () =>
    relay.api.requestDesktopAccessibility(),
  );

function DraftRow({ draft }: { draft: DraftSummary }) {
  const relay = useRelay();
  const { t } = useI18n();
  const name = draft.newSession
    ? t("panelDrafts.newSession")
    : draft.title.trim() || t("panelDrafts.untitledConversation");
  // A draft still waiting can be copied, and stays: Relay types it into an empty composer.
  const waiting = draft.state === "pending";
  const reason = waiting
    ? draft.newSession
      ? t("panelDrafts.waitingTypedBackWhenYouOpen")
      : t("panelDrafts.waitingTypedBackWhenYouOpen2")
    : draftReason(draft.reason, t, draft.newSession);
  // Only re-typing needs the permission: with it off, nothing here asks for it.
  const needsPermission =
    !waiting && relay.settings.draftRetype === true && draft.reason === "accessibility";
  const running = [
    `draft-copy:${draft.id}`,
    `draft-dismiss:${draft.id}`,
    ...(needsPermission ? ["draft-accessibility"] : []),
  ].includes(relay.busy);
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-2 border-t px-1 py-1.5 first:border-0">
      <div className="min-w-0">
        <div className="min-w-0 truncate font-semibold" title={name}>
          {name}
        </div>
        <div
          className="min-w-0 text-xs text-muted-foreground"
          title={reason}
        >
          {reason}
        </div>
        {draft.attachments && (
          <div className="text-xs text-muted-foreground">
            {t("panelDrafts.attachmentsNotRestored")}
          </div>
        )}
      </div>
      <span className="flex shrink-0 gap-1">
        {needsPermission && (
          <Button
            size="xs"
            disabled={running}
            onClick={() => void allowAccessibilityAction(relay)}
          >
            {t("panelDrafts.allow")}
          </Button>
        )}
        <Button
          size="xs"
          variant="outline"
          disabled={running}
          onClick={() => void copyDraftAction(relay, draft.id)}
        >
          {t("common.copy")}
        </Button>
        {!waiting && (
          <Button
            size="xs"
            variant="ghost"
            disabled={running}
            onClick={() => void dismissDraftAction(relay, draft.id)}
          >
            {t("common.dismiss")}
          </Button>
        )}
      </span>
    </div>
  );
}

/**
 * Drafts Relay rescued at a switch: those still waiting to be typed back, with Copy, and the
 * ones it could not re-type (or with re-typing off all of them), with Copy and Dismiss. It shows
 * titles and reasons only, never draft text. With re-typing on, the heading says it is
 * experimental.
 */
export function PanelDrafts() {
  const relay = useRelay();
  const { t } = useI18n();
  const all = relay.data?.drafts ?? [];
  const waitingRows = all.filter((d) => d.state === "pending");
  const waiting = waitingRows.length;
  const rows = [...waitingRows, ...all.filter((d) => d.state === "needs-copy")];
  const left = rows.length - waiting;
  if (waiting === 0 && rows.length === 0) return null;
  return (
    <section className="px-3 py-1.5">
      <div className={panelEyebrow}>
        <span className="flex items-center gap-1.5">
          {t("common.rescuedDrafts")}
          {relay.settings.draftRetype === true && (
            <Badge
              variant="outline"
              className="px-1.5 text-xs text-muted-foreground"
            >
              {t("panelDrafts.experimental")}
            </Badge>
          )}
        </span>
      </div>
      {waiting > 0 && (
        <p
          className="mb-1.5 text-xs text-muted-foreground"
        >
          {t("panelDrafts.draftsWaitToBeRestored", { waiting })}
        </p>
      )}
      {left > 0 && (
        <p className="mb-1.5 text-xs text-muted-foreground">
          {t("panelDrafts.relayDidNotTypeTheseDrafts")}
        </p>
      )}
      {rows.length > 0 && (
        <div className={`${panelCard} px-2 py-1`}>
          {rows.map((draft) => (
            <DraftRow key={draft.id} draft={draft} />
          ))}
        </div>
      )}
    </section>
  );
}
