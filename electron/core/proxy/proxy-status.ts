import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Account, AccountUsage, ProxyClientStatus, ProxyStatus } from "../../../shared/types";
import type { ProxyConfig, ProxyMetrics, ProxyRequestLog } from "../../../shared/proxy-types";

/** The prefix every client key starts with, so a key pasted somewhere is recognised as Relay's. */
export const PROXY_KEY_PREFIX = "relay-sec-";

/** A new client key: 256 random bits, URL-safe, behind the `relay-sec-` prefix. */
export const generateProxyKey = (): string =>
  `${PROXY_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;

/** What the Proxy Gateway page may change: where the gateway listens, its routing strategy and session time. */
export const proxyConfigurePatch = z
  .object({
    port: z.number().int().min(1).max(65_535),
    host: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((host) => !/[\s/@?#]/.test(host), "Not a host address"),
    routingStrategy: z.enum(["soonest-reset", "balanced", "strict-priority"]),
    affinityTtlSeconds: z.number().int().min(10).max(3_600),
    accountOrder: z.array(z.string().min(1).max(128)).max(200),
    excludedAccountIds: z.array(z.string().min(1).max(128)).max(200),
  })
  .strict()
  .partial();
export type ProxyConfigurePatch = z.infer<typeof proxyConfigurePatch>;

/** What proxy-pool.json holds: the parts of the gateway's setup the registry does not. */
export const proxyExtrasSchema = z.object({
  accountOrder: z.array(z.string()).max(200).optional(),
  excludedAccountIds: z.array(z.string()).max(200).optional(),
  /** Which default the registry's affinity lifetime was written under (shared/proxy-types.ts). */
  affinityRevision: z.number().int().min(0).max(1_000).optional(),
  clientBindings: z
    .object({
      "claude-code": z.record(z.string(), z.string().nullable()).optional(),
      codex: z.record(z.string(), z.string().nullable()).optional(),
    })
    .optional(),
});
export type ProxyExtras = z.infer<typeof proxyExtrasSchema>;

/**
 * Every account in the pool's order: the saved order first, then the rest as the registry lists
 * them. Ids of removed accounts are ignored.
 */
export function orderedAccounts<A extends Pick<Account, "id">>(
  accounts: readonly A[],
  config: Pick<ProxyConfig, "accountOrder">,
): A[] {
  const rank = new Map((config.accountOrder ?? []).map((id, index) => [id, index]));
  return accounts
    .map((account, index) => ({ account, key: rank.get(account.id) ?? rank.size + index }))
    .sort((a, b) => a.key - b.key)
    .map((entry) => entry.account);
}

/** The accounts the gateway may route to, in the pool's order. */
export function poolAccounts<A extends Pick<Account, "id">>(
  accounts: readonly A[],
  config: Pick<ProxyConfig, "accountOrder" | "excludedAccountIds">,
): A[] {
  const out = new Set(config.excludedAccountIds ?? []);
  return orderedAccounts(accounts, config).filter((account) => !out.has(account.id));
}

const clampPercent = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.min(100, Math.max(0, value)))
    : undefined;

const minutesUntil = (iso: string | null | undefined, now: number) => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) && at > now ? Math.ceil((at - now) / 60_000) : undefined;
};

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
 * What the Proxy Gateway page shows. `cacheHitRate` is a percentage (0–100) of the prompt tokens
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
  recent?: ProxyRequestLog[];
  tailscaleAddress?: string;
  clients?: ProxyClientStatus[];
  /** The gateway's own cooldown of an account, when one is running. */
  cooldownOf?: (accountId: string) => { until: number; reason: "limit" | "auth" | "transient" } | undefined;
}): ProxyStatus {
  const { config, metrics } = input;
  const excluded = new Set(config.excludedAccountIds ?? []);
  return {
    running: input.running,
    port: config.port,
    host: config.host,
    ...(config.apiKey ? { clientApiKey: config.apiKey } : {}),
    routingStrategy: config.routingStrategy,
    affinityTtlSeconds: config.affinityTtlSeconds,
    stats: {
      totalRequests: metrics?.totalRequests ?? 0,
      activeRequests: metrics?.activeRequests ?? 0,
      promptCacheHits: metrics?.promptCacheHits ?? 0,
      cacheHitRate: Math.round((metrics?.cacheHitRatio ?? 0) * 1000) / 10,
    },
    accounts: orderedAccounts(input.accounts, config).map((account) => {
      const usage = input.usage[account.id];
      const percent = quotaPercent(usage);
      const reset = resetInMinutes(usage, input.now);
      const five = clampPercent(usage?.fiveHour?.usedPercent);
      const fiveReset = minutesUntil(usage?.fiveHour?.resetsAt, input.now);
      const week = clampPercent(usage?.sevenDay?.usedPercent);
      const weekReset = minutesUntil(usage?.sevenDay?.resetsAt, input.now);
      const tokens = metrics?.tokensByAccount[account.id];
      const cooldown = input.running ? input.cooldownOf?.(account.id) : undefined;
      const extra = metrics?.extraUsage?.[account.id];
      return {
        id: account.id,
        name: account.name,
        provider: account.provider ?? "claude",
        ...(account.auth?.email ? { email: account.auth.email } : {}),
        active: input.running && metrics?.lastAccountId === account.id,
        signedIn: account.auth?.loggedIn === true,
        ...(percent === undefined ? {} : { quotaPercent: percent }),
        ...(reset === undefined ? {} : { resetInMinutes: reset }),
        ...(five === undefined ? {} : { fiveHourPercent: five }),
        ...(fiveReset === undefined ? {} : { fiveHourResetMinutes: fiveReset }),
        ...(week === undefined ? {} : { weeklyPercent: week }),
        ...(weekReset === undefined ? {} : { weeklyResetMinutes: weekReset }),
        inPool: !excluded.has(account.id),
        requests: metrics?.requestsByAccount[account.id] ?? 0,
        ...(tokens ? { tokens: { ...tokens } } : {}),
        ...(cooldown && cooldown.until > input.now
          ? { waiting: { reason: cooldown.reason, minutes: Math.ceil((cooldown.until - input.now) / 60_000) } }
          : {}),
        ...(extra
          ? { extraUsage: { kind: extra.kind, minutesAgo: Math.max(0, Math.floor((input.now - extra.at) / 60_000)) } }
          : {}),
      };
    }),
    ...(input.error ? { error: input.error } : {}),
    ...(input.recent ? { recent: input.recent } : {}),
    ...(input.tailscaleAddress ? { tailscaleAddress: input.tailscaleAddress } : {}),
    ...(input.clients ? { clients: input.clients } : {}),
  };
}
