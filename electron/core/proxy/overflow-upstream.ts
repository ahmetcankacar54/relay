import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createAnthropicUsageExtractor } from "./anthropic-upstream";
import type { ProxyStats } from "./proxy-stats";
import { buildTargetUrl, errorMessage, forwardUpstream, type UpstreamOutcome } from "./upstream-common";
import {
  overflowModel,
  type ApiUpstream,
  type OverflowRates,
  type OverflowTestResult,
} from "../../../shared/overflow";

/**
 * The client headers an API-key upstream is sent. Nothing else goes: the client's credential,
 * Relay's own headers, and Claude Code's session and hint headers belong to the subscription
 * route, and a third party has no use for them.
 */
const PASSED_HEADERS = ["content-type", "accept", "anthropic-version", "anthropic-beta"] as const;
/** Betas only a subscription's OAuth token carries; an API key is refused with them. */
const SUBSCRIPTION_BETA = /^oauth-/i;
const MAX_TEST_MESSAGE = 200;
const TEST_TIMEOUT_MS = 20_000;

/**
 * The headers for one upstream: the allowed client headers and the key, as the preset sends it.
 * Anthropic's API keeps the client's betas but the OAuth one; a third party gets none, since some
 * refuse a beta they do not know.
 */
export function overflowHeaders(
  source: http.IncomingHttpHeaders,
  upstream: Pick<ApiUpstream, "preset" | "authStyle">,
  key: string,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const name of PASSED_HEADERS) {
    const value = source[name];
    if (value !== undefined && name !== "anthropic-beta") out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  if (upstream.preset === "anthropic") {
    const raw = source["anthropic-beta"];
    const betas = (Array.isArray(raw) ? raw : [raw ?? ""])
      .flatMap((value) => value.split(","))
      .map((beta) => beta.trim())
      .filter((beta) => beta && !SUBSCRIPTION_BETA.test(beta));
    if (betas.length) out["anthropic-beta"] = [...new Set(betas)].join(",");
    if (!out["anthropic-version"]) out["anthropic-version"] = "2023-06-01";
  }
  if (!out["content-type"]) out["content-type"] = "application/json";
  if (upstream.authStyle === "bearer") out.authorization = `Bearer ${key}`;
  else out["x-api-key"] = key;
  return out;
}

/** The request body with the upstream's model in it; the bytes as they came when nothing changes. */
export function overflowBody(body: Buffer, parsed: unknown, model: string): Buffer {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body;
  if ("model" in parsed && parsed.model === model) return body;
  return Buffer.from(JSON.stringify({ ...parsed, model }));
}

/**
 * Sends a Claude Messages request to an API-key upstream and streams its answer back unchanged
 * (SSE included). Usage is read from the answer as for Anthropic's own: every upstream reports it
 * in `message_start` / `message_delta`, the final figures winning.
 */
export function forwardOverflow(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  body: Buffer,
  options: {
    upstream: ApiUpstream;
    key: string;
    /** The model the upstream is asked for (`overflowModel`). */
    model: string;
    /** The request body parsed, when it could be (needed to rewrite its model). */
    parsed: unknown;
    stats?: ProxyStats;
    holdIf?: (statusCode: number) => boolean;
  },
): Promise<UpstreamOutcome> {
  const { upstream } = options;
  return forwardUpstream({
    clientRes,
    method: clientReq.method,
    target: buildTargetUrl(upstream.baseUrl, clientReq.url),
    headers: overflowHeaders(clientReq.headers, upstream, options.key),
    body: overflowBody(body, options.parsed, options.model),
    accountId: `overflow:${upstream.id}`,
    stats: options.stats,
    usage: createAnthropicUsageExtractor(),
    errorLabel: `Overflow (${upstream.label})`,
    holdIf: options.holdIf,
  });
}

/**
 * Asks the upstream for one token of its Haiku-class model: whether the URL, key and model work.
 * The answer names the model and the upstream's own error, never the key.
 */
