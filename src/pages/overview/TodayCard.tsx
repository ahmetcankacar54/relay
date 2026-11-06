import { dayPlan, planContext } from "../../../shared/day-plan";
import { localDate, wallTime } from "../../../shared/planning";
import { isWeekend } from "../../../shared/work-hours";
import { fallbackTempo } from "../../../shared/tempo";
import { Panda } from "@/components/Panda";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import {
  dayTimeline,
  nextPlannedWindow,
  plannedSettings,
  todayLookout,
  windowTone,
} from "@/lib/day-timeline";
import { formatClock } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { Destination } from "@/app/routes";

export function TodayCard({
  go,
  now,
}: {
  go: (to: Destination) => void;
  now: number;
}) {
  const relay = useRelay();
  const { t, language } = useI18n();
  const settings = relay.settings.planning;
  const zone = settings.timeZone;
  const accounts = relay.accounts;
  // The keeper's tempo, so the card shows the times the keeper starts.
  const tempo = relay.data?.planning?.tempo ?? fallbackTempo(settings);
  const { pct, intervals, rows, showNow } = dayTimeline({
    settings,
    accounts,
    usage: relay.data?.usage ?? {},
    now,
    tempo,
  });
  const planned = plannedSettings(settings, accounts);
  const unplanned = todayLookout(settings, accounts);
  const name = (id?: string) => accounts.find((a) => a.id === id)?.name ?? "—";
  const plannedToday = dayPlan(
    localDate(now, zone),
    planned,
    planContext(accounts, tempo),
  ).accounts.reduce((n, a) => n + a.windows.length, 0);
  const upcoming = nextPlannedWindow(
    settings,
    accounts,
    relay.data?.planning,
    now,
  );
  const clock = (time: number | string) => formatClock(time, language, zone);
  // Today's work hours (weekday or weekend), then how early start stands.
  const today = localDate(now, zone);
  const hours = isWeekend(today) ? settings.weekend : settings.weekday;
  const work = hours.enabled
    ? t(`Çalışma ${hours.start}–${hours.end}`, `Work ${hours.start}–${hours.end}`)
    : t("Bugün çalışma yok", "No work today");
  const early = !settings.autoStart
    ? t("önceden başlatma kapalı", "early start off")
    : !planned.accounts.length
      ? t("plana hesap eklenmedi", "no accounts in the plan")
      : upcoming
        ? t(
            `sonraki başlatma ${clock(upcoming.at)} ${name(upcoming.accountId)}`,
            `next start ${clock(upcoming.at)} ${name(upcoming.accountId)}`,
          )
        : t(
            `bugün ${plannedToday} başlatma planlı`,
            `${plannedToday} ${plannedToday === 1 ? "start" : "starts"} planned today`,
          );
  const summary = `${work} · ${early}`;
  // The hour axis under the rows; 24 is the day's end, wherever DST puts it.
  const ticks = ["00", "06", "12", "18", "24"].map((hour) => ({
    hour,
    at: hour === "24" ? 100 : pct(wallTime(today, `${hour}:00`, zone) ?? now),
  }));
  const nowLine = showNow && (
    <div
      className="absolute -inset-y-1 w-0.5 bg-foreground"
      style={{ left: `${pct(now)}%` }}
    />
  );
  const span = (start: number, end: number) => ({
    left: `${pct(start)}%`,
    width: `${pct(end) - pct(start)}%`,
  });
  return (
    <Card className="gap-0 px-4 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">{t("Bugün", "Today")}</span>
        <Button
          variant="link"
          size="sm"
          className="h-auto px-0"
          onClick={() => go("planlama")}
        >
          {t("Planlama →", "Planning →")}
        </Button>
      </div>
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        {unplanned && <Panda scene="lookout" size={32} playful />}
        <span>{summary}</span>
      </div>
      <div className="grid gap-1.5 text-xs">
        <div className="grid grid-cols-[84px_1fr] items-center gap-2">
          <span className="truncate text-muted-foreground">
            {t("Çalışma", "Work")}
          </span>
          <div className="relative h-3.5 rounded bg-track">
            {intervals.map((i) => (
              <div
                key={i.start}
                title={`${clock(i.start)}–${clock(i.end)}`}
                className="absolute inset-y-0 rounded bg-brand/20"
                style={span(i.start, i.end)}
              />
            ))}
            {nowLine}
          </div>
        </div>
        {rows.map(({ account, windows }, index) => (
          <div
            key={account.id}
            className="grid grid-cols-[84px_1fr] items-center gap-2"
          >
            <span className="truncate">{account.name}</span>
            <div className="relative h-3.5 rounded bg-track">
              {windows.map((w) => (
                <div
                  key={w.start}
                  title={`${clock(w.start)}–${clock(w.end)}`}
                  className={`absolute inset-y-0.5 rounded ${windowTone(index)}`}
                  style={span(w.start, w.end)}
                />
              ))}
              {nowLine}
            </div>
          </div>
        ))}
        <div aria-hidden="true" className="grid grid-cols-[84px_1fr] gap-2">
          <span />
          <div className="relative h-3.5 text-2xs tabular-nums text-muted-foreground">
            {ticks.map(({ hour, at }, index) => (
              <span
                key={hour}
                className={cn(
                  "absolute top-0",
                  index === ticks.length - 1 ? "-translate-x-full" : index > 0 && "-translate-x-1/2",
                )}
                style={{ left: `${at}%` }}
              >
                {hour}
              </span>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}
