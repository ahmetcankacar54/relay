import { localDate, wallTime } from "./planning";
import type { UsageSample } from "./usage-statistics";

const MINUTE_MS = 60_000;
const QUARTER_MS = 15 * MINUTE_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** A window counts when its percent rose this much over at least a quarter hour. */
const MIN_RISE = 3;
const MIN_SPAN_MS = QUARTER_MS;
/** An account is calibrated from at least this many windows and this much rise in all. */
const MIN_WINDOWS = 2;
const MIN_TOTAL_RISE = 10;
/** A window counts only while spending on no account stays under this share of the account's. */
const UNPLACED_SHARE = 0.1;
/** A window's dollars per percent must be within these multiples of the median window's. */
const NEAR_MEDIAN = { low: 0.4, high: 2.5 };

/** What one percent of an account's 5-hour window took, in API-price dollars. */
export interface LimitCalibration {
  accountId: string;
  dollarsPerPercent: number;
  /** The 5-hour windows the estimate rests on. */
  windows: number;
  /** The rise and the spending it rests on. */
  percent: number;
  cost: number;
}

/** The token table's quarter-hour slots: date → who → slot (0–95) → cost. */
export type CostSlots = Record<string, Record<string, Record<string, { cost: number }>>>;

/**
 * The cost the token table counted for `who` between two times: each quarter hour's cost,
 * weighed by how much of it falls inside. Slots are in the planning time zone's local time.
 */
export function slotCostBetween(
  slots: CostSlots,
  who: readonly string[],
  from: number,
  to: number,
  zone: string,
  /** Slot start times already worked out, by date and slot; filled as it goes. */
  starts: Map<string, number | undefined> = new Map(),
): number {
  if (!(to > from)) return 0;
  let cost = 0;
  const first = localDate(from - DAY_MS, zone);
  const last = localDate(to + DAY_MS, zone);
  for (const [date, byWho] of Object.entries(slots)) {
    if (date < first || date > last) continue;
    for (const key of who) {
      const daySlots = byWho[key];
      if (!daySlots) continue;
      for (const [slot, counts] of Object.entries(daySlots)) {
        const index = Number(slot);
        if (!Number.isInteger(index) || index < 0 || index > 95 || !(counts.cost > 0)) continue;
        const key = `${date}|${index}`;
        if (!starts.has(key)) {
          const clock = `${String(Math.floor(index / 4)).padStart(2, "0")}:${String((index % 4) * 15).padStart(2, "0")}`;
          starts.set(key, wallTime(date, clock, zone));
        }
        const start = starts.get(key);
        if (start === undefined) continue;
        const overlap = Math.min(start + QUARTER_MS, to) - Math.max(start, from);
        if (overlap > 0) cost += (counts.cost * overlap) / QUARTER_MS;
      }
    }
  }
  return cost;
}

/**
 * Each account's dollars per percent of its 5-hour window: over the last `days`, the spending
 * the token table put on the account while its 5-hour percent rose, divided by the rise, summed
 * over the windows that rose enough. A window ends where the percent drops, the reset moves by
 * an hour or more, or the readings stop for five hours. Spending outside Claude Code (claude.ai
 * chats) is not in the table, so such use makes a percent look cheaper than it is.
 */
export function calibrateLimits(input: {
  samples: readonly UsageSample[];
  slots: CostSlots;
  zone: string;
  now: number;
  days?: number;
}): Record<string, LimitCalibration> {
  const since = input.now - (input.days ?? 7) * DAY_MS;
  const byAccount = new Map<string, { at: number; percent: number; resetsAt?: number }[]>();
  for (const sample of input.samples) {
    const at = Date.parse(sample.checkedAt);
    const percent = sample.fiveHour?.usedPercent;
    if (!Number.isFinite(at) || at < since || at > input.now || typeof percent !== "number" || !Number.isFinite(percent))
      continue;
    const reset = sample.fiveHour?.resetsAt ? Date.parse(sample.fiveHour.resetsAt) : NaN;
    const list = byAccount.get(sample.accountId) ?? [];
    list.push({ at, percent, ...(Number.isFinite(reset) ? { resetsAt: reset } : {}) });
    byAccount.set(sample.accountId, list);
  }
  const out: Record<string, LimitCalibration> = {};
  const starts = new Map<string, number | undefined>();
  for (const [accountId, points] of byAccount) {
    points.sort((a, b) => a.at - b.at);
    const windows: { first: (typeof points)[number]; last: (typeof points)[number] }[] = [];
    let current: { first: (typeof points)[number]; last: (typeof points)[number] } | undefined;
    for (const point of points) {
      const last = current?.last;
      const newWindow =
        !current ||
        !last ||
        point.percent < last.percent ||
        point.at - last.at > 5 * HOUR_MS ||
        (last.resetsAt !== undefined && point.resetsAt !== undefined && Math.abs(point.resetsAt - last.resetsAt) >= HOUR_MS);
      if (newWindow) {
        current = { first: point, last: point };
        windows.push(current);
      } else current!.last = point;
    }
    const counted: { rise: number; spent: number }[] = [];
    for (const { first, last } of windows) {
      const rise = last.percent - first.percent;
      if (rise < MIN_RISE || last.at - first.at < MIN_SPAN_MS) continue;
      const spent = slotCostBetween(input.slots, [`acct:${accountId}`, `est:${accountId}`], first.at, last.at, input.zone, starts);
      // Nothing in the table while the percent rose: the use was elsewhere and says nothing here.
      if (!(spent > 0)) continue;
      // Spending the table could not put on an account (terminal use before the gateway named
      // its accounts) may be this account's: such a window would make a percent look cheap.
      const unplaced = slotCostBetween(input.slots, ["terminal", "unknown"], first.at, last.at, input.zone, starts);
      if (unplaced > spent * UNPLACED_SHARE) continue;
      counted.push({ rise, spent });
    }
    // Use outside Claude Code (claude.ai chats, another machine) fills the window with little in
    // the table: such windows sit far below the others. Only windows near the median count.
    const ratios = counted.map((w) => w.spent / w.rise).sort((a, b) => a - b);
    const middle = ratios.length
      ? ratios.length % 2
        ? ratios[(ratios.length - 1) / 2]
        : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2
      : 0;
    let percent = 0;
    let cost = 0;
    let used = 0;
    for (const { rise, spent } of counted) {
      const ratio = spent / rise;
      if (ratio < middle * NEAR_MEDIAN.low || ratio > middle * NEAR_MEDIAN.high) continue;
      percent += rise;
      cost += spent;
      used += 1;
    }
    if (used < MIN_WINDOWS || percent < MIN_TOTAL_RISE) continue;
    out[accountId] = {
      accountId,
      dollarsPerPercent: Math.round((cost / percent) * 1000) / 1000,
      windows: used,
      percent: Math.round(percent * 10) / 10,
      cost: Math.round(cost * 100) / 100,
    };
  }
  return out;
}
