import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { ProxyStats } from "./proxy-stats";

/** The client sent something the gateway must not forward (HTTP 400). */
export class BadRequestError extends Error {}

export interface TokenTally {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Collects token usage out of the parsed events (or the whole JSON body) of one response. */
export interface UsageExtractor {
  onEvent(data: unknown): void;
  result(): TokenTally | undefined;
}

export interface UpstreamOutcome {
  statusCode: number;
  rateLimited: boolean;
  /** The upstream refused the token (401/403). */
  unauthorized: boolean;
  retryAfterSeconds?: number;
}

const LOCAL_ORIGIN = "http://relay.invalid";
/** A response body is only parsed for usage up to this size; SSE is parsed incrementally. */
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_SSE_LINE = 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

const DROP_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
  "host",
  "content-length",
  // The body is read for token counts, so ask for it uncompressed.
  "accept-encoding",
  // The account's token replaces whatever credential the client holds.
  "authorization",
  "x-api-key",
]);

const DROP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * The request target as a path on the gateway. Anything that would resolve to another host
 * (`//host/x`, `/\host`, an absolute URL) is refused, so the account's token can never be
 * sent anywhere but the configured upstream.
 */
export function parseRequestUrl(rawUrl: string | undefined): URL {
  const raw = rawUrl ?? "/";
  if (!raw.startsWith("/")) throw new BadRequestError("Invalid request target");
  let parsed: URL;
  try {
    parsed = new URL(raw, LOCAL_ORIGIN);
  } catch {
    throw new BadRequestError("Invalid request target");
  }
  if (parsed.origin !== LOCAL_ORIGIN)
    throw new BadRequestError("Invalid request target");
  return parsed;
}

/**
 * The upstream URL for a client request: the base's origin and path prefix, then the client's
 * path and query. `stripV1` drops a leading `/v1` when the base has its own path prefix
 * (a client's `/v1/responses` against `https://chatgpt.com/backend-api/codex` is `/responses`).
 */
export function buildTargetUrl(
  base: string,
  rawUrl: string | undefined,
  options: { stripV1?: boolean } = {},
): URL {
  const client = parseRequestUrl(rawUrl);
  const target = new URL(base);
  const basePath = target.pathname.replace(/\/+$/, "");
  let path = client.pathname;
  if (options.stripV1 && basePath) path = path.replace(/^\/v1(?=\/|$)/, "");
  target.pathname = basePath + path;
  target.search = client.search;
  return target;
}

export function sanitizeRequestHeaders(
  source: http.IncomingHttpHeaders,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || DROP_REQUEST_HEADERS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function sanitizeResponseHeaders(
  source: http.IncomingHttpHeaders,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || DROP_RESPONSE_HEADERS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

export function parseRetryAfter(
  value: string | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - now) / 1000));
  return undefined;
}

/** A JSON error body both Anthropic and OpenAI style clients can read. */
export function sendJsonError(
  res: http.ServerResponse,
  status: number,
  type: string,
  message: string,
  headers: http.OutgoingHttpHeaders = {},
): void {
  if (res.headersSent || res.destroyed || res.writableEnded) return;
  const body = JSON.stringify({ type: "error", error: { type, message } });
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

/** Reads usage out of a response as it streams, without keeping the response in memory. */
class UsageTap {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private jsonChunks: Buffer[] = [];
  private jsonBytes = 0;
  private overflow = false;

  constructor(
    private readonly extractor: UsageExtractor,
    private readonly sse: boolean,
  ) {}

  push(chunk: Buffer): void {
    if (this.sse) {
      this.pending += this.decoder.write(chunk);
      this.drain(false);
    } else if (!this.overflow) {
      this.jsonBytes += chunk.length;
      if (this.jsonBytes > MAX_JSON_BYTES) {
        this.overflow = true;
        this.jsonChunks = [];
      } else {
        this.jsonChunks.push(chunk);
      }
    }
  }

  end(): void {
    if (this.sse) {
      this.pending += this.decoder.end();
      this.drain(true);
    } else if (!this.overflow && this.jsonChunks.length > 0) {
      try {
        this.extractor.onEvent(
          JSON.parse(Buffer.concat(this.jsonChunks).toString("utf8")),
        );
      } catch {
        // Not JSON (or cut off): no usage to read.
      }
    }
  }

  private drain(final: boolean): void {
    let index: number;
    while ((index = this.pending.indexOf("\n")) !== -1) {
      const line = this.pending.slice(0, index).replace(/\r$/, "");
      this.pending = this.pending.slice(index + 1);
      this.line(line);
    }
    if (final) {
      if (this.pending) this.line(this.pending);
      this.pending = "";
    } else if (this.pending.length > MAX_SSE_LINE) {
      this.pending = "";
    }
  }

  private line(line: string): void {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      this.extractor.onEvent(JSON.parse(data));
    } catch {
      // Partial or non-JSON event.
    }
  }
}

