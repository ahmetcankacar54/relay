/**
 * The Proxy Gateway as a child process: `relay __gateway`, the Rust gateway, spoken to in
 * newline-delimited JSON on its stdin and stdout (crates/relay-gateway/src/sidecar.rs documents
 * the protocol). It keeps the surface the app used of the in-process server: start, stop,
 * updateConfig, getState, getMetrics, stats.recent(), insights, nextPicks(), router.cooldownOf(),
 * sessionCache.list() and sessionCache.evictAccount(). What the app reads synchronously comes from
 * the gateway's latest status, asked for every second and after each answer it logs.
 *
 * No Electron import: the tests run this class on its own.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { Account, AccountUsage, ProxyStatus } from "../../shared/types";
import type {
  ProxyConfig,
  ProxyLoopAlarm,
  ProxyMetrics,
  ProxyRequestLog,
  ProxySessionState,
  ProxySessionView,
  ProxyState,
} from "../../shared/proxy-types";

/** An account's windows as an answer reported them (the gateway's `LiveLimits`). */
export interface SidecarLiveLimits {
  fiveHour?: { usedPercent: number; resetsAt?: string };
  sevenDay?: { usedPercent: number; resetsAt?: string };
  models?: { model: string; weekly: boolean; usedPercent: number; resetsAt?: string }[];
}

type Cooldown = { until: number; reason: "limit" | "auth" | "transient" };

/** What the gateway asks of the app, and what it tells it. */
export interface GatewaySidecarHooks {
  /** The token the gateway sends for an account; undefined when none can be used. */
  credential(account: Account): Promise<string | undefined>;
  /** An Antigravity account's local sidecar. */
  antigravity?(account: Account): Promise<{ url: string; key: string } | undefined>;
  /** An overflow upstream's API key, from the vault. */
  overflowKey?(upstreamId: string): Promise<string | undefined>;
  /** The pool (in its order) and the limits as the app last read them. */
  usage(): { accounts: Account[]; usageMap: Record<string, AccountUsage | undefined> };
  onLiveLimits?(accountId: string, live: SidecarLiveLimits): void;
  onCredentialRejected?(accountId: string): void;
  onCredentialMissing?(accountId: string): void;
  onLoopAlarm?(alarm: ProxyLoopAlarm): void;
  /** The request log kept across restarts. */
  requestLog?: {
    record(entry: ProxyRequestLog): void;
    bind(requestId: string, accountId: string): void;
    recent(): ProxyRequestLog[];
    overflowCosts?(): { at: number; cost: number }[];
  };
  /** The planning time zone: the overflow cap is per day there. */
  timeZone?(): string;
  /** The gateway stopped by itself (it crashed or was killed); the message says how. */
  onExit?(message: string): void;
}

export interface GatewaySidecarOptions {
  /** The `relay` binary (or a build of the sidecar example in tests). */
  binary: string;
  config: ProxyConfig;
  hooks: GatewaySidecarHooks;
  /** Where requests go instead of the real services (tests). */
  upstreams?: { anthropicUrl?: string; codexUrl?: string; openaiUrl?: string; codexWebSocketUrl?: string };
  /** Where OpenRouter's prices are kept. */
  openRouterPricesFile?: string;
  /** How often a changed pool or usage is pushed, and the status asked for; ms. */
  pollMs?: number;
  /** How long the gateway waits for an answer to its own questions; ms. */
  replyTimeoutMs?: number;
}

/** How long a stopping gateway gets after stdin closes before it is killed. */
const STOP_GRACE_MS = 2_000;
const DEFAULT_POLL_MS = 1_000;

interface StatusReply {
  ok: boolean;
  state: ProxyState;
  metrics: ProxyMetrics;
  recent?: ProxyRequestLog[];
  nextPick?: NonNullable<ProxyStatus["nextPick"]>;
  cooldowns?: Record<string, Cooldown>;
  sessions?: ProxySessionView[];
  alarms?: ProxyLoopAlarm[];
  fullAt?: Record<string, number>;
}

/** An error the app can tell apart, as Node's `listen` gave it (`code` is `EADDRINUSE`). */
class SidecarStartError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export class GatewaySidecar {
  private child?: ChildProcessWithoutNullStreams;
  private config: ProxyConfig;
  private status?: StatusReply;
  private sessions: ProxySessionState[] = [];
  private lastUsage = "";
  private timer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private nextId = 1;
  private readonly replies = new Map<number, (status: StatusReply | null) => void>();
  private stopping = false;
  private exited?: Promise<void>;
  private lastStderr = "";
  /** Set once the gateway said it listens: a later exit is a crash the app hears of. */
  private running = false;
  /** The port the gateway listens on (the config may ask for 0). */
  private listening?: number;

