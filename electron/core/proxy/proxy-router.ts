import type { Account, AccountUsage, UsageWindow } from "../../../shared/types";
import type { ProxyMoveReason, ProxyPickReason, RoutingStrategy } from "../../../shared/proxy-types";
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

/** What the gateway knows about one request beyond its session. */
export interface PickContext {
  /** The request's model id; a limit scoped to its model (weekly Fable, Opus) applies to it. */
  model?: string;
  /**
   * The first request of a new prompt in a main conversation. Its cache is read whole either
   * way, so this is where a session may move with the least disruption: never mid-turn.
   */
  turnStart?: boolean;
  /** The session's cache has outlived its time: it is written again wherever it goes. */
  cold?: boolean;
}

export interface RouterSelection {
  account: Account;
  sessionAffinityHit: boolean;
  /** Why this account: the session's own, the strategy's pick, or the only one left. */
  reason: ProxyPickReason;
  /** Accounts a new pick left out for being close to a limit. */
  nearlyFull?: string[];
  /** The session's own account, kept out by its sign-in or an outage; the session stays bound. */
  boundWaiting?: string;
  /** The session left its account on purpose, and why. */
  moved?: ProxyMoveReason;
  /** The account the session left. */
  from?: string;
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

const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;

/** The model family of a model id ("claude-fable-5-2" → "fable"), as usage windows name it. */
export function modelFamily(model: string | undefined): string | undefined {
  return /(fable|opus|sonnet|haiku)/.exec(model?.toLowerCase() ?? "")?.[1];
}

/** The account's limit scoped to a model family (weekly Fable, weekly Opus), when it has one. */
export function scopedWindow(
  usage: AccountUsage | undefined,
  family: string | undefined,
): UsageWindow | undefined {
  if (!family) return undefined;
  const windows = (usage?.modelWindows ?? []).filter((window) => window.model === family);
  // The fuller one decides; a weekly and a 5-hour window of one model can both exist.
  return windows.sort((a, b) => b.usedPercent - a.usedPercent)[0];
}

/** How much of the fuller window is left, 0–100; undefined while no limit has been read. */
const remainingPercent = (usage: AccountUsage | undefined, family?: string): number | undefined => {
  const used = [usage?.fiveHour?.usedPercent, usage?.sevenDay?.usedPercent, scopedWindow(usage, family)?.usedPercent].filter(
    (p): p is number => typeof p === "number" && Number.isFinite(p),
  );
  return used.length ? Math.max(0, 100 - Math.max(...used)) : undefined;
};

/**
 * Until when a read limit keeps the account out: a window at 100 % whose reset is still ahead.
 * Sending it a request would only earn another 429 and spend one of the request's tries. With
 * a model family, that model's own limit counts too.
 */
export function fullUntil(usage: AccountUsage | undefined, now: number, family?: string): number {
  let until = 0;
  for (const window of [usage?.fiveHour, usage?.sevenDay, scopedWindow(usage, family)]) {
    if (!window || !(window.usedPercent >= 100) || !window.resetsAt) continue;
    const reset = Date.parse(window.resetsAt);
    if (Number.isFinite(reset) && reset > now) until = Math.max(until, reset);
  }
  return until;
}

/** Past these, an account takes no new session while another has room (better-ccflare's idea). */
export const SOFT_STOP_FIVE_HOUR = 90;
export const SOFT_STOP_WEEK = 98;

/**
 * Whether an account read as ready is close enough to a limit to take no new session. With a
 * model family, that model's own weekly limit counts like the week's.
 */
export function nearlyFull(usage: AccountUsage | undefined, family?: string): boolean {
  if (!usage || usage.status !== "ready") return false;
  return (
    (usage.fiveHour?.usedPercent ?? 0) >= SOFT_STOP_FIVE_HOUR ||
    (usage.sevenDay?.usedPercent ?? 0) >= SOFT_STOP_WEEK ||
    (scopedWindow(usage, family)?.usedPercent ?? 0) >= SOFT_STOP_WEEK
  );
}

/**
 * Accounts whose weeks end within this of each other count as ending together: between them
 * the 5-hour window decides. Weeks that end days apart are what the order is about.
 */
export const DEADLINE_BAND_MS = 6 * HOUR_MS;
/** A busy session moves to an account whose week ends at least this much sooner than its own. */
export const REBALANCE_GAP_MS = 24 * HOUR_MS;
/** A session that moved stays at least this long before it moves again for a better order. */
export const MIN_STAY_MS = 20 * 60_000;
/** Only an account with at least this much of its week left is worth moving a session to. */
export const REBALANCE_MIN_ROOM = 5;
/**
 * A running session leaves its account only past these, higher than the soft stops for new
 * sessions: the account's last few percent go to the sessions already warm on it, and a move
 * still comes before the limit cuts a turn (claudemanager's eject threshold).
 */
export const EJECT_FIVE_HOUR = 95;
export const EJECT_WEEK = 99;
/** An account with this much of its 5-hour window used ranks after accounts with more room. */
export const FIVE_HOUR_LOW_ROOM = 80;
/** Across the pool, at most one session moves for a better order in this long. */
export const REBALANCE_SPACING_MS = 5 * 60_000;

/** One account as the router weighs it for one request. */
interface Standing {
  account: Account;
  usage: AccountUsage | undefined;
  /** When its week (all models) ends; a week not started ends a full week from now. */
  weekEnds: number;
  /** When its running 5-hour window ends; Infinity when none runs. */
  fiveEnds: number;
  /** Left of its fullest window, this request's model's included; undefined when never read. */
  room: number | undefined;
  /** Past a soft stop: takes no new session while another account has room. */
  draining: boolean;
  /** Past the eject threshold: a running session leaves it at the start of its next prompt. */
  ejecting: boolean;
  /** Most of its 5-hour window is used: a new session would soon have to move. */
  fiveLow: boolean;
  /**
   * Another model's own limit is spent here: the account cannot serve that model, so it is the
   * better home for this request, and accounts that still can keep their room for that model.
   */
  specialised: boolean;
}

export class ProxyRouter {
  readonly sessionCache: ProxySessionCache;
  private strategy: RoutingStrategy;
  private readonly now: () => number;
  /** Cooldowns the gateway itself sets after a 429/401/403, by account id. */
  private readonly cooldowns = new Map<string, { until: number; reason: CooldownReason }>();
  /** Cooldowns of one model on one account (`<account>:<family>`): its weekly limit is spent. */
  private readonly modelCooldowns = new Map<string, number>();
  /** When a session last moved for a better order, across the pool. */
  private lastRebalanceAt = -Infinity;

