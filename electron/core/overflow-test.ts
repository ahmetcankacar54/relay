/**
 * The Proxy page's Test button for an overflow upstream. The gateway itself (relay __gateway)
 * forwards overflow requests; this is the one request the app sends on its own.
 */
import type http from "node:http";
import {
  overflowModel,
  type ApiUpstream,
  type OverflowTestResult,
} from "../../shared/overflow";

/**
 * The client headers an API-key upstream is sent. Nothing else goes: the client's credential,
 * Relay's own headers, and Claude Code's session and hint headers belong to the subscription
 * route, and a third party has no use for them.
 */
const PASSED_HEADERS = [
  "content-type",
  "accept",
  "anthropic-version",
  "anthropic-beta",
] as const;
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
    if (value !== undefined && name !== "anthropic-beta")
      out[name] = Array.isArray(value) ? value.join(", ") : value;
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

/** The upstream's Messages URL: the base's origin and path prefix, then `/v1/messages`. */
function messagesUrl(base: string): URL {
  const target = new URL(base);
  target.pathname = `${target.pathname.replace(/\/+$/, "")}/v1/messages`;
  target.search = "";
  return target;
}

/** An Anthropic-shaped error answer's own message. */
function errorMessage(body: string): string | undefined {
  try {
    const message = JSON.parse(body)?.error?.message;
    return typeof message === "string" ? message : undefined;
  } catch {
    return undefined;
  }
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
    target = messagesUrl(upstream.baseUrl);
  } catch {
    return { ok: false, model, message: "Invalid base URL" };
  }
  try {
    const response = await fetchImpl(target, {
      method: "POST",
      headers: overflowHeaders({}, upstream, key) as Record<string, string>,
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "Hi" }],
      }),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    if (response.ok) {
      await response.body?.cancel().catch(() => {});
      return { ok: true, model, status: response.status };
    }
    const text = await response.text().catch(() => "");
    const message = (errorMessage(text) ?? text)
      .trim()
      .slice(0, MAX_TEST_MESSAGE);
    return {
      ok: false,
      model,
      status: response.status,
      ...(message ? { message } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      model,
      message: String((error as Error)?.message ?? error).slice(
        0,
        MAX_TEST_MESSAGE,
      ),
    };
  }
}
