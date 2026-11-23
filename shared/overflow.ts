import { localDate, wallTime } from "./planning";
import { responseCost } from "./model-prices";

/**
 * Gateway overflow: when every subscription account is at a limit, Claude Messages requests go
 * to an API-key upstream (Anthropic's API, or a third party that speaks the same protocol)
 * instead of failing. API keys are billed per token and allowed for this use, so this is the
 * gateway's one route with no terms risk; a daily spending cap bounds what it costs.
 */

/** Where an upstream's URL, auth header and model names come from. */
export const OVERFLOW_PRESET_IDS = ["anthropic", "openrouter", "deepseek", "kimi", "kimi-cn", "glm", "glm-cn", "custom"] as const;
export type ApiUpstreamPreset = (typeof OVERFLOW_PRESET_IDS)[number];
/** How the key is sent: Anthropic's `x-api-key`, or `Authorization: Bearer`. */
export type ApiUpstreamAuth = "x-api-key" | "bearer";
/** The Claude model families a request is mapped by, and the id used for anything else. */
export type OverflowFamily = "opus" | "sonnet" | "haiku";
export type OverflowModelMap = Partial<Record<OverflowFamily | "default", string>>;

/** USD per million tokens. Cache rates are optional: missing ones are charged at the input rate. */
export interface OverflowRates {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** One API-key upstream; its key is sealed in the vault, never kept here. */
export interface ApiUpstream {
  id: string;
  label: string;
  preset: ApiUpstreamPreset;
  /** The base URL the request's own path (`/v1/messages`) is appended to. */
  baseUrl: string;
  authStyle: ApiUpstreamAuth;
  /** The upstream's model id per Claude family; an empty map sends the requested model as it is. */
  modelMap: OverflowModelMap;
  enabled: boolean;
  /** Upstreams are tried lowest first. */
  order: number;
  /** Prices the user entered, for upstreams Relay has no table for (Kimi, custom). */
  prices?: { input: number; output: number };
}

/**
 * When overflow takes a request: `limited` only when every subscription account is at a limit;
 * `unavailable` also when none can answer for another reason (no usable sign-in, an outage).
 */
export type OverflowTrigger = "limited" | "unavailable";

/** The overflow setup, kept in proxy-pool.json beside the registry. */
export interface OverflowSettings {
  enabled: boolean;
  trigger?: OverflowTrigger;
  /** Today's spend (in the planning time zone) at which overflow stops; none means no cap. */
  dailyCapUsd?: number;
  upstreams: ApiUpstream[];
}

/** The cap a new setup starts with: the page asks for one before overflow is turned on. */
export const DEFAULT_OVERFLOW_CAP_USD = 5;

/** What the gateway page shows: no key, only its masked end. */
export interface OverflowStatus {
  enabled: boolean;
  trigger: OverflowTrigger;
  dailyCapUsd?: number;
  /** Overflow spend today in the planning time zone, from the answers Relay could price. */
  spentTodayUsd: number;
  /** Today's spend reached the cap: overflow answers 429 until the day ends. */
  capReached: boolean;
  upstreams: (ApiUpstream & { keyHint?: string })[];
}

/** What the page may change about overflow as a whole; a null cap removes it. */
export interface OverflowConfigureInput {
  enabled?: boolean;
  trigger?: OverflowTrigger;
  dailyCapUsd?: number | null;
  /** Upstream ids, first tried first. */
  order?: string[];
}

/** An upstream added (no id; a key is needed) or changed (a key given replaces the saved one). */
export type OverflowUpstreamInput = Omit<ApiUpstream, "id" | "order"> & { id?: string; key?: string };

/** A one-token request's outcome from the page's Test button; never holds the key. */
export interface OverflowTestResult {
  ok: boolean;
  /** The model the upstream was asked for. */
  model: string;
  status?: number;
  /** The upstream's own error message, or why it could not be reached, shortened. */
  message?: string;
}

/** Each preset's defaults. Model ids and URLs from the providers' Claude Code guides (2026-11). */
export const OVERFLOW_PRESETS: Record<
  ApiUpstreamPreset,
  { label: string; baseUrl: string; authStyle: ApiUpstreamAuth; modelMap: OverflowModelMap }
> = {
  // The same ids as Claude Code asks for: nothing to rewrite.
  anthropic: { label: "Anthropic API", baseUrl: "https://api.anthropic.com", authStyle: "x-api-key", modelMap: {} },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api",
    authStyle: "bearer",
    modelMap: {
      opus: "anthropic/claude-opus-5.5",
      sonnet: "anthropic/claude-sonnet-5.5",
      haiku: "anthropic/claude-haiku-5.5",
    },
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    authStyle: "x-api-key",
    modelMap: { opus: "deepseek-v4-pro", sonnet: "deepseek-flash", haiku: "deepseek-flash", default: "deepseek-flash" },
  },
  // K2 closes to new users from 2026-10-31 and retires at the end of 2026.
  kimi: {
    label: "Kimi",
    baseUrl: "https://api.moonshot.ai/anthropic",
    authStyle: "bearer",
    modelMap: { opus: "kimi-k3.1-pro", sonnet: "kimi-k3.1-pro", haiku: "kimi-k3", default: "kimi-k3.1-pro" },
  },
  "kimi-cn": {
    label: "Kimi (China)",
    baseUrl: "https://api.moonshot.cn/anthropic",
    authStyle: "bearer",
    modelMap: { opus: "kimi-k3.1-pro", sonnet: "kimi-k3.1-pro", haiku: "kimi-k3", default: "kimi-k3.1-pro" },
  },
  glm: {
    label: "Z.ai GLM",
    baseUrl: "https://api.z.ai/api/anthropic",
    authStyle: "bearer",
    modelMap: { opus: "glm-5.4", sonnet: "glm-5.4", haiku: "glm-5.3-flash", default: "glm-5.4" },
  },
  "glm-cn": {
    label: "Zhipu GLM (China)",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    authStyle: "bearer",
    modelMap: { opus: "glm-5.4", sonnet: "glm-5.4", haiku: "glm-5.3-flash", default: "glm-5.4" },
  },
  custom: { label: "Custom", baseUrl: "", authStyle: "x-api-key", modelMap: {} },
};

