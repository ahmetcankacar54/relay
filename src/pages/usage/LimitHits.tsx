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
    <Card className="gap-0 px-4 py-3.5">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="font-display text-sm font-semibold">
          {t("Limite takılmalar", "Limit hits")}
        </h3>
      </div>
      {hits.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("Bu aralıkta limite takılma yok.", "No limit hits in this range.")}
        </p>
      ) : (
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] gap-x-4 text-sm">
          <div className="col-span-full grid grid-cols-subgrid pb-1.5 text-xs text-muted-foreground">
            <span>{t("Zaman", "When")}</span>
            <span>{t("Hesap", "Account")}</span>
            <span>{t("Limit", "Limit")}</span>
            <span className="text-right">{t("Dolu kaldı", "Full for")}</span>
          </div>
          {shown.map((hit) => {
            const at = Date.parse(hit.at);
            const until = hit.until ? Date.parse(hit.until) : undefined;
            return (
              <div
                key={`${hit.accountId ?? "former"}-${hit.kind}-${hit.at}`}
                className="col-span-full grid grid-cols-subgrid border-t py-1.5"
              >
                <time dateTime={hit.at} className="text-muted-foreground tabular-nums">
                  {`${day.format(at)} ${formatClock(at, language, zone)}`}
                </time>
                <b className="truncate">{rowName(hit, t)}</b>
                <span>{hit.kind === "five-hour" ? t("5 saatlik", "5-hour") : t("haftalık", "weekly")}</span>
                <span className="text-right tabular-nums">
                  {until === undefined ? (
                    <span className="text-crit">{t("sürüyor", "ongoing")}</span>
                  ) : (
                    formatDuration(until - at, language)
                  )}
                </span>
              </div>
            );
          })}
        </div>
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
