import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Account, AccountUsage, ProxyStatus } from "../../../shared/types";
import type { ProxyConfig, ProxyMetrics } from "../../../shared/proxy-types";

/** The prefix every client key starts with, so a key pasted somewhere is recognised as Relay's. */
export const PROXY_KEY_PREFIX = "relay-sec-";

/** A new client key: 256 random bits, URL-safe, behind the `relay-sec-` prefix. */
export const generateProxyKey = (): string =>
  `${PROXY_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;

/** What Settings → Proxy may change: where the gateway listens and whether it crosses providers. */
export const proxyConfigurePatch = z
  .object({
    port: z.number().int().min(1).max(65_535),
    host: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((host) => !/[\s/@?#]/.test(host), "Not a host address"),
    allowCrossProviderFallback: z.boolean(),
  })
  .strict()
  .partial();
export type ProxyConfigurePatch = z.infer<typeof proxyConfigurePatch>;

const windowsOf = (usage: AccountUsage | undefined) =>
  [usage?.fiveHour, usage?.sevenDay].filter((w): w is NonNullable<typeof w> => !!w);

/** How full the account's fuller window is, 0–100; undefined while no limit has been read. */
export function quotaPercent(usage: AccountUsage | undefined): number | undefined {
  const windows = windowsOf(usage);
  if (!windows.length) return undefined;
  return Math.round(Math.min(100, Math.max(0, ...windows.map((w) => w.usedPercent))));
}

/** Whole minutes until the soonest window resets; undefined when none says when. */
export function resetInMinutes(usage: AccountUsage | undefined, now: number): number | undefined {
  const times = windowsOf(usage)
    .map((w) => (w.resetsAt ? Date.parse(w.resetsAt) : NaN))
    .filter((at) => Number.isFinite(at) && at > now);
  if (!times.length) return undefined;
  return Math.ceil((Math.min(...times) - now) / 60_000);
}

/**
 * What the Proxy settings page shows. `cacheHitRate` is a percentage (0–100) of the prompt tokens
 * the gateway's answers read from the upstream cache. Without a gateway the counters are zero.
 */
export function buildProxyStatus(input: {
  running: boolean;
  config: ProxyConfig;
  metrics?: ProxyMetrics;
  accounts: readonly Account[];
  usage: Record<string, AccountUsage | undefined>;
  now: number;
  error?: string;
}): ProxyStatus {
  const { config, metrics } = input;
  return {
    running: input.running,
    port: config.port,
    host: config.host,
    ...(config.apiKey ? { clientApiKey: config.apiKey } : {}),
    stats: {
      totalRequests: metrics?.totalRequests ?? 0,
      activeRequests: metrics?.activeRequests ?? 0,
      promptCacheHits: metrics?.promptCacheHits ?? 0,
      cacheHitRate: Math.round((metrics?.cacheHitRatio ?? 0) * 1000) / 10,
    },
    accounts: input.accounts.map((account) => {
      const usage = input.usage[account.id];
      const percent = quotaPercent(usage);
      const reset = resetInMinutes(usage, input.now);
      return {
        id: account.id,
        name: account.name,
        ...(account.auth?.email ? { email: account.auth.email } : {}),
        active: input.running && metrics?.lastAccountId === account.id,
        ...(percent === undefined ? {} : { quotaPercent: percent }),
        ...(reset === undefined ? {} : { resetInMinutes: reset }),
      };
    }),
    allowCrossProviderFallback: config.allowCrossProviderFallback === true,
    ...(input.error ? { error: input.error } : {}),
  };
}
