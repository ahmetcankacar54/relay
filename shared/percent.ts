import { FORMAT_LOCALE, type Locale } from "./i18n/locales";
import { tFor } from "./i18n/translate";

/**
 * Every limit percentage Relay shows is the percent USED, as on Claude's own usage page, so the number
 * and the bar say the same thing: `%94 kullanıldı` in Turkish, `94% used` in English. Storage, colours
 * and alert thresholds work with the same percent used; only the text is formatted here.
 */

const percentFormats = new Map<Locale, Intl.NumberFormat>();
/** A rounded percentage in the language's style: `%45` in Turkish, `45%` in English, `45 %` in German; `—` when unknown. */
export function formatPercent(value: number | undefined, language: Locale) {
  if (value === undefined || !Number.isFinite(value)) return "—";
  let f = percentFormats.get(language);
  if (!f) {
    f = new Intl.NumberFormat(FORMAT_LOCALE[language], { style: "percent", maximumFractionDigits: 0, useGrouping: false });
    percentFormats.set(language, f);
  }
  return f.format(Math.round(value) / 100);
}

/**
 * The percent used of a window for display: rounded down so only a full window reads 100 (99.9 shows
 * 99), kept between 0 and 100; undefined when unknown.
 */
export function percentUsed(usedPercent: number | undefined) {
  if (usedPercent === undefined || !Number.isFinite(usedPercent))
    return undefined;
  return Math.floor(Math.max(0, Math.min(100, usedPercent)));
}

/** The word that follows a percentage used. */
export const usedWord = (language: Locale) => tFor(language)("percent.usedWord");

/** `%94 kullanıldı` / `94% used` from the percent used; `—` when unknown. */
export function formatUsed(usedPercent: number | undefined, language: Locale) {
  const used = percentUsed(usedPercent);
  return used === undefined
    ? "—"
    : tFor(language)("percent.used", { percent: formatPercent(used, language) });
}
