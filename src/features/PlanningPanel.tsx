import { useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { routineFailure } from "../../shared/routine-failure";
import { clockLocative } from "../../shared/tr-dative";
import type {
  Account,
  AccountPlanning,
  AccountUsage,
  KeeperAccountStatus,
  KeeperSnapshot,
  PlanningHours,
  PlanningSettings,
} from "../../shared/types";
import {
  dayPlan,
  dayStart,
  planContext,
  shiftDate,
} from "../../shared/day-plan";
import { localDate } from "../../shared/planning";
import { fallbackTempo, presetTempo } from "../../shared/tempo";
import {
  dayTimeline,
  nextPlannedWindow,
  nextStartLabel,
  type TimelineAdaptation,
} from "../lib/day-timeline";
import type { Language } from "../data/language";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { AccountDot } from "@/components/AccountDot";
import { ListCard, ListFoot, ListGroup, ListHead, ListRow, ListSection, narrowHidden } from "@/components/ListCard";
import { InfoTip, PageSection } from "@/components/PageSection";
import { StatusDot } from "@/components/StatusDot";
import { StatusLabel } from "@/components/StatusLabel";
import type { AccountStatus } from "@/lib/account-status";
import { forecastSummary } from "@/lib/forecast-text";
import { cn } from "@/lib/utils";
import { macWording } from "@/data/platform";
import { TimePicker } from "./TimePicker";
import { TimeZonePicker } from "./TimeZonePicker";
import { PlanEditor } from "./PlanEditor";
import { PlanTimeline, type NextStat } from "../pages/planning/PlanTimeline";
import { TempoRow } from "../pages/planning/TempoRow";
import { AdaptiveRow } from "../pages/planning/AdaptiveRow";
import { AccountWindowLine } from "../pages/planning/AccountWindowLine";

type T = (tr: string, en: string) => string;
const failureText = (reason: string | undefined, t: T) =>
  t(...(routineFailure(reason) ?? ["istek başarısız", "request failed"]));

/** Refusals that stop an account until the plan changes (see the keeper). */
const stopReason = (status?: KeeperAccountStatus) =>
  status?.state === "blocked" &&
  [
    "routine-policy-unverified",
    "routine-platform-unsupported",
    "routine-cli-unavailable",
    "routine-cli-unsupported",
  ].includes(status.reason ?? "");

function clock(time: number | string, zone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(time));
}

/** "Cumartesi tahmini: " / "Saturday: " for a later day's pill. */
function weekdayForecast(date: string, zone: string, t: T) {
  const weekday = new Intl.DateTimeFormat(t("tr-TR", "en-GB"), {
    timeZone: zone,
    weekday: "long",
  }).format(new Date(dayStart(date, zone) + 12 * 3_600_000));
  return t(`${weekday} tahmini: `, `${weekday}: `);
}

function statusText(
  status: KeeperAccountStatus | undefined,
  lastFailure: string | undefined,
  zone: string,
  t: T,
) {
  if (!status) return t("Henüz durum yok", "No status yet");
  switch (status.state) {
    case "off":
      return t("Önceden başlatma kapalı", "Early start is off");
    case "outside":
      return status.nextStartAt
        ? t(
            `Sonraki başlatma ${clock(status.nextStartAt, zone)}`,
            `Next start ${clock(status.nextStartAt, zone)}`,
          )
        : t("Planlı başlatma yok", "No planned start");
    case "active":
      return t(
        `Dönem açık · ${clockLocative(clock(status.resetsAt!, zone))} yenilenir`,
        `Period open · Resets ${clock(status.resetsAt!, zone)}`,
      );
    case "due":
      return t("Başlatılıyor…", "Start in progress…");
    case "waiting":
      if (status.reason === "adapted")
        return t(
          `Plan uyarlandı · ${clockLocative(clock(status.nextStartAt!, zone))} başlatılacak`,
          `Plan adapted · starts at ${clock(status.nextStartAt!, zone)}`,
        );
      if (status.reason === "cooldown")
        return t(
          `Son deneme başarısız: ${failureText(lastFailure, t)}. 15 dk sonra yeniden denenecek`,
          `Last attempt failed: ${failureText(lastFailure, t)}. Next try in 15 min`,
        );
      if (status.reason === "in-use")
        return t("Relay’de çalışan bir oturum var", "A Relay session is running");
      if (status.reason === "relay-busy")
        return t(
          "Başka bir Relay işlemi sürüyor",
          "Another Relay operation is running",
        );
      return t("Limit verisi yenileniyor", "Usage refresh in progress");
    case "blocked":
      if (stopReason(status))
        return t(
          `Durdu: ${failureText(status.reason, t)}`,
          `Stopped: ${failureText(status.reason, t)}`,
        );
      if (status.reason === "weekly-limit")
        return t("Haftalık limit dolu", "Weekly limit reached");
      if (status.reason === "daily-limit")
        return t(
          "Bugünkü deneme sınırı doldu",
          "Today’s attempt limit reached",
        );
      return t("Limit okuma girişi gerekli", "Usage sign-in required");
  }
}

