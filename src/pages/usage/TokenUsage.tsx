import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  ReferenceLine,
  XAxis,
  YAxis,
  useActiveTooltipLabel,
  useChartWidth,
  usePlotArea,
} from "recharts";
import type { Account } from "../../../shared/types";
import {
  TOKEN_ROW_LABELS,
  type TokenCounts,
  type TokenRow,
  type TokenToday,
  type TokenUsageView,
} from "../../../shared/token-usage-view";
import type { StatisticsRange } from "../../../shared/usage-statistics-view";
import { AccountDot, accountColor } from "@/components/AccountDot";
import { Banner } from "@/components/Banner";
import { Disclosure } from "@/components/Disclosure";
import { InfoTip, PageSection } from "@/components/PageSection";
import { Note } from "@/components/SettingRow";
import { PandaRig } from "@/components/Panda";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useI18n, type Language, type T } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { formatPercent } from "@/lib/meter";
import { CostBreakdown } from "./CostBreakdown";
import { PandaBench } from "./PandaBench";
import { busiestDay, pandaLines, type PandaLine } from "./panda-facts";
import {
  formatChange,
  formatCost,
  formatDay,
  formatDayLong,
  formatNumber,
  formatTokens,
  locale,
  toneIndex,
} from "./format";
import { useTokenUsage, type TokenUsageState } from "./useTokenUsage";

type Metric = "total" | "input" | "output" | "cache" | "cost";
const METRICS: Metric[] = ["total", "input", "output", "cache", "cost"];

const totalOf = (c: TokenCounts) =>
  c.input + c.output + c.cacheWrite + c.cacheRead;
/** What the chart and the table count: all four kinds, or one; "cache" is cache write plus cache read; "cost" the API value. */
function metricValue(c: TokenCounts, metric: Metric) {
  switch (metric) {
    case "cost":
      return c.cost ?? 0;
    case "total":
      return totalOf(c);
    case "input":
      return c.input;
    case "output":
      return c.output;
    case "cache":
      return c.cacheWrite + c.cacheRead;
  }
}

/** A metric's value as text: dollars for the API value, compact tokens otherwise. */
const formatValue = (value: number, metric: Metric, language: Language) =>
  metric === "cost" ? formatCost(value, language) : formatTokens(value, language);

/** Whether a cell's value is estimated: its account always, and under "cost" its amount too. */
const isEstimated = (
  cell: { estimated: boolean; costEstimated?: true } | undefined,
  metric: Metric,
) =>
  cell?.estimated === true ||
  (metric === "cost" && cell?.costEstimated === true);

/** A named row: the account's own name, or the label of its kind in the page's language. */
const rowLabel = (row: TokenRow, t: T) =>
  row.kind === "account"
    ? (row.name ?? "")
    : t(TOKEN_ROW_LABELS[row.kind].tr, TOKEN_ROW_LABELS[row.kind].en);

/** Terminal and unknown tokens belong to no account: they take the muted tone, the unknown one fainter. */
const MUTED_OPACITY: Partial<Record<TokenRow["kind"], string>> = {
  terminal: "opacity-60",
  unknown: "opacity-35",
};
/** The fainter share of the unknown row, as the chart's fill opacity. */
const UNKNOWN_FILL = 0.45;

/** The model mix names at most this many models. */
const MIX_MODELS = 3;
/** The chart's y-axis labels take this many px on the left. */
const AXIS_WIDTH = 56;

export interface Column {
  key: string;
  name: string;
  /** Colour slot of an account or the former row; undefined for the muted rows. */
  tone?: number;
  muted?: string;
  /** The row's own colour as a CSS value: its account's (the dot's), grey for the rows that are no account. */
  color: string;
  /** The account's colour name, for its dot; undefined for the rows that are no account. */
  dot?: string;
  kind: TokenRow["kind"];
}

