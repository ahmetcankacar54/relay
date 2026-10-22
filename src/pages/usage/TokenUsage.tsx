import { useCallback, useRef, useState, type ReactNode } from "react";
import type { Account } from "../../../shared/types";
import {
  TOKEN_ROW_LABELS,
  type TokenCounts,
  type TokenRow,
  type TokenUsageView,
} from "../../../shared/token-usage-view";
import type { StatisticsRange } from "../../../shared/usage-statistics-view";
import { Banner } from "@/components/Banner";
import { Disclosure } from "@/components/Disclosure";
import { Note } from "@/components/SettingRow";
import { PandaRig } from "@/components/Panda";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { cn } from "@/lib/utils";
import {
  barCentre,
  DayTipRow,
  DayTooltip,
  Swatch,
  useDayHover,
} from "./DayHover";
import { PandaBench } from "./PandaBench";
import { TodayCard } from "./TodayCard";
import { busiestDay, pandaLines, type PandaLine } from "./panda-facts";
import {
  formatChange,
  formatCost,
  formatDay,
  formatDayLong,
  formatNumber,
  formatTokens,
  toneFill,
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

// viewBox units. The card spans the page, wider than the daily Pro-unit chart's column.
const WIDTH = 640;
const TOP = 14;
const BASE = 128;
const HEIGHT = 146;
const MIN_LEFT = 28;
const LABEL_CHAR = 5.5;
/** The model mix names at most this many models. */
const MIX_MODELS = 3;

export interface Column {
  key: string;
  name: string;
  /** Colour slot of an account or the former row; undefined for the muted rows. */
  tone?: number;
  muted?: string;
}

/** The view's rows as the chart, legend and table draw them: named, and coloured by account. */
export const tokenColumns = (
  view: TokenUsageView,
  accounts: Account[],
  t: T,
): Column[] =>
  view.rows.map((row) => ({
    key: row.key,
    name: rowLabel(row, t),
    ...(MUTED_OPACITY[row.kind] !== undefined
      ? { muted: MUTED_OPACITY[row.kind] }
      : { tone: toneIndex(row, accounts) }),
  }));

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

function Tile({
  label,
  value,
  exact,
}: {
  label: string;
  value: string;
  exact: string;
}) {
  return (
    <div data-slot="token-tile" className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        title={exact}
        className="font-display text-xl font-bold tracking-tight tabular-nums"
      >
        {value}
      </div>
    </div>
  );
}

function Tiles({ view }: { view: TokenUsageView }) {
  const { t, language } = useI18n();
  const { totals } = view;
  const tiles: [string, number][] = [
    [t("Girdi", "Input"), totals.input],
    [t("Çıktı", "Output"), totals.output],
    [t("Önbellek yazma", "Cache write"), totals.cacheWrite],
    [t("Önbellek okuma", "Cache read"), totals.cacheRead],
  ];
  const cost = totals.cost ?? 0;
  const total = totalOf(totals);
  return (
    <>
      <div
        title={formatNumber(total, language)}
        className="font-display text-xl font-bold tracking-tight tabular-nums"
      >
        {t(
          `Toplam ${formatTokens(total, language)}`,
          `Total ${formatTokens(total, language)}`,
        )}
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {tiles.map(([label, value]) => (
          <Tile
            key={label}
            label={label}
            value={formatTokens(value, language)}
            exact={formatNumber(value, language)}
          />
        ))}
        <Tile
          label={t("API karşılığı", "API value")}
          value={`${totals.costEstimated ? "≈" : ""}${formatCost(cost, language)}`}
          exact={t(
            "Bu token’lar Anthropic API liste fiyatlarıyla ödenseydi tutacak tutar. Aboneliğinizin ücreti bundan bağımsızdır.",
            "What these tokens would cost at Anthropic’s API list prices. Your subscription’s price is separate.",
          )}
        />
      </div>
    </>
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
  const { language } = useI18n();
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
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
            <Swatch tone={column.tone} muted={column.muted} />
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

/** Stacked tokens per local day, one segment per row, coloured by account; pointing at a day details it. */
/** The day the panda took out of the chart, and which of its lines it is saying. */
interface Explained {
  date: string;
  /** The line's key: a refresh may add or drop lines, and the panda keeps saying the same one. */
  key: string;
}

function Chart({
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
  /** Days the panda put back not quite straight. */
  /** A day was clicked, or picked with Enter or Space, on `chart`. */
  onPick: (date: string, chart: Element | null) => void;
  onNextLine: () => void;
  onPutBack: () => void;
  returnFocus: () => void;
}) {
  const { t, language } = useI18n();
  const days = view.days.map((day) => ({
    date: day.date,
    label: formatDay(day.date, language),
    parts: columns
      .map((column) => {
        const cell = day.byRow[column.key];
        return {
          column,
          value: cell ? metricValue(cell, metric) : 0,
          estimated: isEstimated(cell, metric),
        };
      })
      .filter((part) => part.value > 0),
  }));
  const dayTotal = (day: (typeof days)[number]) =>
    day.parts.reduce((sum, part) => sum + part.value, 0);
  const max = Math.max(0, ...days.map(dayTotal));
  const scale = max > 0 ? (BASE - TOP) / max : 0;
  const labels = [
    formatValue(max, metric, language),
    formatValue(max / 2, metric, language),
  ];
  const left = Math.max(
    MIN_LEFT,
    Math.ceil(Math.max(...labels.map((l) => l.length)) * LABEL_CHAR) + 8,
  );
  const step = (WIDTH - left) / Math.max(1, days.length);
  const bar = Math.max(1, step * 0.72);
  const ticks = days.length
    ? [0, Math.floor((days.length - 1) / 2), days.length - 1]
    : [];
  const hover = useDayHover({
    width: WIDTH,
    left,
    step,
    count: days.length,
    onPick: (day) => onPick(days[day].date, hover.ref.current),
    // With the bench open, Escape on the chart only closes it; the day stays.
    onEscape: () => {
      if (!explained) return false;
      onPutBack();
      return true;
    },
  });
  const takenAt = explained
    ? days.findIndex((day) => day.date === explained.date)
    : -1;
  // The day lit against the others: the one the panda explains, else the one pointed at.
  const lit = takenAt >= 0 ? takenAt : hover.active;
  const shown = hover.active === undefined ? undefined : days[hover.active];
  const shownTotal = shown ? dayTotal(shown) : 0;
  return (
    <div className="@container relative mx-auto w-full max-w-4xl">
      <svg
        {...hover.chart}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full cursor-pointer rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        role="group"
        aria-label={t(
          "Günlük token grafiği; günler arasında ok tuşlarıyla gezilir",
          "Daily token chart; arrow keys move between days",
        )}
      >
        <g aria-hidden className="stroke-border" strokeWidth={1}>
          {[TOP, (TOP + BASE) / 2, BASE].map((y) => (
            <line key={y} x1={left} x2={WIDTH} y1={y} y2={y} />
          ))}
        </g>
        {max > 0 && (
          <g
            aria-hidden
            className="fill-muted-foreground"
            fontSize={9}
            textAnchor="end"
          >
            <text x={left - 4} y={TOP + 3}>
              {labels[0]}
            </text>
            <text x={left - 4} y={(TOP + BASE) / 2 + 3}>
              {labels[1]}
            </text>
          </g>
        )}
        {days.map((day, i) => {
          const x = left + i * step + (step - bar) / 2;
          let y = BASE;
          // The day's total, then each row, the estimated ones named as such.
          const spoken = [
            `${day.label}: ${formatValue(dayTotal(day), metric, language)}`,
            ...day.parts.map(
              (p) =>
                `${p.column.name} ${p.estimated ? `${estimatedWord(t)} ` : ""}${formatValue(p.value, metric, language)}`,
            ),
          ].join("; ");
          return (
            <g
              key={day.date}
              role="img"
              aria-label={spoken}
              className={cn(
                "transition-opacity duration-100",
                lit !== undefined && lit !== i && "opacity-40",
              )}
            >
              {lit === i && (
                <rect
                  data-slot="token-day-band"
                  className="fill-muted"
                  x={left + i * step}
                  y={TOP}
                  width={step}
                  height={BASE - TOP}
                />
              )}
              {day.parts.map((part) => {
                const h = part.value * scale;
                y -= h;
                const { column } = part;
                return (
                  <rect
                    key={column.key}
                    data-slot="token-segment"
                    x={x}
                    y={y}
                    width={bar}
                    height={h}
                    rx={Math.min(1.5, bar / 3)}
                    {...(column.tone === undefined
                      ? {
                          className: cn("fill-muted-foreground", column.muted),
                        }
                      : { fill: toneFill(column.tone) })}
                  />
                );
              })}
            </g>
          );
        })}
        <g
          aria-hidden
          className="fill-muted-foreground"
          fontSize={9}
          textAnchor="middle"
        >
          {ticks.map((i) => (
            <text
              key={i}
              x={Math.min(
                WIDTH - 14,
                Math.max(left + 14, left + i * step + step / 2),
              )}
              y={HEIGHT - 4}
            >
              {days[i].label}
            </text>
          ))}
        </g>
      </svg>
      {takenAt >= 0 && explained && line && (
        <PandaBench
          // A new day is taken apart afresh: the panda peeks and the parts are laid out again.
          key={explained.date}
          view={view}
          date={explained.date}
          line={line}
          more={more}
          at={barCentre({ width: WIDTH, left, step }, takenAt)}
          onNext={onNextLine}
          onClose={onPutBack}
          returnFocus={returnFocus}
        />
      )}
      {/* The workbench says more than the hover box; the box waits until it closes. */}
      <DayTooltip at={takenAt >= 0 ? undefined : hover.at}>
        {shown && (
          <>
            <div className="font-semibold">
              {formatDayLong(shown.date, language)}
            </div>
            <div className="mt-0.5 flex items-baseline justify-between gap-4 border-b pb-1">
              <span className="text-muted-foreground">{metricLabel}</span>
              <b className="tabular-nums">
                {shown.parts.some((p) => p.estimated) ? "≈" : ""}
                {formatValue(shownTotal, metric, language)}
              </b>
            </div>
            {shown.parts.length ? (
              <ul className="mt-1.5 grid gap-1">
                {shown.parts.map((part) => (
                  <DayTipRow
                    key={part.column.key}
                    tone={part.column.tone}
                    muted={part.column.muted}
                    name={part.column.name}
                    value={`${part.estimated ? "≈" : ""}${formatValue(part.value, metric, language)}`}
                    share={shareOf(part.value, shownTotal, language)}
                  />
                ))}
              </ul>
            ) : (
              <p className="mt-1.5 text-muted-foreground">
                {t("Bu gün token yok.", "No tokens on this day.")}
              </p>
            )}
            {shown.parts.some((p) => p.estimated) && (
              <p className="mt-1.5 text-muted-foreground">
                {metric === "cost"
                  ? t(
                      "≈ Hesap ya da tutar tahmin edildi",
                      "≈ Account or amount estimated",
                    )
                  : t(
                      "≈ Limit ölçümlerinden tahmin edildi",
                      "≈ Estimated from limit samples",
                    )}
              </p>
            )}
          </>
        )}
      </DayTooltip>
    </div>
  );
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
      ? t(
          "Hesap eşleşmesi limit ölçümlerinden ya da tutar bu sürümden önce sayılan token’lardan tahmin edildi",
          "The account was estimated from limit samples, or the amount from tokens counted before this version",
        )
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
  const mix = modelMix(view, metric, language);
  return (
    <>
      <p aria-live="polite" data-slot="panda-say" className="sr-only">
        {said}
      </p>
      {/* The range always ends today, so an empty range has an empty today too. */}
      {!empty && <TodayCard today={view.today} />}
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
          <Tiles view={view} />
          {/* The chart's controls: what each row adds up to, and what is counted. */}
          <div className="mt-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t pt-3">
            <Legend view={view} columns={columns} metric={metric} />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={(event) => {
                  const date = busiestDay(view);
                  if (date) explain(date, event.currentTarget);
                }}
              >
                <PandaRig pose="head" expression="happy" size={18} />
                {t("Panda anlatsın", "Ask the panda")}
              </Button>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                aria-label={t("Ölçü", "Metric")}
                value={metric}
                onValueChange={(v) => v && setMetric(v as Metric)}
              >
                {METRICS.map((m) => (
                  <ToggleGroupItem key={m} value={m}>
                    {labels[m]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          </div>
          <Chart
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
          {mix && (
            <p className="text-xs text-muted-foreground">
              {t("Aralıktaki modeller: ", "Models in this range: ")}
              {mix}
            </p>
          )}
          <Disclosure title={t("Gün gün tablo", "Day-by-day table")}>
            <DayTable view={view} columns={columns} metric={metric} />
          </Disclosure>
        </>
      )}
      {view.unpricedModels.length > 0 && !empty && (
        <Note className="text-xs">
          {t(
            `${formatTokens(view.totals.unpriced ?? 0, "tr")} token fiyatı bilinmeyen modellerden; tutara katılmadı (${view.unpricedModels.join(", ")}).`,
            `${formatTokens(view.totals.unpriced ?? 0, "en")} tokens are from models with no known price and are left out of the amount (${view.unpricedModels.join(", ")}).`,
          )}
        </Note>
      )}
      {!empty && (
        <Note className="text-xs">
          {t(
            `Fiyatlar: Anthropic API liste fiyatları, ${formatDay(view.pricesChecked, "tr")} ${view.pricesChecked.slice(0, 4)}.`,
            `Prices: Anthropic API list prices, ${formatDay(view.pricesChecked, "en")} ${view.pricesChecked.slice(0, 4)}.`,
          )}
        </Note>
      )}
      {view.exactSince && !empty && (
        <Note className="text-xs">
          {t(
            `Kesin hesap eşleşmesi ${formatDay(view.exactSince, "tr")} tarihinden beri tutuluyor; öncesi Relay’in limit ölçümlerinden tahmin edildi (en fazla 14 gün).`,
            `Exact account matching since ${formatDay(view.exactSince, "en")}; earlier days are estimated from Relay’s limit samples (up to 14 days).`,
          )}
        </Note>
      )}
      {scanning && (
        <Note className="text-xs">
          {t(
            `Konuşma kayıtları taranıyor… ${formatPercent(view.progress.percent, "tr")}`,
            `Scanning conversation logs… ${formatPercent(view.progress.percent, "en")}`,
          )}
        </Note>
      )}
      {view.progress.error && (
        <Note className="text-xs">
          {t(
            "Token kaydı kaydedilemiyor; Relay’i yeniden başlatınca tarama baştan yapılır.",
            "Token records cannot be saved; the scan restarts after Relay restarts.",
          )}
        </Note>
      )}
    </>
  );
}

/** The card for a loaded state; `TokenUsage` fetches it. */
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
  const title = t("Token kullanımı", "Token usage");
  return (
    <Card
      className="min-w-0 gap-3 px-5 py-4"
      role={error && !view ? "alert" : undefined}
      aria-busy={(loading && view !== undefined) || undefined}
    >
      <h3 className="font-display text-[15px] font-semibold">{title}</h3>
      {error && view && (
        <Banner tone="error" role="alert">
          <span>
            <b>
              {t(
                "Token kullanımı yenilenemedi.",
                "Could not refresh token usage.",
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
            {t("Token kullanımı alınamadı.", "Could not load token usage.")}
          </b>{" "}
          {error}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("Token kaydı yükleniyor", "Loading token usage")}
        </p>
      )}
    </Card>
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
  return (
    <TokenUsageCard
      state={useTokenUsage(range, accountId)}
      accounts={accounts}
      filterKey={accountId ?? ""}
    />
  );
}