  constructor(private readonly options: GatewaySidecarOptions) {
    this.config = { ...options.config };
  }

  /** The feed, newest first, as the gateway last reported it. */
  readonly stats = { recent: (): ProxyRequestLog[] => this.status?.recent ?? [] };

  /** What the gateway learned from its traffic, as it last reported it. */
  readonly insights = {
    sessionViews: (): ProxySessionView[] => this.status?.sessions ?? [],
    alarms: (): ProxyLoopAlarm[] => this.status?.alarms ?? [],
    fullAt: (accountId: string): number | undefined => this.status?.fullAt?.[accountId],
  };

  readonly router = {
    cooldownOf: (accountId: string): Cooldown | undefined => {
      const cooldown = this.status?.cooldowns?.[accountId];
      return cooldown && cooldown.until > Date.now() ? cooldown : undefined;
    },
  };

  readonly sessionCache = {
    list: (): ProxySessionState[] => this.sessions.map((session) => ({ ...session })),
    evictAccount: (accountId: string): number => {
      const before = this.sessions.length;
      this.sessions = this.sessions.filter((session) => session.accountId !== accountId);
      this.send({ t: "evict", accountId });
      return before - this.sessions.length;
    },
  };

  /** Starts the gateway; rejects with `code: "EADDRINUSE"` when the port is taken. */
  async start(): Promise<ProxyState> {
    if (this.child) return this.getState();
    this.stopping = false;
    const child = spawn(this.options.binary, ["__gateway"], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdin.on("error", () => {});
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => {
      this.lastStderr = (this.lastStderr + text).slice(-2_000);
    });
    let settle: { resolve: (port: number) => void; reject: (error: Error) => void } | undefined;
    const ready = new Promise<number>((resolve, reject) => (settle = { resolve, reject }));
    let finish: () => void = () => {};
    this.exited = new Promise((resolve) => (finish = resolve));
    const gone = (message: string, code = "other") => {
      if (this.child !== child) return;
      settle?.reject(new SidecarStartError(message, code));
      settle = undefined;
      this.ended(message);
      finish();
    };
    child.once("exit", (code, signal) =>
      gone(this.lastStderr.trim().split("\n").at(-1) || `relay __gateway exited (${signal ?? `code ${code}`})`),
    );
    // The binary could not be started at all (missing, not executable): no "exit" follows.
    child.once("error", (error) => gone(error.message, (error as NodeJS.ErrnoException).code ?? "other"));
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      let message: Record<string, any>;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.t === "ready") {
        settle?.resolve(Number(message.port));
        settle = undefined;
      } else if (message.t === "error" && settle) {
        settle.reject(new SidecarStartError(String(message.message), String(message.code)));
        settle = undefined;
      } else {
        this.receive(message);
      }
    });
    this.send({ t: "config", config: this.sidecarConfig(true) });
    this.pushUsage();
    try {
      const port = await ready;
      // The port it got stays out of the config: a later config with the asked-for port
      // changes the gateway in place instead of restarting it.
      this.listening = port;
      this.running = true;
    } catch (error) {
      await this.stop();
      throw error;
    }
    this.timer = setInterval(() => {
      this.pushUsage();
      void this.refresh();
    }, this.options.pollMs ?? DEFAULT_POLL_MS);
    this.timer.unref();
    await this.refresh();
    return this.getState();
  }

  /** Stops the gateway: stdin closes, and a gateway still there 2 s later is killed. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.send({ t: "stop" });
    child.stdin.end();
    const killer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
    killer.unref();
    await this.exited;
    clearTimeout(killer);
  }

  /**
   * Changes the running gateway's routing strategy, session time, client key, subagent overflow
   * or overflow at once; its host and port stay (a new one takes a restart).
   */
  updateConfig(patch: Partial<ProxyConfig>): void {
    this.config = { ...this.config, ...patch };
    this.send({ t: "config", config: this.sidecarConfig(false) });
    void this.refresh();
  }

  /** The gateway process's id while it runs (diagnostics, `ps`). */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** The gateway's state as last reported; stopped when it is not running. */
  getState(): ProxyState {
    const state = this.status?.state;
    if (this.child && state) return state;
    return {
      status: this.child ? "starting" : "stopped",
      port: this.listening ?? this.config.port,
      host: this.config.host,
      endpointUrl: `http://${this.config.host.includes(":") && !this.config.host.startsWith("[") ? `[${this.config.host}]` : this.config.host}:${this.listening ?? this.config.port}`,
      activeSessionsCount: this.sessions.length,
      uptimeSeconds: 0,
    };
  }

  getMetrics(): ProxyMetrics | undefined {
    return this.status?.metrics;
  }

  nextPicks(): NonNullable<ProxyStatus["nextPick"]> {
    return this.status?.nextPick ?? {};
  }

  /** Asks the gateway for its status; what the synchronous readers above return afterwards. */
  async refresh(): Promise<void> {
    if (!this.child) return;
    const id = this.nextId++;
    const reply = await new Promise<StatusReply | null>((resolve) => {
      this.replies.set(id, resolve);
      this.send({ t: "status", id });
      setTimeout(() => {
        if (this.replies.delete(id)) resolve(null);
      }, 5_000).unref();
    });
    if (reply) this.status = reply;
  }

  /** Pushes the pool and its limits when they changed since the last push. */
  pushUsage(): void {
    const { accounts, usageMap } = this.options.hooks.usage();
    const usage = Object.fromEntries(Object.entries(usageMap).filter(([, value]) => value !== undefined));
    const text = JSON.stringify({ t: "usage", accounts, usage });
    if (text === this.lastUsage) return;
    this.lastUsage = text;
    this.write(text);
  }

  private sidecarConfig(first: boolean) {
    const log = this.options.hooks.requestLog;
    return {
      ...this.config,
      ...(this.options.upstreams ? { upstreams: this.options.upstreams } : {}),
      ...(this.options.hooks.timeZone ? { timeZone: this.options.hooks.timeZone() } : {}),
      ...(this.options.openRouterPricesFile ? { openRouterPricesFile: this.options.openRouterPricesFile } : {}),
      ...(first && log ? { recentRequests: log.recent(), overflowCosts: log.overflowCosts?.() ?? [] } : {}),
      ...(this.options.replyTimeoutMs ? { replyTimeoutMs: this.options.replyTimeoutMs } : {}),
      ...(this.options.pollMs ? { sessionsIntervalMs: this.options.pollMs } : {}),
    };
  }

  private send(message: Record<string, unknown>): void {
    this.write(JSON.stringify(message));
  }

  private write(line: string): void {
    const stdin = this.child?.stdin;
    if (stdin && !stdin.destroyed && stdin.writable) stdin.write(`${line}\n`);
  }

  private account(id: unknown): Account | undefined {
    return this.options.hooks.usage().accounts.find((account) => account.id === id);
  }

  /** Answers one of the gateway's questions; a failed lookup answers null. */
  private answer(kind: string, id: unknown, value: Promise<unknown> | undefined): void {
    void Promise.resolve(value)
      .catch(() => undefined)
      .then((result) => this.send({ t: kind, id, value: result ?? null }));
  }

  private receive(message: Record<string, any>): void {
    const hooks = this.options.hooks;
    switch (message.t) {
      case "need-credential": {
        const account = this.account(message.accountId);
        this.answer("credential", message.id, account ? hooks.credential(account) : undefined);
        break;
      }
      case "need-antigravity": {
        const account = this.account(message.accountId);
        this.answer("antigravity", message.id, account ? hooks.antigravity?.(account) : undefined);
        break;
      }
      case "need-overflow-key":
        this.answer("overflow-key", message.id, hooks.overflowKey?.(String(message.upstreamId)));
        break;
      case "status-reply":
        this.replies.get(message.id)?.(message.status ?? null);
        this.replies.delete(message.id);
        break;
      case "sessions":
        if (Array.isArray(message.list)) this.sessions = message.list;
        break;
      case "live-limits":
        hooks.onLiveLimits?.(String(message.accountId), message.live);
        break;
      case "credential-rejected":
        hooks.onCredentialRejected?.(String(message.accountId));
        break;
      case "credential-missing":
        hooks.onCredentialMissing?.(String(message.accountId));
        break;
      case "loop-alarm":
        hooks.onLoopAlarm?.(message.alarm);
        break;
      case "request-log":
        hooks.requestLog?.record(message.entry);
        // The feed and the counters move with every answer.
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => void this.refresh(), 100);
        this.refreshTimer.unref();
        break;
      case "request-bound":
        hooks.requestLog?.bind(String(message.requestId), String(message.accountId));
        break;
    }
  }

  /** The child is gone: everything it held goes with it. */
  private ended(message: string): void {
    clearInterval(this.timer);
    clearTimeout(this.refreshTimer);
    this.child = undefined;
    this.status = undefined;
    this.sessions = [];
    this.lastUsage = "";
    for (const resolve of this.replies.values()) resolve(null);
    this.replies.clear();
    const crashed = this.running && !this.stopping;
    this.running = false;
    if (crashed) this.options.hooks.onExit?.(message);
  }
}
