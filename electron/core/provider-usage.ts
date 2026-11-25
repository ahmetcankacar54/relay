import type { AccountUsage, ModelWindow, UsageWindow } from "../../shared/types";
import { UsageError } from "./usage-credentials";
import { networkDetail, retryTime } from "./usage";

/**
 * Usage limits of the providers other than Claude, read through each account's own sign-in and
 * answered in the shape `parseUsage` gives for Claude (`fiveHour`, `sevenDay`, model windows).
 *
 * - Codex (a ChatGPT sign-in): `chatgpt.com/backend-api/wham/usage`, the request the Codex CLI's
 *   `/status` makes. Its primary window is the five-hour one, its secondary the weekly one. An
 *   OpenAI API key has no such limits.
 * - Antigravity: Code Assist's `retrieveUserQuotaSummary`, the call Antigravity 2.x shows its
 *   limits from: a few pools (Gemini; Claude & GPT shared), each with a five-hour and a weekly
 *   window. Accounts it refuses (the free tier) fall back to `fetchAvailableModels`, whose per-model
 *   shares are folded into the same pools. There is no account-wide window, so the headline is the
 *   pool with the most room left; each pool window is a model window.
 */

export type ProviderLimits = Pick<
  AccountUsage,
  "fiveHour" | "sevenDay" | "otherLimitReached" | "modelWindows"
>;

export interface ProviderUsageResult {
  limits: ProviderLimits;
  /** The plan the provider reported, e.g. Codex's `plus`; undefined when it named none. */
  plan?: string;
}

type Json = Record<string, any>;
const HOUR = 3_600;

const percent = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : undefined;

/** A reset time given as unix seconds or an ISO date. */
function resetIso(value: unknown, now: number, afterSeconds?: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0)
    return new Date(value * 1000).toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value)))
    return new Date(value).toISOString();
  if (typeof afterSeconds === "number" && Number.isFinite(afterSeconds) && afterSeconds >= 0)
    return new Date(now + afterSeconds * 1000).toISOString();
  return undefined;
}

function codexWindow(raw: unknown, now: number): (UsageWindow & { seconds?: number }) | undefined {
  if (!raw || typeof raw !== "object") return;
  const w = raw as Json;
  const used = percent(w.used_percent);
  if (used === undefined) return;
  const resetsAt = resetIso(w.reset_at, now, w.reset_after_seconds);
  const seconds =
    typeof w.limit_window_seconds === "number" && Number.isFinite(w.limit_window_seconds)
      ? w.limit_window_seconds
      : undefined;
  return { usedPercent: used, ...(resetsAt ? { resetsAt } : {}), ...(seconds ? { seconds } : {}) };
}

/** The limits in a `wham/usage` answer. */
export function parseCodexUsage(value: unknown, now = Date.now()): ProviderUsageResult {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new UsageError("unsupported", undefined, "codex usage: not an object");
  const root = value as Json;
  const limit = root.rate_limit && typeof root.rate_limit === "object" ? (root.rate_limit as Json) : {};
  const windows = [codexWindow(limit.primary_window, now), codexWindow(limit.secondary_window, now)].filter(
    (w): w is NonNullable<typeof w> => !!w,
  );
  let fiveHour: UsageWindow | undefined;
  let sevenDay: UsageWindow | undefined;
  for (const [index, w] of windows.entries()) {
    const { seconds, ...window } = w;
    // By its length when stated (the five-hour window is 18 000 s, the weekly one 604 800 s),
    // else by its place: primary first.
    const long = seconds !== undefined ? seconds > 24 * HOUR : index === 1;
    if (long) sevenDay ??= window;
    else fiveHour ??= window;
  }
  if (!fiveHour && !sevenDay)
    throw new UsageError("unsupported", undefined, "codex usage: no rate-limit windows");
  // A limit the server calls reached with no full window is one of its other limits.
  const otherLimitReached =
    limit.limit_reached === true && ![fiveHour, sevenDay].some((w) => w && w.usedPercent >= 100);
  const plan = typeof root.plan_type === "string" && /^[a-z0-9_-]{1,32}$/i.test(root.plan_type)
    ? root.plan_type.toLowerCase()
    : undefined;
  return {
    limits: {
      ...(fiveHour ? { fiveHour } : {}),
      ...(sevenDay ? { sevenDay } : {}),
      ...(otherLimitReached ? { otherLimitReached } : {}),
    },
    ...(plan ? { plan } : {}),
  };
}

