import type { T } from "../../shared/i18n/translate";

/** How long until `iso`, as "2 sa 10 dk" / "2 h 10 min", or days and hours past a day. */
export function untilText(iso: string, now: number, t: T): string {
  const minutes = Math.max(0, Math.floor((Date.parse(iso) - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days) return hours ? t("srcTime.dH", { days, hours }) : t("srcTime.d", { days });
  if (hours) return mins ? t("srcTime.hMin", { hours, mins }) : t("srcTime.h", { hours });
  return mins ? t("srcTime.min", { mins }) : t("srcTime.underAMinute");
}
