import { useId, type ReactNode } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts";
import type { CategoricalChartFunc } from "recharts/types/chart/types";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { cn } from "@/lib/utils";

/** One line under the total: an account (or a row that is no account), its colour and its period total. */
export interface TrendSeries {
  key: string;
  name: string;
  /** A CSS colour: the account's token, or a grey for rows that are no account. */
  color: string;
  /** The period's total, written as the page writes values. */
  total: string;
  /** A dot before the name (the page's own, so it matches its legends). */
  dot?: ReactNode;
}

export interface TrendDay {
  date: string;
  total: number;
  /** A limit was hit that day: a red dot on the total. */
  hit?: boolean;
  /** Each series' value that day. */
  values: Record<string, number>;
}

/**
 * A daily trend in two parts: the day's total as one calm curve (a red dot on a day with a limit
 * hit), then one small curve per account in its own colour with its period total. Pointing at a day
 * marks it on every curve (the charts share a sync id) and the tooltip says the breakdown. Shared by
 * the Limit history and the Tokens page, so both read alike.
 */
export function DailyTrend({
  days,
  series,
  totalLabel,
  tickDay,
  tickValue,
  tooltip,
  onPick,
  marked,
  axisWidth = 40,
  children,
  slot,
}: {
  days: TrendDay[];
  series: TrendSeries[];
  /** The total's name in the tooltip config ("Dolu dönem", "Token"). */
  totalLabel: string;
  tickDay: (date: string) => string;
  tickValue: (value: number) => string;
  /** The hover box: gets the day pointed at. */
  tooltip: (date: string | undefined) => ReactNode;
  /** A day was clicked. */
  onPick?: (date: string) => void;
  /** A day held out (the panda's): a line marks it. */
  marked?: string;
  axisWidth?: number;
  /** Extra pieces inside the total's chart (a watcher of its geometry). */
  children?: ReactNode;
  slot?: string;
}) {
  // One id per instance: the gradients and the hover sync never meet another chart's.
  const id = `trend${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  // A day without a value for a series is zero, so its curve runs on instead of breaking.
  const data = days.map((day) => ({
    date: day.date,
    total: day.total,
    hit: day.hit,
    ...Object.fromEntries(series.map((s) => [s.key, day.values[s.key] ?? 0])),
  }));
  const totalConfig: ChartConfig = { total: { label: totalLabel, color: "var(--meter)" } };
  const click: CategoricalChartFunc | undefined = onPick
    ? (state) => {
        const label = state?.activeLabel;
        if (label !== undefined) onPick(String(label));
      }
    : undefined;
  return (
    <div data-slot={slot ?? "daily-trend"} className="grid gap-3">
      <ChartContainer config={totalConfig} className="aspect-auto h-36 w-full">
        <AreaChart data={data} margin={{ top: 8, right: 6, bottom: 0, left: 0 }} syncId={id} accessibilityLayer onClick={click}>
          <defs>
            <linearGradient id={`${id}-total`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-total)" stopOpacity={0.32} />
              <stop offset="100%" stopColor="var(--color-total)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={6} minTickGap={28} tickFormatter={tickDay} />
          <YAxis tickLine={false} axisLine={false} width={axisWidth} tickFormatter={tickValue} />
          <ChartTooltip cursor={{ stroke: "var(--border)" }} content={({ active, label }) => (active ? tooltip(label === undefined ? undefined : String(label)) : null)} />
          {marked && <ReferenceLine x={marked} stroke="var(--primary)" strokeWidth={1.5} />}
          <Area
            dataKey="total"
            type="monotone"
            stroke="var(--color-total)"
            strokeWidth={2}
            fill={`url(#${id}-total)`}
            isAnimationActive={false}
            activeDot={{ r: 4, fill: "var(--color-total)", stroke: "var(--card)", strokeWidth: 2 }}
            // A day with a limit hit: a red dot on the curve, ringed by the card so it stands off it.
            dot={(props: { cx?: number; cy?: number; index?: number; payload?: { hit?: boolean } }) =>
              props.payload?.hit && props.cx !== undefined && props.cy !== undefined ? (
                <circle key={props.index} cx={props.cx} cy={props.cy} r={3.5} fill="var(--crit)" stroke="var(--card)" strokeWidth={2} />
              ) : (
                <g key={props.index} />
              )
            }
          />
          {children}
        </AreaChart>
      </ChartContainer>
      {series.length > 0 && (
        <ul data-slot="trend-series" className="grid gap-1.5 border-t pt-3">
          {series.map((s) => (
            <li key={s.key} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-center gap-3 text-xs">
              <span className="flex min-w-0 items-center gap-1.5">
                {s.dot ?? <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: s.color }} />}
                <span className="truncate text-muted-foreground">{s.name}</span>
              </span>
              <ChartContainer config={{ [s.key]: { label: s.name, color: s.color } }} className="aspect-auto h-7 w-full">
                <AreaChart data={data} margin={{ top: 3, right: 6, bottom: 3, left: 0 }} syncId={id}>
                  <defs>
                    <linearGradient id={`${id}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={`var(--color-${s.key})`} stopOpacity={0.4} />
                      <stop offset="100%" stopColor={`var(--color-${s.key})`} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <YAxis hide domain={[0, "dataMax"]} />
                  {/* The cursor follows the total's; the breakdown is in the total's tooltip. */}
                  <ChartTooltip cursor={{ stroke: "var(--border)" }} content={() => null} />
                  <Area
                    dataKey={s.key}
                    type="monotone"
                    stroke={`var(--color-${s.key})`}
                    strokeWidth={1.5}
                    fill={`url(#${id}-${s.key})`}
                    isAnimationActive={false}
                    activeDot={{ r: 2.5, fill: `var(--color-${s.key})`, stroke: "var(--card)", strokeWidth: 1.5 }}
                  />
                </AreaChart>
              </ChartContainer>
              <b className={cn("text-right font-medium tabular-nums")}>{s.total}</b>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
