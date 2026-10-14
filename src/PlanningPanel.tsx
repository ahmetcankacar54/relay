import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Play,
} from "lucide-react";
import type {
  Account,
  AccountPlanning,
  AccountUsage,
  KeeperAccountStatus,
  KeeperSnapshot,
  PlanningHours,
  PlanningSettings,
} from "../shared/types";
import { dayPlan, shiftDate, WINDOW_MS } from "../shared/day-plan";
import { localDate } from "../shared/planning";
import { dayTimeline, nextPlannedWindow, windowTone } from "./lib/day-timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { SectionHeading } from "@/components/SettingRow";
import { cn } from "@/lib/utils";
import { TimePicker } from "./TimePicker";
import { TimeZonePicker } from "./TimeZonePicker";
import { PlanEditor } from "./PlanEditor";

type T = (tr: string, en: string) => string;
const failure: Record<string, [string, string]> = {
  "routine-policy-unverified": [
    "yönetici politikası veya kimlik doğrulanamadı",
    "administrator policy or identity not verified",
  ],
  "routine-cli-unavailable": ["Claude CLI bulunamadı", "Claude CLI not found"],
  "routine-cli-unsupported": [
    "Claude CLI sürümü desteklenmiyor",
    "Claude CLI version not supported",
  ],
  "routine-credentials-unavailable": [
    "limit bağlantısının süresi dolmuş",
    "usage connection expired",
  ],
  "routine-platform-unsupported": [
    "bu sistemde desteklenmiyor",
    "not supported on this system",
  ],
  "routine-settings-changed": ["ayarlar değişti", "settings changed"],
  interrupted: ["Relay kapandı", "Relay quit"],
};
const failureText = (reason: string | undefined, t: T) =>
  t(...(failure[reason ?? ""] ?? ["istek başarısız", "request failed"]));

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

function statusText(
  status: KeeperAccountStatus | undefined,
  lastFailure: string | undefined,
  zone: string,
  t: T,
) {
  if (!status) return t("Durum bekleniyor", "Waiting for status");
  switch (status.state) {
    case "off":
      return t("Otomatik başlatma kapalı", "Automatic start is off");
    case "outside":
      return status.nextStartAt
        ? t(
            `Sonraki başlatma ${clock(status.nextStartAt, zone)}`,
            `Next start ${clock(status.nextStartAt, zone)}`,
          )
        : t("Planlı başlatma yok", "No planned start");
    case "active":
      return t(
        `Pencere açık · ${clock(status.resetsAt!, zone)}'te sıfırlanır`,
        `Window open · resets ${clock(status.resetsAt!, zone)}`,
      );
    case "due":
      return t("Başlatılıyor…", "Starting…");
    case "waiting":
      if (status.reason === "cooldown")
        return t(
          `Son deneme başarısız (${failureText(lastFailure, t)}); 15 dk sonra yeniden denenecek`,
          `Last attempt failed (${failureText(lastFailure, t)}); retrying in 15 min`,
        );
      if (status.reason === "in-use")
        return t("Relay'de çalışan oturum var", "A Relay session is running");
      if (status.reason === "relay-busy")
        return t(
          "Başka bir Relay işlemi sürüyor",
          "Another Relay operation is running",
        );
      return t("Limit verisi yenileniyor", "Refreshing usage");
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
          "Today's attempt limit reached",
        );
      return t("Limit bağlantısı gerekli", "Usage connection required");
  }
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

const cardClass = "gap-0 px-5 py-4";
/** Account row: narrow = switch · name · order, editors below; wide (@xl) = one row. */
const accountRowClass =
  "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3.5 gap-y-2 border-t py-3 @xl:grid-cols-[auto_minmax(0,1.3fr)_160px_minmax(0,1.1fr)_28px]";
const wideCell = "col-start-2 col-end-4 min-w-0 @xl:col-auto";
const noteClass = "text-xs text-muted-foreground";

/** Account status colour by keeper state. */
const stateTone: Partial<Record<KeeperAccountStatus["state"], string>> = {
  active: "text-ok",
  waiting: "text-warn-foreground",
  due: "text-warn-foreground",
  blocked: "text-crit",
};

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
          label={t(`${label} başlangıç`, `${label} start`)}
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
          label={t(`${label} bitiş`, `${label} end`)}
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

const RULER = [0, 3, 6, 9, 12, 15, 18, 21, 24];
const rowClass =
  "grid grid-cols-[84px_minmax(0,1fr)] items-center text-xs @xl:grid-cols-[128px_minmax(0,1fr)]";

function Timeline({
  settings,
  accounts,
  usage,
  now,
  t,
}: {
  settings: PlanningSettings;
  accounts: Account[];
  usage: Record<string, AccountUsage>;
  now: number;
  t: T;
}) {
  const [offset, setOffset] = useState(0);
  const zone = settings.timeZone;
  const { dayBegin, pct, intervals, rows, showNow } = dayTimeline({
    settings,
    accounts,
    usage,
    now,
    offset,
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
  return (
    <Card className={cn(cardClass, "@container")}>
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
                title={`${clock(i.start, zone)}–${clock(i.end, zone)}`}
                style={position(i.start, i.end)}
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
                  title={`${clock(w.start, zone)}–${clock(w.start + WINDOW_MS, zone)}`}
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
          "Her çubuk 5 saatlik bir pencere; çubuğun sonu sıfırlanma anı.",
          "Each bar is a five-hour window; its end is the reset.",
        )}
      </p>
    </Card>
  );
}

