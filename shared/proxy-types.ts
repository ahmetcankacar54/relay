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
  /** The tokens the answer reported. */
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  /** An error answer's own message, shortened. */
  error?: string;
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
