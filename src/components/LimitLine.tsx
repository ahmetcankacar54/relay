import { cva } from "class-variance-authority";
import type { T } from "@/data/i18n";
import { windowElapsed, type UsageWindowRow } from "@/data/selectors";
import { meterFill } from "@/lib/meter";
import { cn } from "@/lib/utils";
import { countdown } from "@/lib/time";
import { usedAt } from "../../shared/quota-windows";

export { countdown };

const track = cva("relative overflow-hidden rounded-full bg-track", {
  variants: { size: { sm: "h-1.5", md: "h-2" } },
  defaultVariants: { size: "sm" },
});
const head = cva("flex min-w-0 items-baseline justify-between gap-2", {
  variants: { size: { sm: "text-2xs", md: "text-xs" } },
  defaultVariants: { size: "sm" },
});

/**
 * One limit as one line and one bar: its name, the share used, the time to its reset, and a tick
 * for how much of the window has passed (a fill past it is being spent fast). A spent limit says
 * "Dolu" and when it opens, in red. The same meter everywhere a limit is shown.
 */
export function LimitLine({
  label,
  usedPercent,
  resetsAt,
  period,
  now,
  t,
  size = "sm",
  faded,
  title,
  showReset = true,
  ariaLabel,
}: {
  label: string;
  usedPercent: number;
  resetsAt?: string;
  /** A five-hour or weekly window gets the elapsed tick; a model of unknown length does not. */
  period?: UsageWindowRow["period"];
  now: number;
  t: T;
  size?: "sm" | "md";
  /** An old reading: shown, but quieter. */
  faded?: boolean;
  title?: string;
  /** Off in a narrow list column: the figure alone; the reset is in the title. */
  showReset?: boolean;
  /** The meter's name when the label is empty (a list column names it). */
  ariaLabel?: string;
}) {
  // A window whose reset has passed is empty again, whatever the reading says.
  const used = Math.min(100, Math.max(0, usedAt({ usedPercent, resetsAt }, now)));
  const full = used >= 100;
  const left = showReset ? countdown(resetsAt, now, t) : undefined;
  const elapsed = windowElapsed({ period, resetsAt }, now);
  const ahead = elapsed !== undefined && used / 100 > elapsed + 0.05;
  // "%45" in Turkish, "45%" in English, as every other percentage in the app.
  const percent = t(`%${Math.round(used)}`, `${Math.round(used)}%`);
  return (
    <div data-slot="limit-line" className={cn("grid min-w-0 gap-1", faded && "opacity-60")} title={title ?? (showReset ? undefined : countdown(resetsAt, now, t))}>
      <div className={head({ size })}>
        <span className="truncate text-muted-foreground">{label}</span>
        <span className="shrink-0 tabular-nums">
          {full ? (
            <span className="font-semibold text-crit">{left ? t(`Dolu · ${left}`, `Full · ${left}`) : t("Dolu", "Full")}</span>
          ) : (
            <>
              <span className={cn("font-semibold", used >= 90 ? "text-crit" : used >= 75 ? "text-warn-foreground" : "text-foreground")}>
                {percent}
              </span>
              {left && <span className="text-muted-foreground"> · {left}</span>}
            </>
          )}
        </span>
      </div>
      <div
        className={track({ size })}
        role="meter"
        aria-label={`${ariaLabel ?? label} ${percent}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(used)}
      >
        <div className={cn("h-full rounded-full", meterFill(used))} style={{ width: `${used}%` }} />
        {elapsed !== undefined && !full && (
          <span
            aria-hidden="true"
            className={cn("absolute inset-y-0 w-px", ahead ? "bg-crit" : "bg-foreground/45")}
            style={{ left: `${elapsed * 100}%` }}
          />
        )}
      </div>
    </div>
  );
}

/** A bare bar for a row (no label): the account's binding limit at a glance. */
export function MiniMeter({ usedPercent, label }: { usedPercent: number | undefined; label: string }) {
  const used = usedPercent === undefined ? 0 : Math.min(100, Math.max(0, usedPercent));
  return (
    <div className={track({ size: "sm" })} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used)}>
      {usedPercent !== undefined && <div className={cn("h-full rounded-full", meterFill(used))} style={{ width: `${used}%` }} />}
    </div>
  );
}
