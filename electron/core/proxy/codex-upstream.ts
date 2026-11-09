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

export interface CodexForwardOptions {
  upstreamUrl?: string;
  token: string;
  accountId: string;
  /** The ChatGPT account a Codex sign-in belongs to; its backend expects it with the token. */
  chatgptAccountId?: string;
  stats?: ProxyStats;
  /** Statuses whose answer is held back so the gateway can try another account. */
  holdIf?: (statusCode: number) => boolean;
}

/**
 * OpenAI style usage: the Responses API reports it in `response.completed`
 * (`response.usage.input_tokens`), Chat Completions in the last chunk (`usage.prompt_tokens`).
 * Cached tokens are part of the prompt count there, so they are split out to match how
 * the stats count input and cache reads separately.
 */
export function createCodexUsageExtractor(): UsageExtractor {
  let tally: TokenTally | undefined;
  const count = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  return {
    onEvent(data) {
      const event = data as { response?: { usage?: any }; usage?: any } | null;
      const usage = event?.response?.usage ?? event?.usage;
      if (!usage || typeof usage !== "object") return;
      const total = count(usage.input_tokens) ?? count(usage.prompt_tokens);
      const output =
        count(usage.output_tokens) ?? count(usage.completion_tokens);
      const cached =
        count(usage.input_tokens_details?.cached_tokens) ??
        count(usage.prompt_tokens_details?.cached_tokens) ??
        0;
      if (total === undefined && output === undefined) return;
      tally = {
        input: Math.max(0, (total ?? 0) - cached),
        output: output ?? 0,
        cacheRead: cached,
      };
    },
    result: () => tally,
  };
}

export class CodexUpstream {
  private readonly defaultBaseUrl = "https://chatgpt.com/backend-api/codex";

  async forwardRequest(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    bodyBuffer: Buffer,
    options: CodexForwardOptions,
  ): Promise<UpstreamOutcome> {
    const target = buildTargetUrl(
      options.upstreamUrl ?? this.defaultBaseUrl,
      clientReq.url,
      {
        stripV1: true,
      },
    );
    const headers = sanitizeRequestHeaders(clientReq.headers);
    headers["authorization"] = `Bearer ${options.token}`;
    if (options.chatgptAccountId) headers["chatgpt-account-id"] = options.chatgptAccountId;

    return forwardUpstream({
      clientRes,
      method: clientReq.method,
      target,
      headers,
      body: bodyBuffer,
      accountId: options.accountId,
      stats: options.stats,
      usage: createCodexUsageExtractor(),
      errorLabel: "Codex upstream error",
      holdIf: options.holdIf,
    });
  }
}