/** A model id without the `[1m]`-style suffix Claude Code adds for long context, lowercased. */
const bare = (model: string) => model.replace(/\[[^\]]*\]$/, "").trim().toLowerCase();

/** The Claude family a requested model belongs to, by name. */
export function overflowFamily(model: string): OverflowFamily | undefined {
  const id = bare(model);
  if (id.includes("opus")) return "opus";
  if (id.includes("sonnet")) return "sonnet";
  if (id.includes("haiku")) return "haiku";
  return undefined;
}

/** The model id the upstream is asked for: its family's mapping, else its default, else the request's own. */
export function overflowModel(upstream: Pick<ApiUpstream, "modelMap">, requested: string): string {
  const family = overflowFamily(requested);
  const mapped = (family && upstream.modelMap[family]) || upstream.modelMap.default;
  return mapped?.trim() || bare(requested);
}

/** DeepSeek's off-peak prices; peak hours cost double. */
const DEEPSEEK: Record<string, OverflowRates> = {
  "deepseek-flash": { cacheRead: 0.003, input: 0.15, output: 0.6 },
  "deepseek-v4-pro": { cacheRead: 0.022, input: 0.66, output: 1.98 },
};
/** Z.ai's prices (GLM-5.4 is not on its page yet: enter its price by hand). */
const GLM: Record<string, OverflowRates> = {
  "glm-5.3": { cacheRead: 0.26, input: 1.4, output: 4.4 },
  "glm-5.3-flash": { cacheRead: 0.03, input: 0.15, output: 0.5 },
  "glm-5.3-flashx": { cacheRead: 0.075, input: 0.37, output: 1.25 },
};

/** DeepSeek's peak: 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday. */
export function deepseekPeak(at: number): boolean {
  const date = new Date(at);
  const day = date.getUTCDay();
  const hour = date.getUTCHours();
  return day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}

/** The table price of an upstream model at a time, for presets Relay has a table for. */
export function presetRates(preset: ApiUpstreamPreset, model: string, at: number): OverflowRates | undefined {
  const id = bare(model);
  if (preset === "deepseek") {
    const base = DEEPSEEK[id];
    if (!base || !deepseekPeak(at)) return base;
    return { cacheRead: base.cacheRead! * 2, input: base.input * 2, output: base.output * 2 };
  }
  if (preset === "glm" || preset === "glm-cn") return GLM[id];
  return undefined;
}

export interface OverflowTokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
}

/**
 * What one overflow answer cost, in USD; undefined when no price is known. Anthropic's own keys
 * use its list prices; others the user's prices, then the preset's table, then OpenRouter's
 * published ones (`fetched`). Cache rates a source lacks are charged at its input rate, so the
 * cap is never reached late.
 */
export function overflowCost(
  upstream: Pick<ApiUpstream, "preset" | "prices">,
  model: string,
  tokens: OverflowTokens,
  at: number,
  fetched?: OverflowRates,
): number | undefined {
  const t = {
    input: tokens.input ?? 0,
    output: tokens.output ?? 0,
    cacheRead: tokens.cacheRead ?? 0,
    cacheWrite: tokens.cacheWrite ?? 0,
  };
  if (upstream.preset === "anthropic") {
    const listed = responseCost(model, {
      ...t,
      ...(tokens.cacheWrite1h !== undefined ? { cacheWrite1h: tokens.cacheWrite1h } : {}),
    });
    if (listed !== undefined) return listed;
  }
  const rates: OverflowRates | undefined = upstream.prices ?? presetRates(upstream.preset, model, at) ?? fetched;
  if (!rates) return undefined;
  return (
    (t.input * rates.input +
      t.output * rates.output +
      t.cacheRead * (rates.cacheRead ?? rates.input) +
      t.cacheWrite * (rates.cacheWrite ?? rates.input)) /
    1_000_000
  );
}

/** A masked key for the page: its first characters and last four, never the rest. */
export function keyHint(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "…";
  const head = trimmed.match(/^[a-z]{2,4}-/i)?.[0] ?? "";
  return `${head}…${trimmed.slice(-4)}`;
}

/** When the local day `at` falls on (in `timeZone`) started and ends, in ms. */
export function localDayBounds(at: number, timeZone: string): { start: number; end: number } {
  const today = localDate(at, timeZone);
  const start = wallTime(today, "00:00", timeZone) ?? at - (at % 86_400_000);
  // Noon tomorrow in UTC terms always lands on tomorrow's local date, whatever the offset.
  const tomorrow = localDate(start + 36 * 3_600_000, timeZone);
  const end = wallTime(tomorrow, "00:00", timeZone) ?? start + 86_400_000;
  return { start, end };
}

/** Overflow spend in the local day `now` falls on, from the priced answers' times and costs. */
export function spentToday(costs: readonly { at: number; cost: number }[], now: number, timeZone: string): number {
  const { start, end } = localDayBounds(now, timeZone);
  let sum = 0;
  for (const { at, cost } of costs) if (at >= start && at < end) sum += cost;
  return Math.round(sum * 1e6) / 1e6;
}
