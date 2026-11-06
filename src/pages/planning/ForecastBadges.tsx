import type { Forecast } from "../../../shared/capacity-plan";
import type { Tempo } from "../../../shared/tempo";
import { forecastSummary } from "@/lib/forecast-text";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type T = (tr: string, en: string) => string;

const SOURCE: Record<Tempo["source"], [string, string]> = {
  learned: ["Yoğun gün temposuyla", "At the busy-day tempo"],
  preset: ["Sabit tempoyla", "At a fixed tempo"],
  default: ["Varsayılan tempoyla", "At the default tempo"],
};

const warnChip = "bg-warn/15 text-warn-foreground";

/**
 * The hero's forecast pill, led by the day it covers, and the tempo it
 * assumes; while the keeper adapts the day, today's pace and that the plan
 * moved.
 */
export function ForecastBadges({
  forecast,
  day,
  source,
  factor = 1,
  adapted = false,
  clock,
  t,
}: {
  forecast: Forecast;
  /** Which day the forecast covers, as its lead ("Bugün kalan: ", "Yarın tahmini: " …). */
  day: string;
  source: Tempo["source"];
  /** Today's pace against the plan's (1 = as planned). */
  factor?: number;
  /** Whether the keeper moved a start today. */
  adapted?: boolean;
  clock: (time: number) => string;
  t: T;
}) {
  const gap = forecast.segments.some((s) => !s.accountId);
  const text = day + forecastSummary(forecast, t, clock);
  const pace = new Intl.NumberFormat(t("tr-TR", "en-GB"), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(factor);
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      <Badge
        variant="secondary"
        className={cn(
          "max-w-full whitespace-normal text-foreground",
          gap ? "bg-warn/15" : "bg-ok/15",
        )}
      >
        <i
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            gap ? "bg-warn" : "bg-ok",
          )}
          aria-hidden="true"
        />
        {text}
      </Badge>
      <Badge variant="secondary">{t(...SOURCE[source])}</Badge>
      {factor > 1 && (
        <Badge variant="secondary" className={warnChip}>
          {t(
            `Bugün plandan ${pace} kat hızlısın`,
            `Today: ${pace}× the planned pace`,
          )}
        </Badge>
      )}
      {adapted && (
        <Badge variant="secondary" className={warnChip}>
          {t("Plan uyarlandı", "Plan adapted")}
        </Badge>
      )}
    </div>
  );
}
