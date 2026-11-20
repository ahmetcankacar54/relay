import type { Language, T } from "@/data/i18n";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const locale = (language: Language) => (language === "tr" ? "tr-TR" : "en-GB");

function clockParts(
  time: number,
  language: Language,
  zone?: string,
  weekday = false,
) {
  return new Intl.DateTimeFormat(locale(language), {
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
  language: Language,
  zone?: string,
) {
  const ms = typeof time === "number" ? time : Date.parse(time);
  if (!Number.isFinite(ms)) return "";
  const parts = clockParts(ms, language, zone);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")}`;
}

/** Reset time plus remaining: "14:20 · 2 sa 10 dk" within a day, "Pazar 09:00 · 4 gün" beyond. */
export function formatReset(
  resetsAt: string,
  now: number,
  language: Language,
  zone?: string,
): string {
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return "";
  const diff = at - now;
  if (diff <= 0) return language === "tr" ? "şimdi" : "now";
  const clock = formatClock(at, language, zone);
  if (diff < DAY) {
    const total = Math.max(1, Math.round(diff / MINUTE));
    const h = Math.floor(total / 60);
    const m = total % 60;
    const parts =
      language === "tr"
        ? [h ? `${h} sa` : "", m ? `${m} dk` : ""]
        : [h ? `${h} h` : "", m ? `${m} min` : ""];
    return `${clock} · ${parts.filter(Boolean).join(" ")}`;
  }
  const weekday =
    clockParts(at, language, zone, true).find((p) => p.type === "weekday")
      ?.value ?? "";
  const days = Math.max(1, Math.round(diff / DAY));
  const span =
    language === "tr"
      ? `${days} gün`
      : `${days} ${days === 1 ? "day" : "days"}`;
  return `${weekday} ${clock} · ${span}`;
}

/** "1 dk önce" / "1 min ago"; under a minute "az önce" / "just now". */
export function formatRelative(
  iso: string,
  now: number,
  language: Language,
): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const diff = now - at;
  const tr = language === "tr";
  if (diff < MINUTE) return tr ? "az önce" : "just now";
  if (diff < HOUR) {
    const n = Math.floor(diff / MINUTE);
    return tr ? `${n} dk önce` : `${n} min ago`;
  }
  if (diff < DAY) {
    const n = Math.floor(diff / HOUR);
    return tr ? `${n} sa önce` : `${n} h ago`;
  }
  const n = Math.floor(diff / DAY);
  return tr ? `${n} gün önce` : `${n} ${n === 1 ? "day" : "days"} ago`;
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
    return days < 2 && hours ? t(`${days} gün ${hours} sa`, `${days} d ${hours} h`) : t(`${days} gün`, `${days} d`);
  }
  const minutes = Math.ceil(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? t(`${h} sa${m ? ` ${m} dk` : ""}`, `${h} h${m ? ` ${m} min` : ""}`) : t(`${m} dk`, `${m} min`);
}