/** The view's rows as the chart, legend and table draw them: named, and coloured by account. */
export const tokenColumns = (
  view: TokenUsageView,
  accounts: Account[],
  t: T,
): Column[] =>
  view.rows.map((row) => {
    const account = row.accountId ? accounts.find((a) => a.id === row.accountId) : undefined;
    return {
      key: row.key,
      name: rowLabel(row, t),
      kind: row.kind,
      ...(MUTED_OPACITY[row.kind] !== undefined
        ? { muted: MUTED_OPACITY[row.kind] }
        : { tone: toneIndex(row, accounts) }),
      color: account
        ? accountColor(account.color)
        : row.kind === "unknown"
          ? "var(--muted-foreground)"
          : "var(--account-none)",
      ...(account ? { dot: account.color } : {}),
    };
  });

/** A row's dot: its account's colour, or grey; the unknown row fainter, as in the chart. */
function RowDot({ column }: { column: Column }) {
  return (
    <span aria-hidden className={column.kind === "unknown" ? "opacity-50" : undefined}>
      <AccountDot color={column.dot} />
    </span>
  );
}

/** The model mix of the range under `metric`: "claude-opus-4 %75 · claude-sonnet-4 %25". */
function modelMix(view: TokenUsageView, metric: Metric, language: Language) {
  const models = view.models
    .map((m) => ({ model: m.model, value: metricValue(m.totals, metric) }))
    .filter((m) => m.value > 0);
  const all = models.reduce((sum, m) => sum + m.value, 0);
  return models
    .slice(0, MIX_MODELS)
    .map((m) => `${m.model} ${formatPercent((m.value / all) * 100, language)}`)
    .join(" · ");
}

/** One figure of the summary: what it counts, the value (exact count on hover), and a quiet line. */
function Tile({
  label,
  value,
  exact,
  detail,
  slot,
  children,
}: {
  label: ReactNode;
  value: string;
  exact?: string;
  detail?: ReactNode;
  slot?: string;
  children?: ReactNode;
}) {
  return (
    <div data-slot="token-tile" className="grid min-w-0 content-start gap-0.5 px-4 py-3.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div data-slot={slot} title={exact} className="font-display text-2xl font-bold tracking-tight tabular-nums">
        {value}
      </div>
      {detail && <div className="truncate text-xs text-muted-foreground tabular-nums">{detail}</div>}
      {children}
    </div>
  );
}

/** "Girdi 1,1 Mn · Çıktı 220 B · Önbellek 855 B": a count split by kind in one quiet line. */
function kindsLine(c: TokenCounts, t: T, language: Language) {
  return [
    `${t("Girdi", "Input")} ${formatTokens(c.input, language)}`,
    `${t("Çıktı", "Output")} ${formatTokens(c.output, language)}`,
    `${t("Önbellek", "Cache")} ${formatTokens(c.cacheWrite + c.cacheRead, language)}`,
  ].join(" · ");
}

/** Today's API value per quarter hour up to now, as the area draws it: one point per filled slot. */
export function todaySeries(today: TokenToday) {
  return today.slots.flatMap((value, slot) => (value === null ? [] : [{ slot, value }]));
}

/** "13:15" for a quarter hour of the day. */
const slotClock = (slot: number) => `${String(Math.floor(slot / 4)).padStart(2, "0")}:${String((slot % 4) * 15).padStart(2, "0")}`;

/**
 * Today so far, as the macOS widget shows it: the tokens and their split, the API value and its
 * change since yesterday at the same time, and a small area of the API value per quarter hour with
 * yesterday's average dashed.
 */