/**
 * An account's status as the page shows it. While adaptation is on, a start
 * deferred before the account's active range (the keeper still reports it as
 * outside the range) waits for its adopted time; once it is off on the page,
 * an adapted wait reads as a plain next start.
 */
function shownStatus(
  status: KeeperAccountStatus | undefined,
  adaptation: TimelineAdaptation | undefined,
): KeeperAccountStatus | undefined {
  if (!status) return undefined;
  const deferred = adaptation?.schedule[status.accountId];
  if (status.state === "outside" && Number.isFinite(deferred))
    return {
      ...status,
      state: "waiting",
      reason: "adapted",
      nextStartAt: new Date(deferred!).toISOString(),
    };
  if (!adaptation && status.state === "waiting" && status.reason === "adapted")
    return {
      accountId: status.accountId,
      state: "outside",
      nextStartAt: status.nextStartAt,
    };
  return status;
}

/** Hours and minutes between two clocks; an end at or before the start is the next day. */
function span(hours: PlanningHours, t: T) {
  const minutes = (value: string) =>
    Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  const length =
    ((minutes(hours.end) - minutes(hours.start) + 1440 - 1) % 1440) + 1;
  const h = Math.floor(length / 60),
    m = length % 60;
  return m ? t(`${h} sa ${m} dk`, `${h} h ${m} min`) : t(`${h} sa`, `${h} h`);
}

const noteClass = "text-xs text-muted-foreground";

/**
 * An account's planning status in at most four words, for the list's status column; the keeper's
 * full sentence (`statusText`) is its title.
 */
export function planStatus(
  status: KeeperAccountStatus | undefined,
  lastFailure: string | undefined,
  zone: string,
  t: T,
): AccountStatus {
  const reason = statusText(status, lastFailure, zone, t);
  const say = (tone: AccountStatus["tone"], text: string): AccountStatus => ({ tone, text, reason });
  if (!status) return say("off", t("Durum yok", "No status"));
  switch (status.state) {
    case "off":
      return say("off", t("Başlatma kapalı", "Early start off"));
    case "outside":
      return status.nextStartAt
        ? say("ok", t(`Sonraki ${clock(status.nextStartAt, zone)}`, `Next ${clock(status.nextStartAt, zone)}`))
        : say("off", t("Başlatma yok", "No start"));
    case "active":
      return say("ok", t(`Dönem açık · ${clock(status.resetsAt!, zone)}`, `Open · ${clock(status.resetsAt!, zone)}`));
    case "due":
      return say("warn", t("Başlatılıyor", "Starting"));
    case "waiting":
      if (status.reason === "adapted")
        return say("warn", t(`Uyarlandı · ${clock(status.nextStartAt!, zone)}`, `Adapted · ${clock(status.nextStartAt!, zone)}`));
      if (status.reason === "cooldown") return say("warn", t("Yeniden denenecek", "Retrying soon"));
      if (status.reason === "in-use") return say("off", t("Oturum açık", "Session running"));
      if (status.reason === "relay-busy") return say("off", t("Sırada", "Queued"));
      return say("off", t("Yenileniyor", "Refreshing"));
    case "blocked":
      if (stopReason(status)) return say("crit", t("Durdu", "Stopped"));
      if (status.reason === "weekly-limit") return say("crit", t("Hafta dolu", "Week full"));
      if (status.reason === "daily-limit") return say("warn", t("Deneme sınırı", "Attempt limit"));
      return say("crit", t("Giriş gerekli", "Sign-in needed"));
  }
}

