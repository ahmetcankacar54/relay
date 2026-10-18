/**
 * Every percentage Relay shows for a usage limit means what is LEFT of it, and carries a word:
 * `%6 kaldı` in Turkish, `6% left` in English. Storage, colours and alert thresholds keep working
 * with the percent USED; only the text turns it around, here.
 */

/** A rounded percentage: `%45` in Turkish, `45%` in English; `—` when unknown. */
export function formatPercent(value: number | undefined, language: string) {
  if (value === undefined || !Number.isFinite(value)) return "—";
  const n = Math.round(value);
  return language === "tr" ? `%${n}` : `${n}%`;
}

/**
 * What is left of a window from the percent used, rounded down so it is never more than the window
 * has (93.5 used leaves 6.5, shown as 6), kept between 0 and 100; undefined when unknown.
 */
export function percentLeft(usedPercent: number | undefined) {
  if (usedPercent === undefined || !Number.isFinite(usedPercent))
    return undefined;
  return Math.floor(Math.max(0, Math.min(100, 100 - usedPercent)));
}

/** The word that follows a remaining percentage. */
export const leftWord = (language: string) =>
  language === "tr" ? "kaldı" : "left";

/** `%6 kaldı` / `6% left` from the percent used; `—` when unknown. */
export function formatLeft(usedPercent: number | undefined, language: string) {
  const left = percentLeft(usedPercent);
  return left === undefined
    ? "—"
    : `${formatPercent(left, language)} ${leftWord(language)}`;
}
