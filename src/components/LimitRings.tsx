import type { ReactNode } from "react";
import type { AccountUsage } from "../../shared/types";
import { useI18n } from "@/data/i18n";
import { usageWindowRows } from "@/data/selectors";
import { formatPercent, percentUsed } from "@/lib/meter";
import { formatReset } from "@/lib/time";
import { timeLeft } from "@/lib/account-row";
import { cn } from "@/lib/utils";
import { RingKey, UsageRing, type RingState } from "./UsageRing";

/**
 * An account's limits as one gauge: two rings (the five-hour window outside, the week inside)
 * with the five-hour percent in the middle, and beside them a key line per limit with its
 * percent and when it renews. Limits past the first two (per model) are listed under them.
 */
export function LimitRings({
  usage,
  now,
  zone,
  size = 76,
  state,
  aside,
  className,
}: {
  usage?: AccountUsage;
  now: number;
  zone?: string;
  size?: number;
  /** How far the reading can be trusted; the key lines say when a full limit opens. */
  state?: RingState;
  /** Above the key lines (a name, a status). */
  aside?: ReactNode;
  className?: string;
}) {
  const { t, language } = useI18n();
  const rows = usageWindowRows(usage);
  const five = usage?.fiveHour?.usedPercent;
  const week = usage?.sevenDay?.usedPercent;
  const label = rows
    .slice(0, 2)
    .map((r) => `${t(r.label.tr, r.label.en)} ${formatPercent(percentUsed(r.usedPercent), language)}`)
    .join(" · ");
  return (
    <div data-slot="limit-rings" className={cn("flex min-w-0 items-center gap-3.5", className)}>
      <UsageRing outer={five} inner={week ?? null} size={size} label={label} state={state}>
        <span className="grid gap-0.5">
          <b className={cn("tabular-nums", size >= 88 ? "text-xl" : "text-[15px]")}>
            {five === undefined ? "—" : formatPercent(percentUsed(five), language)}
          </b>
          <span className="text-[11px] text-muted-foreground">{t("5 saat", "5 hours")}</span>
        </span>
      </UsageRing>
      <div className="grid min-w-0 flex-1 gap-1 overflow-hidden">
        {aside}
        {rows.map((row) => (
          <div
            key={row.key}
            className="min-w-0 text-xs text-muted-foreground"
            title={`${t(row.label.tr, row.label.en)} · ${formatPercent(percentUsed(row.usedPercent), language)}${row.resetsAt ? ` · ${formatReset(row.resetsAt, now, language, zone)}` : ""}`}
          >
            {row.key === "five_hour" || row.key === "seven_day" ? (
              <RingKey percent={row.usedPercent} thin={row.key === "seven_day"}>
                <span>{row.key === "five_hour" ? t("5 saat", "5 hours") : t("Hafta", "Week")}</span>{" "}
                <b className="text-foreground tabular-nums">
                  {formatPercent(percentUsed(row.usedPercent), language)}
                </b>
                {row.resetsAt &&
                  ` · ${
                    row.key === "five_hour"
                      ? t(
                          `${timeLeft(row.resetsAt, now, t) ?? "0 dk"} kaldı`,
                          `${timeLeft(row.resetsAt, now, t) ?? "0 m"} left`,
                        )
                      : formatReset(row.resetsAt, now, language, zone)
                  }`}
              </RingKey>
            ) : (
              <span className="block truncate pl-3.5">
                {t(row.label.tr, row.label.en)} ·{" "}
                <b className="text-foreground tabular-nums">
                  {formatPercent(percentUsed(row.usedPercent), language)}
                </b>
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
