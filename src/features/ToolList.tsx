import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Private } from "@/components/Private";
import { UsageRing, type RingState } from "@/components/UsageRing";
import { useI18n, type Language, type T } from "@/data/i18n";
import { useRelay, type Relay } from "@/data/relay-context";
import { timeLeft } from "@/lib/account-row";
import { formatPercent, formatUsed, percentUsed } from "@/lib/meter";
import { toolRows, type ToolId, type ToolRow } from "@/lib/tools";
import { cn } from "@/lib/utils";
import type { LimitHeadline } from "../../shared/quota-windows";
import type { Account } from "../../shared/types";

const TOOL_NAMES: Record<ToolId, [string, string]> = {
  "claude-app": ["Claude uygulaması", "Claude app"],
  "claude-code": ["Claude Code", "Claude Code"],
  codex: ["Codex CLI", "Codex CLI"],
  antigravity: ["Antigravity", "Antigravity"],
};

/** A limit's short name: "5 saat", "Hafta", or the model's own name. */
export function headlineName(head: LimitHeadline, t: T): string {
  if (head.key === "five_hour") return t("5 saat", "5 hours");
  if (head.key === "seven_day") return t("Hafta", "Week");
  return head.label ?? head.key;
}

/** "Gemini 4 Carbon (High) dolu · 25 dk sonra açılır" or "Hafta %68 · 1 gün sonra yenilenir". */
export function headlineWords(head: LimitHeadline, t: T, language: Language, now: number): string {
  const name = headlineName(head, t);
  // A day or more away reads in days ("4 gün"), as the account rows say it.
  const ms = Date.parse(head.resetsAt ?? "") - now;
  const days = Math.round(ms / 86_400_000);
  const left = ms >= 86_400_000 ? t(`${days} gün`, `${days} ${days === 1 ? "day" : "days"}`) : timeLeft(head.resetsAt, now, t);
  if (head.usedPercent >= 100)
    return left ? t(`${name} dolu · ${left} sonra açılır`, `${name} is full · opens in ${left}`) : t(`${name} dolu`, `${name} is full`);
  const percent = formatPercent(percentUsed(head.usedPercent), language);
  return left ? t(`${name} ${percent} · ${left} sonra yenilenir`, `${name} ${percent} · resets in ${left}`) : `${name} ${percent}`;
}

/** What the row says under the tool's name, in one line. */
function rowLine(row: ToolRow, account: Account | undefined, t: T, language: Language, now: number): string {
  if (row.state === "off")
    return t("Ağ geçidine bağlı ama geçit kapalı: istekleri gitmez", "Bound to the gateway, but it is off: requests fail");
  if (row.foreign) return t("Relay'de olmayan bir Google hesabıyla açık", "Signed in with a Google account Relay does not have");
  if (!account)
    return row.via === "gateway"
      ? t("Henüz istek yok", "No request yet")
      : t("Hangi hesapla açık olduğu okunamadı", "Relay cannot tell which account it is signed in with");
  if (!row.headline) return t("Limit verisi yok", "No usage data");
  const words = headlineWords(row.headline, t, language, now);
  return row.state === "unknown" ? t(`${words} · eski okuma`, `${words} · old reading`) : words;
}

/** Where the tool goes next, when its account is spent or nearly so. */
function nextLine(row: ToolRow, alternative: Account | undefined, t: T, language: Language): string | undefined {
  if (!row.alternative || !alternative) {
    if (row.state !== "blocked") return undefined;
    return row.via === "gateway"
      ? undefined
      : t("Bu sağlayıcıda boş hesap yok", "No account of this provider has room");
  }
  const head = row.alternative.headline;
  const room = head ? formatPercent(percentUsed(100 - head.usedPercent), language) : undefined;
  const what = head?.model ? t("bu model", "this model") : t("limit", "the limit");
  const space = room ? t(`: ${what} ${room} boş`, `: ${what} ${room} free`) : "";
  if (row.via === "gateway")
    return t(`Ağ geçidi sıradaki isteği ${alternative.name} hesabına gönderir${space}`, `The gateway sends the next request to ${alternative.name}${space}`);
  return t(`${alternative.name} hazır${space}`, `${alternative.name} is ready${space}`);
}

