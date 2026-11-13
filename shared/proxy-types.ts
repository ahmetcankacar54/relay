export type ProxyStatus = "stopped" | "starting" | "running" | "error";

export type RoutingStrategy = "soonest-reset" | "balanced" | "strict-priority";

export interface ProxyConfig {
  enabled: boolean;
  port: number;
  host: string;
  /**
   * How long an idle session stays on its account. The prompt cache belongs to the account, and
   * Claude Code on a subscription keeps a conversation's cache for an hour after its last
   * request: a session that moves earlier pays to write its whole history again.
   */
  affinityTtlSeconds: number;
  /** Which default the saved lifetime was written under; kept beside the registry (proxy-pool.json). */
  affinityRevision?: number;
  routingStrategy: RoutingStrategy;
  apiKey?: string;
  /** Account ids in the order the pool uses them (strict priority reads it; the page lists by it). */
  accountOrder?: string[];
  /** Accounts left out of the pool: the gateway never routes to them. */
  excludedAccountIds?: string[];
  /**
   * A session's fresh subagents go to one account other than the session's: they start a prompt
   * of their own, so the move costs no cache, and the session's account lasts longer. Off unless
   * chosen.
   */
  subagentOverflow?: boolean;
  /**
   * The values a bound client's settings held before Relay pointed it at the gateway, by client,
   * so unbinding puts them back. `null` means the key was not there.
   */
  clientBindings?: Partial<Record<ProxyClientId, Record<string, string | null>>>;
}

/** The clients Relay can point at the gateway by writing their settings. */
export type ProxyClientId = "claude-code" | "codex";

/** One request the gateway answered (or passed on), newest first in the status. */
export interface ProxyRequestLog {
  at: number;
  accountId?: string;
  provider?: string;
  model?: string;
  status: number;
  /** The account answered with a limit or refusal and the request went on to the next one. */
  failover?: boolean;
  /** The session stayed on its account (prompt cache kept). */
  affinity?: boolean;
  /** Present for answers the gateway gave itself (no account could take it). */
  note?: string;
  /** How long this try took, in milliseconds. */
  ms?: number;
  /** The provider's id for the request (Anthropic's `request-id`); Claude Code saves it too. */
  requestId?: string;
  /** Who sent it: "claude-code", "codex", or the product its user agent names. */
  client?: string;
  /** Claude Code's own label for the request: main, subagent, compaction, auxiliary, … */
  requestClass?: string;
  /** The tokens the answer reported; `cacheWrite1h` is the 1-hour part of `cacheWrite`. */
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number };
  /** What the answer would cost on the API, in USD, when its model has a price. */
  cost?: number;
  /** An error answer's own message, shortened. */
  error?: string;
  /** The session's prompt cache was written again: why, and about how many tokens. */
  miss?: { reason: CacheMissReason; tokens: number };
  /** Why the gateway gave the request this account. */
  pick?: ProxyPick;
}

/**
 * How the gateway chose an account: the session's own (`bound`), or for a new pick the routing
 * strategy's choice, or the one account left (`only`).
 */
export type ProxyPickReason = "bound" | "soonest-reset" | "balanced" | "priority" | "only";

/** Why a request went to its account. */
export interface ProxyPick {
  reason: ProxyPickReason;
  /** Accounts left out of a new pick for being close to a limit. */
  nearlyFull?: string[];
  /** Accounts skipped because their sign-in could not be read. */
  noSignIn?: string[];
  /** The account the previous try was held on (a limit or an outage). */
  after?: string;
  /** A fresh subagent kept off its session's account (subagent overflow). */
  overflow?: boolean;
  /** The session's own account, waiting on its sign-in or an outage: the session stays bound to it. */
  boundWaiting?: string;
}

/** Why a session's cached prompt was written again instead of read. */
export type CacheMissReason = "account" | "model" | "expired" | "unknown";

/** A session through the gateway, as its prompt cache stands. */
export interface ProxySessionView {
  /** The first characters of Claude Code's session id. */
  id: string;
  accountId: string;
  model?: string;
  lastAt: number;
  /** The cached prompt's size at the last request, in tokens. */
  prefixTokens: number;
  /** How long the cache lives after the last request: an hour or five minutes. */
  ttlMs: number;
  requests: number;
  subagents: number;
  misses: number;
  lastMiss?: { at: number; reason: CacheMissReason; tokens: number };
  /**
   * What writing its cache again would cost, in API-price dollars, and as a share of a 5-hour
   * window on the other accounts, when Relay has calibrated them.
   */
  moveCost?: { dollars: number; percent?: number };
}

/** One prompt that made far more requests or subagents than a prompt usually does. */
export interface ProxyLoopAlarm {
  /** The first characters of Claude Code's prompt id. */
  id: string;
  sessionId?: string;
  accountId?: string;
  since: number;
  lastAt: number;
  requests: number;
  subagents: number;
}

/** One request class's share of today's gateway traffic. */
export interface ProxyClassShare {
  requestClass: string;
  requests: number;
  tokens: number;
  /** API-price cost in USD, for the classes whose models have a price. */
  cost: number;
}

export interface ProxySessionState {
  sessionKey: string;
  accountId: string;
  assignedAt: number;
  lastActiveAt: number;
  requestCount: number;
}

export interface AccountTokenMetrics {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ProxyMetrics {
  totalRequests: number;
  activeSessions: number;
  requestsByAccount: Record<string, number>;
  tokensByAccount: Record<string, AccountTokenMetrics>;
  cacheHitRatio: number;
  /** Requests being answered right now. */
  activeRequests?: number;
  /** Requests whose answer read part of the prompt from the cache. */
  promptCacheHits?: number;
  /** The account the latest request went to. */
  lastAccountId?: string;
  /** Per account: the latest answer billed as extra usage, or a request that needed it. */
  extraUsage?: Record<string, { at: number; kind: "billed" | "required" }>;
  lastError?: string;
  lastErrorAt?: number;
}

export interface ProxyState {
  status: ProxyStatus;
  port: number;
  host: string;
  endpointUrl: string;
  activeSessionsCount: number;
  uptimeSeconds: number;
  error?: string;
}

export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  enabled: false,
  port: 8317,
  host: "127.0.0.1",
  // The lifetime of Claude Code's cache on a subscription; OpenAI's default is 30 minutes.
  affinityTtlSeconds: 3_600,
  routingStrategy: "soonest-reset",
};

/** The lifetime Relay saved by default up to 0.20.0: the API's five-minute cache, not Claude Code's hour. */
export const LEGACY_AFFINITY_TTL_SECONDS = 300;
/** The revision of the default: a saved lifetime written under an older one may be the old default. */
export const AFFINITY_REVISION = 1;
/**
 * A saved lifetime that equals the old default was never chosen: it moves to the new one, once.
 * A lifetime saved under the current revision is the user's and stays, five minutes included.
 */
export function currentAffinityTtl(saved: number | undefined, revision: number | undefined): number | undefined {
  if (saved === undefined || (revision ?? 0) >= AFFINITY_REVISION) return saved;
  return saved === LEGACY_AFFINITY_TTL_SECONDS ? DEFAULT_PROXY_CONFIG.affinityTtlSeconds : saved;
}
