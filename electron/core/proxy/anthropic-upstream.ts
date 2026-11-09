import http from "node:http";
import type { ProxyStats } from "./proxy-stats";
import {
  buildTargetUrl,
  forwardUpstream,
  sanitizeRequestHeaders,
  type TokenTally,
  type UpstreamOutcome,
  type UsageExtractor,
} from "./upstream-common";

export interface ForwardOptions {
  upstreamUrl?: string;
  token: string;
  accountId: string;
  stats?: ProxyStats;
  /** Statuses whose answer is held back so the gateway can try another account. */
  holdIf?: (statusCode: number) => boolean;
}

const OAUTH_BETA = "oauth-2025-04-20";

/**
 * Anthropic reports usage twice in a stream: `message_start` carries the input side and a first
 * output count, `message_delta` the running (cumulative) output count. Every figure replaces
 * the last one, so the answer is the final state, not a sum.
 */
export function createAnthropicUsageExtractor(): UsageExtractor {
  const tally: TokenTally = {};
  let seen = false;
  const take = (key: keyof TokenTally, value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      tally[key] = value;
      seen = true;
    }
  };
  return {
    onEvent(data) {
      const event = data as { message?: { usage?: any }; usage?: any } | null;
      const usage = event?.message?.usage ?? event?.usage;
      if (!usage || typeof usage !== "object") return;
      take("input", usage.input_tokens);
      take("output", usage.output_tokens);
      take("cacheRead", usage.cache_read_input_tokens);
      take("cacheWrite", usage.cache_creation_input_tokens);
    },
    result: () => (seen ? tally : undefined),
  };
}

/** The client's own betas plus the one OAuth tokens need. */
function mergeBetas(existing: string | string[] | undefined): string {
  const betas = new Set<string>();
  for (const value of Array.isArray(existing) ? existing : [existing]) {
    for (const part of (value ?? "").split(",")) {
      if (part.trim()) betas.add(part.trim());
    }
  }
  betas.add(OAUTH_BETA);
  return [...betas].join(",");
}

export class AnthropicUpstream {
  private readonly defaultBaseUrl = "https://api.anthropic.com";

  /**
   * Forwards an incoming HTTP request to Anthropic API, injecting the OAuth bearer token
   * and required beta header. Streams the response back to clientResponse.
   */
  async forwardRequest(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    bodyBuffer: Buffer,
    options: ForwardOptions,
  ): Promise<UpstreamOutcome> {
    const target = buildTargetUrl(
      options.upstreamUrl ?? this.defaultBaseUrl,
      clientReq.url,
    );
    const headers = sanitizeRequestHeaders(clientReq.headers);
    headers["authorization"] = `Bearer ${options.token}`;
    headers["anthropic-beta"] = mergeBetas(clientReq.headers["anthropic-beta"]);
    if (!headers["anthropic-version"])
      headers["anthropic-version"] = "2023-06-01";

    return forwardUpstream({
      clientRes,
      method: clientReq.method,
      target,
      headers,
      body: bodyBuffer,
      accountId: options.accountId,
      stats: options.stats,
      usage: createAnthropicUsageExtractor(),
      errorLabel: "Gateway error",
      holdIf: options.holdIf,
    });
  }
}
