import type { Account, AccountUsage } from "../../../shared/types";
import type { RoutingStrategy } from "../../../shared/proxy-types";
import {
  rankContinuationTargets,
  type ContinuationTargetCandidate,
} from "../../../shared/continuation-target-ranking";
import { ProxySessionCache } from "./proxy-session-cache";

export interface ProxyRouterOptions {
  strategy?: RoutingStrategy;
  sessionCache?: ProxySessionCache;
  now?: () => number;
  allowCrossProviderFallback?: boolean;
}

export interface RouterSelection {
  account: Account;
  sessionAffinityHit: boolean;
  reason: string;
  requiresTranslation?: boolean;
}

/** Every account is cooling down (or none exists); `retryAfterSeconds` is when the first is back. */
export class NoEligibleAccountError extends Error {
  constructor(readonly retryAfterSeconds?: number) {
    super("No eligible accounts available (all in cooldown or empty)");
  }
}

const remainingPercent = (usage: AccountUsage | undefined): number =>
  Math.max(
    0,
    100 -
      Math.max(
        usage?.fiveHour?.usedPercent ?? 0,
        usage?.sevenDay?.usedPercent ?? 0,
      ),
  );

export class ProxyRouter {
  readonly sessionCache: ProxySessionCache;
  readonly allowCrossProviderFallback: boolean;
  private strategy: RoutingStrategy;
  private readonly now: () => number;
  /** Cooldowns the gateway itself sets after a 429/401/403, by account id (ms timestamp). */
  private readonly cooldowns = new Map<string, number>();

  constructor(options: ProxyRouterOptions = {}) {
    this.sessionCache = options.sessionCache ?? new ProxySessionCache();
    this.strategy = options.strategy ?? "soonest-reset";
    this.now = options.now ?? Date.now;
    this.allowCrossProviderFallback =
      options.allowCrossProviderFallback ?? false;
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
   * Selects the most appropriate account for this request.
   * First checks session affinity: if pinned account is still healthy, keeps it (preserving KV cache).
   * Otherwise selects the best candidate according to strategy (e.g. soonest-reset).
   * If targetProvider is given and all its accounts are exhausted, falls back to another eligible provider only when allowed.
   */
  selectAccount(
    sessionKey: string | undefined,
    accounts: readonly Account[],
    usageMap: Record<string, AccountUsage | undefined>,
    targetProvider?: "claude" | "codex" | "gemini",
  ): RouterSelection {
    const now = this.now();

    // Filter accounts not in cooldown
    const ends = new Map(
      accounts.map((acc) => [acc.id, this.cooldownEnd(acc, now)]),
    );
    const allEligible = accounts.filter(
      (acc) => (ends.get(acc.id) ?? 0) <= now,
    );

    if (allEligible.length === 0) {
      const soonest = Math.min(...ends.values());
      throw new NoEligibleAccountError(
        Number.isFinite(soonest)
          ? Math.max(1, Math.ceil((soonest - now) / 1000))
          : undefined,
      );
    }

    const providerOf = (a: Account) => a.provider ?? "claude";
    const matchesProvider = (a: Account) =>
      !targetProvider || !a.provider || a.provider === targetProvider;
    let eligibleAccounts = allEligible.filter(matchesProvider);

    let requiresTranslation = false;
    // Cross-provider fallback: only if explicitly allowed, preventing unexpected stream format mismatches
    if (eligibleAccounts.length === 0 && targetProvider) {
      if (this.allowCrossProviderFallback) {
        eligibleAccounts = allEligible;
        requiresTranslation = true;
      } else {
        throw new NoEligibleAccountError(undefined);
      }
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
            return {
              account: candidate,
              sessionAffinityHit: true,
              reason: `Preserved session affinity for ${sessionKey}`,
              requiresTranslation: targetProvider
                ? providerOf(candidate) !== targetProvider
                : false,
            };
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
    let reason: string;

    if (this.strategy === "soonest-reset") {
      selected = this.pickSoonestReset(candidates, now);
      reason = requiresTranslation
        ? `Fallback across providers to ${providerOf(selected)} account with soonest reset`
        : "Prioritized account with soonest quota reset (token burn optimization)";
    } else if (this.strategy === "strict-priority") {
      selected =
        eligibleAccounts.find(
          (acc) => remainingPercent(usageMap[acc.id]) > 5,
        ) ?? eligibleAccounts[0];
      reason =
        "Prioritized the first account in registry order with quota left";
    } else {
      const ranked = rankContinuationTargets(candidates, { now });
      selected = ranked[0]?.account ?? eligibleAccounts[0];
      reason = "Prioritized account with highest available quota capacity";
    }

    // Update affinity
    if (sessionKey) {
      this.sessionCache.set(sessionKey, selected.id);
    }

    return {
      account: selected,
      sessionAffinityHit: false,
      reason,
      requiresTranslation: targetProvider
        ? providerOf(selected) !== targetProvider
        : false,
    };
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
      remainingPercent: number;
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

    // Filter to candidates with usable quota (> 5%)
    const usable = scored.filter((s) => s.remainingPercent > 5);
    const pool = usable.length > 0 ? usable : scored;

    // Sort:
    // 1. Soonest resetTime (ascending, so earlier expiration comes first)
    // 2. Higher remaining percent if reset times are close
    pool.sort((a, b) => {
      if (a.resetTime !== b.resetTime) {
        return a.resetTime - b.resetTime;
      }
      return b.remainingPercent - a.remainingPercent;
    });

    return pool[0].candidate.account;
  }
}
