import type { Account } from "../../../shared/types";
import type { TokenUsageView } from "../../../shared/token-usage-view";
import { Card } from "@/components/ui/card";
import { AccountDot } from "@/components/AccountDot";
import { PageSection } from "@/components/PageSection";
import { accountTone } from "@/lib/day-timeline";
import { useI18n } from "@/data/i18n";
import { formatPercent } from "@/lib/meter";
import { cn } from "@/lib/utils";
import { formatCost } from "./format";
import { tokenColumns } from "./TokenUsage";

/** A model list names at most this many models; the rest add up to one "other" line. */
const MODELS = 4;

interface Line {
  key: string;
  name: string;
  cost: number;
  estimated: boolean;
  /** An account's line: its dot's colour name (none for the rows that are no account). */
  dot?: string;
  account?: boolean;
  /** The "other models" line, fainter. */
  quiet?: boolean;
}

/** One share line: the account's dot, name, share and amount over a thin bar, as every limit is drawn. */
function Lines({ lines, total }: { lines: Line[]; total: number }) {
  const { t, language } = useI18n();
  return (
    <ul className="grid gap-2">
      {lines.map((line) => {
        const share = total > 0 ? (line.cost / total) * 100 : 0;
        return (
          <li key={line.key} data-slot="cost-line" className={cn("grid gap-1", line.quiet && "opacity-60")}>
            <div className="flex items-center gap-2 text-sm">
              {line.account && <AccountDot color={line.dot} />}
              <span className="min-w-0 flex-1 truncate">{line.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {share > 0 && share < 1 ? t("tokenUsage.under", { percent: formatPercent(1, language) }) : formatPercent(share, language)}
              </span>
              <span className="w-20 shrink-0 text-right font-semibold tabular-nums">
                {line.estimated ? "≈" : ""}
                {formatCost(line.cost, language)}
              </span>
            </div>
            <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-track">
              <div
                className={cn("h-full rounded-full", line.account ? accountTone({ color: line.dot }) : "bg-meter")}
                style={{ width: `${Math.min(100, share)}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * What the range's tokens would cost at Anthropic's API list prices, split by account and by
 * model. It shows only what the ledger priced; the subscription's own price is not compared,
 * since Relay does not know what each account pays. The total and the daily average are the
 * summary's tile.
 */
export function CostBreakdown({
  view,
  accounts,
}: {
  view: TokenUsageView;
  accounts: Account[];
}) {
  const { t } = useI18n();
  const total = view.totals.cost ?? 0;
  if (total <= 0) return null;
  const columns = new Map(tokenColumns(view, accounts, t).map((c) => [c.key, c]));
  const byAccount: Line[] = view.rows
    .map((row) => {
      const column = columns.get(row.key);
      return {
        key: row.key,
        name: column?.name ?? row.key,
        cost: row.totals.cost ?? 0,
        estimated: row.estimated || row.totals.costEstimated === true,
        account: true,
        ...(column?.dot ? { dot: column.dot } : {}),
      };
    })
    .filter((line) => line.cost > 0)
    .sort((a, b) => b.cost - a.cost);
  const priced = view.models
    .map((m) => ({
      key: m.model,
      name: m.model,
      cost: m.totals.cost ?? 0,
      estimated: m.totals.costEstimated === true,
    }))
    .filter((line) => line.cost > 0)
    .sort((a, b) => b.cost - a.cost);
  const rest = priced.slice(MODELS);
  const byModel: Line[] = rest.length
    ? [
        ...priced.slice(0, MODELS),
        {
          key: "other",
          name: t("costBreakdown.otherModels", { restLength: rest.length }),
          cost: rest.reduce((sum, line) => sum + line.cost, 0),
          estimated: rest.some((line) => line.estimated),
          quiet: true,
        },
      ]
    : priced;
  return (
    <PageSection slot="cost-breakdown" title={t("common.apiValue")}>
      <Card className="min-w-0 gap-3 px-4 py-3.5">
        <p className="text-xs text-muted-foreground">
          {t("costBreakdown.theCostOfTheseTokensAt")}
        </p>
        <div className={cn("grid gap-4", byAccount.length > 0 && byModel.length > 0 && "@4xl:grid-cols-2")}>
          {byAccount.length > 0 && (
            <section className="grid content-start gap-2">
              <h4 className="text-xs font-semibold text-muted-foreground">{t("costBreakdown.byAccount")}</h4>
              <Lines lines={byAccount} total={total} />
            </section>
          )}
          {byModel.length > 0 && (
            <section className="grid content-start gap-2">
              <h4 className="text-xs font-semibold text-muted-foreground">{t("costBreakdown.byModel")}</h4>
              <Lines lines={byModel} total={total} />
            </section>
          )}
        </div>
      </Card>
    </PageSection>
  );
}