function TodayTile({ today }: { today: TokenToday }) {
  const { t, language } = useI18n();
  const { totals, change } = today;
  const total = totals.input + totals.output + totals.cacheWrite + totals.cacheRead;
  const cost = totals.cost ?? 0;
  const points = todaySeries(today);
  const max = Math.max(0, today.yesterdayAverage ?? 0, ...points.map((p) => p.value));
  const since =
    today.slotsSince === undefined
      ? undefined
      : new Intl.DateTimeFormat(locale(language), { hour: "2-digit", minute: "2-digit" }).format(today.slotsSince);
  const config: ChartConfig = { value: { label: t("API karşılığı", "API value"), color: "var(--meter)" } };
  return (
    <section data-slot="token-today" aria-label={t("Bugün", "Today")} className="contents">
      <Tile
        label={t("Bugün", "Today")}
        value={formatTokens(total, language)}
        exact={formatNumber(total, language)}
        detail={kindsLine(totals, t, language)}
      >
        <div className="mt-1 flex items-baseline gap-2 text-xs">
          <span className="text-muted-foreground">{t("API karşılığı", "API value")}</span>
          <span data-slot="token-today-cost" className="font-semibold tabular-nums">
            {totals.costEstimated ? "≈" : ""}
            {formatCost(cost, language)}
          </span>
          {/* The change is a direction, not good or bad: the arrow says it, in the text colour. */}
          {change !== null && (
            <span data-slot="token-today-change" className="text-muted-foreground tabular-nums">
              {change >= 0 ? "▲ " : "▼ "}
              {formatChange(change, language)}
            </span>
          )}
        </div>
        {points.length > 0 && (
          <ChartContainer config={config} className="aspect-auto mt-1 h-10 w-full">
            <AreaChart data={points} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
              <XAxis dataKey="slot" type="number" domain={[0, 95]} hide />
              <YAxis domain={[0, max || 1]} hide />
              <ChartTooltip
                cursor={false}
                content={({ active, payload }) => {
                  const point = active ? (payload?.[0]?.payload as { slot: number; value: number } | undefined) : undefined;
                  return point ? (
                    <div className="rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-sm tabular-nums">
                      {`${slotClock(point.slot)} · ${formatCost(point.value, language)}`}
                    </div>
                  ) : null;
                }}
              />
              {today.yesterdayAverage !== null && (
                <ReferenceLine y={today.yesterdayAverage} stroke="var(--muted-foreground)" strokeDasharray="3 3" ifOverflow="extendDomain" />
              )}
              <Area dataKey="value" type="monotone" stroke="var(--color-value)" strokeWidth={1.5} fill="var(--color-value)" fillOpacity={0.12} isAnimationActive={false} />
            </AreaChart>
          </ChartContainer>
        )}
        {/* What the area shows, in words: for screen readers and where the chart is not drawn. */}
        <p data-slot="token-today-line" className="sr-only">
          {t(
            `Bugün çeyrek saat başına API karşılığı, ${points.length} çeyrek; en yüksek ${formatCost(max, "tr")}`,
            `API value per quarter hour today, ${points.length} quarters; highest ${formatCost(max, "en")}`,
          )}
          {today.yesterdayAverage !== null && (
            <span data-slot="token-today-yesterday">
              {t(
                `; dünkü ortalama ${formatCost(today.yesterdayAverage, "tr")}`,
                `; yesterday's average ${formatCost(today.yesterdayAverage, "en")}`,
              )}
            </span>
          )}
        </p>
        {since && (
          <p className="text-2xs text-muted-foreground">
            {t(`Gün içi çizgi için ${since} öncesinde veri yok.`, `No line data before ${since}.`)}
          </p>
        )}
      </Tile>
    </section>
  );
}

/** The summary: today, the range's total split by kind, and what it is worth at API prices. */
function Tiles({ view }: { view: TokenUsageView }) {
  const { t, language } = useI18n();
  const { totals } = view;
  const cost = totals.cost ?? 0;
  const total = totalOf(totals);
  const days = view.days.length || view.range;
  return (
    <Card data-slot="token-tiles" className="grid gap-0 divide-y p-0 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
      <TodayTile today={view.today} />
      <Tile
        label={t(`Toplam · ${view.range} gün`, `Total · ${view.range} days`)}
        value={formatTokens(total, language)}
        exact={formatNumber(total, language)}
        detail={kindsLine(totals, t, language)}
      />
      <Tile
        label={t("API karşılığı", "API value")}
        value={`${totals.costEstimated ? "≈" : ""}${formatCost(cost, language)}`}
        detail={t(`günde ${formatCost(cost / days, "tr")}`, `${formatCost(cost / days, "en")} per day`)}
      />
    </Card>
  );
}

/** "tahmini" / "estimated": what screen readers hear in place of the ≈ mark. */
const estimatedWord = (t: T) => t("tahmini", "estimated");

