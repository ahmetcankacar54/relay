import { planCapacity } from "./planning";
import { quotaWindows } from "./quota-windows";
import type { Account, AccountUsage, AutoSwitchStrategy } from "./types";

/** Every strategy, in the order Settings → Switching offers them; "best" is the default. */
export const AUTO_SWITCH_STRATEGIES: readonly AutoSwitchStrategy[] = ["best", "weekly-first", "consume-first"];

/**
 * The used percent at which automatic switching leaves `account` and stops choosing it: its own
 * line when one is saved (50–100), else `fallback`, the line of the caller's rule: the warning
 * threshold for the suggestion, 90 for a target, 100 (full) for the account being left.
 */
export function switchAtPercent(account: Pick<Account, "switchAtPercent">, fallback: number): number {
  const own = account.switchAtPercent;
  return typeof own === "number" && Number.isInteger(own) && own >= 50 && own <= 100 ? own : fallback;
}

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
  /** How the accounts that hold half an hour are ordered; missing means "best". */
  strategy?: AutoSwitchStrategy;
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
 * The open five-hour window's reset, when its quota is lost then. A weekly
 * window with less left binds instead: that quota is not lost for days, so
 * the account is not urgent, like a closed window (Infinity).
 */
function openReset(usage: AccountUsage | undefined, now: number) {
  const [fiveHour, weekly] = quotaWindows(usage) ?? [];
  if (weekly && weekly.usedPercent > fiveHour.usedPercent) return Infinity;
  const reset = Date.parse(usage?.fiveHour?.resetsAt ?? "");
  return Number.isFinite(reset) && reset > now ? reset : Infinity;
}

/** The weekly period's reset, when known and ahead: "weekly-first" uses that week before it is lost. */
function weeklyReset(usage: AccountUsage | undefined, now: number) {
  const reset = Date.parse(usage?.sevenDay?.resetsAt ?? "");
  return Number.isFinite(reset) && reset > now ? reset : Infinity;
}

/**
 * The order of the accounts that hold enough, by strategy. Infinity − Infinity is NaN, which
 * falls through to the next key, as with two closed windows.
 */
const STRATEGY_ORDER: Record<
  AutoSwitchStrategy,
  (left: RankedContinuationTarget, right: RankedContinuationTarget, now: number) => number
> = {
  best: (left, right, now) => openReset(left.usage, now) - openReset(right.usage, now) || byScore(left, right),
  "weekly-first": (left, right, now) =>
    weeklyReset(left.usage, now) - weeklyReset(right.usage, now) || byScore(left, right),
  // The most used first, in percent; the smaller capacity first among equals, so it drains.
  "consume-first": (left, right) =>
    left.remainingPercent - right.remainingPercent || left.score - right.score || byScore(left, right),
};

/** An account past its own switch line: automatic switching would leave it again at once. */
const pastOwnLine = (r: RankedContinuationTarget) =>
  r.account.switchAtPercent !== undefined && 100 - r.remainingPercent >= switchAtPercent(r.account, 100);

/**
 * Rank policy-eligible candidates without mutating the caller's collection.
 * With a context: accounts with enough quota for half an hour at the current
 * tempo (else 10% left) first, in the strategy's order ("best": open windows
 * resetting soonest first, as their quota is lost at the reset, then closed
 * windows and accounts bound by their weekly window; "weekly-first": the
 * weekly reset soonest; "consume-first": the least left), then the rest. Without
 * one, or when nobody has enough: plan capacity × remaining quota. An account
 * past its own switch line comes last in every order.
 */
export function rankContinuationTargets(
  candidates: readonly ContinuationTargetCandidate[],
  context?: RankingContext,
): RankedContinuationTarget[] {
  const all = candidates.map(({ account, usage }) => {
    const remainingPercent = remainingQuotaPercent(account, usage);
    return {
      account,
      usage,
      remainingPercent,
      score: (planCapacity(account) * remainingPercent) / 100,
    };
  });
  const past = all.filter(pastOwnLine).sort(byScore);
  const ranked = all.filter((r) => !pastOwnLine(r));
  if (!context) return [...ranked.sort(byScore), ...past];
  const rate = context.rate;
  // `score` is in Pro windows, so `score × 100` is Pro units.
  const enough = (r: RankedContinuationTarget) =>
    r.remainingPercent > 0 &&
    (rate && rate > 0
      ? r.score * 100 >= rate * MIN_TEMPO_HOURS
      : r.remainingPercent >= MIN_LEFT_PERCENT);
  const passing = ranked.filter(enough);
  if (!passing.length) return [...ranked.sort(byScore), ...past];
  const order = STRATEGY_ORDER[context.strategy ?? "best"] ?? STRATEGY_ORDER.best;
  passing.sort((left, right) => order(left, right, context.now));
  return [
    ...passing,
    ...ranked.filter((r) => !passing.includes(r)).sort(byScore),
    ...past,
  ];
}
