import type { Account } from "../../../shared/types";
import type { UsageStatisticsView } from "../../../shared/usage-statistics-view";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/data/i18n";
import { windowTone } from "@/lib/day-timeline";
import { formatPercent } from "@/lib/meter";
import { cn } from "@/lib/utils";
import { rowKey, rowName, toneIndex, type StatisticsRow } from "./format";

/** Plan badge; a Team plan also shows the capacity weight it is counted with. */
function planBadge(row: StatisticsRow, accounts: Account[]) {
  if (!row.plan) return;
  const account = accounts.find((a) => a.id === row.accountId);
  return account?.planning?.plan === "team"
    ? `${row.plan} · ${account.planning.capacityWeight}`
    : row.plan;
}

/**
 * Each account's part of the range as a table: its share (bar and percent), the average fill of
 * its finished periods and its idle days, each in its own column under a header.
 */
export function AccountBalance({
  view,
  accounts,
}: {
  view: UsageStatisticsView;
  accounts: Account[];
}) {
  const { t, language } = useI18n();
  const percent = (value: number | undefined) => formatPercent(value, language);
  const head = "text-xs font-normal text-muted-foreground";
  return (
    <Card className="gap-0 px-5 py-4">
      <h3 className="mb-2 font-display text-[15px] font-semibold">
        {t("Hesap dengesi", "Account balance")}
      </h3>
      {/* Rows share these columns (subgrid), so every share bar ends at the same x. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-x-4 sm:grid-cols-[minmax(0,12rem)_1fr_auto_auto_auto]">
        <div className="col-span-full grid grid-cols-subgrid pb-1.5">
          <span className={head}>{t("Hesap", "Account")}</span>
          <span className="hidden sm:block" />
          <span className={cn(head, "text-right")}>{t("Pay", "Share")}</span>
          <span className={cn(head, "text-right")}>{t("Ort. doluluk", "Avg. fill")}</span>
          <span className={cn(head, "text-right")}>{t("Boşta", "Idle")}</span>
        </div>
        {view.accounts.map((row) => {
          const badge = planBadge(row, accounts);
          const share = Math.max(0, Math.min(100, row.share));
          return (
            <div
              key={rowKey(row)}
              className="col-span-full grid grid-cols-subgrid items-center border-t py-2"
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <span className={cn("truncate text-sm font-semibold", row.former && "text-muted-foreground")}>
                  {rowName(row, t)}
                </span>
                {badge && <Badge variant="secondary">{badge}</Badge>}
              </div>
              <div aria-hidden className="hidden h-2.5 overflow-hidden rounded-full bg-track sm:block">
                <div
                  className={cn("h-full rounded-full", windowTone(toneIndex(row, accounts)))}
                  style={{ width: `${share}%` }}
                />
              </div>
              <span className="text-right text-sm font-semibold tabular-nums">{percent(row.share)}</span>
              <span className="text-right text-sm tabular-nums">{percent(row.averageFill)}</span>
              <span className="text-right text-sm text-muted-foreground tabular-nums">
                {t(`${row.idleDays} gün`, `${row.idleDays} ${row.idleDays === 1 ? "day" : "days"}`)}
              </span>
            </div>
          );
        })}
      </div>
      {view.insight && (
        <p className="mt-1 border-t pt-2 text-[13px] text-muted-foreground">
          {t(view.insight.tr, view.insight.en)}
        </p>
      )}
    </Card>
  );
}