function HoursRow({
  id,
  label,
  days,
  value,
  disabled,
  onChange,
  t,
}: {
  id: string;
  label: string;
  days: string;
  value: PlanningHours;
  disabled: boolean;
  onChange: (value: PlanningHours) => void;
  t: T;
}) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-t py-2.5 first:border-t-0 @xl:grid-cols-[auto_120px_minmax(0,1fr)_auto]">
      <Switch
        checked={value.enabled}
        disabled={disabled}
        aria-label={label}
        onCheckedChange={(enabled) => onChange({ ...value, enabled })}
      />
      <span className="grid min-w-0">
        <strong
          className={cn(
            "text-sm font-semibold",
            !value.enabled && "text-muted-foreground",
          )}
        >
          {label}
        </strong>
        <small className={noteClass}>{days}</small>
      </span>
      <div className="col-span-full grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 @xl:col-span-1 @xl:col-start-3 @xl:row-start-1">
        <TimePicker
          id={`${id}-start`}
          label={t(`${label} başlangıç saati`, `${label} start`)}
          value={value.start}
          disabled={disabled || !value.enabled}
          onChange={(start) => onChange({ ...value, start })}
          t={t}
        />
        <span className="text-muted-foreground" aria-hidden="true">
          –
        </span>
        <TimePicker
          id={`${id}-end`}
          label={t(`${label} bitiş saati`, `${label} end`)}
          value={value.end}
          disabled={disabled || !value.enabled}
          onChange={(end) => onChange({ ...value, end })}
          t={t}
        />
      </div>
      <small className="col-start-3 row-start-1 justify-self-end text-xs text-muted-foreground tabular-nums @xl:col-start-4">
        {value.enabled ? span(value, t) : t("Kapalı", "Off")}
      </small>
    </div>
  );
}

export interface PlanningPanelProps {
  settings: PlanningSettings;
  keeper?: KeeperSnapshot;
  accounts: Account[];
  usage: Record<string, AccountUsage>;
  /** The account Claude Desktop uses now. */
  activeId?: string;
  disabled: boolean;
  t: T;
  now?: number;
  update: (patch: Partial<PlanningSettings>) => void;
  updateAccount: (id: string, planning: AccountPlanning) => void;
  /** Relay's platform (`diagnostics.platform`): "Mac" or "computer" in the notes. */
  platform?: string;
  /** The "Plan ayarları" sheet, opened from the page header. */
  settingsOpen?: boolean;
  onSettingsOpenChange?: (open: boolean) => void;
}

/**
 * What the page reads from the settings, the keeper and the clock: the planned accounts, the
 * tempo, today's lane, the forecast and the next start. The header's line and the page share it.
 */
