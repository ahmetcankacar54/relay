/**
 * Anthropic API list prices, to show what Claude Code usage would cost on the
 * API. Hand-maintained: a new model needs a row and a release; until then its
 * tokens are reported as unpriced. Nothing is fetched at runtime.
 */
export const PRICES_CHECKED = "2026-10-22";
export const PRICES_SOURCE =
  "https://platform.claude.com/docs/en/about-claude/pricing";

/** USD per million tokens. */
interface Rates {
  input: number;
  write5m: number;
  write1h: number;
  read: number;
  output: number;
}

interface ModelPrice extends Rates {
  /** Fast mode's input and output; the cache rates scale with input. */
  fast?: { input: number; output: number };
  /** Higher rates for a prompt (input + cache write + cache read) above `above` tokens. */
  longPrompt?: { above: number; rates: Rates };
  /** US-only inference costs 1.1× (Claude 4.6 and later). */
  usGeo: boolean;
}

const rates = (
  input: number,
  write5m: number,
  write1h: number,
  read: number,
  output: number,
): Rates => ({ input, write5m, write1h, read, output });

const FABLE_5_1: ModelPrice = { ...rates(10, 12.5, 20, 0.25, 50), usGeo: true };
const FABLE_5: ModelPrice = { ...rates(10, 12.5, 20, 1, 50), usGeo: true };
const OPUS_5_5: ModelPrice = {
  ...rates(4, 5, 8, 0.2, 20),
  fast: { input: 8, output: 40 },
  usGeo: true,
};
const OPUS_5: ModelPrice = {
  ...rates(5, 6.25, 10, 0.5, 25),
  fast: { input: 10, output: 50 },
  usGeo: true,
};
const OPUS_4_6: ModelPrice = { ...rates(5, 6.25, 10, 0.5, 25), usGeo: true };
const OPUS_4_5: ModelPrice = { ...rates(5, 6.25, 10, 0.5, 25), usGeo: false };
const OPUS_4: ModelPrice = { ...rates(15, 18.75, 30, 1.5, 75), usGeo: false };
const SONNET_5_5: ModelPrice = { ...rates(2, 2.5, 4, 0.1, 10), usGeo: true };
const SONNET_5: ModelPrice = { ...rates(2, 2.5, 4, 0.2, 10), usGeo: true };
const SONNET_4_6: ModelPrice = { ...rates(3, 3.75, 6, 0.3, 15), usGeo: true };
const SONNET_4: ModelPrice = { ...rates(3, 3.75, 6, 0.3, 15), usGeo: false };
const HAIKU_5_5: ModelPrice = {
  ...rates(0.1, 0.125, 0.2, 0.01, 0.5),
  longPrompt: { above: 100_000, rates: rates(0.5, 0.625, 1, 0.05, 2.5) },
  usGeo: true,
};
const HAIKU_4_5: ModelPrice = { ...rates(1, 1.25, 2, 0.1, 5), usGeo: false };
const HAIKU_3_5: ModelPrice = { ...rates(0.8, 1, 1.6, 0.08, 4), usGeo: false };

const PRICES: Record<string, ModelPrice> = {
  "claude-fable-5-1": FABLE_5_1,
  "claude-mythos-5-1": FABLE_5_1,
  "claude-fable-5": FABLE_5,
  "claude-mythos-5": FABLE_5,
  "claude-opus-5-5": OPUS_5_5,
  "claude-opus-5": OPUS_5,
  "claude-opus-4-8": OPUS_5,
  "claude-opus-4-7": OPUS_4_6,
  "claude-opus-4-6": OPUS_4_6,
  "claude-opus-4-5": OPUS_4_5,
  "claude-opus-4-1": OPUS_4,
  "claude-opus-4": OPUS_4,
  "claude-sonnet-5-5": SONNET_5_5,
  "claude-sonnet-5": SONNET_5,
  "claude-sonnet-4-6": SONNET_4_6,
  "claude-sonnet-4-5": SONNET_4,
  "claude-sonnet-4": SONNET_4,
  "claude-haiku-5-5": HAIKU_5_5,
  "claude-haiku-4-5": HAIKU_4_5,
  "claude-3-5-haiku": HAIKU_3_5,
};

/** One response's usage, as its transcript row reports it. */
export interface ResponseUsage {
  input: number;
  output: number;
  /** All cache writes, 5-minute and 1-hour. */
  cacheWrite: number;
  cacheRead: number;
  /** The 1-hour part of `cacheWrite`, when the row splits it; absent means all 5-minute. */
  cacheWrite1h?: number;
  /** `usage.speed`: "fast" is priced at fast mode's rates. */
  speed?: string;
  /** `usage.inference_geo`: "us" costs 1.1×. */
  geo?: string;
}

/** The table's id for a model: a trailing date (`-20251001`) and a `[…]` suffix are dropped. */
export function priceKey(model: string): string | undefined {
  const bare = model
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "")
    .trim();
  return Object.hasOwn(PRICES, bare) ? bare : undefined;
}

function scaled(base: Rates, input: number, output: number): Rates {
  const factor = input / base.input;
  return {
    input,
    write5m: base.write5m * factor,
    write1h: base.write1h * factor,
    read: base.read * factor,
    output,
  };
}

/** What one response would cost on the API, in USD; undefined for a model with no price. */
export function responseCost(
  model: string,
  usage: ResponseUsage,
): number | undefined {
  const key = priceKey(model);
  if (key === undefined) return undefined;
  const price = PRICES[key];
  const prompt = usage.input + usage.cacheWrite + usage.cacheRead;
  let r: Rates =
    price.longPrompt && prompt > price.longPrompt.above
      ? price.longPrompt.rates
      : price;
  if (usage.speed === "fast" && price.fast)
    r = scaled(r, price.fast.input, price.fast.output);
  const write1h = Math.min(usage.cacheWrite1h ?? 0, usage.cacheWrite);
  const write5m = usage.cacheWrite - write1h;
  const cost =
    (usage.input * r.input +
      write5m * r.write5m +
      write1h * r.write1h +
      usage.cacheRead * r.read +
      usage.output * r.output) /
    1_000_000;
  return usage.geo === "us" && price.usGeo ? cost * 1.1 : cost;
}

/**
 * A cost for tokens counted before responses were priced, from a bucket's
 * sums: every cache write as a 1-hour write, which is what current Claude Code
 * writes, and Haiku 5.5 at its lower tier.
 */
export function estimateCost(
  model: string,
  counts: { input: number; output: number; cacheWrite: number; cacheRead: number },
): number | undefined {
  const key = priceKey(model);
  if (key === undefined) return undefined;
  const r = PRICES[key];
  return (
    (counts.input * r.input +
      counts.cacheWrite * r.write1h +
      counts.cacheRead * r.read +
      counts.output * r.output) /
    1_000_000
  );
}
