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

/** One ring: its track, and the arc of what is used from 12 o'clock, clockwise. */
function Arc({
  radius,
  width,
  value,
  faint,
}: {
  radius: number;
  width: number;
  value: number | undefined;
  faint?: boolean;
}) {
  const used = clamp(value);
  return (
    <>
      <circle
        cx="50"
        cy="50"
        r={radius}
        fill="none"
        strokeWidth={width}
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
            strokeClass[meterTone(used)],
            faint && "opacity-60",
            "transition-[stroke-dasharray] duration-500 ease-out motion-reduce:transition-none",
          )}
        />
      )}
    </>
  );
}

/**
 * Two limits at a glance, as concentric rings: the outer one the five-hour window, the inner one
 * the week (fainter, so the two read apart). Each fills with what is used, in the meter's tone
 * (brand, warning from 75 %, critical from 90 %). `children` sits in the middle, usually the
 * five-hour percent. Without `inner` it is a single ring.
 */
export function UsageRing({
  outer,
  inner,
  size = 44,
  label,
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
  className?: string;
  children?: ReactNode;
}) {
  const dual = inner !== null && inner !== undefined;
  // Thicker rings when small, so the arcs stay visible at 20 px.
  const width = size <= 28 ? 13 : size <= 52 ? 10 : 8;
  const gap = size <= 28 ? 3 : 4;
  const outerRadius = 50 - width / 2;
  const innerRadius = outerRadius - width - gap;
  return (
    <div
      role="img"
      aria-label={label}
      className={cn("relative shrink-0", className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 100 100" className="size-full" aria-hidden="true">
        <Arc radius={outerRadius} width={width} value={outer} />
        {dual && <Arc radius={innerRadius} width={width} value={inner ?? undefined} faint />}
      </svg>
      {children !== undefined && (
        <div className="absolute inset-0 grid place-items-center text-center leading-none">
          {children}
        </div>
      )}
    </div>
  );
}

/** A key for the rings: a dot in the limit's tone, its name, and what follows. */
export function RingKey({
  percent,
  faint,
  children,
}: {
  percent?: number;
  faint?: boolean;
  children: ReactNode;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span
        aria-hidden="true"
        className={cn(
          "size-2 shrink-0 rounded-full",
          dotClass[meterTone(clamp(percent))],
          faint && "opacity-60",
        )}
      />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
