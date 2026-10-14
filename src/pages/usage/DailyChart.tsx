import { localDate } from "../../../shared/planning";
import type { Account } from "../../../shared/types";
import type { UsageStatisticsView } from "../../../shared/usage-statistics-view";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/data/i18n";
import { windowTone } from "@/lib/day-timeline";
import { cn } from "@/lib/utils";
import {
  formatDay,
  formatNumber,
  formatUnits,
  rowKey,
  rowName,
  toneFill,
  toneIndex,
} from "./format";

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

/** Stacked Pro units per local day, coloured by account, ▲ on days with a limit hit. */
export function DailyChart({
  view,
  accounts,
  zone,
}: {
  view: UsageStatisticsView;
  accounts: Account[];
  zone: string;
}) {
  const { t, language } = useI18n();
  const rows = view.accounts.map((row) => ({
    key: rowKey(row),
    name: rowName(row, t),
    index: toneIndex(row, accounts),
  }));
  const days = view.daily.map((day) => ({
    date: day.date,
    total: Object.values(day.byAccount).reduce((a, b) => a + b, 0),
    byAccount: day.byAccount,
  }));
  const hitDays = new Set(
    view.hits.map((hit) => localDate(Date.parse(hit.at), zone)),
  );
  const max = Math.max(0, ...days.map((d) => d.total));
  const scale = max > 0 ? (BASE - TOP) / max : 0;
  const labels = [formatNumber(max, language), formatNumber(max / 2, language)];
  // The gutter grows with the longest y label ("12.345").
  const left = Math.max(
    MIN_LEFT,
    Math.ceil(Math.max(...labels.map((l) => l.length)) * LABEL_CHAR) + 8,
  );
  const step = (WIDTH - left) / Math.max(1, days.length);
  const bar = Math.max(1, step * 0.72);
  const mark = Math.min(bar, MARK);
  const busiest = days.reduce<(typeof days)[number] | undefined>(
    (best, day) => (day.total > (best?.total ?? 0) ? day : best),
    undefined,
  );
  const ticks = days.length
    ? [0, Math.floor((days.length - 1) / 2), days.length - 1]
    : [];
  const units = (value: number) => formatUnits(value, language, t);
  return (
    <Card className="gap-0 px-5 py-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="font-display text-[15px] font-semibold">
          {t("Günlük kullanım", "Daily usage")}
        </h3>
        <ul className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          {rows.map((row) => (
            <li key={row.key} className="flex items-center gap-1">
              <i
                aria-hidden
                className={cn("size-2.5 rounded-sm", windowTone(row.index))}
              />
              {row.name}
            </li>
          ))}
        </ul>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="group"
        aria-label={t("Günlük kullanım grafiği", "Daily usage chart")}
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
          const hit = hitDays.has(day.date);
          const label = formatDay(day.date, language);
          let y = BASE;
          const parts = rows
            .map((row) => ({ ...row, value: day.byAccount[row.key] ?? 0 }))
            .filter((part) => part.value > 0);
          return (
            <g
              key={day.date}
              role="img"
              aria-label={`${label}: ${units(day.total)}${hit ? t(", limite takıldı", ", limit hit") : ""}`}
            >
              <title>
                {[
                  label,
                  ...parts.map(
                    (p) => `${p.name} ${formatNumber(p.value, language)}`,
                  ),
                ].join(" · ")}
              </title>
              <rect
                x={left + i * step}
                y={TOP}
                width={step}
                height={BASE - TOP}
                fill="transparent"
              />
              {parts.map((part) => {
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
                    fill={toneFill(part.index)}
                  />
                );
              })}
              {hit && (
                <path
                  d={triangle(x + bar / 2, Math.max(TOP - 2, y - 2), mark)}
                  fill="var(--crit)"
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
      <p className="mt-1 text-xs text-muted-foreground">
        {busiest
          ? t(
              `${view.range} günde toplam ${units(view.totals.proUnits)}; en yoğun gün ${formatDay(busiest.date, language)} (${formatNumber(busiest.total, language)}).`,
              `${units(view.totals.proUnits)} in total over ${view.range} days; busiest day ${formatDay(busiest.date, language)} (${formatNumber(busiest.total, language)}).`,
            )
          : t("Bu dönemde kullanım yok.", "No usage in this period.")}{" "}
        {t(
          "▲ limite takılan günleri gösterir.",
          "▲ marks days with a limit hit.",
        )}
      </p>
    </Card>
  );
}
