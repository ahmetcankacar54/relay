import http from "node:http";
import net from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Account, AccountUsage } from "../../../shared/types";
import {
  DEFAULT_PROXY_CONFIG,
  type ProxyConfig,
  type ProxyMetrics,
  type ProxyState,
} from "../../../shared/proxy-types";
import {
  NoEligibleAccountError,
  NoProviderAccountError,
  ProxyRouter,
  type ProxyProvider,
  type RouterSelection,
} from "./proxy-router";
import { ProxySessionCache } from "./proxy-session-cache";
import { ProxyStats } from "./proxy-stats";
import { AnthropicUpstream } from "./anthropic-upstream";
import { CodexUpstream } from "./codex-upstream";
import { WebSocketBridge, rejectUpgrade } from "./websocket-bridge";
import {
  BadRequestError,
  parseRequestUrl,
  sendJsonError,
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
  readonly anthropicUpstream: AnthropicUpstream;
  readonly codexUpstream: CodexUpstream;
  readonly wsBridge: WebSocketBridge;

  private credentialResolver: CredentialResolver;
  private antigravityResolver?: AntigravityResolver;
  private usageProvider: UsageProvider;
  private onCredentialRejected?: (accountId: string) => void;

  constructor(options: {
    config?: Partial<ProxyConfig>;
    credentialResolver: CredentialResolver;
    antigravityResolver?: AntigravityResolver;
    usageProvider: UsageProvider;
    /** The upstream refused the account's token: a cached copy must be dropped. */
    onCredentialRejected?: (accountId: string) => void;
    now?: () => number;
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

    this.sessionCache = new ProxySessionCache({
      ttlSeconds: this.config.affinityTtlSeconds,
      now: options.now,
    });
    this.router = new ProxyRouter({
      strategy: this.config.routingStrategy,
      sessionCache: this.sessionCache,
      now: options.now,
    });
    this.stats = new ProxyStats();
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
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; ) {
      const { accounts, usageMap } = this.usageProvider();
      let selection: RouterSelection;
      try {
        selection = this.router.selectAccount(
          sessionKey,
          accounts,
          usageMap,
          targetProvider,
          tried,
        );
      } catch (err) {
        if (err instanceof NoProviderAccountError && unsupported && lastHeld === undefined) {
          sendJsonError(res, 501, "unsupported_endpoint", unsupported);
          return;
        }
        if (err instanceof NoProviderAccountError && tried.size === 0) {
          this.stats.recordLog({ at: Date.now(), provider: targetProvider, model: requestedModel, status: 503, note: "no-account" });
          sendJsonError(res, 503, "api_error", err.message);
          return;
        }
        if (err instanceof NoEligibleAccountError && tried.size === 0) {
          this.stats.recordError(err.message);
          this.stats.recordLog({ at: Date.now(), provider: targetProvider, model: requestedModel, status: 429, note: "all-limited" });
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
        if (
          err instanceof NoProviderAccountError ||
          err instanceof NoEligibleAccountError
        ) {
          // Every other account was tried or is cooling down: the last answer was already held.
          this.stats.recordLog({ at: Date.now(), provider: targetProvider, model: requestedModel, status: lastHeld ?? 429, note: "all-limited" });
          sendJsonError(res, lastHeld ?? 429, lastHeld === 401 || lastHeld === 403 ? "authentication_error" : "rate_limit_error", "Every account for this provider is limited or unavailable");
          return;
        }
        throw err;
      }
      tried.add(selection.account.id);
      const isLast = attempt === MAX_ATTEMPTS;
      if (!this.servesRoute(selection.account, pathname)) {
        unsupported = "Codex ChatGPT sign-ins support the Responses API only; add an OpenAI API key account for this endpoint";
        continue;
      }
      attempt += 1;
      const outcome = await this.forwardTo(
        selection,
        req,
        res,
        bodyBuffer,
        pathname,
        isLast
          ? undefined
          : (status: number) =>
              RETRYABLE.has(status) && this.canTryAnother(targetProvider, tried, pathname),
      );
      if (!outcome) return;
      this.stats.recordLog({
        at: Date.now(),
        accountId: selection.account.id,
        provider: targetProvider,
        model: requestedModel,
        status: outcome.statusCode,
        ...(outcome.held ? { failover: true } : {}),
        ...(selection.sessionAffinityHit ? { affinity: true } : {}),
      });
      this.applyOutcome(selection.account.id, outcome);
      if (!outcome.held) return;
      lastHeld = outcome.statusCode;
      this.stats.recordError(
        `${selection.account.name} answered ${outcome.statusCode}; trying another account`,
      );
    }
    // Every attempt was held: the last one is never held, so this is not reached.
    sendJsonError(res, 502, "api_error", "No account could answer the request");
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
   * (no credential, an unsupported route); otherwise the upstream's outcome.
   */
  private async forwardTo(
    selection: RouterSelection,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    bodyBuffer: Buffer,
    pathname: string,
    holdIf: ((status: number) => boolean) | undefined,
  ): Promise<UpstreamOutcome | undefined> {
    const provider = selection.account.provider ?? "claude";
    if (provider === "gemini") {
      sendJsonError(res, 501, "unsupported_provider", "Gemini API key accounts are not supported by this gateway");
      return undefined;
    }
    let antigravityRoute: { url: string; key: string } | undefined;
    let token: string | undefined;
    try {
      if (provider === "antigravity") {
        antigravityRoute = await this.antigravityResolver?.(selection.account);
        token = antigravityRoute?.key;
      } else {
        token = await this.credentialResolver(selection.account);
      }
    } catch (err: any) {
      this.stats.recordError(`Credential lookup failed: ${err?.message ?? err}`);
    }
    if (!token) {
      // The account's sign-in cannot be read: it cools down, and another one is tried.
      this.stats.recordError(`No credential for ${selection.account.name}`);
      const held = holdIf?.(401) ?? false;
      if (!held)
        sendJsonError(
          res,
          401,
          "authentication_error",
          `No active credential found for selected account ${selection.account.name}`,
        );
      return { statusCode: 401, rateLimited: false, unauthorized: true, held };
    }
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

  /** Keeps a limited, refused or overloaded account out of selection for a while. */
  private applyOutcome(accountId: string, outcome: UpstreamOutcome): void {
    let seconds: number | undefined;
    if (outcome.rateLimited) {
      // A full window's reset time beats a short Retry-After: the account is out until then.
      const untilReset = outcome.limitResetsAt
        ? Math.ceil((outcome.limitResetsAt - Date.now()) / 1000)
        : undefined;
      seconds = Math.max(
        untilReset ?? 0,
        outcome.retryAfterSeconds ?? (untilReset ? 0 : DEFAULT_RATE_LIMIT_COOLDOWN_S),
      );
    } else if (outcome.unauthorized) {
      seconds = AUTH_FAILURE_COOLDOWN_S;
      // A cached token the upstream refused is read again next time, not reused.
      this.onCredentialRejected?.(accountId);
    } else if (outcome.statusCode === 529 || outcome.statusCode === 503) {
      seconds = OVERLOADED_COOLDOWN_S;
    }
    if (seconds === undefined) return;
    const clamped = Math.min(MAX_COOLDOWN_S, Math.max(MIN_COOLDOWN_S, seconds));
    this.router.markUnavailable(accountId, clamped * 1000);
    this.sessionCache.evictAccount(accountId);
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
    // Check explicit headers
    for (const name of [
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
