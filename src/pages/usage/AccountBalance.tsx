import type { Account } from "../../../shared/types";
import type { UsageStatisticsView } from "../../../shared/usage-statistics-view";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/data/i18n";
import { windowTone } from "@/lib/day-timeline";
import { formatPercent } from "@/lib/meter";
import { cn } from "@/lib/utils";
import { formatCost, rowKey, rowName, toneIndex, type StatisticsRow } from "./format";
import type { CostSummary } from "./cost-summary";

/** Plan badge; a Team plan also shows the capacity weight it is counted with. */
function planBadge(row: StatisticsRow, accounts: Account[]) {
  if (!row.plan) return;
  const account = accounts.find((a) => a.id === row.accountId);
  return account?.planning?.plan === "team"
    ? `${row.plan} · ${account.planning.capacityWeight}`
    : row.plan;
}

export function AccountBalance({
  view,
  accounts,
  cost,
}: {
  view: UsageStatisticsView;
  accounts: Account[];
  /** Each account's API value in the range, shown before its share. */
  cost?: CostSummary;
}) {
  const { t, language } = useI18n();
  const percent = (value: number | undefined) => formatPercent(value, language);
  const worth = (row: StatisticsRow) => {
    const part = row.accountId ? cost?.byAccount[row.accountId] : undefined;
    return part && `${part.estimated ? "≈" : ""}${formatCost(part.cost, language)} ·`;
  };
  return (
    <Card className="gap-0 px-5 py-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="font-display text-[15px] font-semibold">
          {t("Hesap dengesi", "Account balance")}
        </h3>
        <span className="text-xs text-muted-foreground">
          {cost
            ? t(
                "API değeri · payı · ortalama dönem doluluğu · boşta gün",
                "API value · share · average period fill · idle days",
              )
            : t(
                "payı · ortalama dönem doluluğu · boşta gün",
                "share · average period fill · idle days",
              )}
        </span>
      </div>
      {/* Rows share these columns (subgrid), so every share bar ends at the same x. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 sm:grid-cols-[minmax(0,9rem)_1fr_auto_auto]">
        {view.accounts.map((row) => {
          const badge = planBadge(row, accounts);
          const share = Math.max(0, Math.min(100, row.share));
          return (
            <div
              key={rowKey(row)}
              className="col-span-full grid grid-cols-subgrid items-center gap-y-1.5 border-t py-2 first:border-t-0"
            >
              <div className="min-w-0">
                <div
                  className={cn(
                    "truncate text-sm font-semibold",
                    row.former && "text-muted-foreground",
                  )}
                >
                  {rowName(row, t)}
                </div>
                {badge && (
                  <Badge variant="secondary" className="mt-0.5">
                    {badge}
                  </Badge>
                )}
              </div>
              <div
                aria-hidden
                className="col-span-2 h-2.5 overflow-hidden rounded-full bg-track sm:col-span-1"
              >
                <div
                  className={cn(
                    "h-full rounded-full",
                    windowTone(toneIndex(row, accounts)),
                  )}
                  style={{ width: `${share}%` }}
                />
              </div>
              <div className="text-sm whitespace-nowrap tabular-nums">
                {worth(row) && <b className="mr-1.5">{worth(row)}</b>}
                <b>{percent(row.share)}</b>{" "}
                <span className="text-muted-foreground">
                  ·{" "}
                  {t(
                    `doluluk ${percent(row.averageFill)}`,
                    `fill ${percent(row.averageFill)}`,
                  )}
                </span>
              </div>
              <div className="text-sm whitespace-nowrap text-muted-foreground tabular-nums">
                {t(
                  `boşta ${row.idleDays} gün`,
                  `idle ${row.idleDays} ${row.idleDays === 1 ? "day" : "days"}`,
                )}
              </div>
            </div>
          );
        })}
      </div>
      {view.insight && (
        <p className="mt-2 border-t pt-2 text-[13px] text-muted-foreground">
          <b className="text-foreground">{t("Gözlem:", "Insight:")}</b>{" "}
          {t(view.insight.tr, view.insight.en)}
        </p>
      )}
    </Card>
  );
}