export function planningModel({
  settings,
  keeper,
  accounts,
  usage,
  activeId,
  t,
  now = Date.now(),
}: Pick<PlanningPanelProps, "settings" | "keeper" | "accounts" | "usage" | "activeId" | "t" | "now">) {
  const zone = settings.timeZone;
  const today = localDate(now, zone);
  const included = settings.accounts.filter(({ id }) =>
    accounts.some((a) => a.id === id),
  );
  // Deleted accounts take no slot, exactly as in the window keeper.
  const planned = { ...settings, accounts: included };
  // A fixed tempo applies at once; "auto" uses what the keeper learned.
  const choice = settings.tempo ?? "auto";
  const tempo =
    choice === "auto"
      ? (keeper?.tempo ?? fallbackTempo(settings))
      : presetTempo(choice);
  const context = planContext(accounts, tempo);
  // Today's pace and adopted starts, while the keeper adapts the day (turning
  // adaptation off here applies at once).
  const report =
    settings.autoStart && settings.adaptive !== false
      ? keeper?.adaptation
      : undefined;
  const adaptation: TimelineAdaptation | undefined = report && {
    factor: report.factor,
    schedule: Object.fromEntries(
      report.schedule
        .map((s) => [s.accountId, Date.parse(s.startAt)] as const)
        .filter(([, time]) => Number.isFinite(time)),
    ),
  };
  const plans = [0, 1, 2, 3, 4, 5, 6, 7].map((d) =>
    dayPlan(shiftDate(today, d), planned, context),
  );
  // The next work day that has not ended supplies the automatic times, the
  // forecast and the rate shown on the page.
  const reference = plans.find(
    (plan) => plan.accounts.length > 0 && (plan.interval?.end ?? 0) > now,
  );
  // Today's lane: who works when, live from now (the account lines read it).
  const todayView = dayTimeline({
    settings: planned,
    accounts,
    usage,
    now,
    tempo,
    activeId,
    adaptation,
  });
  // Today the forecast is the lane's live one: of the whole day before work,
  // of the rest while work runs. A later day has its plan's forecast.
  const interval = reference?.interval;
  const live =
    reference === plans[0] && todayView.live?.date === reference.date
      ? todayView.live.forecast
      : undefined;
  const forecast = live ?? reference?.forecast;
  // The forecast names its day unless it is today's.
  const forecastDay = !reference
    ? ""
    : reference.date === today
      ? live && interval && now >= interval.start
        ? t("Bugün kalan: ", "Rest of today: ")
        : t("Tahmin: ", "Forecast: ")
      : reference.date === shiftDate(today, 1)
        ? t("Yarın tahmini: ", "Tomorrow: ")
        : weekdayForecast(reference.date, zone, t);
  // One busy-day rate measures every window: the reference day's; an
  // account's own line reads it at today's pace while the day is adapted.
  const weekend = !!interval?.weekend;
  const rate = tempo.rate[weekend ? "weekend" : "weekday"];
  const todayRate = rate * (adaptation?.factor ?? 1);
  const excluded = accounts.filter(
    (a) => !settings.accounts.some((p) => p.id === a.id),
  );
  const name = (id?: string) => accounts.find((a) => a.id === id)?.name ?? "—";
  // Today's count is drawn from the plan so edits show at once; the next start
  // prefers the keeper's live view (actual resets) when it has one.
  const plannedToday = plans[0].accounts.reduce(
    (n, a) => n + a.windows.length,
    0,
  );
  const upcoming = nextPlannedWindow(settings, accounts, keeper, now);
  const language = t("tr", "en") as Language;
  const nextStart =
    settings.autoStart && included.length && upcoming
      ? nextStartLabel(name(upcoming.accountId), upcoming.at, now, zone, language)
      : undefined;
  return {
    zone,
    included,
    planned,
    choice,
    tempo,
    adaptation,
    reference,
    todayView,
    forecast,
    forecastDay,
    weekend,
    rate,
    todayRate,
    excluded,
    plannedToday,
    nextStart,
    name,
    clock: (time: number) => clock(time, zone),
  };
}

export type PlanningModel = ReturnType<typeof planningModel>;

/** The page header's line: how many accounts the plan uses and how the day goes. */
export function planningHeadline(model: PlanningModel, t: T): string {
  const n = model.included.length;
  if (!n) return t("Plan yok", "No plan");
  const accounts = t(`${n} hesap`, `${n} ${n === 1 ? "account" : "accounts"}`);
  return model.forecast
    ? `${accounts} · ${model.forecastDay}${forecastSummary(model.forecast, t, model.clock)}`
    : accounts;
}

/** A group of the settings sheet: a small heading (an ⓘ for its note) and its rows. */
function SheetGroup({
  id,
  title,
  info,
  children,
}: {
  id: string;
  title: string;
  info?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="@container grid gap-1">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        {title}
        {info && <InfoTip>{info}</InfoTip>}
      </h3>
      <div className="grid">{children}</div>
    </section>
  );
}

/**
 * The "Plan ayarları" sheet: early start, work hours, tempo and adapting, and the time zone. Each
 * row is a label and one short line; what a setting does is behind its ⓘ.
 */
