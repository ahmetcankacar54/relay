import { Button } from "@/components/ui/button";
import { useI18n, type T } from "@/data/i18n";
import { useRelay, type Relay } from "@/data/relay-context";
import type { DraftSummary } from "../../shared/types";
import { panelCard, panelEyebrow } from "./PanelActiveCard";

/** A draft Relay tried to type: it may be in its composer already. */
const MAYBE_TYPED = [
  "Konuşmaya yazılmış olabilir, yapıştırmadan önce bakın",
  "It may already be in the conversation; check before pasting",
] as const;
const BUSY = ["Konuşma meşguldü", "The conversation was busy"] as const;
const UNSUPPORTED = [
  "Desktop arayüzü desteklenmiyor",
  "Desktop's interface is not supported",
] as const;

const REASONS: Record<string, readonly [string, string]> = {
  accessibility: ["Erişilebilirlik izni yok", "Accessibility permission missing"],
  "composer-not-empty": ["Mesaj kutusu doluydu", "The message box was not empty"],
  "context-changed": ["Ekran değişti", "The screen changed"],
  changed: ["Ekran değişti", "The screen changed"],
  lost: ["Desktop taslağı sildi", "Desktop cleared the draft"],
  busy: BUSY,
  "desktop-work-active": BUSY,
  manual: ["Elle yapıştırın", "Paste it yourself"],
  error: ["Geri yazılamadı", "Could not be restored"],
  "maybe-typed": MAYBE_TYPED,
  unconfirmed: MAYBE_TYPED,
  "delivery-ambiguous": MAYBE_TYPED,
  "no-composer": ["Mesaj kutusu bulunamadı", "No message box was found"],
  unsupported: UNSUPPORTED,
  "desktop-ui-unsupported": UNSUPPORTED,
  "exact-session-not-observed": [
    "Konuşma açılamadı",
    "The conversation could not be opened",
  ],
  "not-ready": ["Desktop hazır değildi", "Desktop was not ready"],
  moved: ["Başka bir ekrana geçtiniz", "You went to another screen"],
  "claude-not-running": ["Claude çalışmıyordu", "Claude was not running"],
  budget: ["Süre doldu", "Ran out of time"],
};
const UNKNOWN_REASON = REASONS.error;

/** A new-session draft goes to Code's new-session screen, not a conversation. */
const NEW_SESSION_MAYBE_TYPED = [
  "Yeni oturum ekranına yazılmış olabilir, yapıştırmadan önce bakın",
  "It may already be on the new-session screen; check before pasting",
] as const;
const NEW_SESSION_BUSY = [
  "Yeni oturum ekranı meşguldü",
  "The new-session screen was busy",
] as const;
const NEW_SESSION_REASONS: Record<string, readonly [string, string]> = {
  "maybe-typed": NEW_SESSION_MAYBE_TYPED,
  unconfirmed: NEW_SESSION_MAYBE_TYPED,
  "delivery-ambiguous": NEW_SESSION_MAYBE_TYPED,
  busy: NEW_SESSION_BUSY,
  "desktop-work-active": NEW_SESSION_BUSY,
  "exact-session-not-observed": [
    "Yeni oturum ekranı açılamadı",
    "The new-session screen could not be opened",
  ],
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
  const known = (table: Record<string, readonly [string, string]>) =>
    reason !== undefined && Object.hasOwn(table, reason)
      ? table[reason]
      : undefined;
  const [tr, en] =
    (newSession ? known(NEW_SESSION_REASONS) : undefined) ??
    known(REASONS) ??
    UNKNOWN_REASON;
  return t(tr, en);
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
    ? t("Yeni oturum", "New session")
    : draft.title.trim() || t("Adsız konuşma", "Untitled conversation");
  const reason = draftReason(draft.reason, t, draft.newSession);
  const needsPermission = draft.reason === "accessibility";
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
          className="min-w-0 text-[10.5px] text-muted-foreground"
          title={reason}
        >
          {reason}
        </div>
        {draft.attachments && (
          <div className="text-[10.5px] text-muted-foreground">
            {t("Ekleri geri yüklenemedi", "Attachments could not be restored")}
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
            {t("İzin ver", "Allow")}
          </Button>
        )}
        <Button
          size="xs"
          variant="outline"
          disabled={running}
          onClick={() => void copyDraftAction(relay, draft.id)}
        >
          {t("Kopyala", "Copy")}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={running}
          onClick={() => void dismissDraftAction(relay, draft.id)}
        >
          {t("Kapat", "Dismiss")}
        </Button>
      </span>
    </div>
  );
}

/**
 * Drafts Relay rescued at a switch: the ones it could not re-type, with Copy and Dismiss, and a
 * count of those still waiting. It shows titles and reasons only, never draft text.
 */
export function PanelDrafts() {
  const relay = useRelay();
  const { t } = useI18n();
  const all = relay.data?.drafts ?? [];
  const waiting = all.filter((d) => d.state === "pending").length;
  const rows = all.filter((d) => d.state === "needs-copy");
  if (waiting === 0 && rows.length === 0) return null;
  return (
    <section className="px-3 py-1.5">
      <div className={panelEyebrow}>
        <span>{t("Kurtarılan taslaklar", "Rescued drafts")}</span>
      </div>
      {waiting > 0 && (
        <p
          className={`text-[11.5px] text-muted-foreground ${rows.length > 0 ? "mb-1.5" : ""}`}
        >
          {t(
            `${waiting} taslak geri yazılmayı bekliyor`,
            `${waiting} ${waiting === 1 ? "draft" : "drafts"} waiting to be restored`,
          )}
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
