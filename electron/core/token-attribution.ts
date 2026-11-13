import {
  MAX_USAGE_GAP_MS,
  type UsageSample,
} from "../../shared/usage-statistics";
import type { Account } from "../../shared/types";
import { desktopAccountFor } from "../../shared/desktop-account";

export type Attribution =
  | { kind: "account"; accountId: string; estimated: boolean }
  | { kind: "terminal" }
  | { kind: "unknown" };

/** A later reset time by at least this much means the window rolled over. */
const RESET_SHIFT_MS = 60 * 60_000;
/**
 * When no account's usage rose across the pair around a response, the nearest
 * rise this close still names the account: a small response may not move the
 * percent within its own five minutes, and the server may report it a reading late.
 */
export const NEAR_RISE_MS = 15 * 60_000;

/** How far `time` is from a sample pair: 0 inside it, else to its nearer end. */
const distance = (time: number, from: number, to: number) =>
  time < from ? from - time : time >= to ? time - to : 0;

/** Whether `candidate` (distance, rise) beats `best`: nearer, then a larger rise. */
const nearer = (
  candidate: { distance: number; rise: number },
  best?: { distance: number; rise: number },
) =>
  !best ||
  candidate.distance < best.distance ||
  (candidate.distance === best.distance && candidate.rise > best.rise);

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
 * `time`, the largest rise winning. When none rose there, the account with the
 * nearest rise within `NEAR_RISE_MS` (nearest first, then the larger rise).
 * Undefined when no account's usage rose that close.
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
  if (best) return best.accountId;
  let near: { accountId: string; distance: number; rise: number } | undefined;
  for (const [accountId, points] of byAccount)
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (b.at - a.at > MAX_USAGE_GAP_MS) continue;
      const amount = rise(a, b);
      const away = distance(time, a.at, b.at);
      if (amount <= 0 || !(away <= NEAR_RISE_MS)) continue;
      const candidate = { accountId, distance: away, rise: amount };
      if (nearer(candidate, near)) near = candidate;
    }
  return near?.accountId;
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
  /** The rise nearest `time` within `NEAR_RISE_MS` for one account, whose first sample after `time` is `low`. */
  const nearestRise = (
    { times, rises }: { times: number[]; rises: number[] },
    time: number,
    low: number,
  ) => {
    let near: { distance: number; rise: number } | undefined;
    const consider = (i: number) => {
      const away = distance(time, times[i], times[i + 1]);
      if (rises[i] > 0 && away <= NEAR_RISE_MS) {
        const candidate = { distance: away, rise: rises[i] };
        if (nearer(candidate, near)) near = candidate;
      }
    };
    // Pairs ending at or before `time`, then the pair around it, then pairs after it.
    for (let i = low - 2; i >= 0 && time - times[i + 1] <= NEAR_RISE_MS; i--)
      consider(i);
    if (low >= 1 && low < times.length) consider(low - 1);
    for (
      let i = low;
      i + 1 < times.length && times[i] - time <= NEAR_RISE_MS;
      i++
    )
      consider(i);
    return near;
  };
  return {
    estimate(time) {
      if (Number.isNaN(time)) return estimateAccountAt(time, samples);
      if (!(time >= first - NEAR_RISE_MS && time < last + NEAR_RISE_MS)) return;
      let best: { accountId: string; rise: number } | undefined;
      const lows: number[] = [];
      for (const { accountId, times, rises } of accounts) {
        // The first sample after `time`; the pair starts just before it.
        let low = 0;
        let high = times.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (times[middle] <= time) low = middle + 1;
          else high = middle;
        }
        lows.push(low);
        const amount = low >= 1 && low < times.length ? rises[low - 1] : 0;
        if (amount > 0 && (!best || amount > best.rise))
          best = { accountId, rise: amount };
      }
      if (best) return best.accountId;
      let near:
        { accountId: string; distance: number; rise: number } | undefined;
      accounts.forEach((account, at) => {
        const found = nearestRise(account, time, lows[at]);
        if (found && nearer(found, near))
          near = { accountId: account.accountId, ...found };
      });
      return near?.accountId;
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

/**
 * Which Relay account a Claude response belongs to, or whether it is not
 * Desktop's. Only an account with a Claude app sign-in can be estimated.
 * `samples` is indexed once per array and must not change after.
 */
export function attribute(
  row: { time: number; entrypoint?: string; profileAccountId?: string; sessionId?: string; requestId?: string },
  deps: {
    timeline: {
      accountAt(t: number): { accountUuid: string; orgId?: string } | undefined;
    };
    samples: readonly UsageSample[];
    accounts: readonly Account[];
    /**
     * The account whose separate Claude window held a session at time `t`, by Claude Code
     * session id.
     */
    windowOwner?(sessionId: string, t: number): string | undefined;
    /** The Relay account Relay's gateway sent a request id to, while its request log keeps it. */
    gatewayAccount?(requestId: string): string | undefined;
  },
): Attribution {
  if (row.profileAccountId)
    return {
      kind: "account",
      accountId: row.profileAccountId,
      estimated: false,
    };
  // A response that came through the gateway: the gateway knows which account served it.
  const served = row.requestId ? deps.gatewayAccount?.(row.requestId) : undefined;
  if (served && deps.accounts.some((account) => account.id === served))
    return { kind: "account", accountId: served, estimated: false };
  if (row.entrypoint && row.entrypoint !== "claude-desktop")
    return { kind: "terminal" };
  // A separate window's conversation runs on its own account, whatever the main Claude has open.
  const windowAccount = row.sessionId ? deps.windowOwner?.(row.sessionId, row.time) : undefined;
  if (windowAccount) {
    const owner = desktopAccountFor({ accountUuid: windowAccount }, deps.accounts);
    if (owner) return { kind: "account", accountId: owner.id, estimated: false };
  }
  const known = deps.timeline.accountAt(row.time);
  if (known) {
    const owner = desktopAccountFor(known, deps.accounts);
    return owner
      ? { kind: "account", accountId: owner.id, estimated: false }
      : { kind: "unknown" };
  }
  const estimated = indexFor(deps.samples, deps.accounts).estimate(row.time);
  return estimated
    ? { kind: "account", accountId: estimated, estimated: true }
    : { kind: "unknown" };
}
