import type { ReactNode } from "react";
import type { UsageStatisticsView } from "../../../shared/usage-statistics-view";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/data/i18n";
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
function change(current: number, previous: number, language: string) {
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
      ? t(`son ${range} gün`, `last ${range} days`)
      : previous > 0
        ? t(
            `önceki ${range} güne göre ${change(totals.proUnits, previous, "tr")}`,
            `${change(totals.proUnits, previous, "en")} vs the previous ${range} days`,
          )
        : t(`önceki ${range} günde veri yok`, `no data for the previous ${range} days`);
  const perDay = formatNumber(Math.round((totals.windows / range) * 10) / 10, language);
  const hits = totals.hits.fiveHour + totals.hits.weekly;
  const window = totals.busiestWindow;
  return (
    <Card className="gap-3 px-5 py-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile
          label={t("Kullanılan", "Used")}
          value={
            <>
              {formatNumber(totals.periods ?? 0, language)}{" "}
              {/* The unit wraps as a whole, in smaller type than the number. */}
              <span className="text-sm font-semibold whitespace-nowrap text-muted-foreground">
                {t("dolu dönem", "full periods")}
              </span>
            </>
          }
          detail={versus}
        />
        <Tile
          label={t("Başlayan dönem", "Periods started")}
          value={formatNumber(totals.windows, language)}
          detail={t(`günde ortalama ${perDay}`, `${perDay} per day on average`)}
        />
        <Tile
          label={t("Limite takılma", "Limit hits")}
          value={formatNumber(hits, language)}
          className={hits ? "text-crit" : undefined}
          detail={t(
            `${totals.hits.fiveHour} beş saatlik, ${totals.hits.weekly} haftalık`,
            `${totals.hits.fiveHour} five-hour, ${totals.hits.weekly} weekly`,
          )}
        />
        <Tile
          label={t("En yoğun saatler", "Busiest hours")}
          value={window ? hourRange(window.start, window.end) : "—"}
          detail={
            totals.busiest &&
            t(
              `çalışma saatlerinde ${formatPercent(totals.busiest.workShare, "tr")}`,
              `${formatPercent(totals.busiest.workShare, "en")} in work hours`,
            )
          }
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          `Relay bu süreyi ${formatPercent(view.coveragePercent, "tr")} gözledi; kapalıyken veri yok.`,
          `Relay observed ${formatPercent(view.coveragePercent, "en")} of this time; no data while it was closed.`,
        )}
      </p>
    </Card>
  );
}
