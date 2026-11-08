import type {
  AccountTokenMetrics,
  ProxyMetrics,
} from "../../../shared/proxy-types";

const MAX_ERROR_LENGTH = 500;

/** Counters per account id; the keys are the registry's accounts, so the maps stay small. */
export class ProxyStats {
  private totalRequests = 0;
  private requestsByAccount = new Map<string, number>();
  private tokensByAccount = new Map<string, AccountTokenMetrics>();
  private lastError?: string;
  private lastErrorAt?: number;
  private activeRequests = 0;
  private promptCacheHits = 0;
  private lastAccountId?: string;

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
      totalPrompt += v.input + v.cacheRead;
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
    this.lastError = undefined;
    this.lastErrorAt = undefined;
  }
}