export interface ForwardSpec {
  clientRes: http.ServerResponse;
  method: string | undefined;
  target: URL;
  /** Already sanitized and carrying the account's credential. */
  headers: http.OutgoingHttpHeaders;
  body: Buffer;
  accountId: string;
  stats?: ProxyStats;
  usage: UsageExtractor;
  errorLabel: string;
  onResponseHeaders?: (headers: http.IncomingHttpHeaders) => void;
  /** Idle time (no bytes either way) after which the upstream call is given up. */
  timeoutMs?: number;
}

/**
 * Sends one buffered request upstream and streams the answer back. Never rejects: a transport
 * failure becomes a 502/504 for the client (or a cut stream when the answer already began).
 * A client that hangs up cancels the upstream call, so no socket outlives its caller.
 */
export function forwardUpstream(spec: ForwardSpec): Promise<UpstreamOutcome> {
  return new Promise((resolve) => {
    const { clientRes, target } = spec;
    const none = { rateLimited: false, unauthorized: false };
    if (clientRes.destroyed || clientRes.writableEnded) {
      resolve({ statusCode: 499, ...none });
      return;
    }

    let settled = false;
    const settle = (outcome: UpstreamOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    const isTls = target.protocol === "https:";
    const headers: http.OutgoingHttpHeaders = {
      ...spec.headers,
      host: target.host,
      "content-length": spec.body.length,
    };
    const upstreamReq = (isTls ? https : http).request({
      protocol: target.protocol,
      hostname: target.hostname.replace(/^\[|\]$/g, ""),
      port: target.port || (isTls ? 443 : 80),
      path: target.pathname + target.search,
      method: spec.method,
      headers,
    });

    let clientGone = false;
    let timedOut = false;
    clientRes.once("close", () => {
      if (clientRes.writableFinished) return;
      clientGone = true;
      upstreamReq.destroy();
      settle({ statusCode: 499, ...none });
    });

    upstreamReq.setTimeout(
      spec.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
      () => {
        timedOut = true;
        upstreamReq.destroy(new Error("upstream timed out"));
      },
    );

    upstreamReq.on("error", (err) => {
      if (!clientGone)
        spec.stats?.recordError(`${spec.errorLabel}: ${err.message}`);
      if (!clientRes.headersSent && !clientRes.destroyed) {
        sendJsonError(
          clientRes,
          timedOut ? 504 : 502,
          "api_error",
          `${spec.errorLabel}: ${err.message}`,
        );
      } else if (!clientRes.writableEnded) {
        // The answer had begun: cut it, so the client sees a failure instead of a clean end.
        clientRes.destroy();
      }
      settle({ statusCode: timedOut ? 504 : 502, ...none });
    });

    upstreamReq.on("response", (upstreamRes) => {
      const statusCode = upstreamRes.statusCode ?? 502;
      const outcome: UpstreamOutcome = {
        statusCode,
        rateLimited: statusCode === 429,
        unauthorized: statusCode === 401 || statusCode === 403,
      };
      if (statusCode === 429) {
        const header = upstreamRes.headers["retry-after"];
        outcome.retryAfterSeconds = parseRetryAfter(
          Array.isArray(header) ? header[0] : header,
        );
      }
      spec.onResponseHeaders?.(upstreamRes.headers);

      if (clientRes.destroyed) {
        upstreamRes.destroy();
        settle(outcome);
        return;
      }

      const contentType = String(upstreamRes.headers["content-type"] ?? "");
      const tap =
        spec.stats && statusCode < 400
          ? new UsageTap(spec.usage, contentType.includes("text/event-stream"))
          : undefined;

      clientRes.writeHead(
        statusCode,
        upstreamRes.statusMessage,
        sanitizeResponseHeaders(upstreamRes.headers),
      );
      if (tap) upstreamRes.on("data", (chunk: Buffer) => tap.push(chunk));

      pipeline(upstreamRes, clientRes, (err) => {
        if (tap && spec.stats) {
          tap.end();
          const tally = spec.usage.result();
          if (tally) spec.stats.recordTokens(spec.accountId, tally);
        }
        if (
          err &&
          (err as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE"
        ) {
          spec.stats?.recordError(`${spec.errorLabel}: ${err.message}`);
        }
        settle(outcome);
      });
    });

    upstreamReq.end(spec.body);
  });
}
