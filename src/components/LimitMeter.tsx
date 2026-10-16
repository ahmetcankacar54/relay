import { useContext, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { formatPercent, meterClass, meterTone } from "@/lib/meter";
import { I18nContext } from "@/data/i18n";
import { usePrank } from "@/pranks/context";

/** A meter above this percent may be nibbled once the mouse has rested on it for the time below. */
export const NIBBLE_BAR_PERCENT = 90;
export const NIBBLE_BAR_HOVER_MS = 600;

const later = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/**
 * Starts the wait for a mouse that has come onto a meter: `fire` runs after 0.6 s, and the returned
 * function cancels it. Nothing starts for a meter at or below 90%, or one without a value.
 */
export function nibbleBarRest(
  value: number | undefined,
  fire: () => void,
  schedule: (run: () => void, ms: number) => () => void = later,
): (() => void) | undefined {
  if (value === undefined || value <= NIBBLE_BAR_PERCENT) return undefined;
  return schedule(fire, NIBBLE_BAR_HOVER_MS);
}

export function LimitMeter({
  label,
  percent,
  detail,
  size = "md",
}: {
  label: string;
  percent?: number;
  detail?: string;
  size?: "sm" | "md";
}) {
  // Read the context directly: the sidebar renders this without a provider in tests.
  const language = useContext(I18nContext)?.language ?? "tr";
  const value =
    percent === undefined ? undefined : Math.max(0, Math.min(100, percent));
  const prank = usePrank();
  const fill = useRef<HTMLDivElement>(null);
  const cancelRest = useRef<() => void>(undefined);
  const stopResting = () => {
    cancelRest.current?.();
    cancelRest.current = undefined;
  };
  // A meter that goes away while the mouse rests on it nibbles nothing.
  useEffect(() => stopResting, []);
  return (
    <div
      className="min-w-0"
      onPointerEnter={() => {
        stopResting();
        cancelRest.current = nibbleBarRest(value, () =>
          prank.offer("nibble-bar", fill.current),
        );
      }}
      onPointerLeave={stopResting}
    >
      <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">{label}</span>
        <b
          className={cn(
            "tabular-nums text-foreground",
            size === "md" ? "text-sm" : "text-xs",
          )}
        >
          {formatPercent(value, language)}
        </b>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        className={cn(
          "mt-1 overflow-hidden rounded-full bg-track",
          size === "md" ? "h-1.5" : "h-1",
        )}
      >
        <div
          ref={fill}
          className={cn("h-full rounded-full", meterClass[meterTone(value)])}
          style={{ width: `${value ?? 0}%` }}
        />
      </div>
      {detail && (
        <div className="mt-1 text-[11px] text-muted-foreground">{detail}</div>
      )}
    </div>
  );
}
