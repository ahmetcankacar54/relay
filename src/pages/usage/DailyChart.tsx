import { useState } from "react";
import { localDate } from "../../../shared/planning";
import type { Account } from "../../../shared/types";
import type { UsageStatisticsView } from "../../../shared/usage-statistics-view";
import type { TokenUsageView } from "../../../shared/token-usage-view";
import { FORMAT_LOCALE } from "../../../shared/i18n/locales";
import { Card } from "@/components/ui/card";
import { DailyTrend } from "./DailyTrend";
import { accountColor } from "@/components/AccountDot";
import { PageSection } from "@/components/PageSection";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useI18n, type Language, type T } from "@/data/i18n";
import {
  formatCost,
  formatDay,
  formatDayLong,
  formatNumber,
  formatTokens,
  formatPeriods,
  rowKey,
  rowName,
  toneIndex,
} from "./format";
import { tokenColumns } from "./TokenUsage";


/** What the bars count: Pro units from the limit history, or the token ledger's tokens or API value. */
export type DailyMeasure = "limit" | "tokens" | "cost";
const MEASURES: DailyMeasure[] = ["limit", "tokens", "cost"];

/** A coloured series: an account's tone, or the muted grey of the token rows that are no account. */
interface Series {
  key: string;
  name: string;
  tone?: number;
  muted?: string;
}
interface Day {
  date: string;
  total: number;
  /** The series with a value that day, ≈ where the ledger estimated it. */
  parts: (Series & { value: number; estimated: boolean })[];
}

/** Round guide steps per decade: $1, $1.50, $2, $2.50, $3, $4, $5, $7.50 and their tens. */
const GUIDE_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5];
/**
 * Two round API values for the dashed guides of the $ chart: the largest round
 * step whose double still fits under the busiest day ($75 and $150 below
 * $200); none under ten cents.
 */
export function costGuides(max: number): [number, number] | undefined {
  if (!(max > 0)) return undefined;
  const top = Math.floor(Math.log10(max));
  let best = 0;
  for (let p = top - 1; p <= top; p++)
    for (const m of GUIDE_STEPS) {
      const step = Number((m * 10 ** p).toPrecision(3));
      if (step * 2 <= max) best = Math.max(best, step);
    }
  return best >= 0.1 ? [best, best * 2] : undefined;
}

