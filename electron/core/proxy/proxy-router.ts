import type { Account, AccountUsage } from "../../../shared/types";
import type { RoutingStrategy } from "../../../shared/proxy-types";
import {
  rankContinuationTargets,
  type ContinuationTargetCandidate,
} from "../../../shared/continuation-target-ranking";
import { ProxySessionCache } from "./proxy-session-cache";

export type ProxyProvider = "claude" | "codex" | "antigravity";

export interface ProxyRouterOptions {
  strategy?: RoutingStrategy;
  sessionCache?: ProxySessionCache;
  now?: () => number;
}

export interface RouterSelection {
  account: Account;
  sessionAffinityHit: boolean;
}

/** Every account of the provider is cooling down; `retryAfterSeconds` is when the first is back. */
export class NoEligibleAccountError extends Error {
  constructor(readonly retryAfterSeconds?: number) {
    super("Every account for this provider is cooling down");
  }
}

/** Relay has no account of the requested provider (or every one was already tried). */
export class NoProviderAccountError extends Error {
  constructor(readonly provider: ProxyProvider | undefined) {
    super(
      provider
        ? `No ${provider} account is available in Relay`
        : "No account is available in Relay",
    );
  }
}

/** How much of the fuller window is left, 0–100; undefined while no limit has been read. */
const remainingPercent = (usage: AccountUsage | undefined): number | undefined => {
  const used = [usage?.fiveHour?.usedPercent, usage?.sevenDay?.usedPercent].filter(
    (p): p is number => typeof p === "number" && Number.isFinite(p),
  );
  return used.length ? Math.max(0, 100 - Math.max(...used)) : undefined;
};

export class ProxyRouter {
  readonly sessionCache: ProxySessionCache;
  private strategy: RoutingStrategy;
  private readonly now: () => number;
  /** Cooldowns the gateway itself sets after a 429/401/403, by account id (ms timestamp). */
  private readonly cooldowns = new Map<string, number>();

  constructor(options: ProxyRouterOptions = {}) {
    this.sessionCache = options.sessionCache ?? new ProxySessionCache();
    this.strategy = options.strategy ?? "soonest-reset";
    this.now = options.now ?? Date.now;
  }

  setStrategy(strategy: RoutingStrategy): void {
    this.strategy = strategy;
  }

  /**
   * Keeps an account out of selection for `ms`, e.g. after the upstream answered 429.
   * Evicting its sessions alone is not enough: the strategy would pick it again at once.
   */
  markUnavailable(accountId: string, ms: number): void {
    const until = this.now() + Math.max(0, ms);
    this.cooldowns.set(
      accountId,
      Math.max(this.cooldowns.get(accountId) ?? 0, until),
    );
  }

  /** Lets the account be picked again at once (a usage dashboard cleared its cooldown). */
  clearCooldown(accountId: string): void {
    this.cooldowns.delete(accountId);
  }

  private cooldownEnd(account: Account, now: number): number {
    const local = this.cooldowns.get(account.id);
    if (local !== undefined && local <= now) this.cooldowns.delete(account.id);
    const stored = account.cooldownUntil
      ? Date.parse(account.cooldownUntil)
      : NaN;
    return Math.max(
      Number.isFinite(stored) ? stored : 0,
      this.cooldowns.get(account.id) ?? 0,
    );
  }

