import { useState } from "react";
import type { UsageStatisticsView } from "../../../shared/usage-statistics-view";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/data/i18n";
import { formatClock } from "@/lib/time";
import { formatDuration, locale, rowName } from "./format";

/** Hits shown before "Show all". */
const VISIBLE = 8;

export function LimitHits({
  view,
  zone,
}: {
  view: UsageStatisticsView;
  zone: string;
}) {
  const { t, language } = useI18n();
  const [all, setAll] = useState(false);
  const hits = [...view.hits].sort(
    (a, b) => Date.parse(b.at) - Date.parse(a.at),
  );
  const shown = all ? hits : hits.slice(0, VISIBLE);
  const day = new Intl.DateTimeFormat(locale(language), {
    day: "numeric",
    month: "short",
    timeZone: zone,
  });
  return (
    <Card className="gap-0 px-5 py-4">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="font-display text-[15px] font-semibold">
          {t("Limite takılmalar", "Limit hits")}
        </h3>
        <span className="text-xs text-muted-foreground">
          {t(`son ${view.range} gün`, `last ${view.range} days`)}
        </span>
      </div>
      {hits.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          {t("Bu dönemde limite takılma yok.", "No limit hits in this period.")}
        </p>
      ) : (
        <ul className="grid gap-1 text-[13px]">
          {shown.map((hit) => {
            const at = Date.parse(hit.at);
            const until = hit.until ? Date.parse(hit.until) : undefined;
            return (
              <li key={`${hit.accountId ?? "former"}-${hit.kind}-${hit.at}`}>
                <time
                  dateTime={hit.at}
                  className="text-muted-foreground tabular-nums"
                >
                  {`${day.format(at)} ${formatClock(at, language, zone)}`}
                </time>
                {" · "}
                <b>{rowName(hit, t)}</b>
                {" · "}
                {hit.kind === "five-hour"
                  ? t("5 saatlik", "5-hour")
                  : t("haftalık", "weekly")}
                {" · "}
                {until === undefined ? (
                  <span className="text-crit">{t("sürüyor", "ongoing")}</span>
                ) : (
                  t(
                    `${formatDuration(until - at, language)} boyunca dolu`,
                    `full for ${formatDuration(until - at, language)}`,
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}
      {hits.length > VISIBLE && (
        <Button
          variant="link"
          size="sm"
          className="h-auto self-start px-0 pt-1"
          onClick={() => setAll(!all)}
        >
          {all
            ? t("Daha az göster", "Show fewer")
            : t(`Tümünü göster (${hits.length})`, `Show all (${hits.length})`)}
        </Button>
      )}
    </Card>
  );
}
