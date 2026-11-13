import type {
  AccountTokenMetrics,
  ProxyMetrics,
  ProxyRequestLog,
} from "../../../shared/proxy-types";

const MAX_ERROR_LENGTH = 500;
/** How many requests the live feed keeps. */
export const REQUEST_LOG_SIZE = 40;
const MAX_MODEL_LENGTH = 80;

/** Where the feed's entries are also kept, across restarts (`GatewayRequestLog`). */
export interface RequestLogSink {
  /** The newest entries kept, newest last. */
  recent(): ProxyRequestLog[];
  record(entry: ProxyRequestLog): void;
}

/** Counters per account id; the keys are the registry's accounts, so the maps stay small. */
export class ProxyStats {
  constructor(private readonly sink?: RequestLogSink) {
    // The feed shows the requests before a restart, too.
    if (sink) this.log = sink.recent().slice(-REQUEST_LOG_SIZE);
  }

  private totalRequests = 0;
  private requestsByAccount = new Map<string, number>();
  private tokensByAccount = new Map<string, AccountTokenMetrics>();
  private lastError?: string;
  private lastErrorAt?: number;
  private activeRequests = 0;
  private promptCacheHits = 0;
  private lastAccountId?: string;
  /** Newest last; trimmed to REQUEST_LOG_SIZE. */
  private log: ProxyRequestLog[] = [];
  /** The latest extra-usage answer per account: billed beyond the plan, or needing it. */
  private extraUsage = new Map<string, { at: number; kind: "billed" | "required" }>();

  /** An account's answer was billed as extra usage, or a request needed extra usage it lacks. */
  recordExtraUsage(accountId: string, kind: "billed" | "required"): void {
    const current = this.extraUsage.get(accountId);
    // A billed answer is the one to tell about: it cost money.
    if (current?.kind === "billed" && kind === "required") return;
    this.extraUsage.set(accountId, { at: Date.now(), kind });
  }

  /** One request's outcome for the live feed. */
  recordLog(entry: ProxyRequestLog): void {
    const model = entry.model?.slice(0, MAX_MODEL_LENGTH);
    const kept = { ...entry, ...(model ? { model } : {}) };
    this.log.push(kept);
    if (this.log.length > REQUEST_LOG_SIZE) this.log.splice(0, this.log.length - REQUEST_LOG_SIZE);
    this.sink?.record(kept);
  }

  /** The feed, newest first. */
  recent(): ProxyRequestLog[] {
    return this.log.slice().reverse();
  }

  /** A request came in; pair with requestEnded(). */
  requestStarted(): void {
    this.activeRequests += 1;
  }

  requestEnded(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
  }

  recordRequest(accountId: string): void {
    this.lastAccountId = accountId;
    this.totalRequests += 1;
    this.requestsByAccount.set(
      accountId,
      (this.requestsByAccount.get(accountId) ?? 0) + 1,
    );
  }

  recordTokens(
    accountId: string,
    tokens: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
    },
  ): void {
    const count = (value: number | undefined) =>
      typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : 0;
    const current = this.tokensByAccount.get(accountId) ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    current.input += count(tokens.input);
    current.output += count(tokens.output);
    current.cacheRead += count(tokens.cacheRead);
    if (count(tokens.cacheRead) > 0) this.promptCacheHits += 1;
    current.cacheWrite += count(tokens.cacheWrite);
    this.tokensByAccount.set(accountId, current);
  }

  recordError(error: string): void {
    // Only the latest error is kept, and capped, so a hostile upstream cannot grow it.
    this.lastError =
      error.length > MAX_ERROR_LENGTH
        ? `${error.slice(0, MAX_ERROR_LENGTH)}…`
        : error;
    this.lastErrorAt = Date.now();
  }

  getMetrics(activeSessionsCount: number): ProxyMetrics {
    const reqs: Record<string, number> = {};
    for (const [k, v] of this.requestsByAccount.entries()) {
      reqs[k] = v;
    }

    const toks: Record<string, AccountTokenMetrics> = {};
    let totalPrompt = 0;
    let totalCacheRead = 0;

    for (const [k, v] of this.tokensByAccount.entries()) {
      toks[k] = { ...v };
      // Everything the model was sent: read from the cache, written to it, or neither. A cold
      // start shows up as writes, so leaving them out would hide the misses the ratio is for.
      totalPrompt += v.input + v.cacheRead + v.cacheWrite;
      totalCacheRead += v.cacheRead;
    }

    const cacheHitRatio =
      totalPrompt > 0
        ? Math.round((totalCacheRead / totalPrompt) * 1000) / 1000
        : 0;

    return {
      totalRequests: this.totalRequests,
      activeSessions: activeSessionsCount,
      requestsByAccount: reqs,
      tokensByAccount: toks,
      cacheHitRatio,
      activeRequests: this.activeRequests,
      promptCacheHits: this.promptCacheHits,
      ...(this.lastAccountId ? { lastAccountId: this.lastAccountId } : {}),
      ...(this.extraUsage.size ? { extraUsage: Object.fromEntries(this.extraUsage) } : {}),
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
    };
  }

  reset(): void {
    this.totalRequests = 0;
    this.requestsByAccount.clear();
    this.tokensByAccount.clear();
    this.promptCacheHits = 0;
    this.lastAccountId = undefined;
    this.log = [];
    this.extraUsage.clear();
    this.lastError = undefined;
    this.lastErrorAt = undefined;
  }
}
