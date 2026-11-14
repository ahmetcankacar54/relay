import type { AccountUsage, ModelWindow, UsageWindow } from "./types";

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
