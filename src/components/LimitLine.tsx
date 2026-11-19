import { cva } from "class-variance-authority";
import type { T } from "@/data/i18n";
import { windowElapsed, type UsageWindowRow } from "@/data/selectors";
import { meterFill } from "@/lib/meter";
import { cn } from "@/lib/utils";

/**
 * Time to a reset, short: "25 dk", "1 sa 50 dk", "3 gün". A day or more reads in days, as the
 * reference monitors do; the clock time is in the meter's title.
 */
export function countdown(at: string | undefined, now: number, t: T): string | undefined {
  const ms = at ? Date.parse(at) - now : NaN;
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  if (ms >= 86_400_000) {
    const days = Math.round(ms / 86_400_000);
    return t(`${days} gün`, `${days} d`);
  }
  const minutes = Math.ceil(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? t(`${h} sa${m ? ` ${m} dk` : ""}`, `${h} h${m ? ` ${m} min` : ""}`) : t(`${m} dk`, `${m} min`);
}

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
}) {
  const reset = Date.parse(resetsAt ?? "");
  // A window whose reset has passed is empty again, whatever the reading says.
  const used = Number.isFinite(reset) && reset <= now ? 0 : Math.min(100, Math.max(0, usedPercent));
  const full = used >= 100;
  const left = countdown(resetsAt, now, t);
  const elapsed = windowElapsed({ period, resetsAt }, now);
  const ahead = elapsed !== undefined && used / 100 > elapsed + 0.05;
  const percent = `%${Math.round(used)}`;
  return (
    <div data-slot="limit-line" className={cn("grid min-w-0 gap-1", faded && "opacity-60")} title={title}>
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
        aria-label={`${label} ${percent}`}
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
