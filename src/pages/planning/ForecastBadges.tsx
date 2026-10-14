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

/** The hero's forecast pill (the rest of today while work runs) and the tempo it assumes. */
export function ForecastBadges({
  forecast,
  live,
  source,
  clock,
  t,
}: {
  forecast: Forecast;
  /** The live forecast of today's work from now, rather than a plan's. */
  live: boolean;
  source: Tempo["source"];
  clock: (time: number) => string;
  t: T;
}) {
  const gap = forecast.segments.some((s) => !s.accountId);
  const text =
    (live
      ? t("Bugün kalan: ", "Rest of today: ")
      : t("Tahmin: ", "Forecast: ")) + forecastSummary(forecast, t, clock);
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
    </div>
  );
}
