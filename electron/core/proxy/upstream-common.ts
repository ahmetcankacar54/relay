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
  /** The 1-hour part of `cacheWrite`; the rest was written for 5 minutes. */
  cacheWrite1h?: number;
}

/** Collects token usage out of the parsed events (or the whole JSON body) of one response. */
export interface UsageExtractor {
  onEvent(data: unknown): void;
  result(): TokenTally | undefined;
}

/**
 * What a failed answer says about the account that gave it:
 * - `limit`: a usage window is spent (429).
 * - `extra-usage`: this request needs extra usage the account's plan does not cover (a 429
 *   naming extra usage, e.g. long context); the account still serves other requests.
 * - `auth`: the sign-in was refused (401, or a 403 about the token, the organization or the
 *   account).
 * - `permission`: the account may not use what was asked (a 403 permission error about a
 *   model or a feature); its other requests are fine.
 * - `transient`: an overload or an answer from something in front of the API (an HTML 403
 *   challenge, 503, 529); nothing is wrong with the account itself.
 * - `refused`: a 429 that no rate-limit header calls a spent window, with no Retry-After and a
 *   message not about a limit (Anthropic's bare "Error" for a request that does not come from
 *   Claude Code).
 *   The account is fine, and every other account would answer the same.
 */
export type FailureKind = "limit" | "extra-usage" | "auth" | "permission" | "transient" | "refused";

/** An account's windows as the provider reported them on an answer. */
export interface LiveLimits {
  fiveHour?: { usedPercent: number; resetsAt?: string };
  sevenDay?: { usedPercent: number; resetsAt?: string };
}

export interface UpstreamOutcome {
  statusCode: number;
  rateLimited: boolean;
  /** The upstream refused the token (401/403). */
  unauthorized: boolean;
  /** For an error answer: what it says about the account (see FailureKind). */
  failure?: FailureKind;
  /** An error answer's own message, shortened. */
  errorMessage?: string;
  /** The upstream reported that this answer was billed as extra usage, beyond the plan. */
  extraUsage?: boolean;
  retryAfterSeconds?: number;
  /** When the account's exhausted limit resets (ms), from the provider's rate-limit headers. */
  limitResetsAt?: number;
  /**
   * The answer was held back (`holdIf`) and nothing was sent to the client: the caller may try
   * another account, or must answer the client itself.
   */
  held?: boolean;
  /** The provider's id for this request (Anthropic's `request-id`); Claude Code saves it too. */
  requestId?: string;
  /** The tokens the answer reported. */
  tokens?: TokenTally;
  /** The account's windows as this answer reported them. */
  live?: LiveLimits;
}

const LOCAL_ORIGIN = "http://relay.invalid";
/** An error answer's body is kept up to this size to tell what kind of failure it is. */
const MAX_ERROR_BODY = 64 * 1024;
/** An error message kept for the request log. */
const MAX_ERROR_MESSAGE = 160;
/** What a provider's request id looks like (Anthropic: `req_011C…`). */
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A 403 about the sign-in itself, not about what was asked. */
const AUTH_403 =
  /oauth|token|credential|revoked|organization (?:has been )?disabled|account (?:has been )?(?:disabled|suspended)|only authorized for use with claude code/i;
/** A response body is only parsed for usage up to this size; SSE is parsed incrementally. */
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_SSE_LINE = 1024 * 1024;
/** Until the upstream answers at all: a long prompt can take minutes before its first byte. */
const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * Silence once the answer began. Anthropic streams ping events and Codex gives up after five
 * quiet minutes itself, so a longer wait only holds a dead stream open.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * Opening the connection (TCP and TLS): a healthy one takes well under a second, and the client
 * retries a 504 sooner than it would notice a hung connection.
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 10 * 1000;

/**
 * The upstream connections' own pool. Node's shared agent tries each address of a host for only
 * 250 ms before it drops the attempt and moves to the next one: on a network where IPv4 answers
 * slowly and IPv6 has no route (a VPN), the IPv4 attempt is dropped and the IPv6 one hangs.
 * Two seconds per address keeps the slow IPv4 connection. Idle pooled sockets close after 5 s,
 * as with Node's shared agent.
 */
