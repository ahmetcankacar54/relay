import type { ReactNode } from "react";
import type { AccountUsage } from "../../shared/types";
import { useI18n } from "@/data/i18n";
import { usageWindowRows, type UsageWindowRow } from "@/data/selectors";
import { formatPercent, meterFill, percentUsed } from "@/lib/meter";
import { formatReset } from "@/lib/time";
import { timeLeft } from "@/lib/account-row";
import { cn } from "@/lib/utils";
import { RingKey, UsageRing, type RingState } from "./UsageRing";

/**
 * An account's limits as one gauge: two rings (the five-hour window outside, the week inside)
 * with the five-hour percent in the middle, and beside them a key line per limit with its
 * percent and when it renews. A model's own limit (Fable's week) is listed under them as a line with
 * a short bar in its tone, its percent and when it renews.
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
  // A five-hour window says the time left, a longer one the day and clock it renews.
  const renews = (row: UsageWindowRow) =>
    !row.resetsAt
      ? undefined
      : row.period === "five_hour"
        ? t(
            `${timeLeft(row.resetsAt, now, t) ?? "0 dk"} kaldı`,
            `${timeLeft(row.resetsAt, now, t) ?? "0 min"} left`,
          )
        : formatReset(row.resetsAt, now, language, zone);
  const five = usage?.fiveHour?.usedPercent;
  const week = usage?.sevenDay?.usedPercent;
  // The rings draw the five hours and the week only; the model lines read for themselves.
  const label = rows
    .filter((r) => !r.model)
    .map((r) => `${t(r.label.tr, r.label.en)} ${formatPercent(percentUsed(r.usedPercent), language)}`)
    .join(" · ");
  return (
    <div data-slot="limit-rings" className={cn("flex min-w-0 items-center gap-3.5", className)}>
      <UsageRing outer={five} inner={week ?? null} size={size} label={label} state={state}>
        <span className="grid gap-0.5">
          <b className={cn("tabular-nums", size >= 88 ? "text-2xl font-semibold" : "text-lg")}>
            {five === undefined ? "—" : formatPercent(percentUsed(five), language)}
          </b>
          <span className="text-2xs text-muted-foreground">{t("5 saat", "5 hours")}</span>
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
            {!row.model ? (
              <RingKey percent={row.usedPercent} thin={row.key === "seven_day"}>
                <span>{row.key === "five_hour" ? t("5 saat", "5 hours") : t("Hafta", "Week")}</span>{" "}
                <b className="text-foreground tabular-nums">
                  {formatPercent(percentUsed(row.usedPercent), language)}
                </b>
                {row.resetsAt && ` · ${renews(row)}`}
              </RingKey>
            ) : (
              <span data-slot="model-limit" className="flex min-w-0 items-center gap-1.5">
                <span aria-hidden="true" className="h-1 w-6 shrink-0 overflow-hidden rounded-full bg-track">
                  <span
                    className={cn(
                      "block h-full rounded-full",
                      meterFill(row.usedPercent),
                      state === "stale" && "opacity-45",
                    )}
                    style={{ width: `${Math.max(0, Math.min(100, row.usedPercent))}%` }}
                  />
                </span>
                <span className="min-w-0 truncate">
                  {t(row.label.tr, row.label.en)}{" "}
                  <b className="text-foreground tabular-nums">
                    {formatPercent(percentUsed(row.usedPercent), language)}
                  </b>
                  {row.resetsAt && ` · ${renews(row)}`}
                </span>
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
