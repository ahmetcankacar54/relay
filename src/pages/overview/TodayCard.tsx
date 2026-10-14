import type {
  Account,
  AccountUsage,
  KeeperSnapshot,
  PlanningSettings,
} from "../../../shared/types";
import { dayPlan, dayStart, shiftDate } from "../../../shared/day-plan";
import { localDate } from "../../../shared/planning";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { formatClock } from "@/lib/time";
import type { PageId } from "@/app/routes";

/** Planned settings without deleted accounts, exactly as the window keeper sees them. */
export function plannedSettings(
  settings: PlanningSettings,
  accounts: Account[],
) {
  return {
    ...settings,
    accounts: settings.accounts.filter(({ id }) =>
      accounts.some((a) => a.id === id),
    ),
  };
}

/** The next planned start: the keeper's live view first, else today's plan onward. */
export function nextPlannedWindow(
  settings: PlanningSettings,
  accounts: Account[],
  keeper: KeeperSnapshot | undefined,
  now: number,
) {
  if (keeper?.next) return keeper.next;
  const planned = plannedSettings(settings, accounts);
  const today = localDate(now, settings.timeZone);
  return [0, 1, 2, 3, 4, 5, 6, 7]
    .flatMap((d) => dayPlan(shiftDate(today, d), planned).accounts)
    .flatMap((a) =>
      a.windows.map((w) => ({ accountId: a.accountId, at: w.start })),
    )
    .filter((w) => w.at > now)
    .sort((a, b) => a.at - b.at)
    .map((w) => ({ ...w, at: new Date(w.at).toISOString() }))[0];
}

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
  const usage: Record<string, AccountUsage> = relay.data?.usage ?? {};
  const planned = plannedSettings(settings, accounts);
  const today = localDate(now, zone);
  const dayBegin = dayStart(today, zone);
  const dayEnd = dayStart(shiftDate(today, 1), zone);
  const pct = (time: number) =>
    Math.min(100, Math.max(0, ((time - dayBegin) / (dayEnd - dayBegin)) * 100));
  const live = Object.fromEntries(
    Object.entries(usage).map(([id, u]) => [
      id,
      Date.parse(u.fiveHour?.resetsAt ?? "") || undefined,
    ]),
  );
  const plans = [-1, 0, 1].map((d) =>
    dayPlan(shiftDate(today, d), planned, d === 0 ? live : {}),
  );
  const intervals = plans
    .map((p) => p.interval)
    .filter(
      (i): i is NonNullable<typeof i> =>
        !!i && i.end > dayBegin && i.start < dayEnd,
    );
  const rows = planned.accounts
    .map(({ id }) => accounts.find((a) => a.id === id))
    .filter((a): a is Account => !!a);
  const name = (id?: string) => accounts.find((a) => a.id === id)?.name ?? "—";
  const plannedToday = plans[1].accounts.reduce(
    (n, a) => n + a.windows.length,
    0,
  );
  const upcoming = nextPlannedWindow(
    settings,
    accounts,
    relay.data?.planning,
    now,
  );
  const summary = !settings.autoStart
    ? t("Otomatik başlatma kapalı", "Automatic start is off")
    : !planned.accounts.length
      ? t("Plana hesap eklenmedi", "No accounts in the plan")
      : upcoming
        ? t(
            `Otomatik başlatma açık · sonraki ${formatClock(upcoming.at, language, zone)} ${name(upcoming.accountId)}`,
            `Automatic start on · next ${formatClock(upcoming.at, language, zone)} ${name(upcoming.accountId)}`,
          )
        : t(
            `Bugün ${plannedToday} başlatma planlı`,
            `${plannedToday} starts planned today`,
          );
  const nowLine = now >= dayBegin && now < dayEnd && (
    <div
      className="absolute -inset-y-1 w-0.5 bg-foreground"
      style={{ left: `${pct(now)}%` }}
    />
  );
  const span = (start: number, end: number) => ({
    left: `${pct(start)}%`,
    width: `${pct(end) - pct(start)}%`,
  });
  const range = (start: number, end: number) =>
    `${formatClock(start, language, zone)}–${formatClock(end, language, zone)}`;
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
                title={range(i.start, i.end)}
                className="absolute inset-y-0 rounded bg-brand/20"
                style={span(i.start, i.end)}
              />
            ))}
            {nowLine}
          </div>
        </div>
        {rows.map((account) => {
          const windows = plans
            .flatMap((p) =>
              p.accounts
                .filter((a) => a.accountId === account.id)
                .flatMap((a) => a.windows),
            )
            .filter(
              (w, i, all) =>
                w.end > dayBegin &&
                w.start < dayEnd &&
                all.findIndex((x) => x.start === w.start) === i,
            );
          return (
            <div
              key={account.id}
              className="grid grid-cols-[84px_1fr] items-center gap-2"
            >
              <span className="truncate">{account.name}</span>
              <div className="relative h-3.5 rounded bg-track">
                {windows.map((w) => (
                  <div
                    key={w.start}
                    title={range(w.start, w.end)}
                    className="absolute inset-y-0.5 rounded bg-brand/80"
                    style={span(w.start, w.end)}
                  />
                ))}
                {nowLine}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
