// How long a five-hour window's quota lasts at a tempo, for the Planning page.

/** How long one window of `capacity` lasts at `rate` Pro units/hour, rounded to 5 minutes (at least 5); undefined when rate ≤ 0. */
export function windowMinutes(
  capacity: number,
  rate: number,
): number | undefined {
  if (!(rate > 0)) return undefined;
  return Math.max(5, Math.round(((100 * capacity) / rate) * 12) * 5);
}

/** "~30 dk", "~2 sa 25 dk", "~10 sa" / "~30 min", "~2 h 25 min", "~10 h". */
export function formatDuration(
  minutes: number,
  t: (tr: string, en: string) => string,
): string {
  const h = Math.floor(minutes / 60),
    m = minutes % 60;
  if (!h) return t(`~${m} dk`, `~${m} min`);
  return m
    ? t(`~${h} sa ${m} dk`, `~${h} h ${m} min`)
    : t(`~${h} sa`, `~${h} h`);
}
