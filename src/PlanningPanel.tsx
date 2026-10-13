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
import { dayPlan, dayStart, shiftDate, WINDOW_MS } from "../shared/day-plan";
import { localDate } from "../shared/planning";
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

function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      role="switch"
      className="planning-switch"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
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
    <div className={`planning-hours-row${value.enabled ? "" : " off"}`}>
      <Switch
        checked={value.enabled}
        disabled={disabled}
        label={label}
        onChange={(enabled) => onChange({ ...value, enabled })}
      />
      <span className="planning-hours-name">
        <strong>{label}</strong>
        <small>{days}</small>
      </span>
      <div className="planning-hours-range">
        <TimePicker
          id={`${id}-start`}
          label={t(`${label} başlangıç`, `${label} start`)}
          value={value.start}
          disabled={disabled || !value.enabled}
          onChange={(start) => onChange({ ...value, start })}
          t={t}
        />
        <span className="planning-dash" aria-hidden="true">
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
      <small className="planning-span">
        {value.enabled ? span(value, t) : t("Kapalı", "Off")}
      </small>
    </div>
  );
}

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
  const date = shiftDate(localDate(now, zone), offset);
  const dayBegin = dayStart(date, zone);
  const dayEnd = dayStart(shiftDate(date, 1), zone);
  const pct = (time: number) =>
    Math.min(100, Math.max(0, ((time - dayBegin) / (dayEnd - dayBegin)) * 100));
  const live = Object.fromEntries(
    Object.entries(usage).map(([id, u]) => [
      id,
      Date.parse(u.fiveHour?.resetsAt ?? "") || undefined,
    ]),
  );
  const plans = [-1, 0, 1].map((d) =>
    dayPlan(shiftDate(date, d), settings, offset === 0 ? live : {}),
  );
  const intervals = plans
    .map((p) => p.interval)
    .filter(
      (i): i is NonNullable<typeof i> =>
        !!i && i.end > dayBegin && i.start < dayEnd,
    );
  const planned = settings.accounts
    .map(({ id }) => accounts.find((a) => a.id === id))
    .filter((a): a is Account => !!a);
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
  return (
    <section className="planning-card">
      <div className="planning-card-head">
        <span>
          <strong>{title}</strong>
          {offset >= -1 && offset <= 1 && <small>{label}</small>}
        </span>
        <div className="planning-nav">
          {offset !== 0 && (
            <button
              type="button"
              className="text-button"
              onClick={() => setOffset(0)}
            >
              {t("Bugüne dön", "Back to today")}
            </button>
          )}
          <button
            type="button"
            className="icon"
            aria-label={t("Önceki gün", "Previous day")}
            onClick={() => setOffset(offset - 1)}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            className="icon"
            aria-label={t("Sonraki gün", "Next day")}
            onClick={() => setOffset(offset + 1)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
      <div className="timeline">
        <div className="timeline-ruler" aria-hidden="true">
          {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => (
            <span key={h} style={{ left: `${(h / 24) * 100}%` }}>
              {String(h).padStart(2, "0")}
            </span>
          ))}
        </div>
        <div className="timeline-row">
          <span className="timeline-name">{t("Çalışma", "Work")}</span>
          <div className="timeline-track">
            {intervals.map((i) => (
              <div
                key={i.start}
                className="timeline-band"
                title={`${clock(i.start, zone)}–${clock(i.end, zone)}`}
                style={{
                  left: `${pct(i.start)}%`,
                  width: `${pct(i.end) - pct(i.start)}%`,
                }}
              />
            ))}
            {offset === 0 && now >= dayBegin && now < dayEnd && (
              <div className="timeline-now" style={{ left: `${pct(now)}%` }} />
            )}
          </div>
        </div>
        {planned.map((account, index) => {
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
            <div className="timeline-row" key={account.id}>
              <span className="timeline-name">
                <i className={`tone-${index % 4}`} aria-hidden="true" />
                {account.name}
              </span>
              <div className="timeline-track">
                {windows.map((w) => (
                  <div
                    key={w.start}
                    className={`timeline-window tone-${index % 4}`}
                    title={`${clock(w.start, zone)}–${clock(w.start + WINDOW_MS, zone)}`}
                    style={{
                      left: `${pct(w.start)}%`,
                      width: `${pct(w.end) - pct(w.start)}%`,
                    }}
                  />
                ))}
                {offset === 0 && now >= dayBegin && now < dayEnd && (
                  <div
                    className="timeline-now"
                    style={{ left: `${pct(now)}%` }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      {!intervals.length && (
        <p className="planning-empty">
          {t("Bu gün için plan yok.", "No plan for this day.")}
        </p>
      )}
      <p className="planning-note">
        {t(
          "Her çubuk 5 saatlik bir pencere; çubuğun sonu sıfırlanma anı.",
          "Each bar is a five-hour window; its end is the reset.",
        )}
      </p>
    </section>
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
  const upcoming =
    keeper?.next ??
    plans
      .flatMap((p) =>
        p.accounts.flatMap((a) =>
          a.windows.map((w) => ({ accountId: a.accountId, at: w.start })),
        ),
      )
      .filter((w) => w.at > now)
      .sort((a, b) => a.at - b.at)
      .map((w) => ({ ...w, at: new Date(w.at).toISOString() }))[0];
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
    <div className="planning-panel">
      <section className={`planning-bar${settings.autoStart ? " on" : ""}`}>
        <span className="planning-bar-icon" aria-hidden="true">
          <Play size={16} />
        </span>
        <div>
          <strong>
            {t("Otomatik pencere başlatma", "Automatic window start")}
          </strong>
          <p>{summary}</p>
          <small>
            {t(
              "Her başlatma küçük bir istek kadar kota harcar. Relay açık ve Mac uyanık olmalı.",
              "Each start uses a small request of quota. Relay must be open and the Mac awake.",
            )}
          </small>
        </div>
        <Switch
          checked={settings.autoStart}
          disabled={disabled}
          label={t("Otomatik pencere başlatma", "Automatic window start")}
          onChange={(autoStart) => update({ autoStart })}
        />
      </section>

      <section className="planning-card">
        <div className="planning-card-head">
          <strong>{t("Çalışma saatleri", "Work hours")}</strong>
        </div>
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
        <div className="planning-zone">
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
        <p className="planning-note">
          {t(
            "Bitiş başlangıçtan önceyse aralık ertesi güne taşar. Relay her hesabı işe başlamadan önce kademeli ısıtır.",
            "An end before the start runs into the next day. Relay warms each account up in turn before work starts.",
          )}
        </p>
      </section>

      <Timeline
        settings={planned}
        accounts={accounts}
        usage={usage}
        now={now}
        t={t}
      />

      <section className="planning-card">
        <div className="planning-card-head">
          <strong>{t("Hesaplar", "Accounts")}</strong>
          <small>
            {t(
              "Sıra, otomatik saatlerin dağıtım sırasıdır.",
              "The order sets how automatic times are spread.",
            )}
          </small>
        </div>
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
            <div className="planning-account" key={entry.id}>
              <Switch
                checked
                disabled={disabled}
                label={t(
                  `${account.name} plana dahil`,
                  `${account.name} in the plan`,
                )}
                onChange={() =>
                  update({
                    accounts: included.filter((a) => a.id !== entry.id),
                  })
                }
              />
              <span className="planning-account-name">
                <strong>{account.name}</strong>
                <small className={`planning-state ${status?.state ?? ""}`}>
                  {statusText(status, lastFailure, zone, t)}
                </small>
                {stopReason(status) && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={disabled}
                    onClick={() => update({})}
                  >
                    {t("Yeniden dene", "Try again")}
                  </button>
                )}
              </span>
              <PlanEditor
                account={account}
                disabled={disabled}
                update={(planning) => updateAccount(account.id, planning)}
                t={t}
              />
              <div className="planning-first">
                <span className="planning-first-label">
                  <CalendarClock size={13} aria-hidden="true" />
                  {t("İlk başlangıç", "First start")}
                  {entry.firstStart ? (
                    <span className="planning-mode manual">
                      {t("Elle", "Manual")}
                    </span>
                  ) : (
                    <span className="planning-mode auto">
                      {t("Otomatik", "Automatic")}
                    </span>
                  )}
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
                  <button
                    type="button"
                    className="text-button"
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
                  </button>
                )}
              </div>
              <div className="planning-order">
                <button
                  type="button"
                  className="icon"
                  aria-label={t(
                    `${account.name} yukarı`,
                    `Move ${account.name} up`,
                  )}
                  disabled={disabled || index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  className="icon"
                  aria-label={t(
                    `${account.name} aşağı`,
                    `Move ${account.name} down`,
                  )}
                  disabled={disabled || index === included.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown size={14} />
                </button>
              </div>
            </div>
          );
        })}
        {excluded.map((account) => (
          <div className="planning-account excluded" key={account.id}>
            <Switch
              checked={false}
              disabled={disabled}
              label={t(
                `${account.name} plana dahil`,
                `${account.name} in the plan`,
              )}
              onChange={() =>
                update({ accounts: [...included, { id: account.id }] })
              }
            />
            <span className="planning-account-name">
              <strong>{account.name}</strong>
              <small>{t("Plana dahil değil", "Not in the plan")}</small>
            </span>
            <PlanEditor
              account={account}
              disabled={disabled}
              update={(planning) => updateAccount(account.id, planning)}
              t={t}
            />
          </div>
        ))}
      </section>

      {!!keeper?.attempts.length && (
        <details className="planning-card planning-history">
          <summary>
            {t(
              `Son başlatmalar (${keeper.attempts.length})`,
              `Recent starts (${keeper.attempts.length})`,
            )}
          </summary>
          <ul>
            {keeper.attempts.map((attempt) => (
              <li key={attempt.id} className={attempt.status}>
                <time>{clock(attempt.at, zone)}</time>
                <span>{name(attempt.accountId)}</span>
                <small>
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
      )}
    </div>
  );
}