  /**
   * Selects the account for one request: only the requested provider's accounts are considered
   * (a request never crosses to another provider's protocol), minus those in `exclude` (already
   * tried for this request) and those cooling down. A pinned session keeps its account while it
   * has quota, preserving the upstream prompt cache; otherwise the strategy picks.
   */
  selectAccount(
    sessionKey: string | undefined,
    accounts: readonly Account[],
    usageMap: Record<string, AccountUsage | undefined>,
    targetProvider?: ProxyProvider,
    exclude: ReadonlySet<string> = new Set(),
  ): RouterSelection {
    const now = this.now();
    const ofProvider = accounts.filter(
      (a) =>
        !exclude.has(a.id) &&
        (!targetProvider || (a.provider ?? "claude") === targetProvider),
    );
    if (ofProvider.length === 0) throw new NoProviderAccountError(targetProvider);

    const ends = new Map(
      ofProvider.map((acc) => [acc.id, this.cooldownEnd(acc, now)]),
    );
    const eligibleAccounts = ofProvider.filter(
      (acc) => (ends.get(acc.id) ?? 0) <= now,
    );
    if (eligibleAccounts.length === 0) {
      const soonest = Math.min(...ends.values());
      throw new NoEligibleAccountError(
        Math.max(1, Math.ceil((soonest - now) / 1000)),
      );
    }

    // 1. Session Affinity Check (KV cache preservation)
    if (sessionKey) {
      const existingAccountId = this.sessionCache.get(sessionKey);
      if (existingAccountId) {
        const candidate = eligibleAccounts.find(
          (a) => a.id === existingAccountId,
        );
        if (candidate) {
          const usage = usageMap[candidate.id];
          const hasRemainingQuota =
            !usage ||
            usage.status !== "ready" ||
            ((usage.fiveHour?.usedPercent ?? 0) < 100 &&
              (usage.sevenDay?.usedPercent ?? 0) < 100);

          if (hasRemainingQuota) {
            return { account: candidate, sessionAffinityHit: true };
          } else {
            // Account exhausted its quota, evict affinity
            this.sessionCache.evictAccount(candidate.id);
          }
        }
      }
    }

    // 2. Select best candidate based on strategy
    const candidates: ContinuationTargetCandidate[] = eligibleAccounts.map(
      (account) => ({
        account,
        usage: usageMap[account.id],
      }),
    );

    let selected: Account;
    if (this.strategy === "soonest-reset") {
      selected = this.pickSoonestReset(candidates, now);
    } else if (this.strategy === "strict-priority") {
      // An account whose limits were never read counts as usable: it is tried, not skipped.
      selected =
        eligibleAccounts.find(
          (acc) => (remainingPercent(usageMap[acc.id]) ?? 100) > 5,
        ) ?? eligibleAccounts[0];
    } else {
      const ranked = rankContinuationTargets(candidates, { now });
      selected = ranked[0]?.account ?? eligibleAccounts[0];
    }

    // Update affinity
    if (sessionKey) {
      this.sessionCache.set(sessionKey, selected.id);
    }

    return { account: selected, sessionAffinityHit: false };
  }

  /**
   * Theo's core optimization: Prioritize accounts that expire/reset soonest.
   * Unused quota on an account resetting tomorrow is lost money, while an account
   * with 5 days remaining can wait.
   */
  private pickSoonestReset(
    candidates: ContinuationTargetCandidate[],
    now: number,
  ): Account {
    interface ScoredCandidate {
      candidate: ContinuationTargetCandidate;
      resetTime: number; // ms timestamp
      /** Undefined when no limit was read: such an account ranks after those with known room. */
      remainingPercent: number | undefined;
    }

    const scored: ScoredCandidate[] = candidates.map((cand) => {
      const usage = cand.usage;
      const remaining = remainingPercent(usage);

      // Determine the earliest binding reset
      const resets: number[] = [];
      const parseReset = (iso?: string | null) => {
        if (!iso) return undefined;
        const ms = Date.parse(iso);
        return Number.isFinite(ms) && ms > now ? ms : undefined;
      };

      const r5h = parseReset(usage?.fiveHour?.resetsAt);
      const r7d = parseReset(usage?.sevenDay?.resetsAt);
      if (r5h) resets.push(r5h);
      if (r7d) resets.push(r7d);

      const earliestReset = resets.length > 0 ? Math.min(...resets) : Infinity;

      return {
        candidate: cand,
        resetTime: earliestReset,
        remainingPercent: remaining,
      };
    });

    // Known room first (> 5% left), then accounts whose limits are unknown, then the rest.
    const known = scored.filter((s) => (s.remainingPercent ?? 0) > 5);
    const unknown = scored.filter((s) => s.remainingPercent === undefined);
    const pool = known.length ? known : unknown.length ? unknown : scored;

    // Soonest reset first: unused quota on an account resetting soon is lost, then more room.
    pool.sort((a, b) => {
      if (a.resetTime !== b.resetTime) {
        return a.resetTime - b.resetTime;
      }
      return (b.remainingPercent ?? 0) - (a.remainingPercent ?? 0);
    });

    return pool[0].candidate.account;
  }
}
