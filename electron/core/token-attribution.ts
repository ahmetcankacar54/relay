import {
  MAX_USAGE_GAP_MS,
  type UsageSample,
} from "../../shared/usage-statistics";
import type { Account } from "../../shared/types";

export type Attribution =
  | { kind: "account"; accountId: string; estimated: boolean }
  | { kind: "terminal" }
  | { kind: "unknown" };

/** A later reset time by at least this much means the window rolled over. */
const RESET_SHIFT_MS = 60 * 60_000;

interface Reading {
  at: number;
  percent: number;
  resetsAt?: number;
}

function reading(sample: UsageSample): Reading | undefined {
  const at = Date.parse(sample.checkedAt);
  const window = sample.fiveHour;
  if (!Number.isFinite(at) || !window || !Number.isFinite(window.usedPercent))
    return;
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  return {
    at,
    percent: window.usedPercent,
    ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
  };
}

function rise(a: Reading, b: Reading): number {
  const reset =
    b.percent < a.percent ||
    (a.resetsAt !== undefined &&
      b.resetsAt !== undefined &&
      b.resetsAt - a.resetsAt >= RESET_SHIFT_MS);
  return reset ? b.percent : b.percent - a.percent;
}

/**
 * The Relay account whose 5-hour usage rose across the sample pair around
 * `time`, the largest rise winning. Undefined when no account's usage rose.
 */
export function estimateAccountAt(
  time: number,
  samples: readonly UsageSample[],
): string | undefined {
  const byAccount = new Map<string, Reading[]>();
  for (const sample of samples) {
    const point = reading(sample);
    if (!point) continue;
    const list = byAccount.get(sample.accountId);
    if (list) list.push(point);
    else byAccount.set(sample.accountId, [point]);
  }
  let best: { accountId: string; rise: number } | undefined;
  for (const [accountId, points] of byAccount) {
    points.sort((x, y) => x.at - y.at);
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (a.at > time) break;
      if (time >= b.at || b.at - a.at > MAX_USAGE_GAP_MS) continue;
      const amount = rise(a, b);
      if (amount > 0 && (!best || amount > best.rise))
        best = { accountId, rise: amount };
      break;
    }
  }
  return best?.accountId;
}

export interface SampleIndex {
  /** `estimateAccountAt(time, samples)`, for the samples indexed. */
  estimate(time: number): string | undefined;
}

/**
 * `estimateAccountAt` for many times over one set of samples: the samples are
 * read and sorted once, and each time finds its pair by binary search.
 */
export function indexSamples(samples: readonly UsageSample[]): SampleIndex {
  const byAccount = new Map<string, Reading[]>();
  for (const sample of samples) {
    const point = reading(sample);
    if (!point) continue;
    const list = byAccount.get(sample.accountId);
    if (list) list.push(point);
    else byAccount.set(sample.accountId, [point]);
  }
  let first = Infinity;
  let last = -Infinity;
  const accounts = [...byAccount].map(([accountId, points]) => {
    points.sort((x, y) => x.at - y.at);
    const times = points.map((point) => point.at);
    first = Math.min(first, times[0]);
    last = Math.max(last, times[times.length - 1]);
    // What each consecutive pair rose by; nothing across too long a gap.
    const rises = points
      .slice(1)
      .map((b, i) =>
        b.at - points[i].at > MAX_USAGE_GAP_MS ? 0 : rise(points[i], b),
      );
    return { accountId, times, rises };
  });
  return {
    estimate(time) {
      if (Number.isNaN(time)) return estimateAccountAt(time, samples);
      if (!(time >= first && time < last)) return;
      let best: { accountId: string; rise: number } | undefined;
      for (const { accountId, times, rises } of accounts) {
        // The first sample after `time`; the pair starts just before it.
        let low = 0;
        let high = times.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (times[middle] <= time) low = middle + 1;
          else high = middle;
        }
        const amount = rises[low - 1];
        if (amount > 0 && (!best || amount > best.rise))
          best = { accountId, rise: amount };
      }
      return best?.accountId;
    },
  };
}

/**
 * Each samples array is indexed once per set of candidates, on the first row
 * that needs an estimate; a new array is indexed anew.
 */
const indexes = new WeakMap<
  readonly UsageSample[],
  { candidates: string; index: SampleIndex }
>();
function indexFor(
  samples: readonly UsageSample[],
  accounts: readonly Account[],
): SampleIndex {
  // Desktop's rows can belong only to an account Claude Desktop has signed in to.
  const ids = accounts
    .filter((account) => account.desktop?.accountUuid)
    .map((account) => account.id);
  const candidates = ids.join("\n");
  const cached = indexes.get(samples);
  if (cached?.candidates === candidates) return cached.index;
  const allowed = new Set(ids);
  const index = indexSamples(
    samples.filter((sample) => allowed.has(sample.accountId)),
  );
  indexes.set(samples, { candidates, index });
  return index;
}

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function accountFor(
  known: { accountUuid: string; orgId?: string },
  accounts: readonly Account[],
): Account | undefined {
  return accounts.find((account) => {
    const desktop = account.desktop;
    if (
      !desktop?.accountUuid ||
      !sameId(desktop.accountUuid, known.accountUuid)
    )
      return false;
    // The organization decides only when both sides know it.
    return !known.orgId || !desktop.orgId || sameId(desktop.orgId, known.orgId);
  });
}

/**
 * Which Relay account a Claude response belongs to, or whether it is not
 * Desktop's. Only an account with a Claude app sign-in can be estimated.
 * `samples` is indexed once per array and must not change after.
 */
export function attribute(
  row: { time: number; entrypoint?: string; profileAccountId?: string },
  deps: {
    timeline: {
      accountAt(t: number): { accountUuid: string; orgId?: string } | undefined;
    };
    samples: readonly UsageSample[];
    accounts: readonly Account[];
  },
): Attribution {
  if (row.profileAccountId)
    return {
      kind: "account",
      accountId: row.profileAccountId,
      estimated: false,
    };
  if (row.entrypoint && row.entrypoint !== "claude-desktop")
    return { kind: "terminal" };
  const known = deps.timeline.accountAt(row.time);
  if (known) {
    const owner = accountFor(known, deps.accounts);
    return owner
      ? { kind: "account", accountId: owner.id, estimated: false }
      : { kind: "unknown" };
  }
  const estimated = indexFor(deps.samples, deps.accounts).estimate(row.time);
  return estimated
    ? { kind: "account", accountId: estimated, estimated: true }
    : { kind: "unknown" };
}
