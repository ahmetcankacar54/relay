import { planCapacity } from "./planning";
import { quotaWindows } from "./usage";
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

/** Rank policy-eligible candidates without mutating the caller's collection. */
export function rankContinuationTargets(
  candidates: readonly ContinuationTargetCandidate[],
): RankedContinuationTarget[] {
  return candidates
    .map(({ account, usage }) => {
      const remainingPercent = remainingQuotaPercent(account, usage);
      return {
        account,
        usage,
        remainingPercent,
        score: (planCapacity(account) * remainingPercent) / 100,
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.remainingPercent - left.remainingPercent ||
        (left.account.id < right.account.id
          ? -1
          : left.account.id > right.account.id
            ? 1
            : 0),
    );
}
