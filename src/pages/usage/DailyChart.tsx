import { useState } from "react";
import { localDate } from "../../../shared/planning";
import type { Account } from "../../../shared/types";
import type { UsageStatisticsView } from "../../../shared/usage-statistics-view";
import type { TokenUsageView } from "../../../shared/token-usage-view";
import { Card } from "@/components/ui/card";
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
  const max = Math.max(0, ...days.map((d) => d.total));
  const scale = max > 0 ? (BASE - TOP) / max : 0;
  const guides = measure === "cost" ? costGuides(max) : undefined;
  // The $ chart labels its guides; the others the top and the middle.
  const marks: { y: number; label: string }[] =
    max <= 0
      ? []
      : guides
        ? guides.map((value) => ({
            y: BASE - value * scale,
            label: guideLabel(value, language),
          }))
        : measure === "cost"
          ? []
          : [
              { y: TOP, label: format(max) },
              { y: (TOP + BASE) / 2, label: format(max / 2) },
            ];
  // The gutter grows with the longest y label ("12.345").
  const left = Math.max(
    MIN_LEFT,
    Math.ceil(Math.max(0, ...marks.map((m) => m.label.length)) * LABEL_CHAR) +
      8,
  );
  const step = (WIDTH - left) / Math.max(1, days.length);
  const bar = Math.max(1, step * 0.72);
  const mark = Math.min(bar, MARK);
  const busiest = days.reduce<Day | undefined>(
    (best, day) => (day.total > (best?.total ?? 0) ? day : best),
    undefined,
  );
  const ticks = days.length
    ? [0, Math.floor((days.length - 1) / 2), days.length - 1]
    : [];
  const hover = useDayHover({ width: WIDTH, left, step, count: days.length });
  const shown = hover.active === undefined ? undefined : days[hover.active];
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
  return (
    <Card className="gap-0 px-4 py-3.5">
      <div className="mb-2 grid gap-1">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h3 className="font-display text-sm font-semibold">
            {t("Günlük kullanım", "Daily usage")}
          </h3>
          {tokens && (
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              aria-label={t("Ölçü", "Measure")}
              value={measure}
              onValueChange={(v) => v && setChosen(v as DailyMeasure)}
            >
              {MEASURES.map((m) => (
                <ToggleGroupItem
                  key={m}
                  value={m}
                  aria-label={
                    m === "cost" ? t("API karşılığı", "API value") : undefined
                  }
                >
                  {labels[m]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}
        </div>
        <ul className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1">
              <Swatch tone={s.tone} muted={s.muted} />
              {s.name}
            </li>
          ))}
        </ul>
      </div>
      <div className="relative">
        <svg
          {...hover.chart}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="h-auto w-full rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          role="group"
          aria-label={t(
            "Günlük kullanım grafiği; günler arasında ok tuşlarıyla gezilir",
            "Daily usage chart. Arrow keys move between days.",
          )}
        >
          <g aria-hidden className="stroke-border" strokeWidth={1}>
            {(measure === "cost" ? [BASE] : [TOP, (TOP + BASE) / 2, BASE]).map(
              (y) => (
                <line key={y} x1={left} x2={WIDTH} y1={y} y2={y} />
              ),
            )}
          </g>
          {guides && (
            <g
              aria-hidden
              data-slot="cost-guides"
              className="stroke-muted-foreground/50"
              strokeWidth={1}
              strokeDasharray="3 3"
            >
              {marks.map((m) => (
                <line
                  key={m.label}
                  x1={left}
                  x2={WIDTH}
                  y1={r2(m.y)}
                  y2={r2(m.y)}
                />
              ))}
            </g>
          )}
          {marks.length > 0 && (
            <g
              aria-hidden
              className="fill-muted-foreground"
              fontSize={9}
              textAnchor="end"
            >
              {marks.map((m) => (
                <text key={m.label} x={left - 4} y={r2(m.y + 3)}>
                  {m.label}
                </text>
              ))}
            </g>
          )}
          {days.map((day, i) => {
            const x = left + i * step + (step - bar) / 2;
            const hit = hitDays.has(day.date);
            const label = formatDay(day.date, language);
            let y = BASE;
            return (
              <g
                key={day.date}
                role="img"
                aria-label={`${label}: ${approx(day)}${spoken(day.total)}${hit ? t(", limite takıldı", ", limit hit") : ""}`}
                className={cn(
                  "transition-opacity duration-100",
                  hover.active !== undefined &&
                    hover.active !== i &&
                    "opacity-40",
                )}
              >
                {hover.active === i && (
                  <rect
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
                  return (
                    <rect
                      key={part.key}
                      x={x}
                      y={y}
                      width={bar}
                      height={h}
                      rx={Math.min(1.5, bar / 3)}
                      {...(part.tone === undefined
                        ? { className: cn("fill-muted-foreground", part.muted) }
                        : { fill: toneFill(part.tone) })}
                    />
                  );
                })}
                {hit && (
                  <path
                    d={triangle(x + bar / 2, Math.max(TOP - 2, y - 2), mark)}
                    fill="var(--muted-foreground)"
                  />
                )}
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
                {formatDay(days[i].date, language)}
              </text>
            ))}
          </g>
        </svg>
        <DayTooltip at={hover.at}>
          {shown && (
            <>
              <div className="font-semibold">
                {formatDayLong(shown.date, language)}
              </div>
              <div className="mt-0.5 flex items-baseline justify-between gap-4 border-b pb-1">
                <span className="text-muted-foreground">
                  {measure === "limit"
                    ? t("Dolu dönem", "Full periods")
                    : measure === "tokens"
                      ? t("Token", "Tokens")
                      : t("API karşılığı", "API value")}
                </span>
                <b className="tabular-nums">
                  {approx(shown)}
                  {format(shown.total)}
                </b>
              </div>
              {shown.total > 0 ? (
                <ul className="mt-1.5 grid gap-1">
                  {shown.parts.map((part) => (
                    <DayTipRow
                      key={part.key}
                      tone={part.tone}
                      muted={part.muted}
                      name={part.name}
                      value={`${part.estimated ? "≈" : ""}${format(part.value)}`}
                    />
                  ))}
                </ul>
              ) : (
                <p className="mt-1.5 text-muted-foreground">
                  {measure === "limit"
                    ? t("Bu gün kullanım yok.", "No usage on this day.")
                    : t("Bu gün token yok.", "No tokens on this day.")}
                </p>
              )}
              {hitDays.has(shown.date) && (
                <p className="mt-1.5 font-medium text-crit">
                  {t("▲ Limite takıldı", "▲ Limit hit")}
                </p>
              )}
            </>
          )}
        </DayTooltip>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {footer}{" "}
        {t(
          "▲ limite takılan günleri gösterir.",
          "▲ marks days with a limit hit.",
        )}
        {estimatedRange &&
          ` ${t("≈ hesap ya da tutar tahmin edildi.", "≈ account or amount estimated.")}`}
      </p>
    </Card>
  );
}
