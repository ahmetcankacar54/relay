import { useState } from "react";
import type { Account, AccountUsage } from "../../../shared/types";
import { modelOnlyUsage } from "../../../shared/quota-windows";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LimitLine, countdown } from "@/components/LimitLine";
import { AntigravityAction, AntigravityPrompt, type AntigravityAsk } from "@/features/AntigravityAccount";
import { PROVIDER_NAMES, relayProviders } from "@/features/Providers";
import { ProviderLogo } from "@/components/ProviderLogo";
import { PROVIDERS, type ProviderId } from "@/lib/provider-view";
import { SectionHeading } from "@/components/SettingRow";
import { useI18n, type T } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { usageWindowRows } from "@/data/selectors";
import { cn } from "@/lib/utils";
import { AccountDot } from "@/components/AccountDot";
import { accountPlan, planTitle } from "../accounts/accountLabels";

const HOUR = 3_600_000;
/** A week ending this soon with this much left: what is left may be lost at the reset. */
const EXPIRING_MS = 48 * HOUR;
const EXPIRING_ROOM = 10;

/** Where an account stands now, in the order the board lists them. */
export type LimitStanding =
  /** A five-hour or weekly window is used up: nothing goes there until `opensAt`. */
  | { kind: "full"; opensAt?: string }
  /** Its week ends soon with room left: what is left is lost unless used first. */
  | { kind: "expiring"; endsAt: string; left: number }
  | { kind: "open"; endsAt?: string }
  | { kind: "unread" };

const valid = (iso: string | undefined, now: number) => !!iso && Date.parse(iso) > now;

/** The board's reading of one account (exported for tests). */
export function limitStanding(usage: AccountUsage | undefined, now: number): LimitStanding {
  // An old reading still says how the account stood; the row says it is old.
  if (!usage || (!usage.fiveHour && !usage.sevenDay)) return { kind: "unread" };
  const full = [usage.fiveHour, usage.sevenDay].filter((w) => !!w && w.usedPercent >= 100);
  if (full.length)
    return {
      kind: "full",
      ...(full.some((w) => valid(w!.resetsAt, now))
        ? { opensAt: full.map((w) => w!.resetsAt!).filter((r) => valid(r, now)).sort().at(-1) }
        : {}),
    };
  // Antigravity's week, when it has one, is only its roomiest model: no week of its own ends.
  const week = modelOnlyUsage(usage) ? undefined : usage.sevenDay;
  if (week?.resetsAt && valid(week.resetsAt, now)) {
    const left = Math.max(0, 100 - week.usedPercent);
    if (Date.parse(week.resetsAt) - now <= EXPIRING_MS && left >= EXPIRING_ROOM)
      return { kind: "expiring", endsAt: week.resetsAt, left };
    return { kind: "open", endsAt: week.resetsAt };
  }
  return { kind: "open" };
}

/**
 * The board's order: accounts whose week ends soon with room first (use them first), then the
 * others by when their week ends, the full ones after, and accounts never read last. The
 * gateway's "soonest reset" order works the same way.
 */
export function boardOrder(accounts: Account[], usage: Record<string, AccountUsage | undefined>, now: number): Account[] {
  const rank = (s: LimitStanding) => ({ expiring: 0, open: 1, full: 2, unread: 3 })[s.kind];
  const ends = (s: LimitStanding) =>
    s.kind === "expiring" || s.kind === "open" ? Date.parse(s.endsAt ?? "") || Infinity : Date.parse((s.kind === "full" && s.opensAt) || "") || Infinity;
  return accounts
    .map((account, index) => ({ account, index, s: limitStanding(usage[account.id], now) }))
    .sort((a, b) => rank(a.s) - rank(b.s) || ends(a.s) - ends(b.s) || a.index - b.index)
    .map((x) => x.account);
}

/** A standing in two or three words: "Dolu · 25 dk", "Hafta bitiyor · %65 boş", or nothing for open. */
function standingWords(standing: LimitStanding, now: number, t: T): { text: string; tone: "crit" | "warn" | "muted" } | undefined {
  switch (standing.kind) {
    case "full": {
      const left = countdown(standing.opensAt, now, t);
      return { text: left ? t(`Dolu · ${left}`, `Full · ${left}`) : t("Dolu", "Full"), tone: "crit" };
    }
    case "expiring":
      return {
        text: t(`Hafta bitiyor · %${Math.round(standing.left)} boş`, `Week ending · ${Math.round(standing.left)}% left`),
        tone: "warn",
      };
    case "unread":
      return { text: t("Okunmadı", "Not read"), tone: "muted" };
    default:
      return undefined;
  }
}

/**
 * Every account's limits at a glance, on top of the Limits page (variant A): one row per account,
 * its limits as the same lines everywhere (five-hour, week, each model's own), a short standing
 * ("Dolu · 25 dk", "Hafta bitiyor") and, for an Antigravity account, its one move. A provider
 * filter narrows the board when there are several.
 */