export function PlanSettings({
  settings,
  model,
  accounts,
  disabled,
  update,
  t,
  platform,
  now = Date.now(),
}: {
  settings: PlanningSettings;
  model: PlanningModel;
  accounts: Account[];
  disabled: boolean;
  update: (patch: Partial<PlanningSettings>) => void;
  t: T;
  platform?: string;
  now?: number;
}) {
  const mac = macWording(platform);
  // The keeper's routine runner refuses Windows: there is nothing to switch on.
  const unsupported = platform === "win32";
  const { included, plannedToday, nextStart, tempo, choice, rate, weekend } = model;
  const summary = unsupported
    ? t("Windows'ta kullanılamaz", "Not available on Windows")
    : !settings.autoStart
    ? t(
        "Açınca dönemler planlanan saatlerde başlar.",
        "When on, periods start at the planned times.",
      )
    : !included.length
      ? t(
          "Plana hesap ekle. Başlatma saatlerini Relay dağıtır.",
          "Add accounts to the plan. Relay sets the start times.",
        )
      : t(
          `Bugün ${plannedToday} başlatma planlı`,
          `${plannedToday} ${plannedToday === 1 ? "start" : "starts"} planned today`,
        );
  return (
    <div className="grid gap-5">
      <SheetGroup
        id="planning-early"
        title={t("Önceden başlatma", "Early start")}
        info={
          mac
            ? t(
                "Relay açık, Mac uyanık olmalı. Her başlatma küçük bir istek harcar; limitleri okumak dönem başlatmaz.",
                "Relay must be open and the Mac awake. Each start uses a small request; reading the limits never starts a period.",
              )
            : t(
                "Relay açık, bilgisayar uyanık olmalı. Her başlatma küçük bir istek harcar; limitleri okumak dönem başlatmaz.",
                "Relay must be open and the computer awake. Each start uses a small request; reading the limits never starts a period.",
              )
        }
      >
        <div className="grid grid-cols-[2rem_minmax(0,1fr)] items-center gap-x-3 py-2.5">
          <Switch
            checked={settings.autoStart}
            disabled={disabled || unsupported}
            aria-label={t("Çalışma saatlerinde limit dönemlerini açık tut", "Keep limit periods running during work hours")}
            onCheckedChange={(autoStart) => update({ autoStart })}
          />
          <span className="grid min-w-0">
            <strong className="text-sm font-semibold">
              {t("Çalışma saatlerinde limit dönemlerini açık tut", "Keep limit periods running during work hours")}
            </strong>
            <small className={noteClass}>{summary}</small>
          </span>
        </div>
        {nextStart && (
          <div
            data-slot="next-start"
            className="flex items-center justify-between gap-3 border-t py-2.5 text-sm"
          >
            <span>{t("Sonraki başlatma", "Next start")}</span>
            <span className="min-w-0 truncate text-muted-foreground tabular-nums">
              {nextStart}
            </span>
          </div>
        )}
      </SheetGroup>

      <SheetGroup
        id="planning-hours"
        title={t("Çalışma saatleri ve tempo", "Work hours and tempo")}
        info={t(
          "Bitiş başlangıçtan önceyse aralık ertesi güne uzar.",
          "An end before the start runs into the next day.",
        )}
      >
        <HoursRow
          id="weekday"
          label={t("Hafta içi", "Weekdays")}
          days={t("Pzt–Cum", "Mon–Fri")}
          value={settings.weekday}
          disabled={disabled}
          onChange={(weekday) => update({ weekday })}
          t={t}
        />
        <HoursRow
          id="weekend"
          label={t("Hafta sonu", "Weekend")}
          days={t("Cmt–Paz", "Sat–Sun")}
          value={settings.weekend}
          disabled={disabled}
          onChange={(weekend) => update({ weekend })}
          t={t}
        />
        <TempoRow
          tempo={tempo}
          choice={choice}
          rate={rate}
          weekend={weekend}
          accounts={included.map(({ id }) => accounts.find((a) => a.id === id)!)}
          disabled={disabled}
          onChange={(tempo) => update({ tempo })}
          t={t}
        />
        <AdaptiveRow settings={settings} disabled={disabled} update={update} t={t} />
      </SheetGroup>

      <SheetGroup id="planning-zone-group" title={t("Saat dilimi", "Time zone")}>
        <TimeZonePicker
          id="planning-zone"
          label={t("Saat dilimi", "Time zone")}
          value={settings.timeZone}
          disabled={disabled}
          onChange={(timeZone) => update({ timeZone })}
          t={t}
          now={now}
        />
      </SheetGroup>
    </div>
  );
}

