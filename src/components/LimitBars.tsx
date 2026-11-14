import type { AccountUsage } from "../../shared/types";
import { useI18n } from "@/data/i18n";
import { usageWindowRows, windowElapsed, type UsageWindowRow } from "@/data/selectors";
import { formatPercent, formatUsed, meterFill, percentUsed } from "@/lib/meter";
import { formatReset } from "@/lib/time";
import { timeLeft } from "@/lib/account-row";
import { cn } from "@/lib/utils";
import type { RingState } from "./UsageRing";

const clamp = (value: number) => Math.max(0, Math.min(100, value));

/**
 * An account's limits as rows, as in the macOS Battery and Storage panes: the limit's name, a bar
 * that fills with what is used, the percent, and when the limit renews. `state` is the reading's
 * trust, as for the rings: an old reading is faded, a used-up limit is red. A tick on a five-hour or
 * weekly bar marks how much of the period has passed: a fill past it is use faster than even.
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
  const name = (row: UsageWindowRow) =>
    row.key === "five_hour"
      ? t("5 saat", "5 hours")
      : row.key === "seven_day"
        ? t("Hafta", "Week")
        : t(row.label.tr, row.label.en);
  const renews = (row: UsageWindowRow) =>
    !row.resetsAt
      ? undefined
      : row.period === "five_hour"
        ? t(
            `${timeLeft(row.resetsAt, now, t) ?? "0 dk"} kaldı`,
            `${timeLeft(row.resetsAt, now, t) ?? "0 min"} left`,
          )
        : formatReset(row.resetsAt, now, language, zone);
  // One grid for every row (subgrid), so the name column fits the longest name ("Fable · haftalık")
  // and the bars still line up; a name wraps before it is cut.
  return (
    <div
      data-slot="limit-bars"
      className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] items-center gap-x-3 gap-y-2 sm:grid-cols-[auto_minmax(3rem,1fr)_auto_auto]"
    >
      {rows.map((row) => {
        const used = state === "unknown" ? undefined : clamp(row.usedPercent);
        const elapsed = used === undefined ? undefined : windowElapsed(row, now);
        const pace =
          elapsed === undefined
            ? undefined
            : t(
                `Dönemden geçen süre ${formatPercent(elapsed * 100, "tr")}; çubuk çizgiyi geçtiyse eşit hızdan hızlı kullanıyorsun`,
                `Time passed in the period: ${formatPercent(elapsed * 100, "en")}; a bar past the line means use faster than an even pace`,
              );
        return (
          <div key={row.key} className="col-span-full grid grid-cols-subgrid items-center">
            <span className="text-xs leading-tight text-muted-foreground" title={t(row.label.tr, row.label.en)}>
              {name(row)}
            </span>
            <div className="relative" title={pace}>
              <div
                role="meter"
                aria-label={t(row.label.tr, row.label.en)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={used}
                aria-valuetext={
                  used === undefined ? undefined : [formatUsed(used, language), pace].filter(Boolean).join(" · ")
                }
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
              {elapsed !== undefined && (
                <span
                  aria-hidden="true"
                  data-slot="pace"
                  className="pointer-events-none absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-foreground/60"
                  style={{ left: `${elapsed * 100}%` }}
                />
              )}
            </div>
            <b className="text-right text-sm font-semibold tabular-nums">
              {used === undefined ? "—" : formatPercent(percentUsed(used), language)}
            </b>
            <span className="hidden truncate text-xs text-muted-foreground sm:block">{renews(row)}</span>
          </div>
        );
      })}
    </div>
  );
}
