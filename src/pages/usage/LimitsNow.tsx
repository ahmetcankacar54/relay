import type { Account, AccountUsage } from "../../../shared/types";
import { Card } from "@/components/ui/card";
import { SectionHeading } from "@/components/SettingRow";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { usageWindowRows, windowElapsed, type UsageWindowRow } from "@/data/selectors";
import { meterFill } from "@/lib/meter";
import { formatReset } from "@/lib/time";
import { cn } from "@/lib/utils";
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
  if (!usage || usage.status !== "ready") return { kind: "unread" };
  const full = [usage.fiveHour, usage.sevenDay].filter((w) => !!w && w.usedPercent >= 100);
  if (full.length)
    return {
      kind: "full",
      ...(full.some((w) => valid(w!.resetsAt, now))
        ? { opensAt: full.map((w) => w!.resetsAt!).filter((r) => valid(r, now)).sort().at(-1) }
        : {}),
    };
  const week = usage.sevenDay;
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

/** One window as a thin bar with the share of the window already gone as a tick. */
function MiniBar({ row, now, label }: { row: UsageWindowRow; now: number; label: string }) {
  const elapsed = windowElapsed(row, now);
  const percent = Math.min(100, Math.max(0, row.usedPercent));
  const ahead = elapsed !== undefined && percent / 100 > elapsed + 0.05;
  return (
    <div className="grid min-w-0 gap-1">
      <div className="flex items-baseline justify-between gap-2 text-2xs text-muted-foreground">
        <span className="truncate">{label}</span>
        <span className={cn("font-medium tabular-nums text-foreground", percent >= 90 && "text-crit")}>
          %{Math.round(percent)}
        </span>
      </div>
      <div
        className="relative h-1.5 overflow-hidden rounded-full bg-track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <div className={cn("h-full rounded-full", meterFill(percent))} style={{ width: `${percent}%` }} />
        {elapsed !== undefined && (
          <span
            aria-hidden="true"
            className={cn("absolute inset-y-0 w-px", ahead ? "bg-crit" : "bg-foreground/45")}
            style={{ left: `${elapsed * 100}%` }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Every account's limits at a glance, on top of the Limits page: the five-hour and weekly
 * windows with a pace tick, each model's own limit (Fable), the plan, and what the account means
 * now (use it first, full until a time, open). Before this the same facts were spread over the
 * Overview, the Accounts table, each account page and the Proxy pool.
 */
export function LimitsNow({ now = Date.now() }: { now?: number }) {
  const { accounts, data, settings } = useRelay();
  const { t, language } = useI18n();
  const usage = data?.usage ?? {};
  const zone = settings.planning.timeZone;
  if (!accounts.length) return null;
  const ordered = boardOrder(accounts, usage, now);
  const readings = accounts.map((a) => limitStanding(usage[a.id], now));
  const usable = readings.filter((s) => s.kind === "open" || s.kind === "expiring").length;
  const expiring = ordered.find((a) => limitStanding(usage[a.id], now).kind === "expiring");
  const reset = (iso: string) => formatReset(iso, now, language, zone);
  return (
    <Card className="gap-3 px-4 py-3.5" data-slot="limits-now">
      <SectionHeading
        title={t("Şu an", "Right now")}
        description={t(
          "Her hesabın limitleri tek yerde. Çizgideki ince işaret pencerenin ne kadarının geçtiğini gösterir; dolu kısım onu geçtiyse hesap hızlı harcanıyor.",
          "Every account's limits in one place. The thin mark on a bar shows how much of the window has passed; a fill past it means the account is being spent fast.",
        )}
      />
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm" data-slot="limits-summary">
        <span>
          <span className="font-semibold tabular-nums">
            {usable}/{accounts.length}
          </span>{" "}
          {t("hesap kullanılabilir", "accounts usable")}
        </span>
        {expiring && (
          <span className="text-warn-foreground">
            {t(
              `Önce ${expiring.name}: haftası bitiyor`,
              `${expiring.name} first: its week is ending`,
            )}
          </span>
        )}
      </div>
      <ul className="grid" aria-label={t("Hesapların limitleri", "Accounts' limits")}>
        {ordered.map((account) => {
          const u = usage[account.id];
          const standing = limitStanding(u, now);
          const rows = usageWindowRows(u);
          const main = rows.filter((r) => !r.model);
          const models = rows.filter((r) => r.model);
          const plan = accountPlan(account);
          return (
            <li
              key={account.id}
              data-account={account.id}
              data-standing={standing.kind}
              className="grid gap-x-4 gap-y-2 border-t py-3 first:border-t-0 sm:grid-cols-[minmax(9rem,13rem)_minmax(0,1fr)]"
            >
              <div className="grid min-w-0 content-start gap-1">
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: account.color }} />
                  <span className="truncate font-medium">{account.name}</span>
                  {plan && (
                    <span
                      title={planTitle(account, plan, t)}
                      className="shrink-0 rounded-sm border px-1.5 text-2xs text-muted-foreground"
                    >
                      {plan.short}
                    </span>
                  )}
                </span>
                <span
                  className={cn(
                    "text-xs",
                    standing.kind === "full" && "text-crit",
                    standing.kind === "expiring" && "text-warn-foreground",
                    (standing.kind === "open" || standing.kind === "unread") && "text-muted-foreground",
                  )}
                >
                  {standing.kind === "full"
                    ? standing.opensAt
                      ? t(`Dolu · ${reset(standing.opensAt)} açılır`, `Full · opens ${reset(standing.opensAt)}`)
                      : t("Dolu", "Full")
                    : standing.kind === "expiring"
                      ? t(
                          `Haftası bitiyor (${reset(standing.endsAt)}); kalan %${Math.round(standing.left)} kullanılmazsa silinir`,
                          `Week ends ${reset(standing.endsAt)}; the ${Math.round(standing.left)}% left is lost unless used`,
                        )
                      : standing.kind === "open"
                        ? standing.endsAt
                          ? t(`Açık · hafta ${reset(standing.endsAt)} yenilenir`, `Open · week renews ${reset(standing.endsAt)}`)
                          : t("Açık", "Open")
                        : t("Limitler okunmadı", "Limits not read")}
                </span>
              </div>
              <div className="grid min-w-0 gap-2">
                {main.length > 0 && (
                  <div className="grid grid-cols-2 gap-3">
                    {main.map((row) => (
                      <MiniBar
                        key={row.key}
                        row={row}
                        now={now}
                        label={
                          row.period === "five_hour"
                            ? row.resetsAt
                              ? t(`5 saat · ${reset(row.resetsAt)}`, `5-hour · ${reset(row.resetsAt)}`)
                              : t("5 saat · başlamadı", "5-hour · not started")
                            : t("Hafta", "Week")
                        }
                      />
                    ))}
                  </div>
                )}
                {models.length > 0 && (
                  <div className="flex flex-wrap gap-1.5" data-slot="model-limits">
                    {models.map((row) => {
                      const spent = row.usedPercent >= 100;
                      return (
                        <span
                          key={row.key}
                          className={cn(
                            "rounded-sm border px-1.5 py-0.5 text-2xs tabular-nums",
                            spent ? "border-crit/40 text-crit" : row.usedPercent >= 75 ? "text-warn-foreground" : "text-muted-foreground",
                          )}
                        >
                          {language === "tr" ? row.label.tr : row.label.en} %{Math.round(row.usedPercent)}
                          {spent && row.resetsAt ? ` · ${reset(row.resetsAt)}` : ""}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
