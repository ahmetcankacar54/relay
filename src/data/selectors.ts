import type { Account, AccountUsage, AuthFlow, RelaySettings, Snapshot } from "../../shared/types";
import { freshUsage, quotaWindows } from "../../shared/usage";
import { rankContinuationTargets } from "../../shared/continuation-target-ranking";
import { tempoAt } from "../../shared/tempo";

export const pendingFlow = (f?: AuthFlow) =>
  !!f && ["starting", "waiting", "verifying"].includes(f.status);

export type OverviewState = "ready" | "window-open" | "exhausted" | "not-linked" | "unknown";
export interface OverviewRow {
  account: Account;
  usage?: AccountUsage;
  state: OverviewState;
  availableAt?: string;
  recommended: boolean;
}
/** Pro units per hour at `now` under the keeper's tempo, once the main process reported one. */
export function tempoRateNow(data: Snapshot | undefined, settings: RelaySettings, now: number) {
  return data?.planning?.tempo ? tempoAt(data.planning.tempo, settings.planning, now) : undefined;
}

/**
 * A fresh reading with a window used up: when the account opens again (the latest of those
 * windows' resets, undefined when none is known). Undefined while no window is full.
 */
export function limitFull(
  u: AccountUsage | undefined,
  now: number,
): { availableAt?: string } | undefined {
  if (!freshUsage(u, now)) return undefined;
  const full = (quotaWindows(u) ?? []).filter((w) => w.usedPercent >= 100);
  if (!full.length) return undefined;
  const availableAt = full.map((w) => w.resetsAt).filter((r): r is string => !!r).sort().at(-1);
  return availableAt ? { availableAt } : {};
}

/** The ids of the accounts open in a separate Claude window. */
export const windowAccounts = (data: Snapshot | undefined): ReadonlySet<string> =>
  new Set(data?.windows?.open.map((w) => w.accountId));

/**
 * Other accounts best first, by the switch rule (`rate`: the tempo, Pro units per hour). One open
 * in its own Claude window (`inWindows`, by id) cannot be switched to, so it is never recommended.
 */
export function overviewAccounts(
  active: Account | undefined,
  accounts: Account[],
  usage: Record<string, AccountUsage>,
  now = Date.now(),
  rate?: number,
  inWindows: ReadonlySet<string> = new Set(),
): OverviewRow[] {
  const others = accounts.filter((a) => a.id !== active?.id);
  const ranked = rankContinuationTargets(
    others.map((account) => ({ account, usage: usage[account.id] })),
    { now, rate },
  );
  const order = [...ranked.filter((r) => r.account.desktop), ...ranked.filter((r) => !r.account.desktop)];
  let recommended = false;
  return order.map(({ account }) => {
    const u = usage[account.id];
    let state: OverviewState;
    let availableAt: string | undefined;
    const full = limitFull(u, now);
    if (!account.desktop) state = "not-linked";
    else if (!freshUsage(u, now)) state = "unknown";
    else if (full) {
      state = "exhausted";
      availableAt = full.availableAt;
    } else if (u.fiveHour?.resetsAt && Date.parse(u.fiveHour.resetsAt) > now) state = "window-open";
    else state = "ready";
    const pick =
      !recommended && !inWindows.has(account.id) && (state === "ready" || state === "window-open");
    if (pick) recommended = true;
    return { account, usage: u, state, availableAt, recommended: pick };
  });
}

export function sidebarStatus(snapshot: Snapshot | undefined) {
  return {
    accounts: snapshot?.accounts.length ?? 0,
    planning: !!snapshot?.settings.planning.autoStart,
    switching: !!snapshot?.fleet?.enabled || (snapshot?.settings.autoSwitchMode ?? "off") !== "off",
  };
}

export function usageWindowRows(usage?: AccountUsage) {
  if (!usage) return [];
  const rows: { key: string; label: { tr: string; en: string }; usedPercent: number; resetsAt?: string }[] = [];
  if (usage.fiveHour) rows.push({ key: "five_hour", label: { tr: "5 saatlik dönem", en: "5-hour period" }, ...usage.fiveHour });
  if (usage.sevenDay) rows.push({ key: "seven_day", label: { tr: "Haftalık · tüm modeller", en: "Weekly · all models" }, ...usage.sevenDay });
  for (const w of usage.modelWindows ?? [])
    rows.push({
      key: w.key,
      label: w.key.startsWith("seven_day")
        ? { tr: `Haftalık · ${w.label}`, en: `Weekly · ${w.label}` }
        : { tr: `5 saat · ${w.label}`, en: `5-hour · ${w.label}` },
      usedPercent: w.usedPercent,
      resetsAt: w.resetsAt,
    });
  return rows;
}