export function LimitsNow({ now = Date.now() }: { now?: number }) {
  const relay = useRelay();
  const { accounts, data } = relay;
  const { t, language } = useI18n();
  const [provider, setProvider] = useState<ProviderId | "all">("all");
  const [ask, setAsk] = useState<AntigravityAsk>();
  const usage = data?.usage ?? {};
  if (!accounts.length) return null;
  const providers = PROVIDERS.filter((p) => accounts.some((a) => (a.provider ?? "claude") === p));
  const shown = provider === "all" ? accounts : accounts.filter((a) => (a.provider ?? "claude") === provider);
  const ordered = boardOrder(shown, usage, now);
  const readings = accounts.map((a) => limitStanding(usage[a.id], now));
  const usable = readings.filter((s) => s.kind === "open" || s.kind === "expiring").length;
  const expiring = boardOrder(accounts, usage, now).find((a) => limitStanding(usage[a.id], now).kind === "expiring");
  // The account each provider's tool runs on now: marked "açık" on its row.
  const inUse = new Set(relayProviders(relay, now).flatMap((v) => (v.current ? [v.current.id] : [])));
  return (
    <Card className="gap-3 px-4 py-3.5" data-slot="limits-now">
      <SectionHeading
        title={t("Şu an", "Right now")}
        description={t(
          "Çubuktaki ince işaret dönemin ne kadarının geçtiğini gösterir.",
          "The thin mark on a bar shows how much of the period has passed.",
        )}
      />
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm" data-slot="limits-summary">
          <span>
            <span className="font-semibold tabular-nums">
              {usable}/{accounts.length}
            </span>{" "}
            {t("hesap kullanılabilir", "accounts usable")}
          </span>
          {expiring && (
            <span className="text-warn-foreground">
              {t(`Önce ${expiring.name}: haftası bitiyor`, `${expiring.name} first: its week is ending`)}
            </span>
          )}
        </div>
        {providers.length > 1 && (
          <div role="group" aria-label={t("Sağlayıcı", "Provider")} className="flex gap-1" data-slot="limits-filter">
            {(["all", ...providers] as const).map((p) => (
              <Button key={p} size="xs" variant={provider === p ? "secondary" : "ghost"} aria-pressed={provider === p} onClick={() => setProvider(p)}>
                {p === "all" ? (
                  t("Hepsi", "All")
                ) : (
                  <>
                    <ProviderLogo provider={p} size="sm" />
                    {PROVIDER_NAMES[p]}
                  </>
                )}
              </Button>
            ))}
          </div>
        )}
      </div>
      <ul className="grid" aria-label={t("Hesapların limitleri", "Accounts' limits")}>
        {ordered.map((account) => {
          const u = usage[account.id];
          const standing = limitStanding(u, now);
          const words = standingWords(standing, now, t);
          const plan = accountPlan(account);
          const old = !!u && standing.kind !== "unread" && (u.status !== "ready" || u.stale);
          const rows = usageWindowRows(u).slice(0, 4);
          return (
            <li
              key={account.id}
              data-account={account.id}
              data-standing={standing.kind}
              className="grid gap-x-6 gap-y-2 border-t py-3 first:border-t-0 sm:grid-cols-[minmax(9rem,13rem)_minmax(0,1fr)]"
            >
              <div className="grid min-w-0 content-start gap-1">
                <span className="flex min-w-0 items-center gap-2">
                  <AccountDot color={account.color} />
                  <span className="truncate font-medium">{account.name}</span>
                  {plan && (
                    <span title={planTitle(account, plan, t)} className="shrink-0 rounded-sm border px-1.5 text-2xs text-muted-foreground">
                      {plan.short}
                    </span>
                  )}
                </span>
                <span className="flex flex-wrap items-center gap-1.5 text-2xs">
                  {inUse.has(account.id) && <Badge variant="secondary">{t("açık", "in use")}</Badge>}
                  {words && (
                    <span className={cn(words.tone === "crit" ? "font-semibold text-crit" : words.tone === "warn" ? "text-warn-foreground" : "text-muted-foreground")}>
                      {words.text}
                    </span>
                  )}
                  {old && <span className="text-muted-foreground">{t("eski okuma", "old reading")}</span>}
                  {account.provider === "antigravity" && <AntigravityAction account={account} onAsk={setAsk} />}
                </span>
              </div>
              <div className="grid min-w-0 gap-x-6 gap-y-2.5 sm:grid-cols-2">
                {rows.length ? (
                  rows.map((row) => (
                    <LimitLine
                      key={row.key}
                      label={row.key === "five_hour" ? t("5 saat", "5 hours") : row.key === "seven_day" ? t("Hafta", "Week") : language === "tr" ? row.label.tr : row.label.en}
                      usedPercent={row.usedPercent}
                      resetsAt={row.resetsAt}
                      period={row.period}
                      now={now}
                      t={t}
                      faded={old}
                    />
                  ))
                ) : (
                  <span className="text-xs text-muted-foreground">{t("Limit verisi yok", "No usage data")}</span>
                )}
              </div>
              {account.provider === "antigravity" && (ask?.accountId === account.id || data?.antigravity?.signInFor === account.id) && (
                <div className="sm:col-span-2">
                  <AntigravityPrompt ask={ask} onClose={() => setAsk(undefined)} now={now} size="sm" />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
