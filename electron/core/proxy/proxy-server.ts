import http from "node:http";
import { HUB_PREFIX, hubManagement } from "./hub-management";
import net from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Account, AccountUsage } from "../../../shared/types";
import {
  DEFAULT_PROXY_CONFIG,
  type ProxyConfig,
  type ProxyLoopAlarm,
  type ProxyMetrics,
  type ProxyState,
} from "../../../shared/proxy-types";
import {
  NoEligibleAccountError,
  NoProviderAccountError,
  ProxyRouter,
  type CooldownReason,
  type ProxyProvider,
  type RouterSelection,
} from "./proxy-router";
import { ProxySessionCache } from "./proxy-session-cache";
import { ProxyStats, type RequestLogSink } from "./proxy-stats";
import { GatewayInsights } from "./proxy-insights";
import { responseCost } from "../../../shared/model-prices";
import { AnthropicUpstream } from "./anthropic-upstream";
import { CodexUpstream } from "./codex-upstream";
import { WebSocketBridge, rejectUpgrade } from "./websocket-bridge";
import {
  BadRequestError,
  parseRequestUrl,
  sendJsonError,
  type ForwardSpec,
  type LiveLimits,
  type UpstreamOutcome,
} from "./upstream-common";

export type CredentialResolver = (
  account: Account,
) => Promise<string | undefined>;
export type AntigravityResolver = (account: Account) => Promise<{ url: string; key: string } | undefined>;
export type UsageProvider = () => {
  accounts: Account[];
  usageMap: Record<string, AccountUsage | undefined>;
};

/**
 * Who sent a request, from its user agent: "claude-code" for Claude Code itself, "agent-sdk" for
 * an app built on the Claude Agent SDK (T3 Code, for one), "codex", or the product it names.
 */
export function clientOf(headers: http.IncomingHttpHeaders): string | undefined {
  const agent = String(headers["user-agent"] ?? "");
  const claude = /^claude-cli\/\S+(?:\s+\(([^)]*)\))?/i.exec(agent);
  if (claude) return /\bsdk-(?:ts|py)\b/i.test(claude[1] ?? "") ? "agent-sdk" : "claude-code";
  if (/codex/i.test(agent)) return "codex";
  return /^([A-Za-z][\w.-]{0,39})\//.exec(agent)?.[1]?.toLowerCase();
}

/** Claude Code's label for a request (`CLAUDE_CODE_GATEWAY_HINT_HEADERS`): main, subagent, … */
function requestClassOf(headers: http.IncomingHttpHeaders): string | undefined {
  const value = headers["x-claude-code-request-class"];
  const text = Array.isArray(value) ? value[0] : value;
  return text && /^[a-z][a-z_-]{0,29}$/i.test(text) ? text.toLowerCase() : undefined;
}