export const UPSTREAM_AGENT_OPTIONS = {
  keepAlive: true,
  timeout: 5000,
  autoSelectFamilyAttemptTimeout: 2000,
} as const;
const upstreamAgents = {
  http: new http.Agent(UPSTREAM_AGENT_OPTIONS),
  https: new https.Agent(UPSTREAM_AGENT_OPTIONS),
};

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
  // Relay's own headers: the client key and the provider choice never leave the gateway.
  "x-relay-key",
  "x-relay-provider",
  // Set from the selected account when it is a ChatGPT sign-in, never from the client.
  "chatgpt-account-id",
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

/**
 * When an exhausted limit resets, in ms: Anthropic's unified rate-limit headers carry epoch
 * seconds (`anthropic-ratelimit-unified-reset`, or per window). Undefined when none is given.
 */
const UNIFIED = "anthropic-ratelimit-unified-";
/** The longest a reset read from the overall header alone is trusted for when it names a 5-hour window. */
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

export function parseLimitReset(
  headers: http.IncomingHttpHeaders,
  now = Date.now(),
): number | undefined {
  const read = (name: string) => {
    const value = headers[name];
    const raw = Array.isArray(value) ? value[0] : value;
    if (!raw) return undefined;
    const seconds = Number(raw);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw);
    return Number.isFinite(ms) && ms > now ? ms : undefined;
  };
  const rejected = (name: string) => String(headers[name] ?? "") === "rejected";
  // The windows that refused this request, each with its own reset (5h, 7d, 7d_opus, …). The
  // overall reset is the "representative" window's and drifts: after a 5-hour limit it can
  // name the weekly reset and keep the account out for days.
  const windows = Object.keys(headers)
    .map((name) => /^anthropic-ratelimit-unified-(.+)-status$/.exec(name)?.[1])
    .filter((w): w is string => !!w && w !== "overage" && rejected(`${UNIFIED}${w}-status`))
    .map((w) => read(`${UNIFIED}${w}-reset`))
    .filter((ms): ms is number => ms !== undefined);
  if (windows.length) return Math.max(...windows);
  // No window says which: the overall reset, capped at five hours when it names that window.
  if (!rejected(`${UNIFIED}status`)) return undefined;
  const overall = read(`${UNIFIED}reset`);
  if (overall === undefined) return undefined;
  const claim = String(headers[`${UNIFIED}representative-claim`] ?? "");
  return claim === "five_hour" ? Math.min(overall, now + FIVE_HOURS_MS) : overall;
}

/** The `error.message` of a JSON error body, or undefined. */
function errorMessage(body: string | undefined): { type?: string; message?: string } | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body);
    const error = parsed?.error;
    if (!error || typeof error !== "object") return undefined;
    return {
      ...(typeof error.type === "string" ? { type: error.type } : {}),
      ...(typeof error.message === "string" ? { message: error.message } : {}),
    };
  } catch {
    return undefined;
  }
}

/** What an error answer says about the account; undefined for answers that say nothing about it. */
/**
 * A window's percent and reset as an answer reports them: `-5h-utilization` is a fraction
 * (0.28 is 28 %), `-5h-reset` epoch seconds. Undefined when the answer carries neither window.
 */
export function parseLiveLimits(headers: http.IncomingHttpHeaders): LiveLimits | undefined {
  const value = (name: string) => {
    const raw = headers[name];
    return Array.isArray(raw) ? raw[0] : raw;
  };
  const window = (key: "5h" | "7d") => {
    const raw = value(`${UNIFIED}${key}-utilization`);
    const fraction = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
    if (!Number.isFinite(fraction) || fraction < 0) return undefined;
    const reset = Number(value(`${UNIFIED}${key}-reset`));
    return {
      usedPercent: Math.min(100, Math.round(fraction * 1000) / 10),
      ...(Number.isFinite(reset) && reset > 0 ? { resetsAt: new Date(reset * 1000).toISOString() } : {}),
    };
  };
  const fiveHour = window("5h");
  const sevenDay = window("7d");
  if (!fiveHour && !sevenDay) return undefined;
  return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) };
}

