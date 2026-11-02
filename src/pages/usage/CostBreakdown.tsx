import type { Account } from "../../../shared/types";
import type { TokenUsageView } from "../../../shared/token-usage-view";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/data/i18n";
import { formatPercent } from "@/lib/meter";
import { cn } from "@/lib/utils";
import { Swatch } from "./DayHover";
import { formatCost } from "./format";
import { tokenColumns } from "./TokenUsage";

/** A model list names at most this many models; the rest add up to one "other" line. */
const MODELS = 4;

interface Line {
  key: string;
  name: string;
  cost: number;
  estimated: boolean;
  tone?: number;
  muted?: string;
}

/** One share line: colour, name, a thin bar of its share and the amount. */
function Lines({ lines, total }: { lines: Line[]; total: number }) {
  const { language } = useI18n();
  return (
    <ul className="grid gap-2">
      {lines.map((line) => {
        const share = total > 0 ? (line.cost / total) * 100 : 0;
        return (
          <li key={line.key} data-slot="cost-line" className="grid gap-1">
            <div className="flex items-center gap-2 text-[13px]">
              {line.tone !== undefined || line.muted ? (
                <Swatch tone={line.tone} muted={line.muted} />
              ) : (
                <i aria-hidden className="size-2.5 shrink-0 rounded-sm bg-primary/70" />
              )}
              <span className="min-w-0 flex-1 truncate">{line.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {share > 0 && share < 1 ? (language === "tr" ? "<%1" : "<1%") : formatPercent(share, language)}
              </span>
              <span className="w-20 shrink-0 text-right font-semibold tabular-nums">
                {line.estimated ? "≈" : ""}
                {formatCost(line.cost, language)}
              </span>
            </div>
            <div aria-hidden className="h-1 overflow-hidden rounded-full bg-track">
              <div className="h-full rounded-full bg-primary/80" style={{ width: `${Math.min(100, share)}%` }} />
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
 * since Relay does not know what each account pays.
 */
export function CostBreakdown({
  view,
  accounts,
}: {
  view: TokenUsageView;
  accounts: Account[];
}) {
  const { t, language } = useI18n();
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
        tone: column?.tone,
        muted: column?.muted,
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
          name: t(`Diğer ${rest.length} model`, `${rest.length} other ${rest.length === 1 ? "model" : "models"}`),
          cost: rest.reduce((sum, line) => sum + line.cost, 0),
          estimated: rest.some((line) => line.estimated),
          muted: "opacity-50",
        },
      ]
    : priced;
  const days = view.days.length || view.range;
  const perDay = total / days;
  const estimated = view.totals.costEstimated === true;
  return (
    <Card data-slot="cost-breakdown" className="min-w-0 gap-4 px-5 py-4">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
        <div>
          <h3 className="font-display text-[15px] font-semibold">
            {t("API karşılığı", "API value")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t(
              "Bu token’lar API liste fiyatıyla ödenseydi tutacak tutar. Aboneliğinin ücreti ayrıdır.",
              "What these tokens would cost at API list prices. Your subscription is priced separately.",
            )}
          </p>
        </div>
        <div className="text-right">
          <div className="font-display text-2xl font-bold tracking-tight tabular-nums">
            {estimated ? "≈" : ""}
            {formatCost(total, language)}
          </div>
          <div className="text-xs text-muted-foreground tabular-nums">
            {t(
              `son ${view.range} gün · günde ${formatCost(perDay, "tr")}`,
              `last ${view.range} days · ${formatCost(perDay, "en")} a day`,
            )}
          </div>
        </div>
      </div>
      <div className={cn("grid gap-6", byAccount.length > 0 && byModel.length > 0 && "lg:grid-cols-2")}>
        {byAccount.length > 0 && (
          <section className="grid content-start gap-2">
            <h4 className="text-xs font-semibold text-muted-foreground">{t("Hesaba göre", "By account")}</h4>
            <Lines lines={byAccount} total={total} />
          </section>
        )}
        {byModel.length > 0 && (
          <section className="grid content-start gap-2">
            <h4 className="text-xs font-semibold text-muted-foreground">{t("Modele göre", "By model")}</h4>
            <Lines lines={byModel} total={total} />
          </section>
        )}
      </div>
    </Card>
  );
}
