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

/**
 * Why the gateway is keeping an account out for a while:
 * - `limit`: a window is used up (or the account bills extra usage); its sessions move on.
 * - `auth`: its sign-in was refused or cannot be read; its sessions wait for it.
 * - `transient`: an overload or a blocked answer; its sessions wait for it.
 */
export type CooldownReason = "limit" | "auth" | "transient";

/** Every account of the provider is cooling down; `retryAfterSeconds` is when the first is back. */
export class NoEligibleAccountError extends Error {
  constructor(
    readonly retryAfterSeconds?: number,
    /** Every account is out for its sign-in, none for a limit: a renewed sign-in brings it back. */
    readonly signInOnly = false,
  ) {
    super(
      signInOnly
        ? "Relay cannot use the sign-in of any account in its pool for this provider; renew it in Relay"
        : "Every account in Relay's pool for this provider is at its limit or cooling down",
    );
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

/**
 * Until when a read limit keeps the account out: a window at 100 % whose reset is still ahead.
 * Sending it a request would only earn another 429 and spend one of the request's tries.
 */
export function fullUntil(usage: AccountUsage | undefined, now: number): number {
  let until = 0;
  for (const window of [usage?.fiveHour, usage?.sevenDay]) {
    if (!window || !(window.usedPercent >= 100) || !window.resetsAt) continue;
    const reset = Date.parse(window.resetsAt);
    if (Number.isFinite(reset) && reset > now) until = Math.max(until, reset);
  }
  return until;
}

/** Past these, an account takes no new session while another has room (better-ccflare's idea). */
export const SOFT_STOP_FIVE_HOUR = 90;
export const SOFT_STOP_WEEK = 98;

/** Whether an account read as ready is close enough to a limit to take no new session. */
export function nearlyFull(usage: AccountUsage | undefined): boolean {
  if (!usage || usage.status !== "ready") return false;
  return (usage.fiveHour?.usedPercent ?? 0) >= SOFT_STOP_FIVE_HOUR || (usage.sevenDay?.usedPercent ?? 0) >= SOFT_STOP_WEEK;
}

export class ProxyRouter {
  readonly sessionCache: ProxySessionCache;
  private strategy: RoutingStrategy;
  private readonly now: () => number;
  /** Cooldowns the gateway itself sets after a 429/401/403, by account id. */
  private readonly cooldowns = new Map<string, { until: number; reason: CooldownReason }>();

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
  markUnavailable(accountId: string, ms: number, reason: CooldownReason = "limit"): void {
    const until = this.now() + Math.max(0, ms);
    const current = this.cooldowns.get(accountId);
    // The later end wins, with its reason; a limit is never shortened by a brief outage.
    if (!current || current.until <= this.now() || until >= current.until)
      this.cooldowns.set(accountId, { until, reason });
  }

  /** The gateway's own cooldown of an account still running, with its reason. */
  cooldownOf(accountId: string): { until: number; reason: CooldownReason } | undefined {
    const entry = this.cooldowns.get(accountId);
    if (!entry) return undefined;
    if (entry.until <= this.now()) {
      this.cooldowns.delete(accountId);
      return undefined;
    }
    return { ...entry };
  }

  /** Lets the account be picked again at once (a usage dashboard cleared its cooldown). */
  clearCooldown(accountId: string): void {
    this.cooldowns.delete(accountId);
  }

  /** Until when an account is out, and why: its own cooldown, a saved one, or a used-up window. */
  private blockOf(
    account: Account,
    usage: AccountUsage | undefined,
    now: number,
  ): { until: number; reason: CooldownReason } {
    const local = this.cooldownOf(account.id);
    const stored = account.cooldownUntil ? Date.parse(account.cooldownUntil) : NaN;
    let block = { until: Number.isFinite(stored) ? stored : 0, reason: "limit" as CooldownReason };
    if (local && local.until > block.until) block = local;
    const full = fullUntil(usage, now);
    if (full > block.until) block = { until: full, reason: "limit" };
    return block;
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
    /** An account to leave out of a new pick while another can take it (subagent overflow). */
    avoid?: string,
  ): RouterSelection {
    const now = this.now();
    const ofProvider = accounts.filter(
      (a) =>
        !exclude.has(a.id) &&
        (!targetProvider || (a.provider ?? "claude") === targetProvider),
    );
    if (ofProvider.length === 0) throw new NoProviderAccountError(targetProvider);

    const blocks = new Map(
      ofProvider.map((acc) => [acc.id, this.blockOf(acc, usageMap[acc.id], now)]),
    );
    const eligibleAccounts = ofProvider.filter(
      (acc) => (blocks.get(acc.id)?.until ?? 0) <= now,
    );
    if (eligibleAccounts.length === 0) {
      const all = [...blocks.values()];
      const soonest = Math.min(...all.map((b) => b.until));
      throw new NoEligibleAccountError(
        Math.max(1, Math.ceil((soonest - now) / 1000)),
        all.every((b) => b.reason === "auth"),
      );
    }

    // The account the session is on, while a sign-in problem or an outage keeps it out: the
    // request is served elsewhere, but the session stays bound and returns to its warm cache.
    const boundId = sessionKey ? this.sessionCache.peek(sessionKey) : undefined;
    const boundWaits = !!boundId && (this.cooldownOf(boundId)?.reason ?? "limit") !== "limit";

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

    // 2. Select best candidate based on strategy. A new session starts on an account still well
    // short of its limits when one is: one started near the limit soon has to move, and moving
    // writes its whole cache again elsewhere. Strict priority keeps its own order.
    let pool = eligibleAccounts;
    if (this.strategy !== "strict-priority") {
      const roomy = pool.filter((acc) => !nearlyFull(usageMap[acc.id]));
      if (roomy.length) pool = roomy;
    }
    if (avoid) {
      const others = pool.filter((acc) => acc.id !== avoid);
      if (others.length) pool = others;
    }
    const candidates: ContinuationTargetCandidate[] = pool.map(
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
        pool.find(
          (acc) => (remainingPercent(usageMap[acc.id]) ?? 100) > 5,
        ) ?? pool[0];
    } else {
      const ranked = rankContinuationTargets(candidates, { now });
      selected = ranked[0]?.account ?? pool[0];
    }

    // Update affinity
    if (sessionKey && !boundWaits) {
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