const ringOf = (row: ToolRow): RingState =>
  !row.headline ? "unknown" : row.state === "unknown" ? "stale" : row.headline.usedPercent >= 100 ? "full" : "fresh";

/**
 * Antigravity's way to the other account. The app talks to Google with the account it signed in
 * with and reads it only at start, so Relay cannot move it the way it moves the Claude app: the user
 * signs out there and in with the other account. Relay names the account and brings the app forward.
 */
function AntigravitySteps({ target, canOpen, compact }: { target: Account; canOpen: boolean; compact?: boolean }) {
  const relay = useRelay();
  const { t } = useI18n();
  return (
    <div data-slot="antigravity-steps" className={cn("grid gap-1.5 rounded-md bg-muted/60 px-2.5 py-2", compact ? "text-2xs" : "text-xs")}>
      <ol className="ml-4 list-decimal space-y-0.5 text-muted-foreground [&_b]:font-medium [&_b]:text-foreground">
        <li>{t("Antigravity'de hesap menüsünden çıkış yap.", "In Antigravity, sign out from the account menu.")}</li>
        <li>
          {t("Şu hesapla gir: ", "Sign in with ")}
          <b>{target.name}</b>
          {target.auth?.email && (
            <>
              {" ("}
              <Private>{target.auth.email}</Private>
              {")"}
            </>
          )}
          .
        </li>
        <li>
          {t(
            "Açık agy oturumları eski hesapla sürer; yeni bir agy başlat.",
            "Running agy sessions stay on the old account; start a new agy.",
          )}
        </li>
      </ol>
      {canOpen && (
        <Button
          size="xs"
          variant="outline"
          className="justify-self-start"
          onClick={() => void relay.action("antigravity", () => relay.api.openAntigravity())}
        >
          {t("Antigravity'yi aç", "Open Antigravity")}
        </Button>
      )}
    </div>
  );
}

/** The tools besides the Claude app (which has its own card), from what Relay knows now. */
export function otherToolRows(relay: Relay, now: number): ToolRow[] {
  return toolRows({
    accounts: relay.accounts,
    usage: relay.data?.usage ?? {},
    active: relay.active,
    suggestion: relay.suggestion,
    proxy: relay.desktop?.proxyStatus,
    antigravity: relay.data?.antigravity,
    now,
  }).filter((row) => row.id !== "claude-app");
}

/**
 * The tools besides the Claude app, as rows (variant B): each one's account, the limit that stops it
 * first (an Antigravity account's fullest model), and its next step. Claude Code and the Codex CLI on
 * the gateway move by themselves; Antigravity needs a sign-in, which the row walks through.
 * `onGateway` opens the gateway's page; `onAdd` adds an account.
 */
