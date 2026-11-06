import type { AccountUsage } from "../../shared/types";
import { useI18n } from "@/data/i18n";
import { usageWindowRows } from "@/data/selectors";
import { formatPercent, formatUsed, meterFill, percentUsed } from "@/lib/meter";
import { formatReset } from "@/lib/time";
import { timeLeft } from "@/lib/account-row";
import { cn } from "@/lib/utils";
import type { RingState } from "./UsageRing";

const clamp = (value: number) => Math.max(0, Math.min(100, value));

/**
 * An account's limits as rows, as in the macOS Battery and Storage panes: the limit's name, a bar
 * that fills with what is used, the percent, and when the limit renews. `state` is the reading's
 * trust, as for the rings: an old reading is faded, a used-up limit is red.
 */
export function LimitBars({
  usage,
  now,
  zone,
  state = "fresh",
}: {
  usage?: AccountUsage;
  now: number;
  zone?: string;
  state?: RingState;
}) {
  const { t, language } = useI18n();
  const rows = usageWindowRows(usage);
  return (
    <div data-slot="limit-bars" className="grid gap-2">
      {rows.map((row) => {
        const used = state === "unknown" ? undefined : clamp(row.usedPercent);
        const name =
          row.key === "five_hour"
            ? t("5 saat", "5 hours")
            : row.key === "seven_day"
              ? t("Hafta", "Week")
              : t(row.label.tr, row.label.en);
        const renews = row.resetsAt
          ? row.key === "five_hour"
            ? t(
                `${timeLeft(row.resetsAt, now, t) ?? "0 dk"} kaldı`,
                `${timeLeft(row.resetsAt, now, t) ?? "0 min"} left`,
              )
            : formatReset(row.resetsAt, now, language, zone)
          : undefined;
        return (
          <div
            key={row.key}
            className="grid grid-cols-[5.5rem_minmax(0,1fr)_2.75rem] items-center gap-x-3 sm:grid-cols-[5.5rem_minmax(0,1fr)_2.75rem_9.5rem]"
          >
            <span className="truncate text-xs text-muted-foreground" title={t(row.label.tr, row.label.en)}>
              {name}
            </span>
            <div
              role="meter"
              aria-label={t(row.label.tr, row.label.en)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={used}
              aria-valuetext={used === undefined ? undefined : formatUsed(used, language)}
              className="h-1.5 overflow-hidden rounded-full bg-track"
            >
              {used !== undefined && (
                <div
                  className={cn(
                    "h-full rounded-full",
                    meterFill(used, state === "full"),
                    state === "stale" && "opacity-45",
                  )}
                  style={{ width: `${used}%` }}
                />
              )}
            </div>
            <b className="text-right text-sm font-semibold tabular-nums">
              {used === undefined ? "—" : formatPercent(percentUsed(used), language)}
            </b>
            <span className="hidden truncate text-xs text-muted-foreground sm:block">{renews}</span>
          </div>
        );
      })}
    </div>
  );
}