export interface FetchedResponse {
  status: number;
  retryAfter: string | null;
  body: string;
}

const MAX_BODY = 512 * 1024;

/** One refused or failed answer, as the usage error it means. */
function refusal(status: number, retryAfter: string | null, label: string, now: number): UsageError {
  const detail = `${label} ${status}`;
  if (status === 401 || status === 403) return new UsageError("expired", undefined, detail);
  if (status === 429) return new UsageError("rate-limited", retryTime(retryAfter, now), detail);
  return new UsageError("unavailable", undefined, detail);
}

function json(response: FetchedResponse, label: string, now: number): unknown {
  if (response.status !== 200) throw refusal(response.status, response.retryAfter, label, now);
  if (response.body.length > MAX_BODY) throw new UsageError("unsupported", undefined, `${label} too large`);
  try {
    return JSON.parse(response.body);
  } catch {
    throw new UsageError("unsupported", undefined, `${label} not JSON`);
  }
}

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/** Reads a ChatGPT sign-in's Codex limits. */
export async function readCodexUsage(
  credential: { kind: "api-key" | "chatgpt"; accessToken: string; accountId?: string } | undefined,
  options: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<ProviderUsageResult> {
  if (!credential) throw new UsageError("expired", undefined, "codex: no usable sign-in saved");
  if (credential.kind === "api-key")
    throw new UsageError("unsupported", undefined, "codex: an API key has no plan limits");
  const now = options.now ?? Date.now;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(CODEX_USAGE_URL, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        Accept: "application/json",
        ...(credential.accountId ? { "ChatGPT-Account-Id": credential.accountId } : {}),
        "User-Agent": "codex_cli_rs",
        originator: "codex_cli_rs",
      },
    });
  } catch {
    throw new UsageError("unavailable", undefined, "codex usage: no answer");
  }
  const body = await response.text().catch(() => "");
  return parseCodexUsage(
    json({ status: response.status, retryAfter: response.headers.get("retry-after"), body }, "codex usage", now()),
    now(),
  );
}

/** Models a Code Assist answer lists that are not ones a user picks (tab completion, internal). */
const HIDDEN_MODEL = /^(?:tab_|chat_|rev\d|internal)/i;

const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase();

/** A pool's name as Antigravity shows it: "Gemini Models" → "Gemini", "Claude and GPT models" → "Claude & GPT". */
export function poolName(raw: string): string {
  return raw.trim().replace(/\s+models?$/i, "").replace(/\s+and\s+/gi, " & ").slice(0, 40) || raw.trim().slice(0, 40);
}

/** The pool a model's quota is counted in: Google shares one among the Gemini models, one among Claude and GPT. */
function modelPool(id: string, label: string): string {
  const name = `${id} ${label}`;
  if (/gemini/i.test(name)) return "Gemini";
  if (/claude|gpt/i.test(name)) return "Claude & GPT";
  return label;
}

/**
 * The headline of pool windows: the pool with the most room (judged on its fuller window), as its
 * fuller window. The account still answers while that pool has room.
 */
function poolHeadline(windows: ModelWindow[], now = Date.now()): Pick<ProviderLimits, "fiveHour" | "sevenDay"> {
  const pools = new Map<string, ModelWindow>();
  for (const w of windows) {
    const seen = pools.get(w.label);
    if (!seen || w.usedPercent > seen.usedPercent) pools.set(w.label, w);
  }
  const best = [...pools.values()].sort((a, b) => a.usedPercent - b.usedPercent)[0];
  const headline: UsageWindow = { usedPercent: best.usedPercent, ...(best.resetsAt ? { resetsAt: best.resetsAt } : {}) };
  const weekly =
    best.period === "seven_day" ||
    (!best.period && !!best.resetsAt && Date.parse(best.resetsAt) - now > 24 * HOUR * 1000);
  return weekly ? { sevenDay: headline } : { fiveHour: headline };
}

