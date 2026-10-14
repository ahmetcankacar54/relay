import { dayPlan } from "../../../shared/day-plan";
import { localDate } from "../../../shared/planning";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import {
  dayTimeline,
  nextPlannedWindow,
  plannedSettings,
  windowTone,
} from "@/lib/day-timeline";
import { formatClock } from "@/lib/time";
import type { PageId } from "@/app/routes";

export function TodayCard({
  go,
  now,
}: {
  go: (page: PageId) => void;
  now: number;
}) {
  const relay = useRelay();
  const { t, language } = useI18n();
  const settings = relay.settings.planning;
  const zone = settings.timeZone;
  const accounts = relay.accounts;
  const { pct, intervals, rows, showNow } = dayTimeline({
    settings,
    accounts,
    usage: relay.data?.usage ?? {},
    now,
  });
  const planned = plannedSettings(settings, accounts);
  const name = (id?: string) => accounts.find((a) => a.id === id)?.name ?? "—";
  const plannedToday = dayPlan(localDate(now, zone), planned).accounts.reduce(
    (n, a) => n + a.windows.length,
    0,
  );
  const upcoming = nextPlannedWindow(
    settings,
    accounts,
    relay.data?.planning,
    now,
  );
  const clock = (time: number | string) => formatClock(time, language, zone);
  const summary = !settings.autoStart
    ? t("Otomatik başlatma kapalı", "Automatic start is off")
    : !planned.accounts.length
      ? t("Plana hesap eklenmedi", "No accounts in the plan")
      : upcoming
        ? t(
            `Otomatik başlatma açık · sonraki ${clock(upcoming.at)} ${name(upcoming.accountId)}`,
            `Automatic start on · next ${clock(upcoming.at)} ${name(upcoming.accountId)}`,
          )
        : t(
            `Bugün ${plannedToday} başlatma planlı`,
            `${plannedToday} starts planned today`,
          );
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
        <span className="font-semibold">{t("Bugün", "Today")}</span>
        <Button
          variant="link"
          size="sm"
          className="h-auto px-0"
          onClick={() => go("planlama")}
        >
          {t("Planlama →", "Planning →")}
        </Button>
      </div>
      <div className="mb-2 text-xs text-muted-foreground">{summary}</div>
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
      </div>
    </Card>
  );
}
