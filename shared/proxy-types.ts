export type ProxyStatus = "stopped" | "starting" | "running" | "error";

export type RoutingStrategy = "soonest-reset" | "balanced" | "strict-priority";

export interface ProxyConfig {
  enabled: boolean;
  port: number;
  host: string;
  affinityTtlSeconds: number;
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
  affinityTtlSeconds: 300, // 5 minutes matching prompt caching window
  routingStrategy: "soonest-reset",
};