/** The largest request body the gateway buffers: Anthropic itself caps requests at 32 MB. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** A body is only parsed (session key, model) up to this size. */
const MAX_PARSE_BYTES = 16 * 1024 * 1024;
/** Requests answered at once; the gateway runs in Relay's main process and buffers each body. */
const MAX_CONCURRENT_REQUESTS = 64;
/** Accounts tried for one request: the first and up to two others after a limit or sign-in failure. */
const MAX_ATTEMPTS = 3;
const STOP_GRACE_MS = 3_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_S = 60;
const MIN_COOLDOWN_S = 5;
/** A full weekly window: the longest an exhausted account can have to wait. */
const MAX_COOLDOWN_S = 7 * 24 * 60 * 60;
const AUTH_FAILURE_COOLDOWN_S = 30;
const OVERLOADED_COOLDOWN_S = 10;
/** An account that billed extra usage, when no read limit says when its window resets. */
const EXTRA_USAGE_COOLDOWN_S = 30 * 60;
/** Answers another account may succeed at: a limit, a refused sign-in, an overloaded upstream. */
const RETRYABLE = new Set([401, 403, 429, 503, 529]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const CODEX_WS_URL = "wss://chatgpt.com/backend-api/codex/responses";

const urlHost = (host: string) =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

export class ProxyServer {
  private server?: http.Server;
  private config: ProxyConfig;
  private startedAt?: number;
  private statusState: ProxyState["status"] = "stopped";
  private lastError?: string;
  private starting?: Promise<ProxyState>;
  private readonly upstreams: {
    anthropicUrl?: string;
    codexUrl?: string;
    openaiUrl?: string;
    codexWebSocketUrl?: string;
  };
  private readonly activeSockets = new Set<net.Socket>();

  readonly sessionCache: ProxySessionCache;
  readonly router: ProxyRouter;
  readonly stats: ProxyStats;
  /** Sessions' caches, prompts' counts and accounts' pace, from the traffic. */
  readonly insights: GatewayInsights;
  readonly anthropicUpstream: AnthropicUpstream;
  readonly codexUpstream: CodexUpstream;
  readonly wsBridge: WebSocketBridge;

  private credentialResolver: CredentialResolver;
  private antigravityResolver?: AntigravityResolver;
  private usageProvider: UsageProvider;
  private onCredentialRejected?: (accountId: string) => void;
  private onCredentialMissing?: (accountId: string) => void;
  private onLiveLimits?: (accountId: string, live: LiveLimits) => void;
  private onLoopAlarm?: (alarm: ProxyLoopAlarm) => void;
  private requestLog?: RequestLogSink & { bind(requestId: string, accountId: string): void };
  private hubFetch?: typeof fetch;

  constructor(options: {
    config?: Partial<ProxyConfig>;
    credentialResolver: CredentialResolver;
    antigravityResolver?: AntigravityResolver;
    usageProvider: UsageProvider;
    /** The upstream refused the account's token: a cached copy must be dropped. */
    onCredentialRejected?: (accountId: string) => void;
    /** No usable token could be read (none saved, or expired): the host may renew it. */
    onCredentialMissing?: (accountId: string) => void;
    /** An answer reported the account's windows (Anthropic's rate-limit headers). */
    onLiveLimits?: (accountId: string, live: LiveLimits) => void;
    /** Keeps the request feed across restarts and knows which account served a request id. */
    requestLog?: RequestLogSink & { bind(requestId: string, accountId: string): void };
    /** A prompt went past a loop bound (requests or subagents); told once per prompt. */
    onLoopAlarm?: (alarm: ProxyLoopAlarm) => void;
    now?: () => number;
    /** Sends the usage dashboards' provider requests (tests replace it). */
    hubFetch?: typeof fetch;
    /** Where requests go instead of the real services (tests, regional endpoints). */
    upstreams?: {
      anthropicUrl?: string;
      codexUrl?: string;
      openaiUrl?: string;
      codexWebSocketUrl?: string;
    };
  }) {
    this.upstreams = options.upstreams ?? {};
    this.config = { ...DEFAULT_PROXY_CONFIG, ...options.config };
    this.credentialResolver = options.credentialResolver;
    this.antigravityResolver = options.antigravityResolver;
    this.usageProvider = options.usageProvider;
    this.onCredentialRejected = options.onCredentialRejected;
    this.onCredentialMissing = options.onCredentialMissing;
    this.onLiveLimits = options.onLiveLimits;
    this.onLoopAlarm = options.onLoopAlarm;
    this.requestLog = options.requestLog;
    this.hubFetch = options.hubFetch;

    this.sessionCache = new ProxySessionCache({
      ttlSeconds: this.config.affinityTtlSeconds,
      now: options.now,
    });
    this.router = new ProxyRouter({
      strategy: this.config.routingStrategy,
      sessionCache: this.sessionCache,
      now: options.now,
    });
    this.stats = new ProxyStats(options.requestLog);
    this.insights = new GatewayInsights(options.now);
    this.anthropicUpstream = new AnthropicUpstream();
    this.codexUpstream = new CodexUpstream();
    this.wsBridge = new WebSocketBridge();
  }

  async start(): Promise<ProxyState> {
    if (this.server) return this.getState();
    if (this.starting) return this.starting;

    this.statusState = "starting";
    const server = http.createServer((req, res) => {
      this.stats.requestStarted();
      this.handleHttpRequest(req, res)
        .catch((err: any) => this.fail(res, err))
        .finally(() => this.stats.requestEnded());
    });

    server.on("connection", (socket) => {
      this.activeSockets.add(socket);
      socket.once("close", () => this.activeSockets.delete(socket));
    });

    server.on("upgrade", (req, socket, head) => {
      this.handleWebSocketUpgrade(req, socket as net.Socket, head);
    });
    // After start an 'error' event with no listener would crash the host process.
    server.on("error", (err) => {
      this.lastError = err.message;
      this.stats.recordError(err.message);
    });

    this.starting = new Promise<ProxyState>((resolve, reject) => {
      const onStartError = (err: Error) => {
        this.statusState = "error";
        this.lastError = err.message;
        server.close();
        reject(err);
      };
      server.once("error", onStartError);
      server.listen(this.config.port, this.config.host, () => {
        server.off("error", onStartError);
        const address = server.address();
        if (address && typeof address === "object")
          this.config.port = address.port;
        this.server = server;
        this.startedAt = Date.now();
        this.statusState = "running";
        this.lastError = undefined;
        resolve(this.getState());
      });
    }).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    this.startedAt = undefined;
    this.statusState = "stopped";
    this.wsBridge.closeAll();

    for (const socket of this.activeSockets) {
      try {
        socket.destroy();
      } catch {}
    }
    this.activeSockets.clear();

    await new Promise<void>((resolve) => {
      // Streams in flight get a moment to finish; whatever is left is cut so stop() returns.
      const force = setTimeout(
        () => server.closeAllConnections(),
        STOP_GRACE_MS,
      );
      force.unref();
      server.close(() => {
        clearTimeout(force);
        resolve();
      });
      server.closeIdleConnections();
    });
  }

  getState(): ProxyState {
    const uptime = this.startedAt
      ? Math.floor((Date.now() - this.startedAt) / 1000)
      : 0;
    return {
      status: this.statusState,
      port: this.config.port,
      host: this.config.host,
      endpointUrl: `http://${urlHost(this.config.host)}:${this.config.port}`,
      activeSessionsCount: this.sessionCache.count(),
      uptimeSeconds: uptime,
      error: this.lastError,
    };
  }

  getMetrics(): ProxyMetrics {
    return this.stats.getMetrics(this.sessionCache.count());
  }

  updateConfig(patch: Partial<ProxyConfig>): void {
    this.config = { ...this.config, ...patch };
    if (patch.routingStrategy) {
      this.router.setStrategy(patch.routingStrategy);
    }
    if (patch.affinityTtlSeconds !== undefined) {
      this.sessionCache.setTtl(patch.affinityTtlSeconds);
    }
  }

  private fail(res: http.ServerResponse, err: any): void {
    const message = err?.message ?? "Internal proxy error";
    this.stats.recordError(message);
    if (res.headersSent) {
      if (!res.writableEnded) res.destroy();
      return;
    }
    sendJsonError(res, 500, "api_error", message);
  }

  /** Buffers the request body; undefined when the client left, timed out, or the body was too large. */
  private readBody(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<Buffer | undefined> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;

      const finish = (body: Buffer | undefined) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(body);
      };

      const timer = setTimeout(() => {
        sendJsonError(res, 408, "request_timeout", "Request body timed out", {
          connection: "close",
        });
        res.once("finish", () => req.destroy());
        finish(undefined);
      }, 30_000);
      timer.unref();

      req.on("data", (chunk: Buffer) => {
        if (done) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          chunks.length = 0;
          sendJsonError(
            res,
            413,
            "request_too_large",
            "Request body is too large",
            {
              connection: "close",
            },
          );
          res.once("finish", () => req.destroy());
          finish(undefined);
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => finish(Buffer.concat(chunks)));
      req.on("error", () => finish(undefined));
      // A client that leaves mid-body closes without 'end'.
      req.on("close", () => finish(undefined));
    });
  }

  private async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let pathname: string;
    try {
      pathname = parseRequestUrl(req.url).pathname;
    } catch {
      sendJsonError(
        res,
        400,
        "invalid_request_error",
        "Invalid request target",
        {
          connection: "close",
        },
      );
      return;
    }

    if (!this.hostAllowed(req.headers.host)) {
      sendJsonError(res, 403, "forbidden", "Unexpected Host header", {
        connection: "close",
      });
      return;
    }

    // Claude Code checks it can reach its API here before it starts; Anthropic answers it
    // without a key, and so does the gateway.
    if ((req.method === "GET" || req.method === "HEAD") && pathname === "/api/hello") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify({ message: "hello" }));
      return;
    }

    // Liveness only: it says nothing about the accounts, so it needs no key.
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      pathname === "/health"
    ) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        req.method === "HEAD"
          ? undefined
          : JSON.stringify({ ok: true, status: this.statusState }),
      );
      return;
    }

    const denied = this.authFailure(req.headers);
    if (denied) {
      sendJsonError(res, denied.status, denied.type, denied.message, {
        connection: "close",
      });
      return;
    }

    if (
      (req.method === "GET" || req.method === "HEAD") &&
      pathname === "/status"
    ) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        req.method === "HEAD"
          ? undefined
          : JSON.stringify({
              ok: true,
              state: this.getState(),
              metrics: this.getMetrics(),
            }),
      );
      return;
    }

    // CLIProxyAPI's management calls, as usage dashboards (T3 Code's hubs) make them.
    if (pathname.startsWith(HUB_PREFIX)) {
      let body: unknown;
      if (req.method === "POST") {
        const raw = await this.readBody(req, res);
        if (!raw) return;
        try {
          body = raw.length ? JSON.parse(raw.toString("utf8")) : undefined;
        } catch {
          sendJsonError(res, 400, "invalid_request_error", "The body is not JSON");
          return;
        }
      }
      const answer = await hubManagement(req.method ?? "GET", pathname, body, {
        accounts: () => this.usageProvider().accounts,
        credential: (account) => this.credentialResolver(account),
        clearCooldown: (id) => this.router.clearCooldown(id),
        ...(this.hubFetch ? { fetch: this.hubFetch } : {}),
      });
      if (!answer) {
        sendJsonError(res, 404, "not_found", `Management call '${pathname}' is not supported by Relay`);
        return;
      }
      res.writeHead(answer.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer.body));
      return;
    }

    const ALLOWED_PATHS = new Set([
      "/v1/messages",
      "/v1/responses",
      "/responses",
      "/v1/chat/completions",
      "/chat/completions",
      "/v1/models",
    ]);
    if (!ALLOWED_PATHS.has(pathname)) {
      sendJsonError(
        res,
        404,
        "not_found",
        `Path '${pathname}' not supported by Relay proxy`,
        { connection: "close" },
      );
      return;
    }

    if (this.inFlight >= MAX_CONCURRENT_REQUESTS) {
      sendJsonError(res, 503, "overloaded_error", "Relay is answering too many requests at once", {
        "retry-after": "1",
      });
      return;
    }
    this.inFlight += 1;
    try {
      await this.proxyRequest(req, res, pathname);
    } finally {
      this.inFlight -= 1;
    }
  }

  private inFlight = 0;

  /**
   * On a loopback bind, only loopback Host names are answered: a web page that rebinds its own
   * domain to 127.0.0.1 then cannot reach the gateway. A wider bind needs the client key anyway.
   */
  private hostAllowed(hostHeader: string | undefined): boolean {
    if (!LOOPBACK_HOSTS.has(this.config.host)) return true;
    if (!hostHeader) return true;
    let name: string;
    try {
      name = new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, "");
    } catch {
      return false;
    }
    return LOOPBACK_HOSTS.has(name) || /^127\./.test(name);
  }

  /**
   * Why a client may not use the gateway, or undefined when it may. With a client key, any of
   * `Authorization: Bearer`, `x-relay-key` or `x-api-key` may carry it (compared in constant
   * time). Without one, only a loopback bind is served.
   */
  private authFailure(
    headers: http.IncomingHttpHeaders,
  ): { status: number; type: string; message: string } | undefined {
    const key = this.config.apiKey;
    if (!key) {
      return LOOPBACK_HOSTS.has(this.config.host)
        ? undefined
        : {
            status: 403,
            type: "forbidden",
            message: "Network-exposed proxy requires apiKey to be configured",
          };
    }
    const expected = Buffer.from(key);
    const offered = [
      headers["authorization"],
      headers["x-relay-key"],
      headers["x-api-key"],
    ]
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .filter((value): value is string => typeof value === "string")
      .map((value) => Buffer.from(value.replace(/^Bearer\s+/i, "").trim()));
    const matches = offered.some(
      (candidate) =>
        candidate.length === expected.length &&
        timingSafeEqual(candidate, expected),
    );
    return matches
      ? undefined
      : {
          status: 401,
          type: "authentication_error",
          message: "Invalid or missing proxy authorization",
        };
  }

  private async proxyRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<void> {
    const bodyBuffer = await this.readBody(req, res);
    if (!bodyBuffer) return;

    const isOpenAiRoute =
      pathname.startsWith("/v1/responses") ||
      pathname.startsWith("/responses") ||
      pathname.startsWith("/v1/chat/completions") ||
      pathname.startsWith("/chat/completions") ||
      pathname === "/v1/models";

    // Parsed once, for the session key and the model.
    let parsed: any;
    if (bodyBuffer.length > 0 && bodyBuffer.length <= MAX_PARSE_BYTES) {
      try {
        parsed = JSON.parse(bodyBuffer.toString("utf8"));
      } catch {
        // Not JSON: forwarded as it is.
      }
    }
    const sessionKey = this.extractSessionKey(req, parsed);
    const requestedModel =
      typeof parsed?.model === "string" ? parsed.model.toLowerCase() : "";
    // Who asked, and Claude Code's label for the request, for the request log.
    const client = clientOf(req.headers);
    const requestClass = requestClassOf(req.headers);
    const about = { ...(client ? { client } : {}), ...(requestClass ? { requestClass } : {}) };
    // Claude Code's hints (CLAUDE_CODE_GATEWAY_HINT_HEADERS): which subagent, which prompt.
    const hint = (name: string) => {
      const value = req.headers[name];
      const text = Array.isArray(value) ? value[0] : value;
      return text && /^[\w.:-]{1,80}$/.test(text) ? text : undefined;
    };
    const agentId = hint("x-claude-code-agent-id");
    const agentType = hint("x-claude-code-agent-type")?.toLowerCase();
    const promptId = hint("x-claude-code-prompt-id");
    const compacted =
      requestClass === "compaction" || /^(1|true)$/i.test(String(req.headers["x-claude-code-context-compacted"] ?? ""));
    const alarm = this.insights.countPrompt(promptId, { sessionKey, agentId });
    if (alarm) this.onLoopAlarm?.(alarm);
    // A fresh subagent starts a prompt of its own, so another account costs it no cache: with
    // overflow on, a session's fresh subagents go to one account other than the session's, and
    // stay there. A fork shares the conversation's prompt and stays with it.
    const overflow =
      this.config.subagentOverflow === true && !!sessionKey && !!agentId && requestClass === "subagent" && agentType !== "fork";
    const routeKey = overflow ? `${sessionKey}:sub` : sessionKey;
    const avoid = overflow ? this.sessionCache.peek(sessionKey!) : undefined;
    const headerProvider = String(
      req.headers["x-relay-provider"] ?? "",
    ).toLowerCase();

    let targetProvider: ProxyProvider = isOpenAiRoute ? "codex" : "claude";
    if (
      headerProvider === "antigravity" ||
      headerProvider === "gemini" ||
      requestedModel.startsWith("antigravity") ||
      requestedModel.startsWith("gemini")
    ) {
      targetProvider = "antigravity";
    }

    if (pathname === "/v1/models" && targetProvider !== "antigravity") {
      sendJsonError(res, 501, "unsupported_endpoint", "Choose the Antigravity provider to list its models");
      return;
    }

    const tried = new Set<string>();
    let lastHeld: number | undefined;
    // Set when an account was skipped because its sign-in cannot serve this route.
    let unsupported: string | undefined;
    // Accounts whose sign-in could not be read: skipped without spending one of the tries.
    const unreadable: string[] = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; ) {
      const { accounts, usageMap } = this.usageProvider();
      let selection: RouterSelection;
      try {
        selection = this.router.selectAccount(
          routeKey,
          accounts,
          usageMap,
          targetProvider,
          tried,
          avoid,
        );
      } catch (err) {
        if (!(err instanceof NoProviderAccountError || err instanceof NoEligibleAccountError)) throw err;
        if (err instanceof NoProviderAccountError && unsupported && lastHeld === undefined) {
          sendJsonError(res, 501, "unsupported_endpoint", unsupported);
          return;
        }
        // Nothing was forwarded and the only accounts left could not be signed in with.
        if (lastHeld === undefined && unreadable.length) {
          this.signInNeeded(res, targetProvider, requestedModel, unreadable, about);
          return;
        }
        if (err instanceof NoProviderAccountError && tried.size === 0) {
          this.stats.recordLog({ at: Date.now(), provider: targetProvider, model: requestedModel, status: 503, note: "no-account", ...about });
          sendJsonError(res, 503, "api_error", err.message);
          return;
        }
        if (err instanceof NoEligibleAccountError && tried.size === 0) {
          if (err.signInOnly) {
            this.signInNeeded(res, targetProvider, requestedModel, [], about);
            return;
          }
          this.stats.recordError(err.message);
          this.stats.recordLog({ at: Date.now(), provider: targetProvider, model: requestedModel, status: 429, note: "all-limited", ...about });
          sendJsonError(
            res,
            429,
            "rate_limit_error",
            err.message,
            err.retryAfterSeconds
              ? { "retry-after": String(err.retryAfterSeconds) }
              : {},
          );
          return;
        }
        // Every other account was tried or is cooling down: the last answer was already held.
        this.stats.recordLog({ at: Date.now(), provider: targetProvider, model: requestedModel, status: lastHeld ?? 429, note: "all-limited", ...about });
        sendJsonError(res, lastHeld ?? 429, lastHeld === 401 || lastHeld === 403 ? "authentication_error" : "rate_limit_error", "Every account for this provider is limited or unavailable");
        return;
      }
      tried.add(selection.account.id);
      if (!this.servesRoute(selection.account, pathname)) {
        unsupported = "Codex ChatGPT sign-ins support the Responses API only; add an OpenAI API key account for this endpoint";
        continue;
      }
      const route = await this.resolveRoute(selection.account);
      if (!route) {
        unreadable.push(selection.account.name);
        this.stats.recordError(`No usable sign-in for ${selection.account.name}`);
        // Its sessions wait for it: a renewed sign-in brings them back to their cache.
        this.router.markUnavailable(selection.account.id, AUTH_FAILURE_COOLDOWN_S * 1000, "auth");
        this.onCredentialMissing?.(selection.account.id);
        continue;
      }
      const isLast = attempt === MAX_ATTEMPTS;
      attempt += 1;
      const accountId = selection.account.id;
      const started = Date.now();
      const outcome = await this.forwardTo(
        selection,
        route,
        req,
        res,
        bodyBuffer,
        pathname,
        isLast
          ? undefined
          : (status: number) =>
              RETRYABLE.has(status) && this.canTryAnother(targetProvider, tried, pathname),
        // Known with the headers: the token table may meet this request id before it is done.
        (early) => {
          if (early.requestId) this.requestLog?.bind(early.requestId, accountId);
          if (early.live) {
            this.onLiveLimits?.(accountId, early.live);
            this.insights.observeLimits(accountId, early.live.fiveHour);
          }
        },
      );
      if (!outcome) return;
      const tokens = outcome.tokens;
      const cost = tokens
        ? responseCost(requestedModel, {
            input: tokens.input ?? 0,
            output: tokens.output ?? 0,
            cacheWrite: tokens.cacheWrite ?? 0,
            cacheRead: tokens.cacheRead ?? 0,
            ...(tokens.cacheWrite1h !== undefined ? { cacheWrite1h: tokens.cacheWrite1h } : {}),
          })
        : undefined;
      const miss =
        tokens && !outcome.held && outcome.statusCode < 400
          ? this.insights.observeAnswer({ at: started, sessionKey, accountId, model: requestedModel, requestClass, agentId, compacted, tokens })
          : undefined;
      this.insights.promptServedBy(promptId, accountId);
      this.stats.recordLog({
        at: started,
        accountId,
        provider: targetProvider,
        model: requestedModel,
        status: outcome.statusCode,
        ms: Date.now() - started,
        ...about,
        ...(outcome.requestId ? { requestId: outcome.requestId } : {}),
        ...(tokens ? { tokens } : {}),
        ...(cost !== undefined ? { cost } : {}),
        ...(miss ? { miss } : {}),
        ...(outcome.errorMessage ? { error: outcome.errorMessage } : {}),
        // A refusal is answered here; it does not go on to another account.
        ...(outcome.held && outcome.failure !== "refused" ? { failover: true } : {}),
        ...(selection.sessionAffinityHit ? { affinity: true } : {}),
        ...(outcome.extraUsage ? { note: "extra-usage" } : outcome.failure ? { note: outcome.failure } : {}),
      });
      this.applyOutcome(accountId, routeKey, outcome);
      if (outcome.held && outcome.failure === "refused") {
        // Every account would answer the same: tell the client, and keep the accounts in.
        sendJsonError(
          res,
          429,
          "rate_limit_error",
          `Anthropic refused this request${outcome.errorMessage ? ` ("${outcome.errorMessage}")` : ""} although none of the account's limits is spent. Requests that do not come from Claude Code are refused this way. Relay did not pause the account.`,
        );
        return;
      }
      if (!outcome.held) return;
      lastHeld = outcome.statusCode;
      this.stats.recordError(
        `${selection.account.name} answered ${outcome.statusCode}; trying another account`,
      );
    }
    // Every attempt was held: the last one is never held, so this is not reached.
    sendJsonError(res, 502, "api_error", "No account could answer the request");
  }

  /**
   * No account's sign-in could be used: a 401 that says so, not a 429 a client would wait out.
   * The message names Relay, since the client's own /login would not help.
   */
  private signInNeeded(
    res: http.ServerResponse,
    provider: ProxyProvider,
    model: string,
    names: string[],
    about: { client?: string; requestClass?: string } = {},
  ): void {
    this.stats.recordLog({ at: Date.now(), provider, model, status: 401, note: "sign-in", ...about });
    sendJsonError(
      res,
      401,
      "authentication_error",
      names.length
        ? `Relay cannot use the sign-in of ${names.join(", ")} (expired or signed out). Renew it in Relay > Accounts.`
        : "Relay cannot use the sign-in of any account in its pool right now (expired or signed out). Renew it in Relay > Accounts.",
    );
  }

  /** The token (and for Antigravity the sidecar) one account is used with; undefined when none can be read. */
  private async resolveRoute(
    account: Account,
  ): Promise<{ token: string; antigravity?: { url: string; key: string } } | undefined> {
    const provider = account.provider ?? "claude";
    try {
      if (provider === "antigravity") {
        const route = await this.antigravityResolver?.(account);
        return route?.key ? { token: route.key, antigravity: route } : undefined;
      }
      // Gemini API key accounts are refused when forwarded, with a reason.
      if (provider === "gemini") return { token: "" };
      const token = await this.credentialResolver(account);
      return token ? { token } : undefined;
    } catch (err: any) {
      this.stats.recordError(`Credential lookup failed: ${err?.message ?? err}`);
      return undefined;
    }
  }

  /** Whether an account not yet tried for this request could take it. */
  private canTryAnother(
    provider: ProxyProvider,
    tried: ReadonlySet<string>,
    pathname: string,
  ): boolean {
    const { accounts, usageMap } = this.usageProvider();
    const usable = accounts.filter((a) => this.servesRoute(a, pathname));
    try {
      this.router.selectAccount(undefined, usable, usageMap, provider, tried);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A Codex ChatGPT sign-in (one with a ChatGPT account id) only answers the Responses API;
   * chat completions need an OpenAI API key account.
   */
  private servesRoute(account: Account, pathname: string): boolean {
    if (account.provider !== "codex" || !account.auth?.accountUuid) return true;
    return pathname === "/v1/responses" || pathname === "/responses";
  }

  /**
   * Sends the request to one account. Undefined when the gateway already answered the client
   * (an unsupported route); otherwise the upstream's outcome.
   */
  private async forwardTo(
    selection: RouterSelection,
    route: { token: string; antigravity?: { url: string; key: string } },
    req: http.IncomingMessage,
    res: http.ServerResponse,
    bodyBuffer: Buffer,
    pathname: string,
    holdIf: ((status: number) => boolean) | undefined,
    onAnswer?: ForwardSpec["onAnswer"],
  ): Promise<UpstreamOutcome | undefined> {
    const provider = selection.account.provider ?? "claude";
    if (provider === "gemini") {
      sendJsonError(res, 501, "unsupported_provider", "Gemini API key accounts are not supported by this gateway");
      return undefined;
    }
    const token = route.token;
    const antigravityRoute = route.antigravity;
    const apiKey = provider === "codex" && token.startsWith("sk-");
    if (
      provider === "codex" &&
      !apiKey &&
      pathname !== "/v1/responses" &&
      pathname !== "/responses"
    ) {
      sendJsonError(res, 501, "unsupported_endpoint", "Codex OAuth accounts support the Responses API only");
      return undefined;
    }

    this.stats.recordRequest(selection.account.id);
    const options = {
      token,
      accountId: selection.account.id,
      stats: this.stats,
      holdIf,
      onAnswer,
    };
    if (provider === "claude")
      return this.anthropicUpstream.forwardRequest(req, res, bodyBuffer, {
        ...options,
        upstreamUrl: this.upstreams.anthropicUrl,
      });
    return this.codexUpstream.forwardRequest(req, res, bodyBuffer, {
      ...options,
      ...(provider === "codex" && !apiKey && selection.account.auth?.accountUuid
        ? { chatgptAccountId: selection.account.auth.accountUuid }
        : {}),
      upstreamUrl:
        provider === "antigravity"
          ? antigravityRoute!.url
          : apiKey
            ? (this.upstreams.openaiUrl ?? "https://api.openai.com/v1")
            : this.upstreams.codexUrl,
    });
  }

  /**
   * What an answer means for its account and the session that sent it:
   * - a spent window keeps the account out until that window resets, and its sessions move on;
   * - extra usage billed moves the account's sessions and keeps it out; extra usage needed for
   *   this one request moves only this session;
   * - a refused sign-in keeps the account out briefly, drops the cached token and asks for a
   *   renewal, but its sessions stay bound and come back to their cache;
   * - a permission refusal moves only this session (the account lacks what it asked for);
   * - an overload keeps the account out for seconds, and its sessions stay bound.
   */
  private applyOutcome(accountId: string, sessionKey: string | undefined, outcome: UpstreamOutcome): void {
    const cool = (seconds: number, reason: CooldownReason) =>
      this.router.markUnavailable(
        accountId,
        Math.min(MAX_COOLDOWN_S, Math.max(MIN_COOLDOWN_S, seconds)) * 1000,
        reason,
      );
    switch (outcome.failure) {
      case "limit": {
        // A full window's reset time beats a short Retry-After: the account is out until then.
        const untilReset = outcome.limitResetsAt
          ? Math.ceil((outcome.limitResetsAt - Date.now()) / 1000)
          : undefined;
        cool(
          Math.max(
            untilReset ?? 0,
            outcome.retryAfterSeconds ?? (untilReset ? 0 : DEFAULT_RATE_LIMIT_COOLDOWN_S),
          ),
          "limit",
        );
        this.sessionCache.evictAccount(accountId);
        break;
      }
      case "auth":
        cool(AUTH_FAILURE_COOLDOWN_S, "auth");
        // A cached token the upstream refused is read again next time, not reused.
        this.onCredentialRejected?.(accountId);
        break;
      case "transient":
        if (outcome.held || outcome.statusCode === 529 || outcome.statusCode === 503)
          cool(OVERLOADED_COOLDOWN_S, "transient");
        break;
      case "extra-usage":
        this.stats.recordExtraUsage(accountId, "required");
        if (sessionKey) this.sessionCache.evictSession(sessionKey);
        break;
      case "permission":
        if (sessionKey) this.sessionCache.evictSession(sessionKey);
        break;
    }
    if (outcome.extraUsage) {
      // The plan no longer covers this account's requests: each one now costs money.
      this.stats.recordExtraUsage(accountId, "billed");
      cool(this.untilWindowReset(accountId) ?? EXTRA_USAGE_COOLDOWN_S, "limit");
      this.sessionCache.evictAccount(accountId);
    }
  }

  /** Seconds until the account's fullest read window resets, when Relay knows. */
  private untilWindowReset(accountId: string): number | undefined {
    const usage = this.usageProvider().usageMap[accountId];
    const now = Date.now();
    const resets = [usage?.fiveHour, usage?.sevenDay]
      .filter((w) => w && w.usedPercent >= 90 && w.resetsAt)
      .map((w) => Date.parse(w!.resetsAt!))
      .filter((at) => Number.isFinite(at) && at > now);
    return resets.length ? Math.ceil((Math.min(...resets) - now) / 1000) : undefined;
  }

  private handleWebSocketUpgrade(
    req: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
  ): void {
    // Until the bridge owns the socket, an error on it (reset while the token is looked up)
    // would be an uncaught exception.
    socket.on("error", () => socket.destroy());

    if (!this.hostAllowed(req.headers.host)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    const denied = this.authFailure(req.headers);
    if (denied) {
      rejectUpgrade(socket, denied.status, denied.status === 401 ? "Unauthorized" : "Forbidden");
      return;
    }

    try {
      const { pathname } = parseRequestUrl(req.url);
      if (pathname !== "/responses" && pathname !== "/v1/responses") {
        rejectUpgrade(socket, 404, "Not Found");
        return;
      }
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    void this.upgradeToCodex(req, socket, head).catch((err) => {
      this.stats.recordError(`WebSocket upgrade failed: ${err?.message ?? err}`);
      rejectUpgrade(socket, 502, "Bad Gateway");
    });
  }

  /**
   * The Responses WebSocket is ChatGPT's (Codex sign-ins): an OpenAI API key account cannot
   * serve it, so such accounts, and any without a readable sign-in, are skipped.
   */
  private async upgradeToCodex(
    req: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
  ): Promise<void> {
    const tried = new Set<string>();
    for (;;) {
      const { accounts, usageMap } = this.usageProvider();
      let selection: RouterSelection;
      try {
        selection = this.router.selectAccount(undefined, accounts, usageMap, "codex", tried);
      } catch (err) {
        if (err instanceof NoEligibleAccountError) rejectUpgrade(socket, 429, "Too Many Requests");
        else if (err instanceof NoProviderAccountError) rejectUpgrade(socket, 503, "Service Unavailable");
        else throw err;
        return;
      }
      tried.add(selection.account.id);
      const token = await this.credentialResolver(selection.account);
      if (!token || token.startsWith("sk-")) continue;
      if (socket.destroyed) return;
      this.stats.recordRequest(selection.account.id);
      this.stats.recordLog({ at: Date.now(), accountId: selection.account.id, provider: "codex", model: "websocket", status: 101 });
      this.wsBridge.handleUpgrade(req, socket, head, {
        upstreamUrl: this.upstreams.codexWebSocketUrl ?? CODEX_WS_URL,
        token,
        ...(selection.account.auth?.accountUuid
          ? { chatgptAccountId: selection.account.auth.accountUuid }
          : {}),
      });
      return;
    }
  }

  private extractSessionKey(
    req: http.IncomingMessage,
    parsed: any,
  ): string | undefined {
    // Check explicit headers. Claude Code names its session in x-claude-code-session-id on every
    // request, subagents' included, so a whole session keeps one account and one cache.
    for (const name of [
      "x-claude-code-session-id",
      "x-session-id",
      "x-conversation-id",
      "session_id",
      "conversation_id",
    ]) {
      const value = req.headers[name];
      if (typeof value === "string" && value) return boundedKey(`hdr:${value}`);
    }

    // Check request body
    if (parsed && typeof parsed === "object") {
      try {
        if (parsed.metadata?.user_id) {
          return boundedKey(`user:${parsed.metadata.user_id}`);
        }
        if (parsed.metadata?.conversation_id) {
          return boundedKey(`conv:${parsed.metadata.conversation_id}`);
        }
        // The Responses API names the conversation for its own prompt cache.
        if (
          typeof parsed.prompt_cache_key === "string" &&
          parsed.prompt_cache_key
        ) {
          return boundedKey(`cache:${parsed.prompt_cache_key}`);
        }
        // Hash the first message as conversation fingerprint
        if (Array.isArray(parsed.messages) && parsed.messages.length > 0) {
          const text = messageText(parsed.messages[0]?.content);
          if (text.length > 20) {
            return `msg_hash:${createHash("sha256").update(text.slice(0, 200)).digest("hex").slice(0, 16)}`;
          }
        }
      } catch {
        // Fall back to undefined
      }
    }

    return undefined;
  }
}

/** Session keys come from clients: long ones are hashed so the cache stays small. */
function boundedKey(key: string): string {
  return key.length <= 128
    ? key
    : `h:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

/** The text of a message whose content is a string or a list of content blocks. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && block.type === "text" && typeof block.text === "string"
        ? block.text
        : "",
    )
    .join("\n");
}
