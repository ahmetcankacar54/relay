// Formatting shared by the Usage page's statistics cards.
import type { Account } from "../../../shared/types";
import type { UsageStatisticsView } from "../../../shared/usage-statistics-view";
import { FORMER_KEY } from "../../../shared/usage-statistics-view";
import type { Language, T } from "@/data/i18n";

export type StatisticsRow = UsageStatisticsView["accounts"][number];

const MINUTE = 60_000;
const DAY_MINUTES = 24 * 60;
/** A Monday, used to name weekday 0 = Monday … 6 = Sunday. */
const MONDAY = Date.parse("2026-10-12T12:00:00Z");

export const locale = (language: Language) =>
  language === "tr" ? "tr-TR" : "en-GB";

// Building an Intl formatter is costly and a heatmap formats hundreds of
// cells, so formatters are kept per language and options.
const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();
function numberFormat(language: Language, fractionDigits: number) {
  const key = `${language}:${fractionDigits}`;
  let f = numberFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale(language), {
      maximumFractionDigits: fractionDigits,
    });
    numberFormats.set(key, f);
  }
  return f;
}
function dateFormat(language: Language, options: Intl.DateTimeFormatOptions) {
  const key = `${language}:${JSON.stringify(options)}`;
  let f = dateFormats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale(language), options);
    dateFormats.set(key, f);
  }
  return f;
}

/** Pro units with thousands separators; one decimal below 10. */
export function formatNumber(value: number, language: Language) {
  return numberFormat(language, Math.abs(value) < 10 ? 1 : 0).format(value);
}

const tokenFormats = new Map<Language, Intl.NumberFormat>();
/** A token count in compact units: "1,2 Mn" / "1.2m", "326 B" / "326k". */
export function formatTokens(value: number, language: Language) {
  let f = tokenFormats.get(language);
  if (!f) {
    f = new Intl.NumberFormat(locale(language), {
      notation: "compact",
      maximumFractionDigits: 1,
    });
    tokenFormats.set(language, f);
  }
  return f.format(value);
}

/** "1.840 Pro birimi" / "1,840 Pro units". */
export const formatUnits = (value: number, language: Language, t: T) =>
  `${formatNumber(value, language)} ${t("Pro birimi", "Pro units")}`;

/** "14 Eki" / "14 Oct" for a YYYY-MM-DD calendar date. */
export function formatDay(date: string, language: Language) {
  return dateFormat(language, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

/** Weekday 0 = Monday: "Salı" / "Tuesday", or "Sal" / "Tue" when short. */
export function weekdayName(
  weekday: number,
  language: Language,
  width: "long" | "short" = "long",
) {
  return dateFormat(language, { weekday: width, timeZone: "UTC" }).format(
    new Date(MONDAY + weekday * 24 * 60 * MINUTE),
  );
}

export const hourLabel = (hour: number) =>
  `${String(hour).padStart(2, "0")}:00`;

/** Key used by `daily.byAccount`: the account id, or "former". */
export const rowKey = (row: StatisticsRow) => row.accountId ?? FORMER_KEY;

/** Unmatched identities: the view names them in Turkish only. */
export const rowName = (row: { former?: true; name: string }, t: T) =>
  row.former ? t("Eski hesap", "Former account") : row.name;

/**
 * Colour slot of a row: its account's position in the account list, former
 * rows after every account. Colours stay put across ranges and filters.
 */
export function toneIndex(row: { accountId?: string }, accounts: Account[]) {
  const index = row.accountId
    ? accounts.findIndex((a) => a.id === row.accountId)
    : -1;
  return index >= 0 ? index : accounts.length;
}

/** SVG fill for colour slot `index` (theme `--tone-1..4`, cycled). */
export const toneFill = (index: number) => `var(--tone-${(index % 4) + 1})`;

/** "1 sa 10 dk" / "2 gün 3 sa"; English "1 h 10 min" / "2 days 3 h". */
export function formatDuration(ms: number, language: Language) {
  const total = Math.max(1, Math.round(ms / MINUTE));
  const tr = language === "tr";
  const days = Math.floor(total / DAY_MINUTES);
  const hours = Math.floor((total % DAY_MINUTES) / 60);
  const minutes = total % 60;
  const parts = days
    ? [
        tr ? `${days} gün` : `${days} ${days === 1 ? "day" : "days"}`,
        hours ? (tr ? `${hours} sa` : `${hours} h`) : "",
      ]
    : [
        hours ? (tr ? `${hours} sa` : `${hours} h`) : "",
        minutes ? (tr ? `${minutes} dk` : `${minutes} min`) : "",
      ];
  return parts.filter(Boolean).join(" ");
}
