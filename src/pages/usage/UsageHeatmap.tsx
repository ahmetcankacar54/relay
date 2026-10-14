import type { UsageStatisticsView } from "../../../shared/usage-statistics-view";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/data/i18n";
import { formatPercent } from "@/lib/meter";
import { formatUnits, hourLabel, weekdayName } from "./format";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** Pro units by weekday (rows, Monday first) and local hour; darker = more. */
export function UsageHeatmap({ view }: { view: UsageStatisticsView }) {
  const { t, language } = useI18n();
  const max = Math.max(0, ...view.heatmap.flat());
  const busiest = view.totals.busiest;
  const cellName = (weekday: number, hour: number) =>
    `${weekdayName(weekday, language)} ${hourLabel(hour)}`;
  const peak =
    busiest &&
    `${cellName(busiest.weekday, busiest.hour)}, ${formatUnits(view.heatmap[busiest.weekday]?.[busiest.hour] ?? 0, language, t)}`;
  return (
    <Card className="gap-0 px-5 py-4">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="font-display text-[15px] font-semibold">
          {t("Ne zaman çalışıyorum?", "When do I work?")}
        </h3>
        <span className="text-xs text-muted-foreground">
          {t("saat × gün", "hour × day")}
        </span>
      </div>
      <div
        role="img"
        aria-label={
          peak
            ? t(
                `Saat × gün ısı haritası. En yoğun: ${peak}.`,
                `Hour × day heatmap. Busiest: ${peak}.`,
              )
            : t(
                "Saat × gün ısı haritası. Bu dönemde kullanım yok.",
                "Hour × day heatmap. No usage in this period.",
              )
        }
        className="grid grid-cols-[1.75rem_repeat(24,minmax(0,1fr))] gap-0.5 text-[10px] leading-3 text-muted-foreground"
      >
        <span />
        {HOURS.map((hour) => (
          <span key={hour} className="text-center">
            {hour % 6 === 0 ? String(hour).padStart(2, "0") : ""}
          </span>
        ))}
        {view.heatmap.map((row, weekday) => [
          <span key={`day-${weekday}`} className="truncate">
            {weekdayName(weekday, language, "short")}
          </span>,
          ...HOURS.map((hour) => {
            const value = row[hour] ?? 0;
            return (
              <span
                key={`${weekday}-${hour}`}
                title={`${cellName(weekday, hour)} · ${formatUnits(value, language, t)}`}
                className={
                  value > 0
                    ? "h-3.5 rounded-sm bg-brand"
                    : "h-3.5 rounded-sm bg-track"
                }
                style={
                  value > 0
                    ? {
                        opacity: Math.max(
                          0.12,
                          Math.round((value / max) * 100) / 100,
                        ),
                      }
                    : undefined
                }
              />
            );
          }),
        ])}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {t("Koyu = daha çok kullanım.", "Darker = more usage.")}{" "}
        {busiest
          ? t(
              `En yoğun: ${cellName(busiest.weekday, busiest.hour)} · hafta içi 10–18 arası ${formatPercent(busiest.workShare, language)}.`,
              `Busiest: ${cellName(busiest.weekday, busiest.hour)} · ${formatPercent(busiest.workShare, language)} on weekdays 10–18.`,
            )
          : t("Bu dönemde kullanım yok.", "No usage in this period.")}
      </p>
    </Card>
  );
}
