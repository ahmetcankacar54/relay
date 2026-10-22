import type { TokenUsageView } from "../../../shared/token-usage-view";

/** The range's API value for the Limits tab: the total, its daily average and each account's part. */
export interface CostSummary {
  total: number;
  /** Some of it was estimated (≈). */
  estimated: boolean;
  perDay: number;
  byAccount: Record<string, { cost: number; estimated: boolean }>;
}

/** Undefined without a view or before anything in the range was priced. */
export function costSummary(view: TokenUsageView | undefined): CostSummary | undefined {
  const total = view?.totals.cost ?? 0;
  if (!view || total <= 0) return undefined;
  const byAccount: CostSummary["byAccount"] = {};
  for (const row of view.rows)
    if (row.kind === "account" && row.accountId && (row.totals.cost ?? 0) > 0)
      byAccount[row.accountId] = {
        cost: row.totals.cost ?? 0,
        estimated: row.estimated || row.totals.costEstimated === true,
      };
  return {
    total,
    estimated: view.totals.costEstimated === true,
    perDay: total / (view.days.length || view.range),
    byAccount,
  };
}
