import type { TokenToday } from "../../../shared/token-usage-view";
import { useI18n } from "@/data/i18n";
import { cn } from "@/lib/utils";
import { formatChange, formatCost, formatTokens, locale } from "./format";

// viewBox units of the line.
const WIDTH = 240;
const HEIGHT = 64;
const TOP = 4;
const BASE = 50;
const SLOTS = 96;
/** Axis ticks at 06:00, 12:00 and 18:00. */
const TICKS = [24, 48, 72];

const x = (slot: number) => (slot / (SLOTS - 1)) * WIDTH;

/**
 * Today so far, as the macOS widget shows it: the tokens by kind, their API
 * value and its change since yesterday at the same time, and a line of the
 * API value per quarter hour with yesterday's average dashed.
 */
export function TodayCard({ today }: { today: TokenToday }) {
  const { t, language } = useI18n();
  const { totals } = today;
  const total =
    totals.input + totals.output + totals.cacheWrite + totals.cacheRead;
  const cost = totals.cost ?? 0;
  const { change } = today;
  const rows: [string, number][] = [
    [t("Girdi", "Input"), totals.input],
    [t("Çıktı", "Output"), totals.output],
    [t("Önbellek", "Cache"), totals.cacheWrite + totals.cacheRead],
  ];
  const points = today.slots.flatMap((value, slot) =>
    value === null ? [] : [{ slot, value }],
  );
  const max = Math.max(
    0,
    today.yesterdayAverage ?? 0,
    ...points.map((p) => p.value),
  );
  const y = (value: number) =>
    max > 0 ? BASE - (value / max) * (BASE - TOP) : BASE;
  const line = points
    .map((p, i) => `${i ? "L" : "M"}${x(p.slot).toFixed(1)},${y(p.value).toFixed(1)}`)
    .join("");
  const last = points.at(-1);
  const area =
    line && last ? `${line}L${x(last.slot).toFixed(1)},${BASE}L0,${BASE}Z` : "";
  const since =
    today.slotsSince === undefined
      ? undefined
      : new Intl.DateTimeFormat(locale(language), {
          hour: "2-digit",
          minute: "2-digit",
        }).format(today.slotsSince);
  const tone =
    change === null
      ? "text-muted-foreground"
      : change >= 0
        ? "text-ok-foreground"
        : "text-crit";
  return (
    <section
      data-slot="token-today"
      aria-label={t("Bugün", "Today")}
      className="grid gap-x-6 gap-y-3 rounded-lg border px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 font-display text-sm font-semibold">
          {change !== null && (
            <span aria-hidden className={cn("text-xs", tone)}>
              {change >= 0 ? "▲" : "▼"}
            </span>
          )}
          {t("Bugün", "Today")}
        </div>
        <div className="text-2xs tracking-wide text-muted-foreground uppercase">
          {t("Claude Code · token", "Claude Code · tokens")}
        </div>
        <dl className="mt-2 grid grid-cols-[auto_auto] gap-x-6 gap-y-0.5 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="text-right tabular-nums">
                {formatTokens(value, language)}
              </dd>
            </div>
          ))}
        </dl>
        <div className="mt-1 font-display text-2xl font-bold tracking-tight tabular-nums">
          {formatTokens(total, language)}
        </div>
      </div>
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {t("API karşılığı", "API value")}
          </span>
          <span className="text-right">
            <span
              data-slot="token-today-cost"
              className={cn("font-display text-lg font-bold tabular-nums", tone)}
            >
              {totals.costEstimated ? "≈" : ""}
              {formatCost(cost, language)}
            </span>
            {change !== null && (
              <span
                data-slot="token-today-change"
                className={cn("ml-2 text-sm font-medium tabular-nums", tone)}
              >
                {formatChange(change, language)}
              </span>
            )}
          </span>
        </div>
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="mt-1 h-auto w-full"
          role="img"
          aria-label={t(
            `Bugün çeyrek saat başına API karşılığı; en yüksek ${formatCost(max, "tr")}`,
            `API value per quarter hour today; highest ${formatCost(max, "en")}`,
          )}
        >
          <g aria-hidden className="stroke-border" strokeWidth={1}>
            {TICKS.map((slot) => (
              <line key={slot} x1={x(slot)} x2={x(slot)} y1={TOP} y2={BASE} />
            ))}
          </g>
          {today.yesterdayAverage !== null && (
            <line
              data-slot="token-today-yesterday"
              aria-hidden
              x1={0}
              x2={WIDTH}
              y1={y(today.yesterdayAverage)}
              y2={y(today.yesterdayAverage)}
              className="stroke-muted-foreground"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
          )}
          {area && <path aria-hidden d={area} className="fill-ok/15" />}
          {line && (
            <path
              data-slot="token-today-line"
              aria-hidden
              d={line}
              fill="none"
              className="stroke-ok"
              strokeWidth={1.5}
              strokeLinejoin="round"
            />
          )}
          <g
            aria-hidden
            className="fill-muted-foreground"
            fontSize={9}
            textAnchor="middle"
          >
            {TICKS.map((slot) => (
              <text key={slot} x={x(slot)} y={HEIGHT - 2}>
                {slot / 4}
              </text>
            ))}
          </g>
        </svg>
        {since && (
          <p className="text-2xs text-muted-foreground">
            {t(
              `Gün içi çizgi için ${since} öncesinde veri yok.`,
              `No line data before ${since}.`,
            )}
          </p>
        )}
      </div>
    </section>
  );
}
