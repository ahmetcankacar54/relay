import { planCapacity } from "./planning";
import { quotaWindows } from "./quota-windows";
import type { Account, AccountUsage } from "./types";

export interface ContinuationTargetCandidate {
  account: Account;
  usage: AccountUsage | undefined;
}

export interface RankedContinuationTarget extends ContinuationTargetCandidate {
  /** Relative plan capacity weighted by the smaller remaining quota window. */
  score: number;
  remainingPercent: number;
}

function remainingQuotaPercent(
  account: Account,
  usage: AccountUsage | undefined,
) {
  if (
    !usage ||
    usage.accountId !== account.id ||
    usage.status !== "ready" ||
    usage.stale
  )
    return 0;
  const windows = quotaWindows(usage);
  if (
    !windows ||
    windows.some(
      (w) =>
        typeof w.usedPercent !== "number" ||
        !Number.isFinite(w.usedPercent) ||
        w.usedPercent < 0 ||
        w.usedPercent > 100,
    )
  )
    return 0;
  return Math.min(...windows.map((w) => 100 - w.usedPercent));
}

/**
 * A relative capacity heuristic, not an estimate of tokens, cost, or runtime.
 * Callers must independently verify freshness, reset times, identity, history
 * transfer policy, and cooldown before considering an account eligible.
 */
export function continuationTargetScore(
  account: Account,
  usage: AccountUsage | undefined,
): number {
  return (planCapacity(account) * remainingQuotaPercent(account, usage)) / 100;
}

export interface RankingContext {
  now: number;
  /** Pro units per hour now */
  rate?: number;
}

const MIN_LEFT_PERCENT = 10;
const MIN_TEMPO_HOURS = 0.5;

const byScore = (
  left: RankedContinuationTarget,
  right: RankedContinuationTarget,
) =>
  right.score - left.score ||
  right.remainingPercent - left.remainingPercent ||
  (left.account.id < right.account.id
    ? -1
    : left.account.id > right.account.id
      ? 1
      : 0);

/**
 * When the binding window resets: the weekly one when it has less left (its
 * quota is not lost at the five-hour reset), else the open five-hour window.
 * A closed window or an unknown reset is Infinity.
 */
function bindingReset(usage: AccountUsage | undefined, now: number) {
  const [fiveHour, weekly] = quotaWindows(usage) ?? [];
  const binding =
    weekly && weekly.usedPercent > fiveHour.usedPercent ? weekly : fiveHour;
  const reset = Date.parse(binding?.resetsAt ?? "");
  return Number.isFinite(reset) && reset > now ? reset : Infinity;
}

/**
 * Rank policy-eligible candidates without mutating the caller's collection.
 * With a context: accounts with enough quota for half an hour at the current
 * tempo (else 10% left) first, by the reset of the window that binds them,
 * soonest first (their quota is lost at the reset), closed windows after
 * them. Without one, or when nobody has enough: plan capacity × remaining
 * quota.
 */
export function rankContinuationTargets(
  candidates: readonly ContinuationTargetCandidate[],
  context?: RankingContext,
): RankedContinuationTarget[] {
  const ranked = candidates.map(({ account, usage }) => {
    const remainingPercent = remainingQuotaPercent(account, usage);
    return {
      account,
      usage,
      remainingPercent,
      score: (planCapacity(account) * remainingPercent) / 100,
    };
  });
  if (!context) return ranked.sort(byScore);
  const rate = context.rate;
  // `score` is in Pro windows, so `score × 100` is Pro units.
  const enough = (r: RankedContinuationTarget) =>
    r.remainingPercent > 0 &&
    (rate && rate > 0
      ? r.score * 100 >= rate * MIN_TEMPO_HOURS
      : r.remainingPercent >= MIN_LEFT_PERCENT);
  const passing = ranked.filter(enough);
  if (!passing.length) return ranked.sort(byScore);
  // Two closed windows give Infinity − Infinity = NaN, which falls through to byScore.
  passing.sort(
    (left, right) =>
      bindingReset(left.usage, context.now) -
        bindingReset(right.usage, context.now) || byScore(left, right),
  );
  return [
    ...passing,
    ...ranked.filter((r) => !passing.includes(r)).sort(byScore),
  ];
}
