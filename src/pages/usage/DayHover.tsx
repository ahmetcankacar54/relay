import {
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { windowTone } from "@/lib/day-timeline";
import { cn } from "@/lib/utils";

/** A day chart's bars in viewBox units: the chart's width, where the first bar's slot starts, the slot width and how many. */
export interface DayBars {
  width: number;
  left: number;
  step: number;
  count: number;
}

/** The keys that move the active day: one day back or on, or to either end. */
const KEY_MOVES: Record<
  string,
  (active: number | undefined, last: number) => number
> = {
  ArrowLeft: (active, last) => Math.max(0, (active ?? last + 1) - 1),
  ArrowRight: (active, last) => Math.min(last, (active ?? -1) + 1),
  Home: () => 0,
  End: (_, last) => last,
};

/** Where bar `day` is centred, as a share of the chart's width. */
export const barCentre = (
  { width, left, step }: Omit<DayBars, "count">,
  day: number,
) => (left + day * step + step / 2) / width;

/**
 * Which day of a bar chart is shown in detail. The pointer picks the day under it; with the chart
 * focused, ←/→ move one day, Home/End jump to either end and Escape lets go. `chart` goes on the <svg>;
 * `at` is the active bar's centre as a share of the chart's width, for `DayTooltip`. With `onPick`,
 * a click on a day, or Enter or Space on the active one, picks it. `onEscape` may take an Escape for
 * itself by returning true; the active day then stays.
 */
export function useDayHover({
  width,
  left,
  step,
  count,
  onPick,
  onEscape,
}: DayBars & {
  onPick?: (day: number) => void;
  onEscape?: () => boolean;
}) {
  const [active, setActive] = useState<number>();
  const ref = useRef<SVGSVGElement>(null);
  const dayAt = (clientX: number) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return undefined;
    const x = ((clientX - box.left) / box.width) * width;
    const day = Math.floor((x - left) / step);
    return day >= 0 && day < count ? day : undefined;
  };
  const shown = active !== undefined && active < count ? active : undefined;
  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key === "Escape") {
      if (onEscape?.()) return event.preventDefault();
      return setActive(undefined);
    }
    if ((event.key === "Enter" || event.key === " ") && onPick) {
      if (shown === undefined) return;
      event.preventDefault();
      return onPick(shown);
    }
    const move = KEY_MOVES[event.key];
    if (!move) return;
    event.preventDefault();
    setActive(move(active, count - 1));
  };
  const onClick = (event: MouseEvent<SVGSVGElement>) => {
    const day = dayAt(event.clientX);
    if (day !== undefined) onPick?.(day);
  };
  return {
    ref,
    active: shown,
    at:
      shown === undefined ? undefined : barCentre({ width, left, step }, shown),
    chart:
      count > 0
        ? {
            ref,
            tabIndex: 0,
            onPointerMove: (event: PointerEvent<SVGSVGElement>) =>
              setActive(dayAt(event.clientX)),
            onPointerLeave: () => setActive(undefined),
            onBlur: () => setActive(undefined),
            onKeyDown,
            ...(onPick ? { onClick } : {}),
          }
        : { ref },
  };
}

/**
 * The detail box beside the active bar, at the top of the chart: right of the bar in the chart's
 * left half, left of it in the right half, so it never covers the bar it describes. Screen readers
 * hear each day's label on the chart itself, so the box is hidden from them.
 */
export function DayTooltip({
  at,
  children,
}: {
  at?: number;
  children: ReactNode;
}) {
  if (at === undefined) return null;
  return (
    <div
      aria-hidden
      data-slot="day-tooltip"
      className="pointer-events-none absolute top-0 z-10 w-max max-w-72 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
      style={
        at > 0.5
          ? { right: `calc(${(1 - at) * 100}% + 10px)` }
          : { left: `calc(${at * 100}% + 10px)` }
      }
    >
      {children}
    </div>
  );
}

/** A row's colour: an account's tone, or the muted grey of rows that are no account. */
export function Swatch({ tone, muted }: { tone?: number; muted?: string }) {
  return (
    <i
      aria-hidden
      className={cn(
        "size-2.5 shrink-0 rounded-sm",
        tone === undefined
          ? cn("bg-muted-foreground", muted)
          : windowTone(tone),
      )}
    />
  );
}

/** One line of a day's detail: colour, name, value and, when given, its share of the day. */
export function DayTipRow({
  tone,
  muted,
  name,
  value,
  share,
}: {
  tone?: number;
  muted?: string;
  name: string;
  value: ReactNode;
  share?: string;
}) {
  return (
    <li className="flex items-center gap-2">
      <Swatch tone={tone} muted={muted} />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="font-medium tabular-nums">{value}</span>
      {share !== undefined && (
        <span className="w-9 text-right text-muted-foreground tabular-nums">
          {share}
        </span>
      )}
    </li>
  );
}
