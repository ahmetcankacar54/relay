import { z } from "zod";
import type { Account, AccountUsage, ProxyClientStatus, ProxyStatus } from "./types";
import type {
  ProxyClassShare,
  ProxyConfig,
  ProxyLoopAlarm,
  ProxyMetrics,
  ProxyRequestLog,
  ProxySessionView,
} from "./proxy-types";
import type { LimitCalibration } from "./limit-calibration";
import { responseCost } from "./model-prices";
import { GATEWAY_HOST_ERROR, LOOPBACK_HOSTS, gatewayHostAllowed } from "./proxy-url";
import { OVERFLOW_PRESET_IDS, type OverflowStatus } from "./overflow";

/** The prefix every client key starts with, so a key pasted somewhere is recognised as Relay's. */
export const PROXY_KEY_PREFIX = "relay-sec-";

/** A new client key: 256 random bits, URL-safe (unpadded base64url), behind the `relay-sec-` prefix. */
export function generateProxyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const base64 = btoa(String.fromCharCode(...bytes));
  return `${PROXY_KEY_PREFIX}${base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/**
 * What the Proxy Gateway page may change: where the gateway listens (this computer, or its
 * Tailscale address), its routing strategy and session time.
 */
export const proxyConfigurePatch = z
  .object({
    port: z.number().int().min(1).max(65_535),
    host: z.string().trim().refine(gatewayHostAllowed, GATEWAY_HOST_ERROR),
    routingStrategy: z.enum(["soonest-reset", "balanced", "strict-priority"]),
    affinityTtlSeconds: z.number().int().min(10).max(3_600),
    accountOrder: z.array(z.string().min(1).max(128)).max(200),
    excludedAccountIds: z.array(z.string().min(1).max(128)).max(200),
    subagentOverflow: z.boolean(),
  })
  .strict()
  .partial();
export type ProxyConfigurePatch = z.infer<typeof proxyConfigurePatch>;

/**
 * Where an overflow upstream may be: an https URL, or plain http on this computer only (a local
 * proxy), since its API key travels with every request. No credentials, query or fragment.
 */
export function overflowUrlAllowed(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname.replace(/^\[|\]$/g, ""));
}

const overflowModelId = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._:/~@+[\]-]+$/);
const overflowPrice = z.number().min(0).max(1_000);
/** One API-key upstream as saved; the key is never part of it. */
export const apiUpstreamSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    label: z.string().trim().min(1).max(40),
    preset: z.enum(OVERFLOW_PRESET_IDS),
    baseUrl: z.string().trim().max(300).refine(overflowUrlAllowed, "Use an https:// URL (http:// only on this computer)"),
    authStyle: z.enum(["x-api-key", "bearer"]),
    modelMap: z
      .object({ opus: overflowModelId, sonnet: overflowModelId, haiku: overflowModelId, default: overflowModelId })
      .partial()
      .strict(),
    enabled: z.boolean(),
    order: z.number().int().min(0).max(1_000),
    prices: z.object({ input: overflowPrice, output: overflowPrice }).strict().optional(),
  })
  .strict();
/** The overflow setup as proxy-pool.json keeps it. */
export const overflowSettingsSchema = z
  .object({
    enabled: z.boolean(),
    trigger: z.enum(["limited", "unavailable"]).optional(),
    dailyCapUsd: z.number().min(0.01).max(10_000).optional(),
    upstreams: z.array(apiUpstreamSchema).max(20),
  })
  .strict();
/** What the page may change about overflow as a whole; a null cap removes it. */
export const overflowConfigurePatch = z
  .object({
    enabled: z.boolean(),
    trigger: z.enum(["limited", "unavailable"]),
    dailyCapUsd: z.number().min(0.01).max(10_000).nullable(),
    /** Upstream ids, first tried first. */
    order: z.array(z.string().max(64)).max(20),
  })
  .strict()
  .partial();
/** An upstream added (no id) or changed; a key is needed to add one and replaces the saved one. */
export const overflowUpstreamInput = apiUpstreamSchema
  .omit({ id: true, order: true })
  .extend({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
    key: z.string().trim().min(8).max(512).regex(/^[\x21-\x7e]+$/).optional(),
  })
  .strict();
/** What proxy-pool.json holds: the parts of the gateway's setup the registry does not. */
export const proxyExtrasSchema = z.object({
  accountOrder: z.array(z.string()).max(200).optional(),
  excludedAccountIds: z.array(z.string()).max(200).optional(),
  /** Which default the registry's affinity lifetime was written under (shared/proxy-types.ts). */
  affinityRevision: z.number().int().min(0).max(1_000).optional(),
  subagentOverflow: z.boolean().optional(),
  // A setup this build cannot read is left out, not the whole file: the pool's order stays.
  overflow: overflowSettingsSchema.optional().catch(undefined),
  clientBindings: z
    .object({
      "claude-code": z.record(z.string(), z.string().nullable()).optional(),
      codex: z.record(z.string(), z.string().nullable()).optional(),
      omp: z.record(z.string(), z.string().nullable()).optional(),
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
 * What writing a session's cache again would cost: its prompt at the model's write price (an
 * hour's or five minutes', as it was written), and that as a share of a 5-hour window on the
 * accounts it could move to (the median of their calibrations; its own when no other has one).
 */
export function withMoveCost(
  session: ProxySessionView,
  calibrations: Record<string, LimitCalibration>,
  excluded: ReadonlySet<string> = new Set(),
): ProxySessionView {
  if (!session.model || session.prefixTokens <= 0) return session;
  const hour = session.ttlMs >= 3_600_000;
  const dollars = responseCost(session.model, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: session.prefixTokens,
    ...(hour ? { cacheWrite1h: session.prefixTokens } : {}),
  });
  if (dollars === undefined) return session;
  const others = Object.values(calibrations)
    .filter((c) => c.accountId !== session.accountId && !excluded.has(c.accountId))
    .map((c) => c.dollarsPerPercent)
    .sort((a, b) => a - b);
  const own = calibrations[session.accountId]?.dollarsPerPercent;
  const rate = others.length ? others[Math.floor((others.length - 1) / 2)] : own;
  const rounded = Math.round(dollars * 1000) / 1000;
  return {
    ...session,
    moveCost: {
      dollars: rounded,
      ...(rate && rate > 0 ? { percent: Math.round((dollars / rate) * 100) / 100 } : {}),
    },
  };
}

/** Percents an answer reported this recently count as live. */
const LIVE_MS = 10 * 60_000;

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
  /** What the running gateway learned from its traffic. */
  insights?: {
    sessionViews(): ProxySessionView[];
    alarms(): ProxyLoopAlarm[];
    fullAt(accountId: string): number | undefined;
  };
  classShare?: ProxyClassShare[];
  /** Each account's dollars per percent of its 5-hour window, where Relay could tell. */
  calibrations?: Record<string, LimitCalibration>;
  /** The account a new session would get now, by provider (from the running gateway). */
  nextPick?: ProxyStatus["nextPick"];
  /** Whether the gateway could use an account's sign-in when it last looked. */
  gatewaySignIn?: (accountId: string) => "missing" | "expired" | undefined;
  /** The API-key overflow as the page shows it (keys masked). */
  overflow?: OverflowStatus;
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
        ...(usage?.liveAt && input.now - Date.parse(usage.liveAt) <= LIVE_MS ? { live: true } : {}),
        ...(() => {
          const at = input.running ? input.insights?.fullAt(account.id) : undefined;
          return at && at > input.now ? { fullAt: at } : {};
        })(),
        ...(input.calibrations?.[account.id]
          ? {
              percentCost: {
                dollars: input.calibrations[account.id].dollarsPerPercent,
                windows: input.calibrations[account.id].windows,
              },
            }
          : {}),
        ...(() => {
          const state = input.running && !excluded.has(account.id) ? input.gatewaySignIn?.(account.id) : undefined;
          return state ? { gatewaySignIn: state } : {};
        })(),
      };
    }),
    ...(input.error ? { error: input.error } : {}),
    ...(input.recent ? { recent: input.recent } : {}),
    ...(input.tailscaleAddress ? { tailscaleAddress: input.tailscaleAddress } : {}),
    ...(input.clients ? { clients: input.clients } : {}),
    ...(config.subagentOverflow ? { subagentOverflow: true } : {}),
    ...(input.running && input.insights
      ? (() => {
          const sessions = input.insights
            .sessionViews()
            .map((session) => withMoveCost(session, input.calibrations ?? {}, excluded));
          const alarms = input.insights.alarms();
          return { ...(sessions.length ? { sessions } : {}), ...(alarms.length ? { alarms } : {}) };
        })()
      : {}),
    ...(input.classShare?.length ? { classShare: input.classShare } : {}),
    ...(input.running && input.nextPick && Object.keys(input.nextPick).length ? { nextPick: input.nextPick } : {}),
    ...(input.overflow ? { overflow: input.overflow } : {}),
  };
}
