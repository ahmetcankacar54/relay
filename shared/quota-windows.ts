import type { AccountUsage, UsageWindow } from "./types";

/**
 * Quota windows the provider reported. Team and Enterprise seats can omit the
 * weekly window: that means no weekly limit was reported, never an invented 0% or
 * 100%. The five-hour window is required before an account can be judged.
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
