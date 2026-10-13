import { useEffect, useId, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, Clock3, GanttChart } from "lucide-react";
import type { PlanningReason, WorkdayPlan } from "../shared/planning";
import type { Account, AccountUsage, WorkdaySettings } from "../shared/types";
import {
  dailySchedule,
  type ScheduleEndpoint,
  type ScheduleLane,
} from "../shared/schedule-visual";
import { dialPoint, dialSegmentPath } from "../shared/schedule-dial";

type T = (tr: string, en: string) => string;
function slotStatus(reason: PlanningReason, t: T) {
  const labels: Record<PlanningReason, [string, string]> = {
    "not-selected": ["Seçili değil", "Not selected"],
    "auth-required": ["CLI bağlantısı gerekli", "CLI connection required"],
    "identity-mismatch": ["Hesap kimliği farklı", "Identity mismatch"],
    "duplicate-identity": [
      "Aynı hesaba bağlı başka profil",
      "Duplicate account profile",
    ],
    cooldown: ["Bekleme süresinde", "On cooldown"],
    "usage-not-fresh": ["Limit verisini yenile", "Refresh usage data"],
    "usage-incomplete": ["Limit verisi eksik", "Incomplete usage data"],
    reserve: ["Ayrılan kota sınırında", "At reserved quota limit"],
    "already-active": ["Pencere zaten açık", "Window already active"],
    "outside-workday": ["Çalışma aralığı dışında", "Outside working hours"],
  };
  return t(...labels[reason]);
}
function accountColor(color: string) {
  const palette: Record<string, string> = {
    terra: "#9e5f40",
    olive: "#6b7950",
    blue: "#597886",
    plum: "#87638a",
  };
  return (
    palette[color] ?? (/^#[\da-f]{6}$/i.test(color) ? color : palette.olive)
  );
}
function position(minute: number) {
  return `${(minute / 1_440) * 100}%`;
}
function timeLabel(endpoint: ScheduleEndpoint, t: T) {
  const offset = endpoint.dayOffset;
  return `${endpoint.clock}${offset === 0 ? "" : ` (${offset > 0 ? "+" : ""}${offset} ${t("gün", "day")})`}`;
}
function exactTime(endpoint: ScheduleEndpoint, timeZone: string, t: T) {
  return new Intl.DateTimeFormat(t("tr-TR", "en-GB"), {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
    hourCycle: "h23",
  }).format(new Date(endpoint.at));
}
function laneText(lane: ScheduleLane, timeZone: string, t: T) {
  const proposal = lane.proposal;
  return {
    range: proposal
      ? `${timeLabel(proposal.start, t)} → ${timeLabel(proposal.reset, t)}`
      : t("Öneri hazırlanamadı", "No proposal available"),
    exactRange: proposal
      ? `${exactTime(proposal.start, timeZone, t)} → ${exactTime(proposal.reset, timeZone, t)}`
      : undefined,
    status: proposal?.reason ? slotStatus(proposal.reason, t) : undefined,
  };
}
function AccountSummary({
  lane,
  timeZone,
  t,
  ring,
  compact = false,
}: {
  lane: ScheduleLane;
  timeZone: string;
  t: T;
  ring?: number;
  compact?: boolean;
}) {
  const { range, exactRange, status } = laneText(lane, timeZone, t);
  return (
    <div className="schedule-account-summary">
      <strong title={lane.name}>
        <span className="schedule-account-dot" aria-hidden="true" />
        {lane.name}
        {ring !== undefined && (
          <small className="schedule-ring-number">{ring + 1}</small>
        )}
      </strong>
      <span className="schedule-range" title={exactRange}>
        {range}
      </span>
      {status && <span className="day-schedule-slot-status">{status}</span>}
      {lane.actualReset &&
        (!compact || lane.actualReset.minute === undefined) && (
          <span
            className="schedule-server-time"
            title={exactTime(lane.actualReset, timeZone, t)}
          >
            {t("Sunucu sıfırlanması", "Server reset")}:{" "}
            {timeLabel(lane.actualReset, t)}
          </span>
        )}
    </div>
  );
}

export function DailySchedule({
  accounts,
  usage,
  workday,
  plan,
  t,
  now = Date.now(),
  unsaved = false,
}: {
  accounts: Account[];
  usage: Record<string, AccountUsage>;
  workday: WorkdaySettings;
  plan: WorkdayPlan;
  t: T;
  now?: number;
  unsaved?: boolean;
}) {
  const id = useId();
  const [dayOffset, setDayOffset] = useState(0);
  const [view, setView] = useState<"timeline" | "clock">("timeline");
  useEffect(() => setDayOffset(0), [workday.timeZone, plan.date]);
  const defaultDay = dailySchedule(accounts, usage, workday, plan, now);
  const selectedDate = defaultDay.date
    ? new Date(
        Date.parse(`${defaultDay.date}T12:00:00Z`) + dayOffset * 86_400_000,
      )
        .toISOString()
        .slice(0, 10)
    : undefined;
  const day =
    dayOffset === 0
      ? defaultDay
      : dailySchedule(accounts, usage, workday, plan, now, selectedDate);
  if (!day.valid || !day.date) {
    return (
      <div className="schedule-empty" role="status">
        {t(
          "Günlük görünüm için saatleri, saat dilimini ve en az bir günü seç.",
          "Choose valid times, a time zone and at least one day to view your day.",
        )}
      </div>
    );
  }
  const displayDate = new Intl.DateTimeFormat(t("tr-TR", "en-GB"), {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(`${day.date}T12:00:00Z`));
  const workRange = `${workday.start} → ${workday.end}${workday.end <= workday.start ? ` (+1 ${t("gün", "day")})` : ""}`;
  const summaryId = `${id}-summary`;
  const spansOtherDays = day.lanes.some(
    ({ proposal }) =>
      proposal &&
      (proposal.start.dayOffset !== 0 || proposal.reset.dayOffset !== 0),
  );
  const visibleRings = day.lanes.slice(0, 4);
  const nowClock =
    day.nowMinute === undefined
      ? undefined
      : `${String(Math.floor(day.nowMinute / 60)).padStart(2, "0")}:${String(Math.floor(day.nowMinute % 60)).padStart(2, "0")}`;
  const nowInner =
    day.nowMinute === undefined ? undefined : dialPoint(day.nowMinute, 45);
  const nowOuter =
    day.nowMinute === undefined ? undefined : dialPoint(day.nowMinute, 143);
  const nowLine =
    day.nowMinute === undefined ? null : (
      <span
        className="schedule-now"
        style={{ left: position(day.nowMinute) }}
        aria-hidden="true"
      />
    );
  return (
    <figure
      className="schedule-board"
      data-view={view}
      aria-describedby={summaryId}
    >
      <figcaption className="schedule-heading">
        <div className="schedule-heading-copy">
          <span>{t("Günün görünümü", "Your day at a glance")}</span>
          <strong>{displayDate}</strong>
          <small>{day.timeZone}</small>
        </div>
        <div className="schedule-toolbar">
          <div
            className="schedule-view-switch"
            role="group"
            aria-label={t("Görünüm", "View")}
          >
            <button
              type="button"
              aria-pressed={view === "timeline"}
              onClick={() => setView("timeline")}
            >
              <GanttChart size={15} aria-hidden="true" />
              {t("Çizelge", "Timeline")}
            </button>
            <button
              type="button"
              aria-pressed={view === "clock"}
              onClick={() => setView("clock")}
            >
              <Clock3 size={15} aria-hidden="true" />
              {t("24 saatlik saat", "24-hour clock")}
            </button>
          </div>
          <div
            className="schedule-day-nav"
            role="group"
            aria-label={t("Grafikteki gün", "Chart day")}
          >
            <button
              type="button"
              aria-label={t("Önceki gün", "Previous day")}
              title={t("Önceki gün", "Previous day")}
              onClick={() => setDayOffset((offset) => offset - 1)}
            >
              <ChevronLeft size={15} aria-hidden="true" />
            </button>
            {dayOffset !== 0 && (
              <button
                type="button"
                className="schedule-back-to-plan"
                onClick={() => setDayOffset(0)}
              >
                {t("Plana dön", "Back to plan")}
              </button>
            )}
            <button
              type="button"
              aria-label={t("Sonraki gün", "Next day")}
              title={t("Sonraki gün", "Next day")}
              onClick={() => setDayOffset((offset) => offset + 1)}
            >
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
        <span className="schedule-state">
          <span>
            {unsaved
              ? t("Kaydedilmemiş plan", "Unsaved plan")
              : workday.routineEnabled
                ? t("Plan önizlemesi", "Plan preview")
                : t("Öneri · rutinler kapalı", "Proposal · routines off")}
          </span>
          {nowClock && (
            <span className="schedule-current-time">
              {t("Şimdi", "Now")} · {nowClock}
            </span>
          )}
        </span>
      </figcaption>

      {view === "timeline" ? (
        <div className="schedule-timeline">
          <div className="schedule-timeline-header">
            <div className="schedule-row-label schedule-axis-label">
              {t("24 saat", "24 hours")}
            </div>
            <div className="schedule-ruler" aria-hidden="true">
              {Array.from({ length: 25 }, (_, hour) => (
                <span
                  key={hour}
                  className="schedule-hour"
                  data-major={hour % 2 === 0}
                  data-coarse={hour % 4 === 0}
                  data-edge={
                    hour === 0 ? "start" : hour === 24 ? "end" : undefined
                  }
                  style={{ left: `${(hour / 24) * 100}%` }}
                >
                  <span>{String(hour).padStart(2, "0")}</span>
                </span>
              ))}
            </div>
          </div>
          <div className="schedule-period-row" aria-hidden="true">
            <div className="schedule-row-label" />
            <div className="schedule-periods">
              {[
                ["Gece", "Night"],
                ["Sabah", "Morning"],
                ["Öğleden sonra", "Afternoon"],
                ["Akşam", "Evening"],
              ].map(([tr, en], index) => (
                <span key={index}>{t(tr, en)}</span>
              ))}
            </div>
          </div>
          <div className="schedule-working-row">
            <div className="schedule-row-label">
              <strong>{t("Çalışma aralığı", "Working hours")}</strong>
              <small>{workRange}</small>
              {!day.working.length && (
                <small className="schedule-off-day">
                  {t(
                    "Bu gün çalışma aralığı yok",
                    "No working hours on this day",
                  )}
                </small>
              )}
            </div>
            <div
              className="schedule-track schedule-working-track"
              aria-label={`${t("Çalışma aralığı", "Working hours")}: ${workRange}`}
            >
              {day.working.map((segment, index) => (
                <span
                  key={index}
                  className="schedule-work-band"
                  style={{
                    left: position(segment.startMinute),
                    width: position(segment.endMinute - segment.startMinute),
                  }}
                  aria-hidden="true"
                />
              ))}
              {nowLine}
            </div>
          </div>
          {day.lanes.map((lane) => {
            const { range, exactRange, status } = laneText(
              lane,
              day.timeZone,
              t,
            );
            const proposal = lane.proposal;
            return (
              <div
                className="schedule-account-row"
                key={lane.accountId}
                style={
                  {
                    "--schedule-color": accountColor(lane.color),
                  } as CSSProperties
                }
              >
                <AccountSummary
                  lane={lane}
                  timeZone={day.timeZone}
                  t={t}
                  compact
                />
                <div
                  className="schedule-track"
                  aria-label={`${lane.name}: ${t("tahmini pencere", "estimated window")} ${range}${lane.actualReset ? `; ${t("sunucu sıfırlanması", "server reset")} ${timeLabel(lane.actualReset, t)}` : ""}${status ? `; ${status}` : ""}`}
                >
                  {proposal?.segments.map((segment, index) => (
                    <span
                      key={index}
                      className="schedule-proposal"
                      data-blocked={!!proposal.reason}
                      style={{
                        left: position(segment.startMinute),
                        width: position(
                          segment.endMinute - segment.startMinute,
                        ),
                      }}
                      title={`${t("Tahmini 5 saat", "Estimated 5 hours")}: ${exactRange}${status ? `; ${status}` : ""}`}
                      aria-hidden="true"
                    >
                      <span>
                        {proposal.segments.length === 1 &&
                        proposal.start.dayOffset === 0 &&
                        proposal.reset.dayOffset === 0
                          ? `5 ${t("sa", "h")}`
                          : segment.endMinute - segment.startMinute >= 120
                            ? t("Tahmini", "Estimate")
                            : null}
                      </span>
                    </span>
                  ))}
                  {lane.actualReset?.minute !== undefined && (
                    <span
                      className="schedule-server-marker"
                      data-edge={
                        lane.actualReset.minute < 120
                          ? "start"
                          : lane.actualReset.minute > 1_320
                            ? "end"
                            : undefined
                      }
                      style={{ left: position(lane.actualReset.minute) }}
                      title={`${t("Sunucudan alınan sıfırlanma", "Server-reported reset")}: ${exactTime(lane.actualReset, day.timeZone, t)}`}
                      aria-hidden="true"
                    >
                      <span>{lane.actualReset.clock}</span>
                    </span>
                  )}
                  {nowLine}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="schedule-clock-layout">
          <div className="schedule-dial-panel">
            <svg
              className="schedule-dial"
              viewBox="0 0 360 360"
              aria-hidden="true"
              focusable="false"
            >
              <circle
                className="schedule-dial-base"
                cx="180"
                cy="180"
                r="134"
              />
              {day.working.map((segment, index) => (
                <path
                  key={`work-${index}`}
                  className="schedule-dial-work"
                  d={dialSegmentPath(
                    segment.startMinute,
                    segment.endMinute,
                    134,
                  )}
                />
              ))}
              {visibleRings.map((lane, index) => (
                <g
                  key={lane.accountId}
                  style={
                    {
                      "--schedule-color": accountColor(lane.color),
                    } as CSSProperties
                  }
                >
                  <circle
                    className="schedule-dial-ring-base"
                    cx="180"
                    cy="180"
                    r={112 - index * 16}
                  />
                  {lane.proposal?.segments.map((segment, segmentIndex) => (
                    <path
                      key={segmentIndex}
                      className="schedule-dial-forecast"
                      data-blocked={!!lane.proposal?.reason}
                      d={dialSegmentPath(
                        segment.startMinute,
                        segment.endMinute,
                        112 - index * 16,
                      )}
                    />
                  ))}
                </g>
              ))}
              {Array.from({ length: 24 }, (_, hour) => {
                const start = dialPoint(hour * 60, 148);
                const end = dialPoint(hour * 60, hour % 2 === 0 ? 155 : 151);
                const label = dialPoint(hour * 60, 168);
                return (
                  <g key={hour}>
                    <line
                      className="schedule-dial-tick"
                      data-major={hour % 2 === 0}
                      x1={start.x}
                      y1={start.y}
                      x2={end.x}
                      y2={end.y}
                    />
                    {hour % 2 === 0 && (
                      <text
                        className="schedule-dial-hour"
                        x={label.x}
                        y={label.y}
                        textAnchor="middle"
                        dominantBaseline="middle"
                      >
                        {String(hour).padStart(2, "0")}
                      </text>
                    )}
                  </g>
                );
              })}
              {day.lanes.map((lane) => {
                if (lane.actualReset?.minute === undefined) return null;
                const point = dialPoint(lane.actualReset.minute, 145);
                return (
                  <rect
                    key={`reset-${lane.accountId}`}
                    className="schedule-dial-server"
                    x={point.x - 3}
                    y={point.y - 3}
                    width="6"
                    height="6"
                    transform={`rotate(45 ${point.x} ${point.y})`}
                    style={
                      {
                        "--schedule-color": accountColor(lane.color),
                      } as CSSProperties
                    }
                  />
                );
              })}
              {nowInner && nowOuter && (
                <line
                  className="schedule-dial-now"
                  x1={nowInner.x}
                  y1={nowInner.y}
                  x2={nowOuter.x}
                  y2={nowOuter.y}
                />
              )}
              <text
                className="schedule-dial-center-label"
                x="180"
                y="167"
                textAnchor="middle"
              >
                {nowClock ? t("Şimdi", "Now") : t("24 saat", "24 hours")}
              </text>
              <text
                className="schedule-dial-center-value"
                x="180"
                y="195"
                textAnchor="middle"
              >
                {nowClock ?? "00–24"}
              </text>
            </svg>
            <p className="schedule-clock-caption">
              {t(
                "Dış halka çalışma aralığıdır.",
                "The outer ring shows working hours.",
              )}{" "}
              {day.lanes.length > 4
                ? t(
                    `İç halkalarda ilk 4 hesap; ${day.lanes.length} hesabın tamamı ayrıntılarda.`,
                    `Inner rings show the first 4 accounts; all ${day.lanes.length} accounts are listed in the details.`,
                  )
                : t(
                    "İç halkalar hesap önerileridir.",
                    "Inner rings show account proposals.",
                  )}
            </p>
          </div>
          <div className="schedule-clock-accounts">
            <div className="schedule-clock-list-heading">
              <strong>{t("Hesap pencereleri", "Account windows")}</strong>
              <span>{t("Tahmini · 5 saat", "Estimated · 5 hours")}</span>
            </div>
            <div className="schedule-clock-work-summary">
              <strong>{t("Çalışma aralığı", "Working hours")}</strong>
              <span>{workRange}</span>
              {!day.working.length && (
                <small className="schedule-off-day">
                  {t(
                    "Bu gün çalışma aralığı yok",
                    "No working hours on this day",
                  )}
                </small>
              )}
            </div>
            {day.lanes.map((lane, index) => (
              <div
                key={lane.accountId}
                className="schedule-clock-account"
                data-plotted={index < 4}
                style={
                  {
                    "--schedule-color": accountColor(lane.color),
                  } as CSSProperties
                }
              >
                <AccountSummary
                  lane={lane}
                  timeZone={day.timeZone}
                  t={t}
                  ring={index < 4 ? index : undefined}
                />
                {index >= 4 && (
                  <span className="schedule-not-plotted">
                    {t("Yalnızca ayrıntılarda", "Details only")}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {!day.lanes.length && (
        <p className="schedule-no-accounts">
          {t(
            "Hesap seçince önerilen pencereler burada görünür.",
            "Select accounts to see their proposed windows here.",
          )}
        </p>
      )}
      <div className="schedule-legend" aria-hidden="true">
        <span>
          <i className="schedule-key-working" />
          {t("Çalışma", "Work")}
        </span>
        <span>
          <i className="schedule-key-proposal" />
          {t("Tahmini 5 saat", "Estimated 5 hours")}
        </span>
        <span>
          <i className="schedule-key-reset" />
          {t("Sunucu sıfırlanması", "Server reset")}
        </span>
        {day.isToday && (
          <span>
            <i className="schedule-key-now" />
            {t("Şimdi", "Now")}
          </span>
        )}
      </div>
      {spansOtherDays && (
        <p className="schedule-note schedule-boundary-note">
          {t(
            "Grafik bu güne aittir; ± gün etiketleri diğer takvim günlerini belirtir.",
            "The chart shows this day; ± day labels refer to other calendar days.",
          )}
        </p>
      )}
      <p className="schedule-note" id={summaryId}>
        {t(
          "Çizgiler önerilen 5 saatlik pencerelerdir; giriş yapılmış bir oturumu veya çalıştırılmış bir rutini göstermez. İşaretler yalnızca güncel sunucu sıfırlanma zamanlarıdır.",
          "Lines are proposed 5-hour windows, not active sessions or executed routines. Markers show only fresh server-reported reset times.",
        )}
        {day.elapsedHours !== 24 && (
          <>
            {" "}
            {t(
              `Saat değişimi nedeniyle bu takvim gününde ${day.elapsedHours} saat geçer.`,
              `A clock change makes this calendar day ${day.elapsedHours} elapsed hours long.`,
            )}
          </>
        )}
      </p>
    </figure>
  );
}
