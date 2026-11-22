import { useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type {
  Account,
  AccountUsage,
  PlanningSettings,
} from "../../../shared/types";
import type { Forecast } from "../../../shared/capacity-plan";
import type { Tempo } from "../../../shared/tempo";
import {
  accountTone,
  dayTimeline,
  switchTimes,
  type TimelineAdaptation,
} from "@/lib/day-timeline";
import { forecastSummary } from "@/lib/forecast-text";
import { formatClock } from "@/lib/time";
import { parseLanguage } from "@/data/language";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { AccountDot } from "@/components/AccountDot";
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


/** What comes next today, beside the plan's summary: the page's own words. */
export interface NextStat {
  value: string;
  /** One quiet line under it (today's live forecast). */
  note?: ReactNode;
  /** Chips that only show while the day is adapted. */
  chips?: ReactNode;
}

/** One figure under the timeline: a small label, the value, a quiet line. */
function Stat({
  label,
  value,
  valueTitle,
  note,
  noteTitle,
  crit,
  chips,
  slot,
}: {
  label: string;
  value: string;
  valueTitle?: string;
  note?: ReactNode;
  noteTitle?: string;
  crit?: boolean;
  chips?: ReactNode;
  slot: string;
}) {
  return (
    <div data-slot={slot} className="grid min-w-0 content-start gap-0.5">
      <span className={noteClass}>{label}</span>
      <strong className={cn("text-sm font-semibold", crit && "text-crit")} title={valueTitle}>
        {value}
      </strong>
      {/* Who warms up when: visible, and still the title for a pointer resting on the value. */}
      {valueTitle && <small className="text-2xs text-muted-foreground">{valueTitle}</small>}
      {note && (
        <span className={noteClass} title={noteTitle}>
          {note}
        </span>
      )}
      {noteTitle && <small className="text-2xs text-muted-foreground">{noteTitle}</small>}
      {chips}
    </div>
  );
}
/** The day's work, usage forecast and five-hour windows, one day at a time. */
export function PlanTimeline({
  settings,
  accounts,
  usage,
  now,
  tempo,
  activeId,
  adaptation,
  next,
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
  /** Today's next start and live forecast, beside the plan's summary (today only). */
  next?: NextStat;
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
      return t("Önceden başlatma kapalı", "Early start is off");
    const list = times
      .map((time, i) => `${name(ids[i])} ${clock(time)}`)
      .join(" · ");
    return t(`Önceden başlatma: ${list}`, `Early start: ${list}`);
  };
  // What the lanes' marks mean: work hours, the faded forecast, no quota and a switch.
  const legend = [
    {
      label: t("Çalışma", "Work"),
      swatch: <i aria-hidden="true" className="h-2.5 w-4 rounded-sm bg-brand/20" />,
    },
    {
      label: t("Tahmin", "Forecast"),
      swatch: (
        <i aria-hidden="true" className="h-2.5 w-4 rounded-sm bg-meter opacity-50 dark:opacity-65" />
      ),
    },
    {
      label: t("Limit dolu", "No quota"),
      swatch: (
        <i
          aria-hidden="true"
          className="h-2.5 w-4 rounded-sm bg-crit/25 bg-[repeating-linear-gradient(135deg,var(--crit)_0_2px,transparent_2px_6px)]"
        />
      ),
    },
    {
      label: t("Geçiş", "Switch"),
      swatch: <i aria-hidden="true" className="h-3 w-0.5 rounded-[1px] bg-foreground/55" />,
    },
  ];
  // Under the lanes: this plan against an even spread (who warms up when is in the titles), and
  // what comes next today.
  const planStat = compare && {
    value: forecastSummary(compare.plan, t, clock),
    valueTitle: warmUpLine(compare.warmUps.accountIds, compare.warmUps.plan),
    crit: hasGap(compare.plan),
    note: t(
      `Eşit dağıtımda: ${forecastSummary(compare.even, t, clock)}`,
      `Spread evenly: ${forecastSummary(compare.even, t, clock)}`,
    ),
    noteTitle: warmUpLine(compare.warmUps.accountIds, compare.warmUps.even),
  };
  const nextStat = offset === 0 ? next : undefined;
  return (
    <Card padded className="@container">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-baseline gap-2">
          <strong className="font-display text-sm font-semibold">
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
          <div className="relative h-4 text-xs text-muted-foreground tabular-nums">
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
                index < 0 ? t("Limit dolu", "No quota") : rows[index].account.name;
              const text = `${name} ${clock(segment.from)}–${clock(segment.to)}`;
              return (
                <div
                  key={`${segment.live ? "live" : "plan"}-${segment.from}`}
                  className="absolute inset-y-0 flex items-center justify-center-safe overflow-hidden rounded-[5px] px-1 text-xs font-bold"
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
                      index < 0 ? "bg-crit/25" : accountTone(rows[index].account),
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
        {rows.map(({ account, windows }) => (
          <div className={rowClass} key={account.id}>
            <span className="flex min-w-0 items-center gap-1.5 pr-2.5">
              <AccountDot color={account.color} />
              <span className="truncate">{account.name}</span>
            </span>
            <div className="relative h-[18px] rounded-md bg-track">
              {windows.map((w) => (
                <div
                  key={w.start}
                  className={cn(
                    "absolute inset-y-0.5 rounded-[5px]",
                    accountTone(account),
                  )}
                  title={`${clock(w.start)}–${clock(w.end)}`}
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
      <ul
        data-slot="timeline-legend"
        className={cn(noteClass, "mt-2.5 flex flex-wrap gap-x-4 gap-y-1")}
      >
        {legend.map(({ label, swatch }) => (
          <li key={label} className="flex items-center gap-1.5">
            {swatch}
            {label}
          </li>
        ))}
      </ul>
      {(planStat || nextStat) && (
        <div className="mt-3 grid gap-3 border-t pt-3 @xl:grid-cols-2">
          {planStat && <Stat slot="plan-stat" label={t("Bu plan", "This plan")} {...planStat} />}
          {nextStat && <Stat slot="next-stat" label={t("Sıradaki", "Next")} {...nextStat} />}
        </div>
      )}
    </Card>
  );
}