export function PlanningPanel({
  settings,
  keeper,
  accounts,
  usage,
  disabled,
  t,
  now = Date.now(),
  update,
  updateAccount,
}: {
  settings: PlanningSettings;
  keeper?: KeeperSnapshot;
  accounts: Account[];
  usage: Record<string, AccountUsage>;
  disabled: boolean;
  t: T;
  now?: number;
  update: (patch: Partial<PlanningSettings>) => void;
  updateAccount: (id: string, planning: AccountPlanning) => void;
}) {
  const zone = settings.timeZone;
  const today = localDate(now, zone);
  const included = settings.accounts.filter(({ id }) =>
    accounts.some((a) => a.id === id),
  );
  // Deleted accounts take no slot, exactly as in the window keeper.
  const planned = { ...settings, accounts: included };
  const plans = [0, 1, 2, 3, 4, 5, 6, 7].map((d) =>
    dayPlan(shiftDate(today, d), planned),
  );
  // The next day with work hours supplies the automatic times shown per account.
  const reference = plans.find((plan) => plan.accounts.length);
  const excluded = accounts.filter(
    (a) => !settings.accounts.some((p) => p.id === a.id),
  );
  const name = (id?: string) => accounts.find((a) => a.id === id)?.name ?? "—";
  const move = (index: number, delta: number) => {
    const next = [...included];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    update({ accounts: next });
  };
  // Today's count is drawn from the plan so edits show at once; the next start
  // prefers the keeper's live view (actual resets) when it has one.
  const plannedToday = plans[0].accounts.reduce(
    (n, a) => n + a.windows.length,
    0,
  );
  const upcoming = nextPlannedWindow(settings, accounts, keeper, now);
  const summary = !settings.autoStart
    ? t(
        "Kapalı. Açınca Relay pencereleri planlanan saatlerde başlatır ve gün boyu canlı tutar.",
        "Off. When on, Relay starts windows at the planned times and keeps them running.",
      )
    : !included.length
      ? t(
          "Plana hesap ekle; başlatma saatleri otomatik dağıtılır.",
          "Add accounts to the plan; start times are spread automatically.",
        )
      : upcoming
        ? t(
            `Bugün ${plannedToday} başlatma planlı · sonraki ${clock(upcoming.at, zone)} ${name(upcoming.accountId)}`,
            `${plannedToday} starts planned today · next ${clock(upcoming.at, zone)} ${name(upcoming.accountId)}`,
          )
        : t(
            `Bugün ${plannedToday} başlatma planlı`,
            `${plannedToday} starts planned today`,
          );
  return (
    <div className="grid gap-3">
      <Card
        className={cn(
          cardClass,
          "@container flex-row items-center gap-3.5",
          settings.autoStart && "border-primary/40",
        )}
      >
        <span
          className={cn(
            "hidden size-9 shrink-0 place-items-center rounded-lg @lg:grid",
            settings.autoStart
              ? "bg-accent text-accent-foreground"
              : "bg-muted text-muted-foreground",
          )}
          aria-hidden="true"
        >
          <Play className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <strong className="font-display text-[15px] font-semibold">
            {t("Otomatik pencere başlatma", "Automatic window start")}
          </strong>
          <p className="mt-0.5 text-[13px]">{summary}</p>
          <small className={cn(noteClass, "mt-0.5 block")}>
            {t(
              "Her başlatma küçük bir istek kadar kota harcar. Relay açık ve Mac uyanık olmalı.",
              "Each start uses a small request of quota. Relay must be open and the Mac awake.",
            )}
          </small>
        </div>
        <Switch
          checked={settings.autoStart}
          disabled={disabled}
          aria-label={t("Otomatik pencere başlatma", "Automatic window start")}
          onCheckedChange={(autoStart) => update({ autoStart })}
        />
      </Card>

      <Card className={cn(cardClass, "@container")}>
        <SectionHeading title={t("Çalışma saatleri", "Work hours")} />
        <div className="grid">
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
        </div>
        <div className="mt-2.5 max-w-[420px]">
          <TimeZonePicker
            id="planning-zone"
            label={t("Saat dilimi", "Time zone")}
            value={zone}
            disabled={disabled}
            onChange={(timeZone) => update({ timeZone })}
            t={t}
            now={now}
          />
        </div>
        <p className={cn(noteClass, "mt-2.5")}>
          {t(
            "Bitiş başlangıçtan önceyse aralık ertesi güne taşar. Relay her hesabı işe başlamadan önce kademeli ısıtır.",
            "An end before the start runs into the next day. Relay warms each account up in turn before work starts.",
          )}
        </p>
      </Card>

      <Timeline
        settings={planned}
        accounts={accounts}
        usage={usage}
        now={now}
        t={t}
      />

      <Card className={cn(cardClass, "@container")}>
        <SectionHeading
          title={t("Hesaplar", "Accounts")}
          description={t(
            "Sıra, otomatik saatlerin dağıtım sırasıdır.",
            "The order sets how automatic times are spread.",
          )}
        />
        {included.map((entry, index) => {
          const account = accounts.find((a) => a.id === entry.id)!;
          const automatic = reference?.accounts.find(
            (a) => a.accountId === entry.id,
          );
          const first =
            entry.firstStart ??
            (automatic ? clock(automatic.firstStart, zone) : "09:00");
          const status = keeper?.accounts.find((s) => s.accountId === entry.id);
          const lastFailure = keeper?.attempts.find(
            (a) => a.accountId === entry.id && a.status === "failed",
          )?.reason;
          return (
            <div className={accountRowClass} key={entry.id}>
              <Switch
                checked
                disabled={disabled}
                aria-label={t(
                  `${account.name} plana dahil`,
                  `${account.name} in the plan`,
                )}
                onCheckedChange={() =>
                  update({
                    accounts: included.filter((a) => a.id !== entry.id),
                  })
                }
              />
              <span className="grid min-w-0 justify-items-start gap-0.5">
                <strong className="text-sm font-semibold">
                  {account.name}
                </strong>
                <small
                  className={cn(
                    "text-xs text-muted-foreground",
                    status && stateTone[status.state],
                  )}
                >
                  {statusText(status, lastFailure, zone, t)}
                </small>
                {stopReason(status) && (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto px-0 text-xs"
                    disabled={disabled}
                    onClick={() => update({})}
                  >
                    {t("Yeniden dene", "Try again")}
                  </Button>
                )}
              </span>
              <div className={wideCell}>
                <PlanEditor
                  account={account}
                  disabled={disabled}
                  update={(planning) => updateAccount(account.id, planning)}
                  t={t}
                />
              </div>
              <div className={cn(wideCell, "grid min-w-0 gap-1")}>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CalendarClock className="size-3.5" aria-hidden="true" />
                  {t("İlk başlangıç", "First start")}
                  <Badge
                    variant="secondary"
                    className={cn(
                      "ml-auto rounded-md",
                      entry.firstStart
                        ? "bg-warn/15 text-foreground"
                        : "bg-ok/15 text-foreground",
                    )}
                  >
                    {entry.firstStart
                      ? t("Elle", "Manual")
                      : t("Otomatik", "Automatic")}
                  </Badge>
                </span>
                <TimePicker
                  id={`first-${entry.id}`}
                  label={t(
                    `${account.name} ilk başlangıç`,
                    `${account.name} first start`,
                  )}
                  value={first}
                  disabled={disabled}
                  onChange={(firstStart) =>
                    update({
                      accounts: included.map((a) =>
                        a.id === entry.id ? { ...a, firstStart } : a,
                      ),
                    })
                  }
                  t={t}
                />
                {entry.firstStart && (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto justify-self-start px-0 text-xs"
                    disabled={disabled}
                    onClick={() =>
                      update({
                        accounts: included.map((a) =>
                          a.id === entry.id ? { id: a.id } : a,
                        ),
                      })
                    }
                  >
                    {t("Otomatiğe dön", "Back to automatic")}
                  </Button>
                )}
              </div>
              <div className="col-start-3 row-start-1 flex gap-0.5 @xl:col-start-5 @xl:flex-col">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="h-6 w-7"
                  aria-label={t(
                    `${account.name} yukarı`,
                    `Move ${account.name} up`,
                  )}
                  disabled={disabled || index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="h-6 w-7"
                  aria-label={t(
                    `${account.name} aşağı`,
                    `Move ${account.name} down`,
                  )}
                  disabled={disabled || index === included.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown className="size-3.5" />
                </Button>
              </div>
            </div>
          );
        })}
        {excluded.map((account) => (
          <div className={accountRowClass} key={account.id}>
            <Switch
              checked={false}
              disabled={disabled}
              aria-label={t(
                `${account.name} plana dahil`,
                `${account.name} in the plan`,
              )}
              onCheckedChange={() =>
                update({ accounts: [...included, { id: account.id }] })
              }
            />
            <span className="grid min-w-0 gap-0.5">
              <strong className="text-sm font-semibold text-muted-foreground">
                {account.name}
              </strong>
              <small className={noteClass}>
                {t("Plana dahil değil", "Not in the plan")}
              </small>
            </span>
            <div className={wideCell}>
              <PlanEditor
                account={account}
                disabled={disabled}
                update={(planning) => updateAccount(account.id, planning)}
                t={t}
              />
            </div>
          </div>
        ))}
      </Card>

      {!!keeper?.attempts.length && (
        <Card className={cn(cardClass, "@container")}>
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
                  <span className="truncate">{name(attempt.accountId)}</span>
                  <small
                    className={cn(
                      "col-start-2 text-xs @xl:col-start-3",
                      attempt.status === "failed"
                        ? "text-crit"
                        : attempt.status === "verified"
                          ? "text-ok"
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
    </div>
  );
}