/** A summary bucket's window: its `window` cadence ("5h", "weekly"), else its id's or name's. */
function bucketPeriod(bucket: Json): ModelWindow["period"] {
  const window = typeof bucket.window === "string" ? bucket.window.trim().toLowerCase() : "";
  if (/^(?:5h|5-hour|five[_ -]?hours?)$/.test(window)) return "five_hour";
  if (/^(?:weekly|week|7d|seven[_ -]?days?)$/.test(window)) return "seven_day";
  const id = typeof bucket.bucketId === "string" ? bucket.bucketId.toLowerCase() : "";
  if (/[-_]5h$/.test(id)) return "five_hour";
  if (/[-_](?:weekly|7d)$/.test(id)) return "seven_day";
  const name = typeof bucket.displayName === "string" ? bucket.displayName.toLowerCase() : "";
  if (/\b5[ -]?(?:h\b|hour)/.test(name)) return "five_hour";
  if (/week/.test(name)) return "seven_day";
  return undefined;
}

/**
 * The limits in a `retrieveUserQuotaSummary` answer: each pool's five-hour and weekly window, in
 * the order Antigravity lists them (Gemini first), five hours before the week. A disabled bucket
 * (a pool the plan lacks, or the five hours while the week is spent) is left out; a bucket without
 * a fraction but with a reset is spent (proto3 drops a zero). Undefined when the answer has no
 * usable bucket, so the caller falls back to the model list.
 */
export function parseAntigravitySummary(value: unknown, now = Date.now()): ProviderUsageResult | undefined {
  const groups = (value as Json | null)?.groups;
  if (!Array.isArray(groups)) return undefined;
  const windows: ModelWindow[] = [];
  const order = (w: ModelWindow) => (w.period === "five_hour" ? 0 : w.period === "seven_day" ? 1 : 2);
  for (const group of groups) {
    if (!group || typeof group !== "object" || !Array.isArray(group.buckets)) continue;
    const pool = typeof group.displayName === "string" && group.displayName.trim() ? poolName(group.displayName) : undefined;
    const own: ModelWindow[] = [];
    for (const bucket of group.buckets as Json[]) {
      if (!bucket || typeof bucket !== "object" || bucket.disabled === true) continue;
      const resetsAt = resetIso(typeof bucket.resetTime === "string" && !bucket.resetTime.trim() ? undefined : bucket.resetTime, now);
      const raw = bucket.remainingFraction ?? bucket.remaining?.remainingFraction;
      const remaining =
        typeof raw === "number" && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : resetsAt ? 0 : undefined;
      if (remaining === undefined) continue;
      const period = bucketPeriod(bucket);
      const name = typeof bucket.displayName === "string" && bucket.displayName.trim() ? bucket.displayName.trim().slice(0, 40) : undefined;
      const label = pool ?? name ?? "Antigravity";
      const id = typeof bucket.bucketId === "string" && slug(bucket.bucketId) ? slug(bucket.bucketId) : `${slug(label)}_${period ?? own.length}`;
      const key = `antigravity_${id}`;
      if (windows.some((w) => w.key === key) || own.some((w) => w.key === key)) continue;
      own.push({
        key,
        label,
        usedPercent: Math.round((1 - remaining) * 1000) / 10,
        ...(resetsAt ? { resetsAt } : {}),
        ...(period ? { period } : {}),
      });
    }
    windows.push(...own.sort((a, b) => order(a) - order(b)));
  }
  if (!windows.length) return undefined;
  return { limits: { ...poolHeadline(windows, now), modelWindows: windows } };
}

/**
 * The limits in a `fetchAvailableModels` answer, the fallback for accounts the summary refuses:
 * each model's share folded into its pool (Gemini; Claude & GPT), the fullest model standing for
 * the pool. Its windows have no known length.
 */