  constructor(options: ProxyRouterOptions = {}) {
    // One clock for both: the cache times moves and lifetimes the router weighs.
    this.sessionCache = options.sessionCache ?? new ProxySessionCache({ now: options.now });
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

  /**
   * Keeps one model off an account for `ms`: its own limit (weekly Fable, Opus) is spent while
   * the account's other models still have room.
   */
  markModelUnavailable(accountId: string, family: string, ms: number): void {
    const key = `${accountId}:${family}`;
    const until = this.now() + Math.max(0, ms);
    if ((this.modelCooldowns.get(key) ?? 0) < until) this.modelCooldowns.set(key, until);
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

  /** Until when one model is kept off an account by the gateway, when it is. */
  modelCooldownOf(accountId: string, family: string | undefined): number | undefined {
    if (!family) return undefined;
    const key = `${accountId}:${family}`;
    const until = this.modelCooldowns.get(key);
    if (until === undefined) return undefined;
    if (until <= this.now()) {
      this.modelCooldowns.delete(key);
      return undefined;
    }
    return until;
  }

  /** Lets the account be picked again at once (a usage dashboard cleared its cooldown). */
  clearCooldown(accountId: string): void {
    this.cooldowns.delete(accountId);
    for (const key of [...this.modelCooldowns.keys()])
      if (key.startsWith(`${accountId}:`)) this.modelCooldowns.delete(key);
  }

  /** Until when an account is out for this request, and why: a cooldown or a used-up window. */
  private blockOf(
    account: Account,
    usage: AccountUsage | undefined,
    now: number,
    family: string | undefined,
  ): { until: number; reason: CooldownReason } {
    const local = this.cooldownOf(account.id);
    const stored = account.cooldownUntil ? Date.parse(account.cooldownUntil) : NaN;
    let block = { until: Number.isFinite(stored) ? stored : 0, reason: "limit" as CooldownReason };
    if (local && local.until > block.until) block = local;
    const model = this.modelCooldownOf(account.id, family) ?? 0;
    if (model > block.until) block = { until: model, reason: "limit" };
    const full = fullUntil(usage, now, family);
    if (full > block.until) block = { until: full, reason: "limit" };
    return block;
  }

  /** How the router sees one account for a request of `family`. */
  private standing(account: Account, usage: AccountUsage | undefined, now: number, family: string | undefined): Standing {
    const at = (window: UsageWindow | undefined) => {
      const ms = window?.resetsAt ? Date.parse(window.resetsAt) : NaN;
      return Number.isFinite(ms) && ms > now ? ms : undefined;
    };
    const ready = usage?.status === "ready";
    const spent = [usage?.fiveHour, usage?.sevenDay, scopedWindow(usage, family)].some(
      (window) => !!window && window.usedPercent >= 100,
    );
    const scoped = scopedWindow(usage, family)?.usedPercent ?? 0;
    return {
      account,
      usage,
      weekEnds: (ready ? at(usage?.sevenDay) : undefined) ?? now + WEEK_MS,
      fiveEnds: (ready ? at(usage?.fiveHour) : undefined) ?? Infinity,
      room: ready ? remainingPercent(usage, family) : undefined,
      draining: nearlyFull(usage, family) || (ready && spent),
      ejecting:
        ready &&
        (spent ||
          (usage?.fiveHour?.usedPercent ?? 0) >= EJECT_FIVE_HOUR ||
          (usage?.sevenDay?.usedPercent ?? 0) >= EJECT_WEEK ||
          scoped >= EJECT_WEEK),
      fiveLow: ready && (usage?.fiveHour?.usedPercent ?? 0) >= FIVE_HOUR_LOW_ROOM,
      specialised:
        ready &&
        (usage?.modelWindows ?? []).some(
          (w) => !!w.model && w.model !== family && w.usedPercent >= 100 && (!w.resetsAt || Date.parse(w.resetsAt) > now),
        ),
    };
  }

  /**
   * The order "soonest reset" means: an account whose week ends first is used first, since
   * what is left of its week is lost at the reset while a later week can wait. Weeks ending
   * within a few hours of each other tie, and then the running 5-hour window that ends first
   * goes first, for the same reason. Accounts never read rank after those with known room, and
   * accounts with almost nothing left after both.
   */
  private bySoonestReset(now: number) {
    // Known room first; an account whose 5-hour window is mostly used after those (a session
    // started there soon has to move and write its cache again); then never read; then nearly
    // empty ones.
    const tier = (s: Standing) => (s.room === undefined ? 2 : s.room <= 5 ? 3 : s.fiveLow ? 1 : 0);
    const band = (s: Standing) => Math.floor((s.weekEnds - now) / DEADLINE_BAND_MS);
    return (a: Standing, b: Standing) =>
      tier(a) - tier(b) ||
      band(a) - band(b) ||
      Number(b.specialised) - Number(a.specialised) ||
      (a.fiveEnds === b.fiveEnds ? 0 : a.fiveEnds < b.fiveEnds ? -1 : 1) ||
      (b.room ?? 0) - (a.room ?? 0);
  }

  /** The strategy's pick among `pool` (never empty). */
  private pick(pool: Standing[], now: number): Standing {
    if (this.strategy === "strict-priority")
      // An account whose limits were never read counts as usable: it is tried, not skipped.
      return pool.find((s) => (s.room ?? 100) > 5) ?? pool[0];
    if (this.strategy === "balanced") {
      const candidates: ContinuationTargetCandidate[] = pool.map((s) => ({ account: s.account, usage: s.usage }));
      const ranked = rankContinuationTargets(candidates, { now });
      const id = ranked[0]?.account.id;
      return pool.find((s) => s.account.id === id) ?? pool[0];
    }
    // Stable: equal accounts keep the pool's order.
    return [...pool].sort(this.bySoonestReset(now))[0];
  }

  /** The pool a new pick chooses from: accounts with room first, then everything eligible. */
  private newPickPool(eligible: Standing[], avoid: string | undefined): { pool: Standing[]; leftOut: string[] } {
    let pool = eligible;
    let leftOut: string[] = [];
    if (this.strategy !== "strict-priority") {
      const roomy = pool.filter((s) => !s.draining);
      if (roomy.length) {
        leftOut = pool.filter((s) => s.draining).map((s) => s.account.id);
        pool = roomy;
      }
    }
    if (avoid) {
      const others = pool.filter((s) => s.account.id !== avoid);
      if (others.length) pool = others;
    }
    return { pool, leftOut };
  }

  /**
   * Whether a session healthy on its account should still leave it for `best`, and why:
   * - its cache went cold: it is written again wherever it goes, so it goes where it is best;
   * - at the start of a prompt, its account is past a soft stop and another has room: moving
   *   now beats a limit in the middle of the turn;
   * - at the start of a prompt (soonest reset), `best`'s week ends a day or more before its
   *   account's and still has room: the session uses the week that would otherwise be lost.
   *   A session that just moved stays a while first, so sessions never swing back and forth.
   */
  private moveReason(
    bound: Standing,
    best: Standing,
    context: PickContext,
    movedAt: number | undefined,
    now: number,
  ): ProxyMoveReason | undefined {
    if (best.account.id === bound.account.id) return undefined;
    if (context.cold) return "cold";
    if (!context.turnStart) return undefined;
    if (bound.ejecting && !best.draining) return "drain";
    if (
      this.strategy === "soonest-reset" &&
      !best.draining &&
      !best.fiveLow &&
      (best.room ?? 0) >= REBALANCE_MIN_ROOM &&
      best.weekEnds + REBALANCE_GAP_MS <= bound.weekEnds &&
      (movedAt === undefined || now - movedAt >= MIN_STAY_MS) &&
      // One at a time across the pool: a herd of sessions moving together would fill the
      // target's 5-hour window at once and move straight back.
      now - this.lastRebalanceAt >= REBALANCE_SPACING_MS
    )
      return "rebalance";
    return undefined;
  }

  /**
   * Selects the account for one request: only the requested provider's accounts are considered
   * (a request never crosses to another provider's protocol), minus those in `exclude` (already
   * tried for this request) and those out for this request's model. A session keeps its account
   * (and its prompt cache) unless `moveReason` says it is worth leaving; otherwise the strategy
   * picks.
   */
  selectAccount(
    sessionKey: string | undefined,
    accounts: readonly Account[],
    usageMap: Record<string, AccountUsage | undefined>,
    targetProvider?: ProxyProvider,
    exclude: ReadonlySet<string> = new Set(),
    /** An account to leave out of a new pick while another can take it (subagent overflow). */
    avoid?: string,
    context: PickContext = {},
  ): RouterSelection {
    const now = this.now();
    const family = modelFamily(context.model);
    const ofProvider = accounts.filter(
      (a) =>
        !exclude.has(a.id) &&
        (!targetProvider || (a.provider ?? "claude") === targetProvider),
    );
    if (ofProvider.length === 0) throw new NoProviderAccountError(targetProvider);

    const blocks = new Map(
      ofProvider.map((acc) => [acc.id, this.blockOf(acc, usageMap[acc.id], now, family)]),
    );
    const eligible = ofProvider
      .filter((acc) => (blocks.get(acc.id)?.until ?? 0) <= now)
      .map((acc) => this.standing(acc, usageMap[acc.id], now, family));
    if (eligible.length === 0) {
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
    const { pool, leftOut } = this.newPickPool(eligible, avoid);
    const best = this.pick(pool, now);

    let moved: ProxyMoveReason | undefined;
    if (sessionKey && boundId) {
      const bound = eligible.find((s) => s.account.id === boundId);
      if (bound) {
        const spent = [bound.usage?.fiveHour, bound.usage?.sevenDay, scopedWindow(bound.usage, family)].some(
          (window) => bound.usage?.status === "ready" && !!window && window.usedPercent >= 100,
        );
        moved = spent && best.account.id !== bound.account.id ? "limit" : this.moveReason(bound, best, context, this.sessionCache.movedAt(sessionKey), now);
        if (!moved) {
          this.sessionCache.get(sessionKey);
          return { account: bound.account, sessionAffinityHit: true, reason: "bound" };
        }
      } else if (!boundWaits) {
        // Its account is out for a limit (the account's, or this model's): it moves on.
        moved = "limit";
      }
    }

    if (moved === "rebalance") this.lastRebalanceAt = now;
    // Update affinity
    if (sessionKey && !boundWaits) this.sessionCache.set(sessionKey, best.account.id);

    const reason: ProxyPickReason =
      pool.length === 1
        ? "only"
        : this.strategy === "strict-priority"
          ? "priority"
          : this.strategy === "soonest-reset"
            ? "soonest-reset"
            : "balanced";
    return {
      account: best.account,
      sessionAffinityHit: false,
      reason,
      ...(leftOut.length ? { nearlyFull: leftOut } : {}),
      ...(boundWaits && boundId ? { boundWaiting: boundId } : {}),
      ...(moved && boundId && boundId !== best.account.id ? { moved, from: boundId } : {}),
    };
  }

  /** The account a new session of `provider` (and `model`) would get now, and why; nothing is bound. */
  preview(
    accounts: readonly Account[],
    usageMap: Record<string, AccountUsage | undefined>,
    provider: ProxyProvider,
    model?: string,
  ): RouterSelection | undefined {
    try {
      return this.selectAccount(undefined, accounts, usageMap, provider, new Set(), undefined, { model });
    } catch {
      return undefined;
    }
  }
}
