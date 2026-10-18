/**
 * Every limit percentage Relay shows is the percent USED, as on Claude's own usage page, so the number
 * and the bar say the same thing: `%94 kullanıldı` in Turkish, `94% used` in English. Storage, colours
 * and alert thresholds work with the same percent used; only the text is formatted here.
 */

/** A rounded percentage: `%45` in Turkish, `45%` in English; `—` when unknown. */
export function formatPercent(value: number | undefined, language: string) {
  if (value === undefined || !Number.isFinite(value)) return "—";
  const n = Math.round(value);
  return language === "tr" ? `%${n}` : `${n}%`;
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
export const usedWord = (language: string) =>
  language === "tr" ? "kullanıldı" : "used";

/** `%94 kullanıldı` / `94% used` from the percent used; `—` when unknown. */
export function formatUsed(usedPercent: number | undefined, language: string) {
  const used = percentUsed(usedPercent);
  return used === undefined
    ? "—"
    : `${formatPercent(used, language)} ${usedWord(language)}`;
}