export async function testOverflowUpstream(
  upstream: ApiUpstream,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OverflowTestResult> {
  const model = overflowModel(upstream, "claude-haiku-5-5");
  let target: URL;
  try {
    target = buildTargetUrl(upstream.baseUrl, "/v1/messages");
  } catch {
    return { ok: false, model, message: "Invalid base URL" };
  }
  try {
    const response = await fetchImpl(target, {
      method: "POST",
      headers: overflowHeaders({}, upstream, key) as Record<string, string>,
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "Hi" }] }),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    if (response.ok) {
      await response.body?.cancel().catch(() => {});
      return { ok: true, model, status: response.status };
    }
    const text = await response.text().catch(() => "");
    const message = (errorMessage(text)?.message ?? text).trim().slice(0, MAX_TEST_MESSAGE);
    return { ok: false, model, status: response.status, ...(message ? { message } : {}) };
  } catch (error) {
    return { ok: false, model, message: String((error as Error)?.message ?? error).slice(0, MAX_TEST_MESSAGE) };
  }
}

const DAY_MS = 86_400_000;
/** After a failed read of OpenRouter's prices, the next try waits this long, not a day. */
const RETRY_MS = 3_600_000;
const OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models";
/** Prices per token, as OpenRouter publishes them, become prices per million. */
const perMillion = (value: unknown) => {
  const number = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number * 1_000_000 : undefined;
};

/** OpenRouter's `/api/v1/models` answer as prices per million tokens, by model id. */
export function parseOpenRouterModels(json: unknown): Map<string, OverflowRates> {
  const out = new Map<string, OverflowRates>();
  const data = json && typeof json === "object" && "data" in json ? json.data : undefined;
  if (!Array.isArray(data)) return out;
  for (const row of data) {
    const id = typeof row?.id === "string" ? row.id : undefined;
    const pricing = row?.pricing;
    const input = perMillion(pricing?.prompt);
    const output = perMillion(pricing?.completion);
    if (!id || input === undefined || output === undefined) continue;
    const cacheRead = perMillion(pricing?.input_cache_read);
    const cacheWrite = perMillion(pricing?.input_cache_write);
    out.set(id, {
      input,
      output,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    });
  }
  return out;
}

/**
 * OpenRouter's published prices, read at most once a day and kept in a file, so its overflow
 * answers have a cost. A failed read leaves the last prices in use and tries again in an hour.
 */
export class OpenRouterPrices {
  private rates = new Map<string, OverflowRates>();
  private fetchedAt = 0;
  private running?: Promise<void>;

  constructor(
    private readonly options: { file?: string; fetch?: typeof fetch; url?: string; now?: () => number } = {},
  ) {
    if (!options.file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(options.file, "utf8"));
      this.rates = parseOpenRouterModels(saved?.models);
      if (typeof saved?.fetchedAt === "number" && Number.isFinite(saved.fetchedAt)) this.fetchedAt = saved.fetchedAt;
    } catch {
      // None kept yet: read on first use.
    }
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }

  /** The price of an OpenRouter model id; read again first when the prices are a day old. */
  async rate(model: string): Promise<OverflowRates | undefined> {
    if (this.now() - this.fetchedAt >= DAY_MS) await this.refresh();
    return this.rates.get(model);
  }

  private refresh(): Promise<void> {
    this.running ??= this.read().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async read(): Promise<void> {
    try {
      const response = await (this.options.fetch ?? fetch)(this.options.url ?? OPENROUTER_MODELS, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      const rates = parseOpenRouterModels(json);
      if (!rates.size) throw new Error("No prices");
      this.rates = rates;
      this.fetchedAt = this.now();
      if (this.options.file) {
        // Only the prices are kept, in OpenRouter's own shape, so the file reads back the same way.
        const models = {
          data: [...rates].map(([id, r]) => ({
            id,
            pricing: {
              prompt: r.input / 1_000_000,
              completion: r.output / 1_000_000,
              ...(r.cacheRead !== undefined ? { input_cache_read: r.cacheRead / 1_000_000 } : {}),
              ...(r.cacheWrite !== undefined ? { input_cache_write: r.cacheWrite / 1_000_000 } : {}),
            },
          })),
        };
        fs.mkdirSync(path.dirname(this.options.file), { recursive: true, mode: 0o700 });
        const temp = `${this.options.file}.tmp`;
        fs.writeFileSync(temp, JSON.stringify({ fetchedAt: this.fetchedAt, models }), { mode: 0o600 });
        fs.renameSync(temp, this.options.file);
      }
    } catch {
      this.fetchedAt = this.now() - DAY_MS + RETRY_MS;
    }
  }
}