/**
 * Whether no rate-limit header of a 429 says a window is spent: neither the overall status nor
 * any window's reads "rejected". A spent plan window always says so; the 429 Anthropic gives a
 * request that does not come from Claude Code carries no rate-limit header at all (seen
 * 2026-11-13). Overage (extra usage) is not a window; it reads "rejected" on ordinary answers of
 * an account without extra usage.
 */
function noWindowSpent(headers: http.IncomingHttpHeaders): boolean {
  if (String(headers[`${UNIFIED}status`] ?? "") === "rejected") return false;
  return !Object.keys(headers).some((name) => {
    const window = /^anthropic-ratelimit-unified-(.+)-status$/.exec(name)?.[1];
    return !!window && window !== "overage" && String(headers[name]) === "rejected";
  });
}

export function classifyFailure(
  statusCode: number,
  headers: http.IncomingHttpHeaders,
  body: string | undefined,
): FailureKind | undefined {
  const error = errorMessage(body);
  if (statusCode === 429) {
    const message = error?.message ?? "";
    if (/extra usage/i.test(message)) return "extra-usage";
    // A burst or concurrency limit names itself or asks for a wait (Retry-After), and a bare
    // 429 may be one: another account may well take the request. Only an answer that does
    // neither, and says something, is a refusal.
    return noWindowSpent(headers) &&
      headers["retry-after"] === undefined &&
      message.trim() !== "" &&
      !/limit|exceed|too many|quota|concurren/i.test(message)
      ? "refused"
      : "limit";
  }
  if (statusCode === 401) return "auth";
  if (statusCode === 403) {
    const json = String(headers["content-type"] ?? "").includes("json") || !!error;
    // Not the API's own answer (a challenge page from a proxy or CDN in front of it).
    if (!json || !error) return "transient";
    if (AUTH_403.test(error.message ?? "") || error.type === "authentication_error") return "auth";
    return error.type === "permission_error" ? "permission" : "auth";
  }
  if (statusCode === 503 || statusCode === 529) return "transient";
  return undefined;
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
  /** Told when the answer's headers arrive, before its body: its status, request id and windows. */
  onAnswer?: (early: Pick<UpstreamOutcome, "statusCode" | "requestId" | "live">) => void;
  /**
   * An answer with this status is not sent to the client: its body is dropped and the outcome
   * says `held`, so the caller can try another account. Only asked before anything was sent.
   */
  holdIf?: (statusCode: number) => boolean;
  /** How long to wait for the upstream to answer at all. */
  firstByteTimeoutMs?: number;
  /** Silence after the answer began, after which the upstream call is given up. */
  idleTimeoutMs?: number;
  /** How long opening a new connection may take. */
  connectTimeoutMs?: number;
  /** The connection pool; the upstream pool when not given (tests pass their own). */
  agent?: http.Agent;
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

    // The gateway's own deadlines. A socket's 'timeout' event is not one: the pool sets a short
    // socket timeout of its own, which also runs while a connection is being opened.
    const timers = new Map<"connect" | "answer", NodeJS.Timeout>();
    const clearDeadline = (name: "connect" | "answer") => {
      clearTimeout(timers.get(name));
      timers.delete(name);
    };
    let settled = false;
    const settle = (outcome: UpstreamOutcome) => {
      clearDeadline("connect");
      clearDeadline("answer");
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
      agent: spec.agent ?? (isTls ? upstreamAgents.https : upstreamAgents.http),
    });

    let clientGone = false;
    let timedOut = false;
    clientRes.once("close", () => {
      if (clientRes.writableFinished) return;
      clientGone = true;
      upstreamReq.destroy();
      settle({ statusCode: 499, ...none });
    });

    const deadline = (name: "connect" | "answer", ms: number, message: string) => {
      clearDeadline(name);
      if (settled) return;
      timers.set(
        name,
        setTimeout(() => {
          timedOut = true;
          upstreamReq.destroy(new Error(message));
        }, ms),
      );
    };
    const firstByteMs = spec.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS;
    const idleMs = spec.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const connectMs = spec.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const duration = (ms: number) =>
      ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
    deadline("answer", firstByteMs, `the upstream did not answer within ${duration(firstByteMs)}`);
    upstreamReq.once("socket", (socket) => {
      // A pooled socket is open already; a new one has to connect (and for TLS, shake hands) first.
      if (!socket.connecting) return;
      deadline("connect", connectMs, `could not connect to the upstream within ${duration(connectMs)}`);
      socket.once(isTls ? "secureConnect" : "connect", () => clearDeadline("connect"));
    });
    // Each chunk of the answer restarts the wait for the next one.
    const stillTalking = () =>
      deadline(
        "answer",
        idleMs,
        `the upstream sent nothing for ${duration(idleMs)} in the middle of its answer`,
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
      clearDeadline("connect");
      stillTalking();
      upstreamRes.on("data", stillTalking);
      const statusCode = upstreamRes.statusCode ?? 502;
      const outcome: UpstreamOutcome = {
        statusCode,
        rateLimited: statusCode === 429,
        unauthorized: statusCode === 401 || statusCode === 403,
      };
      if (String(upstreamRes.headers[`${UNIFIED}overage-in-use`] ?? "") === "true")
        outcome.extraUsage = true;
      if (statusCode === 429) {
        const header = upstreamRes.headers["retry-after"];
        outcome.retryAfterSeconds = parseRetryAfter(
          Array.isArray(header) ? header[0] : header,
        );
        outcome.limitResetsAt = parseLimitReset(upstreamRes.headers);
      }
      const requestId = upstreamRes.headers["request-id"];
      if (typeof requestId === "string" && REQUEST_ID.test(requestId)) outcome.requestId = requestId;
      const live = parseLiveLimits(upstreamRes.headers);
      if (live) outcome.live = live;
      spec.onResponseHeaders?.(upstreamRes.headers);
      // Before the answer streams: Claude Code saves the request id as soon as text arrives.
      spec.onAnswer?.({
        statusCode,
        ...(outcome.requestId ? { requestId: outcome.requestId } : {}),
        ...(live ? { live } : {}),
      });

      // An error answer is small: its start is kept to tell what kind of failure it is.
      const errorChunks: Buffer[] = [];
      let errorBytes = 0;
      if (statusCode >= 400)
        upstreamRes.on("data", (chunk: Buffer) => {
          if (errorBytes >= MAX_ERROR_BODY) return;
          errorChunks.push(chunk.subarray(0, MAX_ERROR_BODY - errorBytes));
          errorBytes += chunk.length;
        });
      const classified = (extra: Partial<UpstreamOutcome> = {}): UpstreamOutcome => {
        if (statusCode < 400) return { ...outcome, ...extra };
        const body = errorChunks.length ? Buffer.concat(errorChunks).toString("utf8") : undefined;
        const failure = classifyFailure(statusCode, upstreamRes.headers, body);
        const message = errorMessage(body)?.message?.trim().slice(0, MAX_ERROR_MESSAGE);
        return {
          ...outcome,
          ...(failure ? { failure } : {}),
          ...(message ? { errorMessage: message } : {}),
          rateLimited: failure === "limit",
          unauthorized: failure === "auth",
          ...extra,
        };
      };

      if (clientRes.destroyed) {
        upstreamRes.destroy();
        settle(classified());
        return;
      }
      if (!clientRes.headersSent && spec.holdIf?.(statusCode)) {
        // Read to the end, so the connection can be reused and the body classified.
        upstreamRes.resume();
        upstreamRes.once("end", () => settle(classified({ held: true })));
        upstreamRes.once("error", () => settle(classified({ held: true })));
        upstreamRes.once("close", () => settle(classified({ held: true })));
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
        let tokens: TokenTally | undefined;
        if (tap && spec.stats) {
          tap.end();
          tokens = spec.usage.result();
          if (tokens) spec.stats.recordTokens(spec.accountId, tokens);
        }
        if (
          err &&
          (err as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE"
        ) {
          spec.stats?.recordError(`${spec.errorLabel}: ${err.message}`);
        }
        settle(classified(tokens ? { tokens } : {}));
      });
    });

    upstreamReq.end(spec.body);
  });
}
