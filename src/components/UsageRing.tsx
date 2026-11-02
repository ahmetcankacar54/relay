import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { meterTone, type MeterTone } from "@/lib/meter";

const strokeClass: Record<MeterTone, string> = {
  ok: "stroke-brand",
  warn: "stroke-warn",
  crit: "stroke-crit",
  none: "stroke-transparent",
};
const dotClass: Record<MeterTone, string> = {
  ok: "bg-brand",
  warn: "bg-warn",
  crit: "bg-crit",
  none: "bg-track",
};

const clamp = (value: number | undefined) =>
  value === undefined || !Number.isFinite(value)
    ? undefined
    : Math.max(0, Math.min(100, value));

/**
 * How far a ring's reading can be trusted: `fresh`, `stale` (an old reading: faded arcs on a
 * dashed track), `unknown` (no reading: the dashed track alone) or `full` (a limit is used up:
 * critical arcs whatever their length; the caller says when it opens).
 */
export type RingState = "fresh" | "stale" | "unknown" | "full";

/** One ring: its track, and the arc of what is used from 12 o'clock, clockwise. */
function Arc({
  radius,
  width,
  value,
  state,
}: {
  radius: number;
  width: number;
  value: number | undefined;
  state: RingState;
}) {
  const used = state === "unknown" ? undefined : clamp(value);
  const dashed = state === "stale" || state === "unknown";
  return (
    <>
      <circle
        cx="50"
        cy="50"
        r={radius}
        fill="none"
        strokeWidth={width}
        {...(dashed && { pathLength: 100, strokeDasharray: "3 2.5" })}
        className="stroke-track"
      />
      {used !== undefined && used > 0 && (
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          strokeWidth={width}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${used} 100`}
          transform="rotate(-90 50 50)"
          className={cn(
            strokeClass[state === "full" ? "crit" : meterTone(used)],
            state === "stale" && "opacity-45",
            "transition-[stroke-dasharray] duration-500 ease-out motion-reduce:transition-none",
          )}
        />
      )}
    </>
  );
}

/**
 * Two limits at a glance, as concentric rings: the outer one the five-hour window, thick, the
 * inner one the week, thin, so the two read apart by weight rather than by colour. Each fills with
 * what is used, in the meter's tone (brand, warning from 75 %, critical from 90 %). `children` sits
 * in the middle, usually the five-hour percent, inside a clear zone the rings never touch.
 * Without `inner` it is a single ring. `state` says how far the reading can be trusted (`RingState`).
 */
export function UsageRing({
  outer,
  inner,
  size = 44,
  label,
  state = "fresh",
  className,
  children,
}: {
  /** Percent used of the five-hour window. */
  outer?: number;
  /** Percent used of the week; omitted for a single ring. */
  inner?: number | null;
  size?: number;
  /** What the rings say, for screen readers. */
  label: string;
  state?: RingState;
  className?: string;
  children?: ReactNode;
}) {
  const dual = inner !== null && inner !== undefined;
  // In a 100 unit box: the outer ring 8 thick and the inner one 3 at hero sizes; thicker when small,
  // so the arcs stay visible at 20 px, with the inner ring always under half the outer's weight.
  const width = size <= 28 ? 16 : size <= 52 ? 13 : 8;
  const innerWidth = size <= 52 ? 6 : 3;
  const gap = size <= 52 ? 3 : 4.5;
  const outerRadius = 50 - width / 2;
  const innerRadius = outerRadius - width / 2 - gap - innerWidth / 2;
  return (
    <div
      role="img"
      aria-label={label}
      data-state={state === "fresh" ? undefined : state}
      className={cn("relative shrink-0", className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 100 100" className="size-full" aria-hidden="true">
        <Arc radius={outerRadius} width={width} value={outer} state={state} />
        {dual && <Arc radius={innerRadius} width={innerWidth} value={inner ?? undefined} state={state} />}
      </svg>
      {children !== undefined && (
        <div className="absolute inset-0 grid place-items-center text-center leading-none">
          {children}
        </div>
      )}
    </div>
  );
}

const ringClass: Record<MeterTone, string> = {
  ok: "border-brand",
  warn: "border-warn",
  crit: "border-crit",
  none: "border-track",
};

/**
 * A key for the rings: a mark in the limit's tone, its name, and what follows. The thick outer
 * ring's mark is a filled dot, the thin inner ring's (`thin`) a hollow one.
 */
export function RingKey({
  percent,
  thin,
  children,
}: {
  percent?: number;
  thin?: boolean;
  children: ReactNode;
}) {
  const tone = meterTone(clamp(percent));
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span
        aria-hidden="true"
        className={cn(
          "size-2 shrink-0 rounded-full",
          thin ? cn("border-[1.5px]", ringClass[tone]) : dotClass[tone],
        )}
      />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