/** Nothing in the plan yet: what the plan is for, and the way to choose its accounts. */
function EmptyPlan({ onPick, t }: { onPick: () => void; t: T }) {
  return (
    <Card data-slot="planning-empty" className="grid justify-items-center gap-2 px-4 py-7 text-center">
      <strong className="text-sm font-semibold">
        {t("Hangi hesaplar sırayla kullanılsın?", "Which accounts take turns?")}
      </strong>
      <p className={cn(noteClass, "max-w-sm")}>
        {t(
          "Seçtiğin hesapların dönemleri çalışma saatlerine göre sıraya dizilir; biri dolmadan diğeri hazır olur.",
          "The chosen accounts' periods line up with your work hours, so the next is ready before one runs out.",
        )}
      </p>
      <Button size="sm" onClick={onPick}>
        {t("Hesap seç", "Choose accounts")}
      </Button>
    </Card>
  );
}

export function PlanningPanel(props: PlanningPanelProps) {
  const {
    settings,
    keeper,
    accounts,
    usage,
    activeId,
    disabled,
    t,
    now = Date.now(),
    update,
    updateAccount,
    platform,
    settingsOpen = false,
    onSettingsOpenChange,
  } = props;
  const model = planningModel({ settings, keeper, accounts, usage, activeId, t, now });
  const { zone, included, planned, tempo, adaptation, reference, todayView, forecast, forecastDay, todayRate, excluded, nextStart } = model;
  // The accounts outside the plan wait behind one line until asked for.
  const [showExcluded, setShowExcluded] = useState(false);
  const move = (index: number, delta: number) => {
    const next = [...included];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    update({ accounts: next });
  };
  const pace = new Intl.NumberFormat(t("tr-TR", "en-GB"), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(adaptation?.factor ?? 1);
  const adapted = !!adaptation && Object.keys(adaptation.schedule).length > 0;
  const gap = !!forecast?.segments.some((s) => !s.accountId);
  // Beside the plan's summary: the next start, today's live forecast under it, and while the
  // keeper adapts the day, its pace and that the plan moved.
  const next: NextStat = {
    value:
      nextStart ??
      (settings.autoStart
        ? t("Planlı başlatma yok", "No planned start")
        : t("Önceden başlatma kapalı", "Early start is off")),
    note:
      settings.autoStart && forecast ? (
        <span data-slot="live-forecast" className="inline-flex items-center gap-1.5">
          <StatusDot tone={gap ? "warn" : "ok"} />
          {forecastDay + forecastSummary(forecast, t, model.clock)}
        </span>
      ) : settings.autoStart ? undefined : (
        t("Plan ayarlarından açılır", "Turn it on in plan settings")
      ),
    chips:
      (adaptation?.factor ?? 1) > 1 || adapted ? (
        <span className="mt-1 flex flex-wrap gap-1.5">
          {(adaptation?.factor ?? 1) > 1 && (
            <Badge variant="warn">
              {t(`Bugün plandan ${pace} kat hızlısın`, `Today: ${pace}× the planned pace`)}
            </Badge>
          )}
          {adapted && <Badge variant="warn">{t("Plan uyarlandı", "Plan adapted")}</Badge>}
        </span>
      ) : undefined,
  };
  const head = (
    <ListHead columns="plan">
      <span />
      <span>{t("Hesap", "Account")}</span>
      <span>{t("Plan", "Plan")}</span>
      <span>{t("İlk başlangıç", "First start")}</span>
      <span className={narrowHidden}>{t("Durum", "Status")}</span>
    </ListHead>
  );
  return (
    <div className="grid gap-5">
      {included.length ? (
        <PlanTimeline
          settings={planned}
          accounts={accounts}
          usage={usage}
          now={now}
          tempo={tempo}
          activeId={activeId}
          adaptation={adaptation}
          next={next}
          t={t}
        />
      ) : (
        <EmptyPlan onPick={() => setShowExcluded(true)} t={t} />
      )}

      <PageSection
        slot="planning-accounts"
        title={t("Plandaki hesaplar", "Accounts in the plan")}
        info={t(
          "Relay başlatma saatlerini kapasiteye ve tempoya göre belirler. Sıra yalnızca eşitlikte öncelik verir.",
          "Relay sets the start times from capacity and tempo. The order applies only to ties.",
        )}
        aside={
          <span className="text-xs text-muted-foreground tabular-nums">
            {included.length} / {accounts.length}
          </span>
        }
      >
        <ListCard label={t("Plandaki hesaplar", "Accounts in the plan")} slot="plan-accounts">
          {(included.length > 0 || showExcluded) && head}
          {included.length > 0 && (
            <>
              <ListGroup name={t("Planda", "In the plan")} count={included.length} />
              <ListSection id="plan-included" label={t("Plandaki hesaplar", "Accounts in the plan")}>
                {included.map((entry, index) => {
                  const account = accounts.find((a) => a.id === entry.id)!;
                  const automatic = reference?.accounts.find((a) => a.accountId === entry.id);
                  // Without a work day ahead there is no automatic time to show.
                  const first = entry.firstStart ?? (automatic ? clock(automatic.firstStart, zone) : undefined);
                  const status = shownStatus(
                    keeper?.accounts.find((s) => s.accountId === entry.id),
                    adaptation,
                  );
                  const lastFailure = keeper?.attempts.find(
                    (a) => a.accountId === entry.id && a.status === "failed",
                  )?.reason;
                  return (
                    <ListRow key={entry.id} columns="plan" data={{ "data-account": entry.id }}>
                      <Switch
                        checked
                        disabled={disabled}
                        aria-label={t(`${account.name} plana dahil`, `${account.name} in the plan`)}
                        onCheckedChange={() => update({ accounts: included.filter((a) => a.id !== entry.id) })}
                      />
                      <div className="grid min-w-0 gap-0.5">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <AccountDot color={account.color} />
                          <strong className="truncate text-sm font-semibold" title={account.name}>
                            {account.name}
                          </strong>
                          <span className="ml-auto flex shrink-0">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              aria-label={t(`${account.name} hesabını yukarı taşı`, `Move ${account.name} up`)}
                              disabled={disabled || index === 0}
                              onClick={() => move(index, -1)}
                            >
                              <ArrowUp />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              aria-label={t(`${account.name} hesabını aşağı taşı`, `Move ${account.name} down`)}
                              disabled={disabled || index === included.length - 1}
                              onClick={() => move(index, 1)}
                            >
                              <ArrowDown />
                            </Button>
                          </span>
                        </div>
                      </div>
                      <PlanEditor
                        account={account}
                        disabled={disabled}
                        update={(planning) => updateAccount(account.id, planning)}
                        t={t}
                        compact
                      />
                      <div className="grid min-w-0 justify-items-start gap-0.5">
                        <div className="flex min-w-0 items-center gap-1.5">
                          {first ? (
                            <TimePicker
                              id={`first-${entry.id}`}
                              label={t(`${account.name} ilk başlangıç`, `${account.name} first start`)}
                              value={first}
                              disabled={disabled}
                              onChange={(firstStart) =>
                                update({
                                  accounts: included.map((a) => (a.id === entry.id ? { ...a, firstStart } : a)),
                                })
                              }
                              t={t}
                            />
                          ) : (
                            <span className="text-sm text-muted-foreground tabular-nums">—</span>
                          )}
                          <Badge variant="outline">
                            {entry.firstStart ? t("Elle", "Manual") : t("Otomatik", "Auto")}
                          </Badge>
                        </div>
                        {entry.firstStart && (
                          <Button
                            type="button"
                            variant="link"
                            size="xs"
                            className="h-auto px-0"
                            title={t("Elle seçildi", "Set by hand")}
                            disabled={disabled}
                            onClick={() =>
                              update({
                                accounts: included.map((a) => (a.id === entry.id ? { id: a.id } : a)),
                              })
                            }
                          >
                            {t("Otomatiğe dön", "Back to automatic")}
                          </Button>
                        )}
                      </div>
                      <div className={cn(narrowHidden, "flex min-w-0 flex-wrap items-center gap-x-2")}>
                        <StatusLabel status={planStatus(status, lastFailure, zone, t)} />
                        {stopReason(status) && (
                          <Button type="button" variant="ghost" size="xs" disabled={disabled} onClick={() => update({})}>
                            {t("Yeniden dene", "Try again")}
                          </Button>
                        )}
                      </div>
                      {/* How long a window lasts and when it works today: a quiet second line the whole row wide. */}
                      <span data-slot="window-line" className="col-start-2 col-span-4 flex min-w-0 items-center gap-2 @max-2xl:col-span-3 [&>small]:truncate">
                        <AccountWindowLine account={account} rate={todayRate} lane={todayView.lane} clock={model.clock} t={t} />
                        {/* A narrow list drops the status column; its retry moves here. */}
                        {stopReason(status) && (
                          <Button type="button" variant="ghost" size="xs" className="@2xl:hidden" disabled={disabled} onClick={() => update({})}>
                            {t("Yeniden dene", "Try again")}
                          </Button>
                        )}
                      </span>
                    </ListRow>
                  );
                })}
              </ListSection>
            </>
          )}
          {showExcluded && excluded.length > 0 && (
            <>
              <ListGroup name={t("Plana dahil değil", "Not in the plan")} count={excluded.length} />
              <ListSection id="plan-excluded" label={t("Plana dahil olmayan hesaplar", "Accounts not in the plan")}>
                {excluded.map((account) => (
                  <ListRow key={account.id} columns="plan" data={{ "data-account": account.id }}>
                    <Switch
                      checked={false}
                      disabled={disabled}
                      aria-label={t(`${account.name} plana dahil`, `${account.name} in the plan`)}
                      onCheckedChange={() => update({ accounts: [...included, { id: account.id }] })}
                    />
                    <div className="flex min-w-0 items-center gap-1.5">
                      <AccountDot color={account.color} />
                      <strong className="truncate text-sm font-semibold text-muted-foreground" title={account.name}>
                        {account.name}
                      </strong>
                    </div>
                    <PlanEditor
                      account={account}
                      disabled={disabled}
                      update={(planning) => updateAccount(account.id, planning)}
                      t={t}
                      compact
                    />
                    <span />
                    <span className={cn(narrowHidden, noteClass)}>{t("Plana dahil değil", "Not in the plan")}</span>
                  </ListRow>
                ))}
              </ListSection>
            </>
          )}
          {excluded.length > 0 && (
            <ListFoot
              action={
                <Button type="button" variant="ghost" size="xs" onClick={() => setShowExcluded(!showExcluded)}>
                  {showExcluded ? t("Gizle", "Hide") : t("Göster", "Show")}
                </Button>
              }
            >
              {t(`Plana dahil olmayan ${excluded.length} hesap`, `${excluded.length} ${excluded.length === 1 ? "account" : "accounts"} not in the plan`)}
            </ListFoot>
          )}
        </ListCard>
      </PageSection>

      {!!keeper?.attempts.length && (
        <Card padded className="@container">
          <details>
            <summary className="cursor-pointer rounded-sm text-sm font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
              {t(
                `Son başlatmalar (${keeper.attempts.length})`,
                `Recent starts (${keeper.attempts.length})`,
              )}
            </summary>
            <ul className="mt-2.5 grid gap-1.5 text-xs">
              {keeper.attempts.map((attempt) => (
                <li
                  key={attempt.id}
                  className="grid grid-cols-[44px_minmax(0,1fr)] gap-x-2.5 @xl:grid-cols-[44px_minmax(0,160px)_1fr]"
                >
                  <time className="text-muted-foreground tabular-nums">
                    {clock(attempt.at, zone)}
                  </time>
                  <span className="truncate">{model.name(attempt.accountId)}</span>
                  <small
                    className={cn(
                      "col-start-2 text-xs @xl:col-start-3",
                      attempt.status === "failed"
                        ? "text-crit"
                        : attempt.status === "verified"
                          ? "text-ok-foreground"
                          : "text-muted-foreground",
                    )}
                  >
                    {attempt.status === "verified"
                      ? t("doğrulandı", "verified")
                      : attempt.status === "sent-unverified"
                        ? t("gönderildi, doğrulanamadı", "sent, not verified")
                        : attempt.status === "started"
                          ? t("sürüyor", "in progress")
                          : `${t("başarısız", "failed")}: ${failureText(attempt.reason, t)}`}
                  </small>
                </li>
              ))}
            </ul>
          </details>
        </Card>
      )}

      <Sheet open={settingsOpen} onOpenChange={onSettingsOpenChange}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md" onOpenAutoFocus={(e) => e.preventDefault()}>
          <SheetHeader>
            <SheetTitle>{t("Plan ayarları", "Plan settings")}</SheetTitle>
            <SheetDescription>
              {t("Çalışma saatleri, tempo ve önceden başlatma", "Work hours, tempo and early start")}
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">
            <PlanSettings
              settings={settings}
              model={model}
              accounts={accounts}
              disabled={disabled}
              update={update}
              t={t}
              platform={platform}
              now={now}
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