/** A row's share of a day: "%29", "<%1" for a sliver; undefined for an empty day. */
function shareOf(value: number, total: number, language: Language) {
  if (total <= 0) return undefined;
  const percent = (value / total) * 100;
  if (percent > 0 && percent < 1) return language === "tr" ? "<%1" : "<1%";
  return formatPercent(percent, language);
}

/** Each row's tokens over the range under `metric`, ≈ when any of its days was estimated. */
function Legend({
  view,
  columns,
  metric,
}: {
  view: TokenUsageView;
  columns: Column[];
  metric: Metric;
}) {
  const { t, language } = useI18n();
  return (
    <ul data-slot="token-legend" aria-label={t("Satırlar", "Rows")} className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {columns.map((column) => {
        let value = 0;
        let estimated = false;
        for (const day of view.days) {
          const cell = day.byRow[column.key];
          const part = cell ? metricValue(cell, metric) : 0;
          value += part;
          estimated ||= part > 0 && isEstimated(cell, metric);
        }
        return (
          <li key={column.key} className="flex items-center gap-1.5">
            <RowDot column={column} />
            <span className="text-muted-foreground">{column.name}</span>
            <span className="font-medium tabular-nums">
              {estimated ? "≈" : ""}
              {formatValue(value, metric, language)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The day the panda took out of the chart, and which of its lines it is saying. */
interface Explained {
  date: string;
  /** The line's key: a refresh may add or drop lines, and the panda keeps saying the same one. */
  key: string;
}

/** A day as the chart, its detail and its spoken list read it. */
export interface ChartDay {
  date: string;
  total: number;
  parts: { column: Column; value: number; estimated: boolean }[];
}

/** Each day's rows with a value under `metric`, in the columns' order. */
export function chartDays(view: TokenUsageView, columns: Column[], metric: Metric): ChartDay[] {
  return view.days.map((day) => {
    const parts = columns
      .map((column) => {
        const cell = day.byRow[column.key];
        return { column, value: cell ? metricValue(cell, metric) : 0, estimated: isEstimated(cell, metric) };
      })
      .filter((part) => part.value > 0);
    return { date: day.date, total: parts.reduce((sum, part) => sum + part.value, 0), parts };
  });
}

/** A day pointed at: its date, the metric's total and each row's value and share, ≈ where estimated. */
export function DayDetail({ day, metric, metricLabel }: { day: ChartDay; metric: Metric; metricLabel: string }) {
  const { t, language } = useI18n();
  const estimated = day.parts.some((p) => p.estimated);
  return (
    <div data-slot="day-tooltip" className="grid min-w-44 gap-1 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <div className="font-semibold">{formatDayLong(day.date, language)}</div>
      <div className="flex items-baseline justify-between gap-4 border-b pb-1">
        <span className="text-muted-foreground">{metricLabel}</span>
        <b className="tabular-nums">
          {estimated ? "≈" : ""}
          {formatValue(day.total, metric, language)}
        </b>
      </div>
      {day.parts.length ? (
        <ul className="grid gap-1">
          {day.parts.map((part) => (
            <li key={part.column.key} className="flex items-center gap-2">
              <RowDot column={part.column} />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{part.column.name}</span>
              <span className="tabular-nums">
                {part.estimated ? "≈" : ""}
                {formatValue(part.value, metric, language)}
              </span>
              <span className="w-9 text-right text-muted-foreground tabular-nums">{shareOf(part.value, day.total, language)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">{t("Bu gün token yok.", "No tokens on this day.")}</p>
      )}
      {estimated && (
        <p className="text-muted-foreground">
          {metric === "cost"
            ? t("≈ Hesap ya da tutar tahmin edildi", "≈ Account or amount estimated")
            : t("≈ Limit ölçümlerinden tahmin edildi", "≈ Estimated from limit samples")}
        </p>
      )}
    </div>
  );
}

/** Where the chart's plot sits, and the day pointed at or focused: read inside the chart, kept by its parent. */
interface Geometry {
  width: number;
  plotX: number;
  plotWidth: number;
}
function ChartWatch({ onGeometry, onActive }: { onGeometry: (g: Geometry) => void; onActive: (date?: string) => void }) {
  const width = useChartWidth();
  const plot = usePlotArea();
  const label = useActiveTooltipLabel();
  useEffect(() => {
    if (width && plot) onGeometry({ width, plotX: plot.x, plotWidth: plot.width });
  }, [width, plot?.x, plot?.width]);
  // A block body: an effect returns nothing but its clean-up, and onActive may return the date it keeps.
  useEffect(() => {
    onActive(label === undefined ? undefined : String(label));
  }, [label]);
  return null;
}

/**
 * Stacked tokens per local day, one part per row in its account's colour (the same chart as the
 * Limits page's). Pointing at a day details it; clicking it, or Enter on the focused chart, has the
 * panda explain it, with the other days dimmed; Escape puts it back. The days are also a list for
 * screen readers.
 */
function TokenChart({
  view,
  columns,
  metric,
  metricLabel,
  explained,
  line,
  more,
  onPick,
  onNextLine,
  onPutBack,
  returnFocus,
}: {
  view: TokenUsageView;
  columns: Column[];
  metric: Metric;
  metricLabel: string;
  explained?: Explained;
  /** What the panda says about the explained day, and whether it has more. */
  line?: PandaLine;
  more: boolean;
  /** A day was clicked, or picked with Enter, on `chart`. */
  onPick: (date: string, chart: Element | null) => void;
  onNextLine: () => void;
  onPutBack: () => void;
  returnFocus: () => void;
}) {
  const { t, language } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const geometry = useRef<Geometry | undefined>(undefined);
  const active = useRef<string | undefined>(undefined);
  const days = chartDays(view, columns, metric);
  const takenAt = explained ? days.findIndex((day) => day.date === explained.date) : -1;
  /** A day's bar centre as a share of the chart's width, for the panda's bench. */
  const at = (index: number) => {
    const g = geometry.current;
    if (!g || g.width <= 0 || !days.length) return (index + 0.5) / Math.max(1, days.length);
    return (g.plotX + ((index + 0.5) * g.plotWidth) / days.length) / g.width;
  };
  const config: ChartConfig = Object.fromEntries(columns.map((c) => [c.key, { label: c.name, color: c.color }]));
  const data = days.map((day) => ({
    date: day.date,
    ...Object.fromEntries(day.parts.map((part) => [part.column.key, part.value])),
  }));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.key === "Enter" || event.key === " ") && active.current) {
      event.preventDefault();
      onPick(active.current, box.current);
    } else if (event.key === "Escape" && explained) {
      // With the bench open, Escape on the chart only closes it.
      event.preventDefault();
      onPutBack();
    }
  };
  const dayOf = (label: unknown) => days.find((day) => day.date === String(label));
  return (
    <div ref={box} data-slot="token-chart-box" data-taken={takenAt >= 0 ? explained?.date : undefined} className="@container relative min-w-0" onKeyDown={onKeyDown}>
      <ChartContainer config={config} className="aspect-auto h-48 w-full">
        <ComposedChart
          data={data}
          margin={{ top: 8, right: 4, bottom: 0, left: 0 }}
          barCategoryGap="18%"
          accessibilityLayer
          onClick={(state) => {
            const day = dayOf(state?.activeLabel);
            if (day) onPick(day.date, box.current);
          }}
        >
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            minTickGap={28}
            tickFormatter={(d: string) => formatDay(d, language)}
          />
          <YAxis tickLine={false} axisLine={false} width={AXIS_WIDTH} tickFormatter={(v: number) => formatValue(v, metric, language)} />
          <ChartTooltip
            cursor={{ fill: "var(--muted)" }}
            // The bench says more than the hover box; the box waits until it closes.
            {...(takenAt >= 0 ? { active: false } : {})}
            content={({ active: shown, label }) => {
              const day = shown ? dayOf(label) : undefined;
              return day ? <DayDetail day={day} metric={metric} metricLabel={metricLabel} /> : null;
            }}
          />
          {columns.map((column, i) => (
            <Bar
              key={column.key}
              dataKey={column.key}
              stackId="day"
              fill={`var(--color-${column.key})`}
              fillOpacity={column.kind === "unknown" ? UNKNOWN_FILL : 1}
              // A 2 px surface gap between stacked parts; the top part gets the rounded end.
              stroke="var(--card)"
              strokeWidth={1}
              radius={i === columns.length - 1 ? [3, 3, 0, 0] : 0}
              isAnimationActive={false}
            >
              {/* The day the panda explains stays lit; the others step back. */}
              {takenAt >= 0 && data.map((day, d) => <Cell key={day.date} opacity={d === takenAt ? 1 : 0.4} />)}
            </Bar>
          ))}
          <ChartWatch onGeometry={(g) => (geometry.current = g)} onActive={(date) => (active.current = date)} />
        </ComposedChart>
      </ChartContainer>
      {takenAt >= 0 && explained && line && (
        <PandaBench
          // A new day is taken apart afresh: the panda peeks and the parts are laid out again.
          key={explained.date}
          view={view}
          date={explained.date}
          line={line}
          more={more}
          at={at(takenAt)}
          onNext={onNextLine}
          onClose={onPutBack}
          returnFocus={returnFocus}
        />
      )}
      {/* The same days as a list, for screen readers and as the chart's text: each names its rows, the estimated ones as such. */}
      <ul data-slot="token-days" className="sr-only" aria-label={t("Günlük token değerleri", "Daily token values")}>
        {days.map((day) => (
          <li key={day.date}>
            {[
              `${formatDay(day.date, language)}: ${formatValue(day.total, metric, language)}`,
              ...day.parts.map(
                (p) => `${p.column.name} ${p.estimated ? `${estimatedWord(t)} ` : ""}${formatValue(p.value, metric, language)}`,
              ),
            ].join("; ")}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The footnotes under the ⓘ: the range's model mix, the price list, since when accounts match exactly. */
export function tokenNotes(view: TokenUsageView, metric: Metric, t: T, language: Language): string[] {
  const mix = modelMix(view, metric, language);
  return [
    mix ? `${t("Aralıktaki modeller: ", "Models in this range: ")}${mix}` : "",
    t(
      `Fiyatlar: Anthropic API liste fiyatları, ${formatDay(view.pricesChecked, "tr")} ${view.pricesChecked.slice(0, 4)}.`,
      `Prices: Anthropic API list prices, ${formatDay(view.pricesChecked, "en")} ${view.pricesChecked.slice(0, 4)}.`,
    ),
    view.exactSince
      ? t(
          `Hesap eşleşmesi ${formatDay(view.exactSince, "tr")} tarihinden beri kesin. Önceki günler limit ölçümlerinden tahmin edildi.`,
          `Account matches are exact from ${formatDay(view.exactSince, "en")}. Earlier days are estimated from limit samples.`,
        )
      : "",
  ].filter(Boolean);
}

/** Days newest first, the rows from the view, then the day's total; ≈ marks values estimated from limit samples. */
export function DayTable({
  view,
  columns,
  metric,
}: {
  view: TokenUsageView;
  columns: Column[];
  metric: Metric;
}) {
  const { t, language } = useI18n();
  const estimatedTip =
    metric === "cost"
      ? t("Hesap ya da tutar tahmin edildi", "Account or amount estimated")
      : t("Limit ölçümlerinden tahmin edildi", "Estimated from limit samples");
  /**
   * A cell's text: "—" for none, "≈" before a value estimated from limit
   * samples, which screen readers hear as "tahmini".
   */
  const show = (value: number, estimated: boolean): ReactNode =>
    value > 0 ? (
      <>
        {estimated && (
          <>
            <span aria-hidden="true">≈</span>
            <span className="sr-only">{estimatedWord(t)} </span>
          </>
        )}
        {formatValue(value, metric, language)}
      </>
    ) : (
      "—"
    );
  return (
    <div
      role="region"
      tabIndex={0}
      aria-label={t("Günlük token tablosu", "Daily token table")}
      className="max-h-96 overflow-y-auto"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("Gün", "Date")}</TableHead>
            {columns.map((column) => (
              <TableHead key={column.key} className="text-right">
                {column.name}
              </TableHead>
            ))}
            <TableHead className="text-right">{t("Toplam", "Total")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[...view.days].reverse().map((day) => {
            let total = 0;
            let anyEstimated = false;
            const cells = columns.map((column) => {
              const cell = day.byRow[column.key];
              const value = cell ? metricValue(cell, metric) : 0;
              const estimated = value > 0 && isEstimated(cell, metric);
              total += value;
              anyEstimated ||= estimated;
              return { column, value, estimated };
            });
            return (
              <TableRow key={day.date}>
                <TableHead scope="row" className="font-normal">
                  {formatDay(day.date, language)}
                </TableHead>
                {cells.map(({ column, value, estimated }) => (
                  <TableCell
                    key={column.key}
                    title={estimated ? estimatedTip : undefined}
                    className="text-right tabular-nums"
                  >
                    {show(value, estimated)}
                  </TableCell>
                ))}
                <TableCell
                  title={anyEstimated ? estimatedTip : undefined}
                  className="text-right font-medium tabular-nums"
                >
                  {show(total, anyEstimated)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function Content({
  view,
  accounts,
  filterKey,
}: {
  view: TokenUsageView;
  accounts: Account[];
  /** What the view was asked for beyond its range: the account filter. */
  filterKey: string;
}) {
  const { t, language } = useI18n();
  const [metric, setMetric] = useState<Metric>("total");
  const [explained, setExplained] = useState<Explained>();
  /** What screen readers hear: set only when the user asks, so a refresh announces nothing. */
  const [said, setSaid] = useState("");
  const opener = useRef<Element | null>(null);
  // A new range, a new day or a new account filter closes the workbench.
  const shape = `${view.range}|${view.days[0]?.date ?? ""}|${filterKey}`;
  const [seenShape, setSeenShape] = useState(shape);
  if (seenShape !== shape) {
    setSeenShape(shape);
    setExplained(undefined);
    setSaid("");
  }
  const accountNames = Object.fromEntries(
    view.rows
      .filter((row) => row.kind === "account")
      .map((row) => [row.key, rowLabel(row, t)]),
  );
  const today = view.days[view.days.length - 1]?.date ?? "";
  const linesOf = (date: string) =>
    pandaLines({ view, date, accountNames, today });
  const lines = explained ? linesOf(explained.date) : [];
  // The chosen line while it still applies; after a refresh dropped it, the day's first.
  const line = explained
    ? (lines.find((l) => l.key === explained.key) ?? lines[0])
    : undefined;
  const say = (date: string, next: PandaLine) => {
    setExplained({ date, key: next.key });
    setSaid(`${formatDayLong(date, language)}: ${t(next.tr, next.en)}`);
  };
  const nextLine = () => {
    if (!explained || !line) return;
    say(explained.date, lines[(lines.indexOf(line) + 1) % lines.length]);
  };
  /** The panda explains `date`, opened from `from`; asked about the same day again, it says its next line. */
  const explain = (date: string, from: Element | null) => {
    opener.current = from;
    if (explained?.date === date) return nextLine();
    say(date, linesOf(date)[0]);
  };
  const close = useCallback(() => {
    if (!explained) return;
    setExplained(undefined);
    setSaid("");
  }, [explained]);
  const columns = tokenColumns(view, accounts, t);
  const labels: Record<Metric, string> = {
    total: t("Toplam", "Total"),
    input: t("Girdi", "Input"),
    output: t("Çıktı", "Output"),
    cache: t("Önbellek", "Cache"),
    cost: t("API karşılığı", "API value"),
  };
  const empty = view.rows.length === 0;
  const scanning = !view.progress.complete;
  return (
    <>
      <p aria-live="polite" data-slot="panda-say" className="sr-only">
        {said}
      </p>
      {empty ? (
        // While the scan runs, an empty range may only not be read yet: the scanning note says so.
        !scanning && (
          <p className="text-sm text-muted-foreground">
            {t(
              "Bu aralıkta token kaydı yok.",
              "No token records in this range.",
            )}
          </p>
        )
      ) : (
        <>
          {/* The range always ends today, so an empty range has an empty today too. */}
          <Tiles view={view} />
          <PageSection
            slot="token-chart"
            title={t("Günlük", "Daily")}
            info={
              <span className="grid gap-1">
                {tokenNotes(view, metric, t, language).map((note) => (
                  <span key={note}>{note}</span>
                ))}
              </span>
            }
            aside={
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={(event) => {
                    const date = busiestDay(view);
                    if (date) explain(date, event.currentTarget);
                  }}
                >
                  <PandaRig pose="head" expression="happy" size={16} />
                  {t("Panda anlatsın", "Ask the panda")}
                </Button>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  aria-label={t("Ölçü", "Measure")}
                  value={metric}
                  onValueChange={(v) => v && setMetric(v as Metric)}
                >
                  {METRICS.map((m) => (
                    <ToggleGroupItem key={m} value={m}>
                      {labels[m]}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </>
            }
          >
            <Card className="gap-3 px-4 py-3.5">
              <TokenChart
                view={view}
                columns={columns}
                metric={metric}
                metricLabel={labels[metric]}
                explained={explained}
                line={line}
                more={lines.length > 1}
                onPick={explain}
                onNextLine={nextLine}
                onPutBack={close}
                returnFocus={() =>
                  (opener.current as HTMLElement | null)?.focus?.()
                }
              />
              <Legend view={view} columns={columns} metric={metric} />
              <Disclosure title={t("Gün gün tablo", "Day-by-day table")}>
                <DayTable view={view} columns={columns} metric={metric} />
              </Disclosure>
            </Card>
          </PageSection>
        </>
      )}
      {view.unpricedModels.length > 0 && !empty && (
        <Note className="text-xs">
          {t(
            `${formatTokens(view.totals.unpriced ?? 0, "tr")} token, fiyatı bilinmeyen modellerden geldi; tutara katılmadı (${view.unpricedModels.join(", ")}).`,
            `${formatTokens(view.totals.unpriced ?? 0, "en")} tokens are from models with no known price and are not in the amount (${view.unpricedModels.join(", ")}).`,
          )}
        </Note>
      )}
      {scanning && (
        <Note className="text-xs">
          {t(
            `Konuşma kayıtları taranıyor… ${formatPercent(view.progress.percent, "tr")}`,
            `Relay scans the conversation logs… ${formatPercent(view.progress.percent, "en")}`,
          )}
        </Note>
      )}
      {view.progress.error && (
        <Note className="text-xs">
          {t(
            "Token kayıtları saklanamıyor.",
            "Relay cannot save the token records.",
          )}
        </Note>
      )}
    </>
  );
}

/** The page's token part for a loaded state: summary, daily chart and notes; `TokenUsage` fetches it. */
export function TokenUsageCard({
  state,
  accounts,
  filterKey = "",
}: {
  state: TokenUsageState;
  accounts: Account[];
  /** The account filter the view was asked for; a new one closes the panda's workbench. */
  filterKey?: string;
}) {
  const { t } = useI18n();
  const { view, loading, error } = state;
  return (
    <section
      data-slot="token-usage"
      aria-label={t("Token kullanımı", "Token usage")}
      className="grid min-w-0 gap-4"
      role={error && !view ? "alert" : undefined}
      aria-busy={(loading && view !== undefined) || undefined}
    >
      {error && view && (
        <Banner tone="error" role="alert">
          <span>
            <b>
              {t(
                "Token kullanımı yenilenemedi.",
                "Cannot refresh token usage.",
              )}
            </b>{" "}
            {error}
          </span>
        </Banner>
      )}
      {view ? (
        <Content view={view} accounts={accounts} filterKey={filterKey} />
      ) : error ? (
        <p className="text-sm text-muted-foreground">
          <b>
            {t("Token kullanımı alınamadı.", "Cannot load token usage.")}
          </b>{" "}
          {error}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("Token kaydı yükleniyor", "Relay loads the token usage…")}
        </p>
      )}
    </section>
  );
}

/** Tokens per account and day for the page's range and account filter. */
export function TokenUsage({
  range,
  accountId,
}: {
  range: StatisticsRange;
  accountId?: string;
}) {
  const { accounts } = useRelay();
  const state = useTokenUsage(range, accountId);
  return (
    <div className="grid gap-5">
      <TokenUsageCard
        state={state}
        accounts={accounts}
        filterKey={accountId ?? ""}
      />
      {state.view && <CostBreakdown view={state.view} accounts={accounts} />}
    </div>
  );
}
