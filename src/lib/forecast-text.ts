// One-line forecast summaries for the Planning page.
import type { Forecast } from "../../shared/capacity-plan";
import type { T } from "../../shared/i18n/translate";

/** "Kesintisiz · 3 geçiş", "14:18–14:50 limit dolu · 5 geçiş" or "2 aralıkta limit dolu, ilki 14:18–14:50 · 5 geçiş". */
export function forecastSummary(
  forecast: Forecast,
  t: T,
  clock: (time: number) => string,
): string {
  const n = forecast.switches;
  const switches =
    n === 0
      ? t("forecastText.noSwitches")
      : t("forecastText.switches", { n });
  const gaps = forecast.segments.filter((s) => !s.accountId);
  if (!gaps.length)
    return t("forecastText.noGaps", { switches });
  const first = `${clock(gaps[0].from)}–${clock(gaps[0].to)}`;
  return gaps.length === 1
    ? t("forecastText.noQuota", { first, switches })
    : t("forecastText.noQuotaGapsFirst", { gapsLength: gaps.length, first, switches });
}
