import { FORMAT_LOCALE, type Locale } from "../../shared/i18n/locales";
import { tFor, type T } from "../../shared/i18n/translate";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function clockParts(
  time: number,
  language: Locale,
  zone?: string,
  weekday = false,
) {
  return new Intl.DateTimeFormat(FORMAT_LOCALE[language], {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(weekday ? { weekday: "long" as const } : {}),
  }).formatToParts(new Date(time));
}

/** "14:20" in the given zone. */
export function formatClock(
  time: number | string,
  language: Locale,
  zone?: string,
) {
  const ms = typeof time === "number" ? time : Date.parse(time);
  if (!Number.isFinite(ms)) return "";
  const parts = clockParts(ms, language, zone);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")}`;
}

/** Hours and minutes, the minutes alone under an hour: "2 sa 10 dk", "2 sa", "10 dk" / "2 h 10 min", "2 h", "10 min". */
export const hoursMinutes = (h: number, m: number, t: T) =>
  h ? (m ? t("planningPanel.hMin", { h, m }) : t("planningPanel.h", { h })) : t("libTime.min", { m });

/** Reset time plus remaining: "14:20 · 2 sa 10 dk" within a day, "Pazar 09:00 · 4 gün" beyond. */
export function formatReset(
  resetsAt: string,
  now: number,
  language: Locale,
  zone?: string,
): string {
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return "";
  const t = tFor(language);
  const diff = at - now;
  if (diff <= 0) return t("proxyUi.now");
  const clock = formatClock(at, language, zone);
  if (diff < DAY) {
    const total = Math.max(1, Math.round(diff / MINUTE));
    return `${clock} · ${hoursMinutes(Math.floor(total / 60), total % 60, t)}`;
  }
  const weekday =
    clockParts(at, language, zone, true).find((p) => p.type === "weekday")
      ?.value ?? "";
  const days = Math.max(1, Math.round(diff / DAY));
  return `${weekday} ${clock} · ${t("format.days", { days })}`;
}

/** "1 dk önce" / "1 min ago"; under a minute "az önce" / "just now". */
export function formatRelative(
  iso: string,
  now: number,
  language: Locale,
): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const t = tFor(language);
  const diff = now - at;
  if (diff < MINUTE) return t("libTime.justNow");
  if (diff < HOUR) return t("proxyUi.minAgo", { minutes: Math.floor(diff / MINUTE) });
  if (diff < DAY) return t("proxyUi.hAgo", { hours: Math.floor(diff / HOUR) });
  return t("libTime.daysAgo", { days: Math.floor(diff / DAY) });
}

/**
 * Time to a reset, short: "25 dk", "1 sa 50 dk", "1 gün 13 sa", "3 gün". Two days or more read in
 * whole days, rounded down so it never says more time than is left; the clock time is in the title.
 */
export function countdown(at: string | undefined, now: number, t: T): string | undefined {
  const ms = at ? Date.parse(at) - now : NaN;
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  if (ms >= 86_400_000) {
    // Whole days rounded down, never more than is left; under two days the hours still matter.
    const days = Math.floor(ms / 86_400_000);
    const hours = Math.floor((ms % 86_400_000) / 3_600_000);
    return days < 2 && hours ? t("libTime.dH", { days, hours }) : t("libTime.d", { days });
  }
  const minutes = Math.ceil(ms / 60_000);
  return hoursMinutes(Math.floor(minutes / 60), minutes % 60, t);
}