export function parseAntigravityQuota(value: unknown): ProviderUsageResult {
  const models = (value as Json | null)?.models;
  if (!models || typeof models !== "object")
    throw new UsageError("unsupported", undefined, "antigravity quota: no models");
  const entries: Array<Omit<ModelWindow, "key"> & { id: string }> = [];
  const list: [string, Json][] = Array.isArray(models)
    ? models.map((m: Json) => [String(m?.model ?? m?.id ?? m?.name ?? ""), m])
    : Object.entries(models as Record<string, Json>);
  for (const [id, model] of list) {
    if (!id || HIDDEN_MODEL.test(id) || !model || typeof model !== "object") continue;
    const quota = model.quotaInfo ?? model.quota_info;
    if (!quota || typeof quota !== "object") continue;
    const fraction = quota.remainingFraction ?? quota.remaining_fraction;
    const resetsAt = resetIso(quota.resetTime ?? quota.reset_time, Date.now());
    // An exhausted model's answer leaves the fraction out and keeps only its reset time.
    const remaining =
      typeof fraction === "number" && Number.isFinite(fraction)
        ? Math.min(1, Math.max(0, fraction))
        : resetsAt
          ? 0
          : undefined;
    if (remaining === undefined) continue;
    const label =
      typeof model.displayName === "string" && model.displayName.trim()
        ? model.displayName.trim().slice(0, 60)
        : id;
    entries.push({
      id,
      label,
      usedPercent: Math.round((1 - remaining) * 1000) / 10,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  if (!entries.length) throw new UsageError("unsupported", undefined, "antigravity quota: no model quotas");
  // The models of one pool share its quota: one line per pool, its fullest model.
  const byPool = new Map<string, ModelWindow>();
  for (const { id, label, usedPercent, resetsAt } of entries) {
    const pool = modelPool(id, label);
    const seen = byPool.get(pool);
    if (!seen || usedPercent > seen.usedPercent)
      byPool.set(pool, { key: `antigravity_${slug(pool)}`, label: pool, usedPercent, ...(resetsAt ? { resetsAt } : {}) });
  }
  const modelWindows = [...byPool.values()].sort(
    (a, b) => Number(b.label === "Gemini") - Number(a.label === "Gemini") || a.label.localeCompare(b.label),
  );
  // No `otherLimitReached`: a spent pool leaves the others usable, and that flag would call the
  // whole account full. The pool windows show which one is out.
  return { limits: { ...poolHeadline(modelWindows), modelWindows } };
}

/**
 * Antigravity 2.x's quota summary, the daily host first: it is the one the app and agy are metered
 * on, while the prod host can keep a "no window open" five hours (100% left) whatever is used.
 */
export const ANTIGRAVITY_SUMMARY_URLS = [
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
];

/** The summary answers only a 2.x Antigravity client; others are checked for a Code Assist license. */
export const ANTIGRAVITY_SUMMARY_AGENT = "antigravity/2.24.0 Darwin/arm64";

/** Code Assist's hosts, the one CLIProxyAPI uses first. */
export const ANTIGRAVITY_QUOTA_URLS = [
  "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
  "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
];

/** Code Assist's account setup call: it names the Google plan (tier) the sign-in is on. */
export const ANTIGRAVITY_TIER_URLS = [
  "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
  "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
];

/** Google's tier ids, as the short plan Relay stores: Google AI Pro and Ultra, the free tier, … */
const GOOGLE_TIERS: Record<string, string> = {
  "g1-ultra-tier": "ultra",
  "g1-pro-tier": "pro",
  "standard-tier": "standard",
  "free-tier": "free",
  "legacy-tier": "legacy",
};

/**
 * The plan a `loadCodeAssist` answer names: the paid tier when there is one (a Google AI Pro or
 * Ultra subscription), else the current tier. Undefined when it names none Relay can read.
 */
export function parseAntigravityTier(value: unknown): string | undefined {
  const root = value && typeof value === "object" ? (value as Json) : undefined;
  for (const tier of [root?.paidTier, root?.currentTier]) {
    const id = typeof tier?.id === "string" ? tier.id.toLowerCase() : "";
    if (GOOGLE_TIERS[id]) return GOOGLE_TIERS[id];
    if (/^[a-z0-9-]{1,40}$/.test(id)) return id.replace(/-tier$/, "");
  }
  return undefined;
}

/** The Google plan of an Antigravity sign-in, or undefined when it cannot be read now. */
export async function readAntigravityTier(
  call: (request: { url: string; body: string }) => Promise<FetchedResponse>,
  projectId: string | undefined,
): Promise<string | undefined> {
  const body = JSON.stringify({
    ...(projectId ? { cloudaicompanionProject: projectId } : {}),
    metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI", ...(projectId ? { duetProject: projectId } : {}) },
  });
  for (const url of ANTIGRAVITY_TIER_URLS) {
    try {
      const response = await call({ url, body });
      if (response.status !== 200 || response.body.length > MAX_BODY) continue;
      const tier = parseAntigravityTier(JSON.parse(response.body));
      if (tier) return tier;
    } catch {
      // The plan is a label: a failed read leaves the saved one.
    }
  }
  return undefined;
}

/**
 * Why the sidecar gave no answer, for the usage issue log: the bridge's own messages name the step
 * (its local service refused, no saved credential, it did not start) and carry no secret; anything
 * else is described by its kind only (`networkDetail`).
 */
function sidecarDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^(?:Antigravity OAuth service returned \d{3}|No Antigravity credential in the sidecar|CLIProxyAPI [\w /.-]{1,80})$/.test(message)
    ? `no answer: ${message}`
    : networkDetail(error);
}

/**
 * How long one read may go on asking: past it no further address is tried. Each call through the
 * sidecar can wait 20 s or more, and a read holds one of the usage reads' two places meanwhile.
 */
export const ANTIGRAVITY_READ_MS = 60_000;

/**
 * Reads an Antigravity account's model quotas through its CLIProxyAPI sidecar, which holds the
 * Google sign-in and renews it: Relay never handles the token itself.
 */
export async function readAntigravityUsage(
  call: (request: { url: string; body: string; userAgent?: string }) => Promise<FetchedResponse>,
  projectId: string | undefined,
  now: () => number = Date.now,
): Promise<ProviderUsageResult> {
  const body = JSON.stringify(projectId ? { project: projectId } : {});
  const started = now();
  const late = () => now() - started >= ANTIGRAVITY_READ_MS;
  // The pools Antigravity shows. A refused sign-in stops here; anything else (the free tier's 403,
  // an outage, an answer without buckets) moves on, and in the end to the model list.
  for (const url of ANTIGRAVITY_SUMMARY_URLS) {
    if (late()) break;
    let response: FetchedResponse;
    try {
      response = await call({ url, body, userAgent: ANTIGRAVITY_SUMMARY_AGENT });
    } catch {
      continue;
    }
    if (response.status === 401) throw refusal(401, response.retryAfter, "antigravity quota summary", now());
    if (response.status !== 200 || response.body.length > MAX_BODY) continue;
    try {
      const summary = parseAntigravitySummary(JSON.parse(response.body), now());
      if (summary) return summary;
    } catch {
      // Not JSON: the model list may still answer.
    }
  }
  let last: UsageError | undefined;
  for (const url of ANTIGRAVITY_QUOTA_URLS) {
    if (late()) {
      last ??= new UsageError("unavailable", undefined, "antigravity quota: no answer in time");
      break;
    }
    let response: FetchedResponse;
    try {
      response = await call({ url, body });
    } catch (error) {
      last = new UsageError("unavailable", undefined, `antigravity quota: ${sidecarDetail(error)}`);
      continue;
    }
    // A refusal of the sign-in is the same on both hosts; only an outage is worth a second try.
    if (response.status !== 200 && response.status < 500) throw refusal(response.status, response.retryAfter, "antigravity quota", now());
    if (response.status !== 200) {
      last = refusal(response.status, response.retryAfter, "antigravity quota", now());
      continue;
    }
    return parseAntigravityQuota(json(response, "antigravity quota", now()));
  }
  throw last ?? new UsageError("unavailable", undefined, "antigravity quota: no answer");
}
