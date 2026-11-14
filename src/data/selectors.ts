import type { Account, AccountUsage, AuthFlow, DesktopState, ModelWindow, RelaySettings, Snapshot } from "../../shared/types";
import { freshUsage, quotaWindows } from "../../shared/usage";
import { spentModelWindows } from "../../shared/quota-windows";
import { rankContinuationTargets } from "../../shared/continuation-target-ranking";
import { tempoAt } from "../../shared/tempo";
import { clientHost } from "../lib/proxy-ui";

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
 * windows' resets, undefined when none is known). Undefined while no window is full. A model's own
 * window (`modelLimitFull`) does not count: the other models still answer.
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

/**
 * The model windows of a fresh reading that are used up (Fable's own week, an Antigravity model):
 * only that model stops, so the account is not full, but its status names them. Empty otherwise.
 */
export function modelLimitFull(u: AccountUsage | undefined, now: number): ModelWindow[] {
  return freshUsage(u, now) ? spentModelWindows(u, now) : [];
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
  // Only a Claude account is switched to in the Claude app; Codex and Antigravity accounts feed the gateway.
  const claude = (a: Account) => (a.provider ?? "claude") === "claude";
  const order = [
    ...ranked.filter((r) => claude(r.account) && r.account.desktop),
    ...ranked.filter((r) => !claude(r.account)),
    ...ranked.filter((r) => claude(r.account) && !r.account.desktop),
  ];
  const rows = order.map(({ account }): OverviewRow => {
    const u = usage[account.id];
    let state: OverviewState;
    let availableAt: string | undefined;
    const full = limitFull(u, now);
    if (claude(account) && !account.desktop) state = "not-linked";
    else if (!freshUsage(u, now)) state = "unknown";
    else if (full) {
      state = "exhausted";
      availableAt = full.availableAt;
    } else if (u.fiveHour?.resetsAt && Date.parse(u.fiveHour.resetsAt) > now) state = "window-open";
    else state = "ready";
    return { account, usage: u, state, availableAt, recommended: false };
  });
  const pickable = rows.filter(
    (r) => claude(r.account) && !inWindows.has(r.account.id) && (r.state === "ready" || r.state === "window-open"),
  );
  // A spent model limit (Fable's week) leaves the account usable: it is recommended only when no other is clear.
  const pick = pickable.find((r) => !modelLimitFull(r.usage, now).length) ?? pickable[0];
  if (pick) pick.recommended = true;
  return rows;
}

/**
 * What the sidebar's dots say. The gateway's state rides on the desktop state (`proxyStatus`), not on
 * the snapshot, so the shell passes both; `proxyAddress` is set only while the gateway answers.
 */
export function sidebarStatus(snapshot: Snapshot | undefined, desktop?: DesktopState) {
  const proxy = desktop?.proxyStatus;
  return {
    accounts: snapshot?.accounts.length ?? 0,
    planning: !!snapshot?.settings.planning.autoStart,
    switching: !!snapshot?.fleet?.enabled || (snapshot?.settings.autoSwitchMode ?? "off") !== "off",
    proxyRunning: !!proxy?.running,
    ...(proxy?.running ? { proxyAddress: `${clientHost(proxy.host)}:${proxy.port}` } : {}),
  };
}

/** The length of a window kind, for how much of it has passed (`windowElapsed`). */
const PERIOD_MS = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 } as const;
export type WindowPeriod = keyof typeof PERIOD_MS;

export interface UsageWindowRow {
  key: string;
  label: { tr: string; en: string };
  usedPercent: number;
  resetsAt?: string;
  /** A five-hour or weekly window; undefined for one of unknown length (an Antigravity model). */
  period?: WindowPeriod;
  /** A model's own limit (Fable, Opus, an Antigravity model), listed after the account's two. */
  model?: boolean;
}

/** The kind of window a key names: `seven_day_fable` is weekly, `antigravity_*` has no fixed length. */
const periodOf = (key: string): WindowPeriod | undefined =>
  key.startsWith("seven_day") ? "seven_day" : key.startsWith("five_hour") ? "five_hour" : undefined;

/**
 * A model window's name: the model first, then its period ("Fable · haftalık", "Opus · 5 saat"). An
 * Antigravity model's window is not a five-hour or weekly one, so it is the model's name alone.
 */
function modelRowLabel(w: ModelWindow): { tr: string; en: string } {
  const period = periodOf(w.key);
  if (!period) return { tr: w.label, en: w.label };
  return period === "seven_day"
    ? { tr: `${w.label} · haftalık`, en: `${w.label} · weekly` }
    : { tr: `${w.label} · 5 saat`, en: `${w.label} · 5-hour` };
}

/**
 * An account's limits as rows: the five-hour and weekly windows, then each model's own limit,
 * fullest first, so the one that binds next reads first.
 */
export function usageWindowRows(usage?: AccountUsage): UsageWindowRow[] {
  if (!usage) return [];
  const rows: UsageWindowRow[] = [];
  if (usage.fiveHour)
    rows.push({ key: "five_hour", label: { tr: "5 saatlik dönem", en: "5-hour period" }, period: "five_hour", ...usage.fiveHour });
  if (usage.sevenDay)
    rows.push({ key: "seven_day", label: { tr: "Haftalık · tüm modeller", en: "Weekly · all models" }, period: "seven_day", ...usage.sevenDay });
  const models = [...(usage.modelWindows ?? [])].sort(
    (a, b) => b.usedPercent - a.usedPercent || a.key.localeCompare(b.key),
  );
  for (const w of models)
    rows.push({
      key: w.key,
      label: modelRowLabel(w),
      usedPercent: w.usedPercent,
      resetsAt: w.resetsAt,
      period: periodOf(w.key),
      model: true,
    });
  return rows;
}

/**
 * How much of a five-hour or weekly window has passed at `now`, 0 to 1: where even use would have
 * the bar by now. Undefined without a reset time or a known length.
 */
export function windowElapsed(row: Pick<UsageWindowRow, "period" | "resetsAt">, now: number): number | undefined {
  const reset = Date.parse(row.resetsAt ?? "");
  if (!row.period || !Number.isFinite(reset)) return undefined;
  return Math.max(0, Math.min(1, 1 - (reset - now) / PERIOD_MS[row.period]));
}