/** A guide's label: "$75", "$2,5" — no cents a round value does not need. */
const guideFormats = new Map<Language, Intl.NumberFormat>();
export function guideLabel(value: number, language: Language) {
  let f = guideFormats.get(language);
  if (!f) {
    f = new Intl.NumberFormat(FORMAT_LOCALE[language], {
      style: "currency",
      currency: "USD",
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
    guideFormats.set(language, f);
  }
  return f.format(value);
}

/** The series and days a measure draws: the limit history's accounts, or the token ledger's rows. */
function measured(
  measure: DailyMeasure,
  view: UsageStatisticsView,
  tokens: TokenUsageView | undefined,
  accounts: Account[],
  t: T,
): { series: Series[]; days: Day[] } {
  if (measure === "limit" || !tokens) {
    const series = view.accounts.map((row) => ({
      key: rowKey(row),
      name: rowName(row, t),
      tone: toneIndex(row, accounts),
    }));
    return {
      series,
      // Full 5-hour periods, unweighted; a view from an older main without them keeps Pro units.
      days: view.daily.map((day) => {
        const values = day.periods ?? day.byAccount;
        const parts = series
          .map((s) => ({
            ...s,
            value: values[s.key] ?? 0,
            estimated: false,
          }))
          .filter((part) => part.value > 0);
        return {
          date: day.date,
          total: Object.values(values).reduce((a, b) => a + b, 0),
          parts,
        };
      }),
    };
  }
  const series = tokenColumns(tokens, accounts, t);
  return {
    series,
    days: tokens.days.map((day) => {
      const parts = series
        .map((s) => {
          const cell = day.byRow[s.key];
          const value = !cell
            ? 0
            : measure === "cost"
              ? (cell.cost ?? 0)
              : cell.input + cell.output + cell.cacheWrite + cell.cacheRead;
          const estimated =
            cell?.estimated === true ||
            (measure === "cost" && cell?.costEstimated === true);
          return { ...s, value, estimated };
        })
        .filter((part) => part.value > 0);
      return {
        date: day.date,
        total: parts.reduce((sum, part) => sum + part.value, 0),
        parts,
      };
    }),
  };
}

/**
 * Stacked values per local day, coloured by account, ▲ on days with a limit hit; pointing at a day
 * details it. With the token ledger's view the bars can count tokens or the API value instead of
 * Pro units; the $ bars get two dashed guides at round values.
 */
export function DailyChart({
  view,
  tokens,
  accounts,
  zone,
}: {
  view: UsageStatisticsView;
  /** The token ledger's view of the same range; without it only Pro units are drawn. */
  tokens?: TokenUsageView;
  accounts: Account[];
  zone: string;
}) {
  const { t, language } = useI18n();
  const [chosen, setChosen] = useState<DailyMeasure>("limit");
  const measure: DailyMeasure = tokens ? chosen : "limit";
  const { series, days } = measured(measure, view, tokens, accounts, t);
  const hitDays = new Set(
    view.hits.map((hit) => localDate(Date.parse(hit.at), zone)),
  );
  /** A value as the axis and the detail write it. */
  const format = (value: number) =>
    measure === "cost"
      ? formatCost(value, language)
      : measure === "tokens"
        ? formatTokens(value, language)
        : formatNumber(value, language);
  /** A value with its unit, as a day's label and the footer say it. */
  const spoken = (value: number) =>
    measure === "cost"
      ? formatCost(value, language)
      : measure === "tokens"
        ? t("dailyChart.tokensSpoken", { count: value, tokens: formatTokens(value, language) })
        : formatPeriods(value, language, t);
  const busiest = days.reduce<Day | undefined>(
    (best, day) => (day.total > (best?.total ?? 0) ? day : best),
    undefined,
  );
  const approx = (day: Day) => (day.parts.some((p) => p.estimated) ? "≈" : "");
  const total = days.reduce((sum, day) => sum + day.total, 0);
  const estimatedRange = days.some((day) => approx(day));
  const labels: Record<DailyMeasure, string> = {
    limit: t("dailyChart.limit"),
    tokens: t("dailyChart.tokens"),
    cost: "$",
  };
  const footer = !busiest
    ? measure === "limit"
      ? t("dailyChart.noUsageInThisRange")
      : t("dailyChart.noTokensInThisRange")
    : measure === "cost"
      ? t("dailyChart.apiValueOverDaysHighestDay", { viewRange: view.range, spoken: `${estimatedRange ? "≈" : ""}${spoken(total)}`, formatDay: formatDay(busiest.date, language), format: format(busiest.total) })
      : t("dailyChart.overDaysBusiestDay", { spoken: `${estimatedRange ? "≈" : ""}${spoken(total)}`, viewRange: view.range, formatDay: formatDay(busiest.date, language), format: format(busiest.total) });
  // Each series in its account's own colour (the dot's), the rows that are no account in grey.
  const colorOf = (s: Series) =>
    s.muted ? "var(--account-none)" : accountColor(accounts.find((a) => a.id === s.key)?.color);
  const trendDays = days.map((day) => ({
    date: day.date,
    total: day.total,
    hit: hitDays.has(day.date) && day.total > 0,
    values: Object.fromEntries(day.parts.map((part) => [part.key, part.value])),
  }));
  const trendSeries = series.map((s) => {
    const sum = days.reduce((acc, day) => acc + (day.parts.find((p) => p.key === s.key)?.value ?? 0), 0);
    const estimated = days.some((day) => day.parts.some((p) => p.key === s.key && p.estimated));
    return { key: s.key, name: s.name, color: colorOf(s), total: `${estimated ? "≈" : ""}${format(sum)}` };
  });
  const hitLabel = t("dailyChart.limitHit");
  return (
    <PageSection
      title={t("dailyChart.daily")}
      slot="daily-chart"
      aside={
        tokens && (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-label={t("dailyChart.measure")}
            value={measure}
            onValueChange={(v) => v && setChosen(v as DailyMeasure)}
          >
            {MEASURES.map((m) => (
              <ToggleGroupItem key={m} value={m} aria-label={m === "cost" ? t("common.apiValue") : undefined}>
                {labels[m]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )
      }
    >
      <Card className="gap-2 px-4 py-3.5">
        <DailyTrend
          slot="daily-trend"
          days={trendDays}
          series={trendSeries}
          totalLabel={labels[measure]}
          tickDay={(d) => formatDay(d, language)}
          tickValue={(v) => (measure === "cost" ? guideLabel(v, language) : format(v))}
          axisWidth={44}
          tooltip={(date) => {
            const day = days.find((d) => d.date === date);
            if (!day) return null;
            const hit = hitDays.has(day.date);
            return (
              <div className="grid min-w-44 gap-1 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
                <div className="font-semibold">
                  {formatDayLong(day.date, language)}
                  {hit && <span className="font-normal text-crit"> · ▲ {hitLabel}</span>}
                </div>
                <div className="flex items-baseline justify-between gap-4 border-b pb-1">
                  <span className="text-muted-foreground">{t("common.total")}</span>
                  <b className="tabular-nums">{approx(day)}{format(day.total)}</b>
                </div>
                <ul className="grid gap-1">
                  {day.parts.map((part) => (
                    <li key={part.key} className="flex items-center gap-2">
                      <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: colorOf(part) }} />
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">{part.name}</span>
                      <span className="tabular-nums">{part.estimated ? "≈" : ""}{format(part.value)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          }}
        />
        <p className="text-xs text-muted-foreground">{footer}</p>
        {/* The same days as a list, for screen readers and as the chart's table view. */}
        <ul className="sr-only" aria-label={t("dailyChart.dailyValues")}>
          {days.map((day) => (
            <li key={day.date}>
              {t("dailyChart.dayValue", { day: formatDayLong(day.date, language), value: `${approx(day)}${spoken(day.total)}`, hit: hitDays.has(day.date) ? "yes" : "no" })}
            </li>
          ))}
        </ul>
      </Card>
    </PageSection>
  );
}
