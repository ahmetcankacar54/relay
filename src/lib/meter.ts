export type MeterTone = "ok" | "warn" | "crit" | "none";
/** Usage colour: below 75 % normal, 75–89 % warning, 90 % and above critical. */
export function meterTone(percent: number | undefined): MeterTone {
  if (percent === undefined || !Number.isFinite(percent)) return "none";
  return percent >= 90 ? "crit" : percent >= 75 ? "warn" : "ok";
}
export const meterClass: Record<MeterTone, string> = {
  ok: "bg-brand",
  warn: "bg-warn",
  crit: "bg-crit",
  none: "bg-transparent",
};
/** A rounded percentage: `%45` in Turkish, `45%` in English; `—` when unknown. */
export function formatPercent(value: number | undefined, language: string) {
  if (value === undefined || !Number.isFinite(value)) return "—";
  const n = Math.round(value);
  return language === "tr" ? `%${n}` : `${n}%`;
}
