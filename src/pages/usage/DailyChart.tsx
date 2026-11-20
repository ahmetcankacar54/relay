import { useState } from "react";
import { localDate } from "../../../shared/planning";
import type { Account } from "../../../shared/types";
import type { UsageStatisticsView } from "../../../shared/usage-statistics-view";
import type { TokenUsageView } from "../../../shared/token-usage-view";
import { Bar, CartesianGrid, ComposedChart, Scatter, XAxis, YAxis } from "recharts";
import { Card } from "@/components/ui/card";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { AccountDot, accountColor } from "@/components/AccountDot";
import { PageSection } from "@/components/PageSection";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useI18n, type Language, type T } from "@/data/i18n";
import { cn } from "@/lib/utils";
import { DayTipRow, DayTooltip, Swatch, useDayHover } from "./DayHover";
import {
  formatCost,
  formatDay,
  formatDayLong,
  formatNumber,
  formatTokens,
  formatPeriods,
  locale,
  rowKey,
  rowName,
  toneFill,
  toneIndex,
} from "./format";
import { tokenColumns } from "./TokenUsage";

// viewBox units; the chart scales with the card width (about 420–700 px), so
// its 9-unit labels stay readable at both ends.
const WIDTH = 440;
const TOP = 14;
const BASE = 128;
const HEIGHT = 146;
/** Narrowest y-label gutter, and the width a 9-unit label character takes. */
const MIN_LEFT = 28;
const LABEL_CHAR = 5.5;
/** Hit markers are as wide as their bar, at most this wide. */
const MARK = 6;

const r2 = (v: number) => Math.round(v * 100) / 100;
/** An upward triangle `width` wide, centred on `cx`, standing on `base`. */
const triangle = (cx: number, base: number, width: number) =>
  `M ${r2(cx - width / 2)} ${r2(base)} L ${r2(cx + width / 2)} ${r2(base)} L ${r2(cx)} ${r2(base - width * 0.85)} Z`;

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
    f = new Intl.NumberFormat(locale(language), {
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
        ? `${formatTokens(value, language)} ${t("token", value === 1 ? "token" : "tokens")}`
        : formatPeriods(value, language, t);
  const busiest = days.reduce<Day | undefined>(
    (best, day) => (day.total > (best?.total ?? 0) ? day : best),
    undefined,
  );
  const approx = (day: Day) => (day.parts.some((p) => p.estimated) ? "≈" : "");
  const total = days.reduce((sum, day) => sum + day.total, 0);
  const estimatedRange = days.some((day) => approx(day));
  const labels: Record<DailyMeasure, string> = {
    limit: t("Limit", "Limit"),
    tokens: t("Token", "Tokens"),
    cost: "$",
  };
  const footer = !busiest
    ? measure === "limit"
      ? t("Bu aralıkta kullanım yok.", "No usage in this range.")
      : t("Bu aralıkta token yok.", "No tokens in this range.")
    : measure === "limit"
      ? t(
          `${view.range} günde ${spoken(total)}. En yoğun gün ${formatDay(busiest.date, language)}: ${format(busiest.total)}.`,
          `${spoken(total)} over ${view.range} days. Busiest day ${formatDay(busiest.date, language)}: ${format(busiest.total)}.`,
        )
      : measure === "tokens"
        ? t(
            `${view.range} günde ${estimatedRange ? "≈" : ""}${spoken(total)}. En yoğun gün ${formatDay(busiest.date, language)}: ${format(busiest.total)}.`,
            `${estimatedRange ? "≈" : ""}${spoken(total)} over ${view.range} days. Busiest day ${formatDay(busiest.date, language)}: ${format(busiest.total)}.`,
          )
        : t(
            `${view.range} günde API karşılığı ${estimatedRange ? "≈" : ""}${spoken(total)}. En yüksek gün ${formatDay(busiest.date, language)}: ${format(busiest.total)}.`,
            `API value over ${view.range} days: ${estimatedRange ? "≈" : ""}${spoken(total)}. Highest day ${formatDay(busiest.date, language)}: ${format(busiest.total)}.`,
          );
  // Each series in its account's own colour (the dot's), the rows that are no account in grey.
  const colorOf = (s: Series) =>
    s.muted ? "var(--account-none)" : accountColor(accounts.find((a) => a.id === s.key)?.color);
  const config: ChartConfig = Object.fromEntries(series.map((s) => [s.key, { label: s.name, color: colorOf(s) }]));
  const data = days.map((day) => ({
    date: day.date,
    total: day.total,
    // ▲ sits on top of a day with a limit hit.
    hit: hitDays.has(day.date) && day.total > 0 ? day.total : undefined,
    ...Object.fromEntries(day.parts.map((part) => [part.key, part.value])),
  }));
  const hitLabel = t("limite takıldı", "limit hit");
  return (
    <PageSection
      title={t("Günlük", "Daily")}
      slot="daily-chart"
      aside={
        tokens && (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-label={t("Ölçü", "Measure")}
            value={measure}
            onValueChange={(v) => v && setChosen(v as DailyMeasure)}
          >
            {MEASURES.map((m) => (
              <ToggleGroupItem key={m} value={m} aria-label={m === "cost" ? t("API karşılığı", "API value") : undefined}>
                {labels[m]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )
      }
    >
      <Card className="gap-2 px-4 py-3.5">
        <ChartContainer config={config} className="aspect-auto h-48 w-full">
          <ComposedChart data={data} margin={{ top: 14, right: 4, bottom: 0, left: 0 }} barCategoryGap="18%" accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={6}
              minTickGap={28}
              tickFormatter={(d: string) => formatDay(d, language)}
            />
            <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => (measure === "cost" ? guideLabel(v, language) : format(v))} />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) => {
                    const row = payload?.[0]?.payload as { date: string; hit?: number } | undefined;
                    return row ? `${formatDayLong(row.date, language)}${row.hit ? ` · ▲ ${hitLabel}` : ""}` : "";
                  }}
                  formatter={(value, name, item) =>
                    name === "hit" ? null : (
                      <div className="flex w-full items-center gap-2">
                        <span className="size-2 shrink-0 rounded-[2px]" style={{ background: item.color }} />
                        <span className="text-muted-foreground">{config[String(name)]?.label}</span>
                        <span className="ml-auto font-medium tabular-nums">{format(Number(value))}</span>
                      </div>
                    )
                  }
                />
              }
            />
            {series.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                stackId="day"
                fill={`var(--color-${s.key})`}
                // A 2 px surface gap between stacked parts; the top part gets the rounded end.
                stroke="var(--card)"
                strokeWidth={1}
                radius={i === series.length - 1 ? [3, 3, 0, 0] : 0}
                isAnimationActive={false}
              />
            ))}
            <Scatter dataKey="hit" fill="var(--crit)" shape="triangle" legendType="none" tooltipType="none" isAnimationActive={false} />
            {series.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
          </ComposedChart>
        </ChartContainer>
        <p className="text-xs text-muted-foreground">{footer}</p>
        {/* The same days as a list, for screen readers and as the chart's table view. */}
        <ul className="sr-only" aria-label={t("Günlük değerler", "Daily values")}>
          {days.map((day) => (
            <li key={day.date}>
              {`${formatDayLong(day.date, language)}: ${approx(day)}${spoken(day.total)}${hitDays.has(day.date) ? t(", limite takıldı", ", limit hit") : ""}`}
            </li>
          ))}
        </ul>
      </Card>
    </PageSection>
  );
}
