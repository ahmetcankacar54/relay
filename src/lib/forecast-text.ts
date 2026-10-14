// One-line forecast summaries for the Planning page.
import type { Forecast } from "../../shared/capacity-plan";

/** "Kesintisiz · 3 geçiş", "14:18–14:50 kotasız · 5 geçiş" or "2 kotasız aralık, ilk 14:18–14:50 · 5 geçiş". */
export function forecastSummary(
  forecast: Forecast,
  t: (tr: string, en: string) => string,
  clock: (time: number) => string,
): string {
  const n = forecast.switches;
  const switches =
    n === 0
      ? t("geçiş yok", "no switches")
      : t(`${n} geçiş`, `${n} ${n === 1 ? "switch" : "switches"}`);
  const gaps = forecast.segments.filter((s) => !s.accountId);
  if (!gaps.length)
    return t(`Kesintisiz · ${switches}`, `No gaps · ${switches}`);
  const first = `${clock(gaps[0].from)}–${clock(gaps[0].to)}`;
  return gaps.length === 1
    ? t(`${first} kotasız · ${switches}`, `No quota ${first} · ${switches}`)
    : t(
        `${gaps.length} kotasız aralık, ilk ${first} · ${switches}`,
        `${gaps.length} no-quota gaps, first ${first} · ${switches}`,
      );
}
