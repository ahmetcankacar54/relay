import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useI18n, type T } from "@/data/i18n";
import { useRelay, type Relay } from "@/data/relay-context";
import type { DraftSummary } from "../../shared/types";
import { panelCard, panelEyebrow } from "./PanelActiveCard";

/** A draft Relay tried to type: it may be in its composer already. */
const MAYBE_TYPED = [
  "Konuşmaya yazılmış olabilir, yapıştırmadan önce bak",
  "Possibly in the conversation already; check before you paste",
] as const;
const BUSY = ["Konuşma meşguldü", "The conversation was busy"] as const;
const UNSUPPORTED = [
  "Claude uygulamasının arayüzü desteklenmiyor",
  "The Claude app’s interface is not supported",
] as const;

const REASONS: Record<string, readonly [string, string]> = {
  accessibility: ["Erişilebilirlik izni yok", "Accessibility permission missing"],
  "composer-not-empty": ["Mesaj kutusunda zaten yazı vardı", "The message box already had text"],
  "context-changed": ["Ekran değişti", "The screen changed"],
  changed: ["Ekran değişti", "The screen changed"],
  lost: ["Claude uygulaması taslağı sildi", "The Claude app cleared the draft"],
  busy: BUSY,
  "desktop-work-active": BUSY,
  manual: ["Elle yapıştır", "Paste it yourself"],
  error: ["Geri yazılamadı", "Restore failed"],
  "maybe-typed": MAYBE_TYPED,
  unconfirmed: MAYBE_TYPED,
  "delivery-ambiguous": MAYBE_TYPED,
  "no-composer": ["Mesaj kutusu yüklenmedi", "The message box did not load"],
  loading: ["Claude uygulaması henüz yüklenmemişti", "The Claude app was not loaded yet"],
  unsupported: UNSUPPORTED,
  "desktop-ui-unsupported": UNSUPPORTED,
  "exact-session-not-observed": [
    "Konuşma açılamadı",
    "The conversation did not open",
  ],
  "not-ready": ["Claude uygulaması hazır değildi", "The Claude app was not ready"],
  moved: ["Başka bir ekrana geçtin", "You went to another screen"],
  "claude-not-running": ["Claude uygulaması çalışmıyordu", "The Claude app was not running"],
  budget: ["Süre doldu", "Time ran out"],
  "not-opened": [
    "Konuşmayı 30 dakika içinde açmadın",
    "You did not open the conversation in 30 minutes",
  ],
};
const UNKNOWN_REASON = REASONS.error;

/** A new-session draft goes to Code's new-session screen, not a conversation. */
const NEW_SESSION_MAYBE_TYPED = [
  "Yeni oturum ekranına yazılmış olabilir, yapıştırmadan önce bak",
  "Possibly on the new-session screen already; check before you paste",
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
    "The new-session screen did not open",
  ],
  "not-opened": [
    "Yeni oturum ekranını 30 dakika içinde açmadın",
    "You did not open the new-session screen in 30 minutes",
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
  // A draft still waiting can be copied, and stays: Relay types it into an empty composer.
  const waiting = draft.state === "pending";
  const reason = waiting
    ? draft.newSession
      ? t("Bekliyor: yeni oturumu açınca geri yazılır", "Waiting: typed back when you open a new session")
      : t("Bekliyor: konuşmayı açınca geri yazılır", "Waiting: typed back when you open the conversation")
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
            {t("Ekler geri yüklenmedi", "Attachments not restored")}
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
        {!waiting && (
          <Button
            size="xs"
            variant="ghost"
            disabled={running}
            onClick={() => void dismissDraftAction(relay, draft.id)}
          >
            {t("Kapat", "Dismiss")}
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
          {t("Kurtarılan taslaklar", "Rescued drafts")}
          {relay.settings.draftRetype === true && (
            <Badge
              variant="outline"
              className="px-1.5 text-xs text-muted-foreground"
            >
              {t("deneysel", "experimental")}
            </Badge>
          )}
        </span>
      </div>
      {waiting > 0 && (
        <p
          className="mb-1.5 text-xs text-muted-foreground"
        >
          {t(
            `${waiting} taslak geri yazılmayı bekliyor`,
            waiting === 1 ? "1 draft waits to be restored" : `${waiting} drafts wait to be restored`,
          )}
        </p>
      )}
      {left > 0 && (
        <p className="mb-1.5 text-xs text-muted-foreground">
          {t(
            "Geçişte geri yazılamayan taslaklar.",
            "Relay did not type these drafts back after the switch.",
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
