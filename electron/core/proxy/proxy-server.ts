import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import type { Account, AccountUsage } from "../../../shared/types";
import {
  DEFAULT_PROXY_CONFIG,
  type ProxyConfig,
  type ProxyMetrics,
  type ProxyState,
} from "../../../shared/proxy-types";
import {
  NoEligibleAccountError,
  ProxyRouter,
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
} from "./upstream-common";
import { translateAnthropicToOpenAI } from "./protocol-translator";

export type CredentialResolver = (
  account: Account,
) => Promise<string | undefined>;
export type UsageProvider = () => {
  accounts: Account[];
  usageMap: Record<string, AccountUsage | undefined>;
};

/** The largest request body the gateway buffers (Anthropic itself caps requests at 32 MB). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** A body is only parsed for a session key up to this size. */
const MAX_PARSE_BYTES = 16 * 1024 * 1024;
const STOP_GRACE_MS = 3_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_S = 60;
const MIN_COOLDOWN_S = 5;
const MAX_COOLDOWN_S = 60 * 60;
const AUTH_FAILURE_COOLDOWN_S = 30;
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
  private usageProvider: UsageProvider;

  constructor(options: {
    config?: Partial<ProxyConfig>;
    credentialResolver: CredentialResolver;
    usageProvider: UsageProvider;
    now?: () => number;
    /** Where requests go instead of the real services (tests, regional endpoints). */
    upstreams?: {
      anthropicUrl?: string;
      codexUrl?: string;
      codexWebSocketUrl?: string;
    };
  }) {
    this.upstreams = options.upstreams ?? {};
    this.config = { ...DEFAULT_PROXY_CONFIG, ...options.config };
    this.credentialResolver = options.credentialResolver;
    this.usageProvider = options.usageProvider;

    this.sessionCache = new ProxySessionCache({
      ttlSeconds: this.config.affinityTtlSeconds,
      now: options.now,
    });
    this.router = new ProxyRouter({
      strategy: this.config.routingStrategy,
      sessionCache: this.sessionCache,
      now: options.now,
      allowCrossProviderFallback:
        (this.config as any).allowCrossProviderFallback ?? false,
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
      this.handleHttpRequest(req, res).catch((err: any) => this.fail(res, err));
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
    if (patch.affinityTtlSeconds) {
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

    // Health / Status endpoint (public status check)
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      (pathname === "/health" || pathname === "/status")
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

    // Client Authentication: Verify API key or require auth on network-exposed hosts
    if (this.config.apiKey) {
      const authHeader =
        req.headers["authorization"] ||
        req.headers["x-relay-key"] ||
        req.headers["x-api-key"];
      const token =
        typeof authHeader === "string"
          ? authHeader.replace(/^Bearer\s+/i, "").trim()
          : "";
      if (token !== this.config.apiKey) {
        sendJsonError(
          res,
          401,
          "authentication_error",
          "Invalid or missing proxy authorization",
          {
            connection: "close",
          },
        );
        return;
      }
    } else if (
      this.config.host !== "127.0.0.1" &&
      this.config.host !== "localhost" &&
      this.config.host !== "::1"
    ) {
      sendJsonError(
        res,
        403,
        "forbidden",
        "Network-exposed proxy requires apiKey to be configured",
        {
          connection: "close",
        },
      );
      return;
    }

    // Restrict to known AI provider endpoints
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
        {
          connection: "close",
        },
      );
      return;
    }

    const bodyBuffer = await this.readBody(req, res);
    if (!bodyBuffer) return;

    const isCodex =
      pathname.startsWith("/v1/responses") ||
      pathname.startsWith("/responses") ||
      pathname.startsWith("/v1/chat/completions") ||
      pathname.startsWith("/chat/completions");

    // Determine session key for KV cache affinity
    const sessionKey = this.extractSessionKey(req, bodyBuffer);

    const { accounts, usageMap } = this.usageProvider();
    if (accounts.length === 0) {
      sendJsonError(res, 503, "api_error", "No accounts configured in Relay");
      return;
    }

    const targetProvider = isCodex ? "codex" : "claude";
    let selection: RouterSelection;
    try {
      selection = this.router.selectAccount(
        sessionKey,
        accounts,
        usageMap,
        targetProvider,
      );
    } catch (err) {
      if (err instanceof NoEligibleAccountError) {
        this.stats.recordError(err.message);
        sendJsonError(
          res,
          429,
          "rate_limit_error",
          `${err.message}. Every account is cooling down.`,
          err.retryAfterSeconds
            ? { "retry-after": String(err.retryAfterSeconds) }
            : {},
        );
        return;
      }
      throw err;
    }

    let token: string | undefined;
    try {
      token = await this.credentialResolver(selection.account);
    } catch (err: any) {
      this.stats.recordError(
        `Credential lookup failed: ${err?.message ?? err}`,
      );
    }
    if (!token) {
      // Don't keep sending requests at an account whose sign-in cannot be read.
      this.router.markUnavailable(
        selection.account.id,
        AUTH_FAILURE_COOLDOWN_S * 1000,
      );
      this.sessionCache.evictAccount(selection.account.id);
      sendJsonError(
        res,
        401,
        "authentication_error",
        `No active credential found for selected account ${selection.account.name}`,
      );
      return;
    }

    this.stats.recordRequest(selection.account.id);

    const selectedProvider = selection.account.provider ?? targetProvider;
    const useCodex = selectedProvider === "codex";
    let effectiveBuffer = bodyBuffer;

    if (!isCodex && useCodex) {
      // Cross-provider translation: Anthropic request -> Codex/OpenAI Chat Completions
      try {
        const parsed = JSON.parse(bodyBuffer.toString("utf8"));
        const translated = translateAnthropicToOpenAI(parsed);
        effectiveBuffer = Buffer.from(JSON.stringify(translated), "utf8");
        req.url = "/v1/chat/completions";
      } catch (err: any) {
        this.stats.recordError(`Translation error: ${err.message}`);
      }
    }

    const upstream = useCodex ? this.codexUpstream : this.anthropicUpstream;
    const outcome = await upstream.forwardRequest(req, res, effectiveBuffer, {
      upstreamUrl: useCodex
        ? this.upstreams.codexUrl
        : this.upstreams.anthropicUrl,
      token,
      accountId: selection.account.id,
      stats: this.stats,
    });

    if (outcome.rateLimited) {
      // Rate limit hit: evict the account and keep it out of selection so the next call falls over
      const seconds = Math.min(
        MAX_COOLDOWN_S,
        Math.max(
          MIN_COOLDOWN_S,
          outcome.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_COOLDOWN_S,
        ),
      );
      this.router.markUnavailable(selection.account.id, seconds * 1000);
      this.sessionCache.evictAccount(selection.account.id);
    } else if (outcome.unauthorized) {
      this.router.markUnavailable(
        selection.account.id,
        AUTH_FAILURE_COOLDOWN_S * 1000,
      );
      this.sessionCache.evictAccount(selection.account.id);
    }
  }

  private handleWebSocketUpgrade(
    req: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
  ): void {
    // Until the bridge owns the socket, an error on it (reset while the token is looked up)
    // would be an uncaught exception.
    socket.on("error", () => socket.destroy());

    // Client Authentication for WebSocket upgrades
    if (this.config.apiKey) {
      const authHeader =
        req.headers["authorization"] ||
        req.headers["x-relay-key"] ||
        req.headers["x-api-key"];
      const token =
        typeof authHeader === "string"
          ? authHeader.replace(/^Bearer\s+/i, "").trim()
          : "";
      if (token !== this.config.apiKey) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }
    } else if (
      this.config.host !== "127.0.0.1" &&
      this.config.host !== "localhost" &&
      this.config.host !== "::1"
    ) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    let selection: RouterSelection;
    try {
      const { pathname } = parseRequestUrl(req.url);
      if (pathname !== "/responses" && pathname !== "/v1/responses") {
        rejectUpgrade(socket, 404, "Not Found");
        return;
      }

      const { accounts, usageMap } = this.usageProvider();
      if (accounts.length === 0) {
        rejectUpgrade(socket, 503, "Service Unavailable");
        return;
      }
      selection = this.router.selectAccount(
        undefined,
        accounts,
        usageMap,
        "codex",
      );
    } catch (err) {
      if (err instanceof BadRequestError)
        rejectUpgrade(socket, 400, "Bad Request");
      else if (err instanceof NoEligibleAccountError)
        rejectUpgrade(socket, 429, "Too Many Requests");
      else rejectUpgrade(socket, 500, "Internal Server Error");
      return;
    }

    this.credentialResolver(selection.account)
      .then((token) => {
        if (!token) {
          rejectUpgrade(socket, 401, "Unauthorized");
          return;
        }
        this.stats.recordRequest(selection.account.id);
        this.wsBridge.handleUpgrade(req, socket, head, {
          upstreamUrl: this.upstreams.codexWebSocketUrl ?? CODEX_WS_URL,
          token,
        });
      })
      .catch((err) => {
        this.stats.recordError(
          `WebSocket upgrade failed: ${err?.message ?? err}`,
        );
        rejectUpgrade(socket, 502, "Bad Gateway");
      });
  }

  private extractSessionKey(
    req: http.IncomingMessage,
    bodyBuffer: Buffer,
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
    if (bodyBuffer.length > 0 && bodyBuffer.length <= MAX_PARSE_BYTES) {
      try {
        const parsed = JSON.parse(bodyBuffer.toString("utf8"));
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
