import type { Account } from "../../../shared/types";
import { planCapacity } from "../../../shared/planning";
import type { LaneSegment } from "@/lib/day-timeline";
import { formatDuration, windowMinutes } from "@/lib/window-duration";

type T = (tr: string, en: string) => string;

/**
 * When the account works on the lane, as `[from, to]` ranges. Pieces that
 * meet (the plan's part and the live part at now) read as one range.
 */
function workRanges(lane: LaneSegment[], accountId: string) {
  const ranges: [number, number][] = [];
  for (const segment of lane) {
    if (segment.accountId !== accountId) continue;
    const last = ranges.at(-1);
    if (last && last[1] === segment.from) last[1] = segment.to;
    else ranges.push([segment.from, segment.to]);
  }
  return ranges;
}

/**
 * Under a planned account's status: how long its window lasts at the tempo
 * and when it works today; without a chosen plan, a nudge to choose one.
 */
export function AccountWindowLine({
  account,
  rate,
  lane,
  clock,
  t,
}: {
  account: Account;
  /** Pro units per hour the window is measured against. */
  rate: number;
  /** Today's usage lane. */
  lane: LaneSegment[];
  clock: (time: number) => string;
  t: T;
}) {
  const capacity = planCapacity(account);
  if (!account.planning || account.planning.plan === "unknown")
    return (
      <small className="text-xs text-warn-foreground">
        {t(
          `Plan türünü seç; ${capacity}× sayılıyor`,
          `Select the plan type. Counted as ${capacity}×`,
        )}
      </small>
    );
  const minutes = windowMinutes(capacity, rate);
  if (minutes === undefined) return null;
  const duration = formatDuration(minutes, t);
  const ranges = workRanges(lane, account.id)
    .map(([from, to]) => `${clock(from)}–${clock(to)}`)
    .join(", ");
  return (
    <small className="text-xs text-muted-foreground">
      {t(`Bir dönem ${duration} yeter`, `A period lasts ${duration}`) +
        (ranges ? t(` · bugün ${ranges}`, ` · today ${ranges}`) : "")}
    </small>
  );
}
