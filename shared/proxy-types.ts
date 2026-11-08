export type ProxyStatus = "stopped" | "starting" | "running" | "error";

export type RoutingStrategy = "soonest-reset" | "balanced" | "strict-priority";

export interface ProxyConfig {
  enabled: boolean;
  port: number;
  host: string;
  affinityTtlSeconds: number;
  routingStrategy: RoutingStrategy;
  apiKey?: string;
  allowCrossProviderFallback?: boolean;
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
  lastError?: string;
  lastErrorAt?: number;
}

export interface ProxyState {
  status: ProxyStatus;
  port: number;
  host: string;
  endpointUrl: string;
  tailscaleUrl?: string;
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
