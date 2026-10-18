import type { Translate } from "./i18n";

/** How long until `iso`, as "2 sa 10 dk" / "2 h 10 min", or days and hours past a day. */
export function untilText(iso: string, now: number, t: Translate): string {
  const minutes = Math.max(0, Math.floor((Date.parse(iso) - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days) return hours ? t(`${days} g ${hours} sa`, `${days} d ${hours} h`) : t(`${days} g`, `${days} d`);
  if (hours) return mins ? t(`${hours} sa ${mins} dk`, `${hours} h ${mins} min`) : t(`${hours} sa`, `${hours} h`);
  return mins ? t(`${mins} dk`, `${mins} min`) : t("1 dakikadan az", "under a minute");
}
