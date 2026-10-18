import { useState, type ReactNode } from "react";
import type { Account } from "../../../shared/types";
import {
  TOKEN_ROW_LABELS,
  type TokenCounts,
  type TokenRow,
  type TokenUsageView,
} from "../../../shared/token-usage-view";
import type { StatisticsRange } from "../../../shared/usage-statistics-view";
import { Banner } from "@/components/Banner";
import { Note } from "@/components/SettingRow";
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
import { windowTone } from "@/lib/day-timeline";
import { formatPercent } from "@/lib/meter";
import { cn } from "@/lib/utils";
import {
  formatDay,
  formatNumber,
  formatTokens,
  toneFill,
  toneIndex,
} from "./format";
import { useTokenUsage, type TokenUsageState } from "./useTokenUsage";

type Metric = "total" | "input" | "output" | "cache";
const METRICS: Metric[] = ["total", "input", "output", "cache"];

const totalOf = (c: TokenCounts) =>
  c.input + c.output + c.cacheWrite + c.cacheRead;
/** What the chart and the table count: all four kinds, or one; "cache" is cache write plus cache read. */
function metricValue(c: TokenCounts, metric: Metric) {
  switch (metric) {
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

interface Column {
  key: string;
  name: string;
  /** Colour slot of an account or the former row; undefined for the muted rows. */
  tone?: number;
  muted?: string;
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
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {tiles.map(([label, value]) => (
          <Tile
            key={label}
            label={label}
            value={formatTokens(value, language)}
            exact={formatNumber(value, language)}
          />
        ))}
      </div>
    </>
  );
}

/** "tahmini" / "estimated": what screen readers hear in place of the ≈ mark. */
const estimatedWord = (t: T) => t("tahmini", "estimated");

/** Stacked tokens per local day, one segment per row, coloured by account. */
function Chart({
  view,
  columns,
  metric,
}: {
  view: TokenUsageView;
  columns: Column[];
  metric: Metric;
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
          estimated: cell?.estimated === true,
        };
      })
      .filter((part) => part.value > 0),
  }));
  const dayTotal = (day: (typeof days)[number]) =>
    day.parts.reduce((sum, part) => sum + part.value, 0);
  const max = Math.max(0, ...days.map(dayTotal));
  const scale = max > 0 ? (BASE - TOP) / max : 0;
  const labels = [formatTokens(max, language), formatTokens(max / 2, language)];
  const left = Math.max(
    MIN_LEFT,
    Math.ceil(Math.max(...labels.map((l) => l.length)) * LABEL_CHAR) + 8,
  );
  const step = (WIDTH - left) / Math.max(1, days.length);
  const bar = Math.max(1, step * 0.72);
  const ticks = days.length
    ? [0, Math.floor((days.length - 1) / 2), days.length - 1]
    : [];
  const mix = modelMix(view, metric, language);
  return (
    <div>
      <ul className="mb-2 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        {columns.map((column) => (
          <li key={column.key} className="flex items-center gap-1">
            <i
              aria-hidden
              className={cn(
                "size-2.5 rounded-sm",
                column.tone === undefined
                  ? cn("bg-muted-foreground", column.muted)
                  : windowTone(column.tone),
              )}
            />
            {column.name}
          </li>
        ))}
      </ul>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="mx-auto h-auto w-full max-w-4xl"
        role="group"
        aria-label={t("Günlük token grafiği", "Daily token chart")}
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
            `${day.label}: ${formatTokens(dayTotal(day), language)}`,
            ...day.parts.map(
              (p) =>
                `${p.column.name} ${p.estimated ? `${estimatedWord(t)} ` : ""}${formatTokens(p.value, language)}`,
            ),
          ].join("; ");
          return (
            <g key={day.date} role="img" aria-label={spoken}>
              <title>
                {[
                  day.label,
                  ...day.parts.map(
                    (p) =>
                      `${p.column.name} ${p.estimated ? "≈" : ""}${formatTokens(p.value, language)}`,
                  ),
                  ...(day.parts.length && mix
                    ? [
                        t("Aralıktaki modeller: ", "Models in this range: ") +
                          mix,
                      ]
                    : []),
                ].join("\n")}
              </title>
              <rect
                x={left + i * step}
                y={TOP}
                width={step}
                height={BASE - TOP}
                fill="transparent"
              />
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
    </div>
  );
}

/** Days newest first, the rows from the view, then the day's total; ≈ marks values estimated from limit samples. */
function DayTable({
  view,
  columns,
  metric,
}: {
  view: TokenUsageView;
  columns: Column[];
  metric: Metric;
}) {
  const { t, language } = useI18n();
  const estimatedTip = t(
    "Limit ölçümlerinden tahmin edildi",
    "Estimated from limit samples",
  );
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
        {formatTokens(value, language)}
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
              const estimated = value > 0 && cell?.estimated === true;
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
}: {
  view: TokenUsageView;
  accounts: Account[];
}) {
  const { t, language } = useI18n();
  const [metric, setMetric] = useState<Metric>("total");
  const columns: Column[] = view.rows.map((row) => ({
    key: row.key,
    name: rowLabel(row, t),
    ...(MUTED_OPACITY[row.kind] !== undefined
      ? { muted: MUTED_OPACITY[row.kind] }
      : { tone: toneIndex(row, accounts) }),
  }));
  const labels: Record<Metric, string> = {
    total: t("Toplam", "Total"),
    input: t("Girdi", "Input"),
    output: t("Çıktı", "Output"),
    cache: t("Önbellek", "Cache"),
  };
  const empty = view.rows.length === 0;
  const scanning = !view.progress.complete;
  return (
    <>
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
          <Chart view={view} columns={columns} metric={metric} />
          <DayTable view={view} columns={columns} metric={metric} />
        </>
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
}: {
  state: TokenUsageState;
  accounts: Account[];
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
        <Content view={view} accounts={accounts} />
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
    />
  );
}