export function ToolList({
  now,
  compact,
  onGateway,
  onAdd,
  open: controlled,
  onOpenChange,
}: {
  now: number;
  /** The menu bar panel's smaller rows. */
  compact?: boolean;
  onGateway: () => void;
  onAdd: () => void;
  /** The row whose steps are open, when the page owns it (its banner opens them too). */
  open?: ToolId;
  onOpenChange?: (id: ToolId | undefined) => void;
}) {
  const relay = useRelay();
  const { t, language } = useI18n();
  const [local, setLocal] = useState<ToolId>();
  const open = onOpenChange ? controlled : local;
  const setOpen = onOpenChange ?? setLocal;
  const rows = otherToolRows(relay, now);
  if (!rows.length) return null;
  const byId = (id?: string) => (id ? relay.accounts.find((a) => a.id === id) : undefined);
  return (
    <div data-slot="tool-list" className="overflow-hidden rounded-lg border bg-card">
      {rows.map((row, i) => {
        const account = byId(row.accountId);
        const alternative = byId(row.alternative?.accountId);
        const name = t(...TOOL_NAMES[row.id]);
        const line = rowLine(row, account, t, language, now);
        const next = nextLine(row, alternative, t, language);
        const stuck = row.state === "blocked" || row.state === "near";
        // One action per row: the step that gets the tool going again.
        const action =
          row.state === "off" ? (
            <Button size="xs" variant="outline" onClick={onGateway}>
              {t("Ağ geçidi", "Gateway")}
            </Button>
          ) : row.id === "antigravity" && stuck && alternative ? (
            <Button
              size="xs"
              variant={row.state === "blocked" ? "default" : "outline"}
              aria-expanded={open === row.id}
              onClick={() => setOpen(open === row.id ? undefined : row.id)}
            >
              {t("Nasıl geçilir", "How to move")}
            </Button>
          ) : (row.foreign || (row.state === "blocked" && !alternative && row.via !== "gateway")) ? (
            <Button size="xs" variant="outline" onClick={onAdd}>
              {t("Hesap ekle", "Add account")}
            </Button>
          ) : undefined;
        const said = [name, account?.name, row.headline && `${headlineName(row.headline, t)} ${formatUsed(row.headline.usedPercent, language)}`]
          .filter(Boolean)
          .join(" · ");
        return (
          <div key={row.id} data-slot="tool-row" data-tool={row.id} className={cn(i > 0 && "border-t", compact ? "px-2.5 py-2" : "px-3 py-2.5")}>
            <div className={cn("grid items-center gap-x-3 gap-y-1", action && !compact ? "grid-cols-[auto_minmax(0,1fr)_auto]" : "grid-cols-[auto_minmax(0,1fr)]")}>
              <UsageRing outer={row.headline?.usedPercent} inner={null} size={compact ? 26 : 32} label={said} state={ringOf(row)} />
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  <span className={cn("font-semibold", compact ? "text-xs" : "text-sm")}>{name}</span>
                  {account && (
                    <span className="truncate rounded bg-secondary px-1.5 py-px text-2xs font-medium text-secondary-foreground">
                      {account.name}
                      {row.via === "gateway" && t(" · ağ geçidi", " · gateway")}
                    </span>
                  )}
                </div>
                <p className={cn("truncate", compact ? "text-2xs" : "text-xs", row.state === "blocked" || row.state === "off" ? "text-crit" : "text-muted-foreground")} title={line}>
                  {line}
                </p>
                {stuck && next && (
                  <p className={cn("truncate text-muted-foreground", compact ? "text-2xs" : "text-xs")} title={next}>
                    {next}
                  </p>
                )}
              </div>
              {action && <div className={cn(compact && "col-start-2 justify-self-start")}>{action}</div>}
            </div>
            {open === row.id && alternative && (
              <div className={cn("mt-2", compact ? "" : "ml-11")}>
                <AntigravitySteps target={alternative} canOpen={!!relay.data?.antigravity?.canOpen} compact={compact} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The banner over the tools when one of them is stopped and another account has room. */
export function blockedToolText(row: ToolRow, accounts: Account[], t: T, language: Language, now: number) {
  const alternative = accounts.find((a) => a.id === row.alternative?.accountId);
  const name = t(...TOOL_NAMES[row.id]);
  const head = row.headline ? headlineWords(row.headline, t, language, now) : "";
  return {
    title: t(`${name} limitte.`, `${name} is at its limit.`),
    body: [head, alternative && (row.via === "gateway"
      ? t(`Ağ geçidi ${alternative.name} hesabına geçer.`, `The gateway moves to ${alternative.name}.`)
      : t(`${alternative.name} hazır.`, `${alternative.name} is ready.`))]
      .filter(Boolean)
      .join(" · "),
  };
}
