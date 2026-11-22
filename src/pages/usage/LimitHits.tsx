import { useState } from "react";
import type { UsageStatisticsView } from "../../../shared/usage-statistics-view";
import { FORMAT_LOCALE } from "../../../shared/i18n/locales";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageSection } from "@/components/PageSection";
import { useI18n } from "@/data/i18n";
import { formatClock } from "@/lib/time";
import { formatDuration, rowName } from "./format";

/** Hits shown before "Show all". */
const VISIBLE = 5;

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
  const day = new Intl.DateTimeFormat(FORMAT_LOCALE[language], {
    day: "numeric",
    month: "short",
    timeZone: zone,
  });
  return (
    <PageSection title={t("limitHits.limitHits")} slot="limit-hits">
    <Card padded>
      {hits.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("limitHits.noLimitHitsInThisRange")}
        </p>
      ) : (
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] gap-x-4 text-sm">
          <div className="col-span-full grid grid-cols-subgrid pb-1.5 text-xs text-muted-foreground">
            <span>{t("limitHits.when")}</span>
            <span>{t("common.account")}</span>
            <span>{t("limitHits.limit")}</span>
            <span className="text-right">{t("limitHits.fullFor")}</span>
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
                <span>{hit.kind === "five-hour" ? t("limitHits.n5Hour") : t("limitHits.weekly")}</span>
                <span className="text-right tabular-nums">
                  {until === undefined ? (
                    <span className="text-crit">{t("limitHits.ongoing")}</span>
                  ) : (
                    formatDuration(until - at, t)
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
            ? t("limitHits.showFewer")
            : t("limitHits.showAll", { hitsLength: hits.length })}
        </Button>
      )}
    </Card>
    </PageSection>
  );
}
