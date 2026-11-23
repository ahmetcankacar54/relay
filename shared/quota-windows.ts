import type { AccountUsage, LimitSource, ModelWindow, UsageWindow } from "./types";

/**
 * Quota windows the provider reported. Team and Enterprise seats can omit the
 * weekly window: that means no weekly limit was reported, never an invented 0% or
 * 100%. The five-hour window is required before an account can be judged. A
 * model's own window (`spentModelWindows`) is left out on purpose: when Fable's
 * week is spent the other models still answer, so the account is not full.
 */
export function quotaWindows(
  u: Pick<AccountUsage, "fiveHour" | "sevenDay"> | undefined,
): UsageWindow[] | undefined {
  if (!u?.fiveHour) return;
  return u.sevenDay ? [u.fiveHour, u.sevenDay] : [u.fiveHour];
}
/** Highest utilization across the reported windows (the binding limit). */
export function maxUsedPercent(
  u: Pick<AccountUsage, "fiveHour" | "sevenDay"> | undefined,
) {
  const windows = quotaWindows(u);
  return windows && Math.max(...windows.map((w) => w.usedPercent));
}
/** The model windows used up and not yet reset (Fable's week, an Antigravity model). */
export function spentModelWindows(
  u: Pick<AccountUsage, "modelWindows"> | undefined,
  now: number,
): ModelWindow[] {
  return (u?.modelWindows ?? []).filter(
    (w) => w.usedPercent >= 100 && (!w.resetsAt || Date.parse(w.resetsAt) > now),
  );
}

/**
 * Usage made only of model limits (Antigravity): Google states a quota per model and none for the
 * account. Its five-hour or weekly window is then the roomiest model, kept so the gateway can tell the
 * account still answers; it is never shown as the account's own limit.
 */
export function modelOnlyUsage(u: Pick<AccountUsage, "modelWindows"> | undefined): boolean {
  const models = u?.modelWindows ?? [];
  return models.length > 0 && models.every((w) => w.key.startsWith("antigravity_"));
}

/** How full a window is now: one whose reset has passed is empty again, whatever an old reading says. */
export function usedAt(window: UsageWindow, now: number): number {
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  return Number.isFinite(reset) && reset <= now ? 0 : window.usedPercent;
}

/** The limit an account's figure shows: the one that stops it first. */
export interface LimitHeadline {
  /** "five_hour", "seven_day", or a model window's key. */
  key: string;
  /** A model's name, for a model's own limit (an Antigravity model). */
  label?: string;
  usedPercent: number;
  resetsAt?: string;
  /** A model's own limit: only requests for that model stop when it is spent. */
  model: boolean;
  /** Where the figure came from and when (`UsageWindow.source`, `.readAt`), when known. */
  source?: LimitSource;
  readAt?: string;
}

/** A window's source and read time, only the ones it has, so untagged windows keep their shape. */
const originOf = (w: Pick<UsageWindow, "source" | "readAt">) => ({
  ...(w.source ? { source: w.source } : {}),
  ...(w.readAt ? { readAt: w.readAt } : {}),
});

/**
 * The limit that stops the account first, as its one figure. For Claude and Codex the fuller of the
 * five-hour and weekly windows (the five hours on a tie, since they end first). For usage made only of
 * model limits (`modelOnlyUsage`) the fullest model, so a spent model is never hidden behind the
 * roomiest one. A window whose reset has passed counts as empty. Undefined without a reading.
 */
export function limitHeadline(
  u: Pick<AccountUsage, "fiveHour" | "sevenDay" | "modelWindows"> | undefined,
  now: number,
): LimitHeadline | undefined {
  const candidates: LimitHeadline[] = modelOnlyUsage(u)
    ? (u?.modelWindows ?? []).map((w) => ({ key: w.key, label: w.label, usedPercent: usedAt(w, now), resetsAt: w.resetsAt, model: true, ...originOf(w) }))
    : [
        ...(u?.fiveHour ? [{ key: "five_hour", usedPercent: usedAt(u.fiveHour, now), resetsAt: u.fiveHour.resetsAt, model: false, ...originOf(u.fiveHour) }] : []),
        ...(u?.sevenDay ? [{ key: "seven_day", usedPercent: usedAt(u.sevenDay, now), resetsAt: u.sevenDay.resetsAt, model: false, ...originOf(u.sevenDay) }] : []),
      ];
  const resetMs = (h: LimitHeadline) => {
    const ms = Date.parse(h.resetsAt ?? "");
    return Number.isFinite(ms) ? ms : Infinity;
  };
  return candidates.sort((a, b) => b.usedPercent - a.usedPercent || resetMs(a) - resetMs(b))[0];
}

/**
 * The fullest model window of each length: an Antigravity account's pools as its five hours and its
 * week, for a table's two columns. Windows of unknown length are left out; a passed reset is empty.
 */
export function fullestByPeriod(
  u: Pick<AccountUsage, "modelWindows"> | undefined,
  now: number,
): Partial<Record<"five_hour" | "seven_day", LimitHeadline>> {
  const out: Partial<Record<"five_hour" | "seven_day", LimitHeadline>> = {};
  for (const w of u?.modelWindows ?? []) {
    if (!w.period) continue;
    const used = usedAt(w, now);
    const seen = out[w.period];
    if (!seen || used > seen.usedPercent)
      out[w.period] = { key: w.key, label: w.label, usedPercent: used, ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}), model: true, ...originOf(w) };
  }
  return out;
}

/** A window as a list column shows it: its share, its reset and, for a pool, the pool's name. */
export interface ColumnWindow {
  usedPercent: number;
  resetsAt?: string;
  label?: string;
  source?: LimitSource;
  readAt?: string;
}

/**
 * An account's two list columns, its five hours and its week, the same in every list. For usage made
 * of pools (Antigravity) each column is its fullest pool of that length; pools of unknown length (an
 * older reading) fill the first with the fullest.
 */
export function limitColumns(
  u: Pick<AccountUsage, "fiveHour" | "sevenDay" | "modelWindows"> | undefined,
  now: number,
): { five?: ColumnWindow; week?: ColumnWindow; pooled: boolean } {
  if (!modelOnlyUsage(u)) return { five: u?.fiveHour, week: u?.sevenDay, pooled: false };
  const byPeriod = fullestByPeriod(u, now);
  return {
    five: byPeriod.five_hour ?? (byPeriod.seven_day ? undefined : limitHeadline(u, now)),
    week: byPeriod.seven_day,
    pooled: true,
  };
}

/** Where a shown limit figure came from (`LimitSource`) and when it was read. */
export interface LimitOrigin {
  source: LimitSource;
  readAt?: string;
}

/**
 * Where a limit row's figure came from, for its tooltip. A window whose reset passed after it was
 * read shows as empty: that is Relay's estimate, not a reading. A window read before windows were
 * tagged takes its source from the account's sign-in (`AccountUsage.source`). Undefined when
 * nothing says where it came from.
 */
export function limitOrigin(
  window: Pick<UsageWindow, "resetsAt" | "source" | "readAt"> | undefined,
  usage: Pick<AccountUsage, "source" | "checkedAt"> | undefined,
  now: number,
): LimitOrigin | undefined {
  if (!window) return;
  const readAt = window.readAt ?? usage?.checkedAt;
  const reset = Date.parse(window.resetsAt ?? "");
  const source: LimitSource | undefined =
    Number.isFinite(reset) && reset <= now
      ? "estimate"
      : (window.source ?? (usage?.source === "desktop" ? "app-session" : usage?.source === "cli" ? "official" : undefined));
  if (!source) return;
  return { source, ...(readAt ? { readAt } : {}) };
}
