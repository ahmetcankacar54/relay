export type MeterTone = "ok" | "warn" | "crit" | "none";
/** Usage level: below 75 % normal, 75–89 % warning, 90 % and above critical. */
export function meterTone(percent: number | undefined): MeterTone {
  if (percent === undefined || !Number.isFinite(percent)) return "none";
  return percent >= 90 ? "crit" : percent >= 75 ? "warn" : "ok";
}
/** Bars and rings are grey at every level; the near-limit warnings say the level in words. */
export const meterClass: Record<MeterTone, string> = {
  ok: "bg-meter",
  warn: "bg-meter",
  crit: "bg-meter",
  none: "bg-transparent",
};
/** A bar's fill: grey, and red only once the limit is used up. */
export const meterFill = (percent: number | undefined, full = false) =>
  full || (percent !== undefined && percent >= 100) ? "bg-crit" : meterClass[meterTone(percent)];
// The one percentage helper (shared with the menu bar); limit figures read as what is used: `formatUsed`.
export { formatPercent, formatUsed, percentUsed, usedWord } from "../../shared/percent";
