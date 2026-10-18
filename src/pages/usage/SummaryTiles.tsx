import type { ReactNode } from "react";
import type { UsageStatisticsView } from "../../../shared/usage-statistics-view";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/data/i18n";
import { formatPercent } from "@/lib/meter";
import { cn } from "@/lib/utils";
import { formatNumber, hourLabel, weekdayName } from "./format";

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
        : t(
            `önceki ${range} günde veri yok`,
            `no data for the previous ${range} days`,
          );
  const perDay = formatNumber(
    Math.round((totals.windows / range) * 10) / 10,
    language,
  );
  const hits = totals.hits.fiveHour + totals.hits.weekly;
  const busiest = totals.busiest;
  return (
    <Card className="grid grid-cols-2 gap-4 px-5 py-4 lg:grid-cols-4">
      <Tile
        label={t("Toplam kullanım", "Total usage")}
        value={
          <>
            {formatNumber(totals.proUnits, language)}{" "}
            {/* The unit wraps as a whole, in smaller type than the number. */}
            <span className="text-sm font-semibold whitespace-nowrap text-muted-foreground">
              {t("Pro birimi", "Pro units")}
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
          `5 sa: ${totals.hits.fiveHour} · haftalık: ${totals.hits.weekly}`,
          `5 h: ${totals.hits.fiveHour} · weekly: ${totals.hits.weekly}`,
        )}
      />
      <Tile
        label={t("En yoğun zaman", "Busiest time")}
        value={
          busiest
            ? `${weekdayName(busiest.weekday, language)} ${hourLabel(busiest.hour)}`
            : "—"
        }
        detail={
          busiest &&
          t(
            `hafta içi 10–18 arası ${formatPercent(busiest.workShare, language)}`,
            `${formatPercent(busiest.workShare, language)} on weekdays 10–18`,
          )
        }
      />
    </Card>
  );
}
