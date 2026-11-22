import type { UsageStatisticsView } from "../../../shared/usage-statistics-view";
import type { PlanningHours } from "../../../shared/types";
import { Card } from "@/components/ui/card";
import { PageSection } from "@/components/PageSection";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { formatPercent } from "@/lib/meter";
import { hourLabel, hourRange, weekdayName } from "./format";
import type { T } from "../../../shared/i18n/translate";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
/** Opacity of the five steps; step 0 is an empty cell. */
const STEP_OPACITY = [0, 0.22, 0.4, 0.6, 0.8, 1];

/**
 * 0 for no use, else 1–5 by the cell's rank among the busy cells (`sorted`, ascending): even
 * fifths, so one outlier hour does not wash the rest out, and the busiest cell is always 5.
 */
export function heatStep(value: number, sorted: number[]): number {
  if (value <= 0 || !sorted.length) return 0;
  const atOrBelow = sorted.filter((v) => v <= value).length;
  return Math.max(1, Math.ceil((5 * atOrBelow) / sorted.length));
}

/** "Pzt–Cum 09:00–18:00" and, when on, "Cmt–Paz 11:00–17:00": the hours the work share counts. */
function hoursLine(
  weekday: PlanningHours,
  weekend: PlanningHours,
  t: T,
) {
  const part = (days: string, h: PlanningHours) => (h.enabled ? `${days} ${h.start}–${h.end}` : "");
  return [part(t("usageHeatmap.monFri"), weekday), part(t("usageHeatmap.satSun"), weekend)]
    .filter(Boolean)
    .join(", ");
}

/**
 * When the user works: use by weekday (rows, Monday first) and local hour, in five even steps so
 * one long night does not wash the rest out, with each day's and each hour's total beside the
 * grid. The summary names the busiest three hours and the share inside the user's own work hours.
 */
export function UsageHeatmap({ view }: { view: UsageStatisticsView }) {
  const { t, language } = useI18n();
  const { settings } = useRelay();
  const cells = view.heatmap;
  const busy = cells.flat().filter((v) => v > 0).sort((a, b) => a - b);
  const max = Math.max(0, ...cells.flat());
  const dayTotals = cells.map((row) => row.reduce((a, b) => a + b, 0));
  const hourTotals = HOURS.map((h) => cells.reduce((sum, row) => sum + (row[h] ?? 0), 0));
  const maxDay = Math.max(0, ...dayTotals);
  const maxHour = Math.max(0, ...hourTotals);
  const window = view.totals.busiestWindow;
  const share = view.totals.busiest?.workShare;
  const hours = hoursLine(settings.planning.weekday, settings.planning.weekend, t);
  const cellName = (weekday: number, hour: number) =>
    `${weekdayName(weekday, language, "short")} ${hourLabel(hour)}`;
  const relative = (value: number) =>
    max > 0 ? formatPercent(Math.round((value / max) * 100), language) : formatPercent(0, language);
  return (
    <PageSection
      title={t("usageHeatmap.workingHours")}
      slot="usage-heatmap"
      info={
        window && share !== undefined && hours
          ? t("usageHeatmap.busiestHoursOfUseFallsIn", { hourRange: hourRange(window.start, window.end), share: formatPercent(share, language), hours })
          : undefined
      }
      aside={
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-hidden="true">
          {t("usageHeatmap.less")}
          {STEP_OPACITY.slice(1).map((opacity) => (
            <span key={opacity} className="size-3 rounded-[3px] bg-brand" style={{ opacity }} />
          ))}
          {t("usageHeatmap.more")}
        </span>
      }>
    <Card className="gap-3 px-4 py-3.5">
      <div
        role="img"
        aria-label={
          window
            ? t("usageHeatmap.usageByDayAndHourBusiest", { hourRange: hourRange(window.start, window.end) })
            : t("usageHeatmap.usageByDayAndHourNo")
        }
        // Square cells: they take the width they get and as much height, up to a 768 px grid.
        className="grid max-w-3xl grid-cols-[2.5rem_repeat(24,minmax(0,1fr))_3rem] items-center gap-[3px] text-2xs leading-none text-muted-foreground"
      >
        <span />
        {HOURS.map((hour) => (
          <span key={hour} className="text-center tabular-nums">
            {hour % 3 === 0 ? String(hour).padStart(2, "0") : ""}
          </span>
        ))}
        <span className="text-2xs">{t("usageHeatmap.total")}</span>
        {cells.map((row, weekday) => [
          <span key={`day-${weekday}`} className="self-center truncate">
            {weekdayName(weekday, language, "short")}
          </span>,
          ...HOURS.map((hour) => {
            const value = row[hour] ?? 0;
            const step = heatStep(value, busy);
            return (
              <span
                key={`${weekday}-${hour}`}
                data-step={step}
                title={
                  value > 0
                    ? t("usageHeatmap.ofTheBusiestHour", { cellName: cellName(weekday, hour), relative: relative(value) })
                    : t("usageHeatmap.noUsage", { cellName: cellName(weekday, hour) })
                }
                className={step ? "aspect-square rounded-[3px] bg-brand" : "aspect-square rounded-[3px] bg-track"}
                style={step ? { opacity: STEP_OPACITY[step] } : undefined}
              />
            );
          }),
          <span key={`total-${weekday}`} className="flex items-center" aria-hidden="true">
            <span
              className="h-2 rounded-full bg-foreground/25"
              style={{ width: `${maxDay > 0 ? Math.max(4, (dayTotals[weekday] / maxDay) * 100) : 0}%` }}
            />
          </span>,
        ])}
        <span className="self-end text-2xs">{t("usageHeatmap.total")}</span>
        {HOURS.map((hour) => (
          <span key={`hour-${hour}`} className="flex h-6 items-end" aria-hidden="true">
            <span
              className="w-full rounded-t-[2px] bg-foreground/25"
              style={{ height: `${maxHour > 0 ? (hourTotals[hour] / maxHour) * 100 : 0}%` }}
            />
          </span>
        ))}
        <span />
      </div>
      {!window && <p className="text-sm text-muted-foreground">{t("usageHeatmap.noUsageInThisRange")}</p>}
    </Card>
    </PageSection>
  );
}
