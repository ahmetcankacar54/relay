import type { ReactNode } from "react";
import type { UsageStatisticsView } from "../../../shared/usage-statistics-view";
import { Card } from "@/components/ui/card";
import { PageSection } from "@/components/PageSection";
import { useI18n, type Language } from "@/data/i18n";
import { formatPercent } from "@/lib/meter";
import { cn } from "@/lib/utils";
import { formatNumber, hourRange } from "./format";

function Tile({
  label,
  value,
  detail,
  className,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  className?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "font-display text-xl font-bold tracking-tight tabular-nums",
          className,
        )}
      >
        {value}
      </div>
      {detail && <div className="text-xs text-muted-foreground">{detail}</div>}
    </div>
  );
}

/** "+%12" / "−%8" ("+12%" / "−8%" in English) against the previous period of the same length. */
function change(current: number, previous: number, language: Language) {
  const pct = Math.round(((current - previous) / previous) * 100);
  return `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${formatPercent(Math.abs(pct), language)}`;
}

/**
 * The Limits tab's four numbers, all from the limits: full 5-hour periods used, periods started,
 * limits reached and the busiest hours, with how much of the range Relay observed.
 */
export function SummaryTiles({ view }: { view: UsageStatisticsView }) {
  const { t, language } = useI18n();
  const { totals, range } = view;
  const previous = totals.previousProUnits;
  const versus =
    previous === undefined
      ? t("summaryTiles.lastDays", { range })
      : previous > 0
        ? t("summaryTiles.vsThePreviousDays", { change: change(totals.proUnits, previous, language), range })
        : t("summaryTiles.noDataForThePreviousDays", { range });
  const perDay = formatNumber(Math.round((totals.windows / range) * 10) / 10, language);
  const hits = totals.hits.fiveHour + totals.hits.weekly;
  const window = totals.busiestWindow;
  return (
    <PageSection
      title={t("summaryTiles.summary")}
      slot="summary-tiles"
      info={
        <>
          {t("summaryTiles.relayCouldReadTheLimitsFor", { coverage: formatPercent(view.coveragePercent, language) })} {t("summaryTiles.theNumbersComeFromTheLimit")}
        </>
      }
    >
    <Card className="gap-3 px-4 py-3.5">
      <div className="grid grid-cols-2 gap-4 @2xl:grid-cols-4">
        <Tile
          label={t("summaryTiles.used")}
          value={
            <>
              {formatNumber(totals.periods ?? 0, language)}{" "}
              {/* The unit wraps as a whole, in smaller type than the number. */}
              <span className="text-sm font-semibold whitespace-nowrap text-muted-foreground">
                {t("summaryTiles.fullPeriods")}
              </span>
            </>
          }
          detail={versus}
        />
        <Tile
          label={t("summaryTiles.periodsStarted")}
          value={formatNumber(totals.windows, language)}
          detail={t("summaryTiles.perDayOnAverage", { perDay })}
        />
        <Tile
          label={t("summaryTiles.limitHits")}
          value={formatNumber(hits, language)}
          detail={t("summaryTiles.fiveHourWeekly", { hitsFiveHour: totals.hits.fiveHour, hitsWeekly: totals.hits.weekly })}
        />
        <Tile
          label={t("summaryTiles.busiestHours")}
          value={window ? hourRange(window.start, window.end) : "—"}
          detail={
            totals.busiest &&
            t("summaryTiles.inWorkHours", { share: formatPercent(totals.busiest.workShare, language) })
          }
        />
      </div>
    </Card>
    </PageSection>
  );
}
