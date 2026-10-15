import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type {
  Account,
  AccountUsage,
  PlanningSettings,
} from "../../../shared/types";
import { WINDOW_MS } from "../../../shared/day-plan";
import type { Forecast } from "../../../shared/capacity-plan";
import type { Tempo } from "../../../shared/tempo";
import {
  dayTimeline,
  switchTimes,
  windowTone,
  type TimelineAdaptation,
} from "@/lib/day-timeline";
import { forecastSummary } from "@/lib/forecast-text";
import { formatClock } from "@/lib/time";
import { parseLanguage } from "@/data/language";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type T = (tr: string, en: string) => string;

const RULER = [0, 3, 6, 9, 12, 15, 18, 21, 24];
const rowClass =
  "grid grid-cols-[84px_minmax(0,1fr)] items-center text-xs @xl:grid-cols-[128px_minmax(0,1fr)]";
const noteClass = "text-xs text-muted-foreground";
/** The lane block's name shows only when the block is this wide (% of the day). */
const NAMED_WIDTH = 8;

const hasGap = (forecast: Forecast) =>
  forecast.segments.some((s) => !s.accountId);

/** The day's work, usage forecast and five-hour windows, one day at a time. */
export function PlanTimeline({
  settings,
  accounts,
  usage,
  now,
  tempo,
  activeId,
  adaptation,
  t,
}: {
  settings: PlanningSettings;
  accounts: Account[];
  usage: Record<string, AccountUsage>;
  now: number;
  /** The keeper's tempo; without it the settings' fallback tempo plans. */
  tempo?: Tempo;
  /** The account Claude Desktop uses now. */
  activeId?: string;
  /** Today's pace and adopted starts from the keeper. */
  adaptation?: TimelineAdaptation;
  t: T;
}) {
  const [offset, setOffset] = useState(0);
  const zone = settings.timeZone;
  const clock = (time: number) =>
    formatClock(time, parseLanguage(t("tr", "en")), zone);
  const { dayBegin, pct, intervals, rows, showNow, lane, compare } =
    dayTimeline({
      settings,
      accounts,
      usage,
      now,
      offset,
      tempo,
      activeId,
      adaptation,
    });
  const label = new Intl.DateTimeFormat(t("tr-TR", "en-GB"), {
    timeZone: zone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(dayBegin + 12 * 3_600_000));
  const title =
    offset === 0
      ? t("Bugün", "Today")
      : offset === 1
        ? t("Yarın", "Tomorrow")
        : offset === -1
          ? t("Dün", "Yesterday")
          : label;
  const position = (start: number, end: number) => ({
    left: `${pct(start)}%`,
    width: `${pct(end) - pct(start)}%`,
  });
  const nowLine = showNow && (
    <div
      className="absolute -inset-y-[3px] -ml-px w-0.5 rounded-[1px] bg-foreground"
      style={{ left: `${pct(now)}%` }}
    />
  );
  const name = (id: string) =>
    rows.find((r) => r.account.id === id)?.account.name ?? "—";
  /** Who warms up when, by name; nothing is warmed up while auto start is off. */
  const warmUpLine = (ids: string[], times: number[]) => {
    if (!settings.autoStart)
      return t(
        "Otomatik başlatma kapalı; ısıtma yapılmaz",
        "Automatic start is off; no warm-ups",
      );
    const list = times
      .map((time, i) => `${name(ids[i])} ${clock(time)}`)
      .join(" · ");
    return t(`Isıtma: ${list}`, `Warm-up: ${list}`);
  };
  const comparison = compare && [
    {
      title: t("Bu plan", "This plan"),
      forecast: compare.plan,
      warmUps: warmUpLine(compare.warmUps.accountIds, compare.warmUps.plan),
    },
    {
      title: t("Eşit aralıklı dağıtım", "Even spread"),
      forecast: compare.even,
      warmUps: warmUpLine(compare.warmUps.accountIds, compare.warmUps.even),
    },
  ];
  return (
    <Card className="@container gap-0 px-5 py-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-baseline gap-2">
          <strong className="font-display text-[15px] font-semibold">
            {title}
          </strong>
          {offset >= -1 && offset <= 1 && (
            <small className={noteClass}>{label}</small>
          )}
        </span>
        <div className="flex items-center gap-1">
          {offset !== 0 && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto px-1 text-xs"
              onClick={() => setOffset(0)}
            >
              {t("Bugüne dön", "Back to today")}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("Önceki gün", "Previous day")}
            onClick={() => setOffset(offset - 1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("Sonraki gün", "Next day")}
            onClick={() => setOffset(offset + 1)}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
      <div className="grid gap-[7px]">
        <div className={rowClass} aria-hidden="true">
          <span />
          <div className="relative h-4 text-[11px] text-muted-foreground tabular-nums">
            {RULER.map((h, index) => (
              <span
                key={h}
                className={cn(
                  "absolute",
                  index === 0
                    ? ""
                    : index === RULER.length - 1
                      ? "-translate-x-full"
                      : "-translate-x-1/2",
                  index % 2 === 1 && "hidden @xl:inline",
                )}
                style={{ left: `${(h / 24) * 100}%` }}
              >
                {String(h).padStart(2, "0")}
              </span>
            ))}
          </div>
        </div>
        <div className={rowClass}>
          <span className="truncate pr-2.5 text-muted-foreground">
            {t("Çalışma", "Work")}
          </span>
          <div className="relative h-[18px] rounded-md bg-track">
            {intervals.map((i) => (
              <div
                key={i.start}
                className="absolute inset-y-0 rounded-md bg-brand/20"
                title={`${clock(i.start)}–${clock(i.end)}`}
                style={position(i.start, i.end)}
              />
            ))}
            {nowLine}
          </div>
        </div>
        <div className={rowClass}>
          <span className="flex min-w-0 items-baseline gap-1 pr-2.5">
            <span className="font-semibold">{t("Kullanım", "Usage")}</span>
            <span className="truncate text-muted-foreground">
              {t("tahmin", "forecast")}
            </span>
          </span>
          <div className="relative h-5 rounded-md bg-track">
            {lane.map((segment) => {
              // Lane colours follow the window rows (planned-account order).
              const index = rows.findIndex(
                (r) => r.account.id === segment.accountId,
              );
              const name =
                index < 0 ? t("Kotasız", "No quota") : rows[index].account.name;
              const text = `${name} ${clock(segment.from)}–${clock(segment.to)}`;
              return (
                <div
                  key={`${segment.live ? "live" : "plan"}-${segment.from}`}
                  className="absolute inset-y-0 flex items-center justify-center-safe overflow-hidden rounded-[5px] px-1 text-[10px] font-bold"
                  title={text}
                  aria-label={text}
                  role="img"
                  style={position(segment.from, segment.to)}
                >
                  {/* Only the fill dims, so the name keeps its contrast
                      (dark mode dims less: its tones sit on a dark track). */}
                  <span
                    className={cn(
                      "absolute inset-0",
                      index < 0 ? "bg-crit/25" : windowTone(index),
                      !segment.live && "opacity-50 dark:opacity-65",
                    )}
                    aria-hidden="true"
                  >
                    {index < 0 && (
                      <span className="absolute inset-0 bg-[repeating-linear-gradient(135deg,var(--crit)_0_2px,transparent_2px_6px)] opacity-60" />
                    )}
                  </span>
                  {index >= 0 &&
                    pct(segment.to) - pct(segment.from) >= NAMED_WIDTH && (
                      <span className="relative min-w-0 truncate text-foreground dark:text-primary-foreground">
                        {name}
                      </span>
                    )}
                </div>
              );
            })}
            {switchTimes(lane).map((time) => (
              <div
                key={time}
                className="absolute -inset-y-[3px] -ml-px w-0.5 rounded-[1px] bg-foreground/55"
                style={{ left: `${pct(time)}%` }}
              />
            ))}
            {nowLine}
          </div>
        </div>
        {rows.map(({ account, windows }, index) => (
          <div className={rowClass} key={account.id}>
            <span className="flex min-w-0 items-center gap-1.5 pr-2.5">
              <i
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  windowTone(index),
                )}
                aria-hidden="true"
              />
              <span className="truncate">{account.name}</span>
            </span>
            <div className="relative h-[18px] rounded-md bg-track">
              {windows.map((w) => (
                <div
                  key={w.start}
                  className={cn(
                    "absolute inset-y-0.5 rounded-[5px]",
                    windowTone(index),
                  )}
                  title={`${clock(w.start)}–${clock(w.start + WINDOW_MS)}`}
                  style={position(w.start, w.end)}
                />
              ))}
              {nowLine}
            </div>
          </div>
        ))}
      </div>
      {!intervals.length && (
        <p className={cn(noteClass, "mt-2")}>
          {t("Bu gün için plan yok.", "No plan for this day.")}
        </p>
      )}
      <p className={cn(noteClass, "mt-2.5")}>
        {t(
          "Kullanım şeridi Relay’in tahmini: hangi saatte hangi hesapla çalışacağın. Dikey çizgiler geçiş, taralı kırmızı kotasız. Alttaki çubuklar 5 saatlik pencereler; çubuğun sonu sıfırlanma. Soluk kısım planın tahmini, canlı kısım şu anki kullanımdan hesaplanır.",
          "The usage lane is Relay’s forecast of which account you work on when. Vertical lines are switches, striped red is no quota. The bars below are five-hour windows; a bar ends at the reset. The faded part is the plan’s forecast; the solid part is computed from current usage.",
        )}
      </p>
      {comparison && (
        <div className="mt-2.5 grid gap-2.5 @xl:grid-cols-2">
          {comparison.map(({ title, forecast, warmUps }) => (
            <div
              key={title}
              className="min-w-0 rounded-[10px] border px-2.5 py-2"
            >
              <span className={noteClass}>{title}</span>
              <strong
                className={cn(
                  "block text-[13px] font-semibold",
                  hasGap(forecast) && "text-crit",
                )}
              >
                {forecastSummary(forecast, t, clock)}
              </strong>
              <small
                className={cn(noteClass, "block truncate")}
                title={warmUps}
              >
                {warmUps}
              </small>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
