import { DEFAULT_PROXY_CONFIG, type ProxySessionState } from "../../../shared/proxy-types";

export interface SessionCacheOptions {
  ttlSeconds?: number;
  /** Upper bound on remembered sessions; the least recently used go first. */
  maxEntries?: number;
  now?: () => number;
}

export const DEFAULT_MAX_SESSIONS = 10_000;

export class ProxySessionCache {
  /** Insertion order is last-use order: a touched session is re-inserted at the end. */
  private sessions = new Map<string, ProxySessionState>();
  private ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: SessionCacheOptions = {}) {
    this.ttlMs = (options.ttlSeconds ?? DEFAULT_PROXY_CONFIG.affinityTtlSeconds) * 1000;
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_SESSIONS);
    this.now = options.now ?? Date.now;
  }

  setTtl(ttlSeconds: number): void {
    if (Number.isFinite(ttlSeconds) && ttlSeconds > 0)
      this.ttlMs = ttlSeconds * 1000;
  }

  /**
   * Retrieves an active account assigned to this sessionKey if it hasn't expired.
   */
  get(sessionKey: string): string | undefined {
    const now = this.now();
    const existing = this.sessions.get(sessionKey);
    if (!existing) return undefined;
    if (now - existing.lastActiveAt > this.ttlMs) {
      this.sessions.delete(sessionKey);
      return undefined;
    }
    existing.lastActiveAt = now;
    existing.requestCount += 1;
    this.sessions.delete(sessionKey);
    this.sessions.set(sessionKey, existing);
    return existing.accountId;
  }

  /** The account a live session is bound to, without counting it as a use. */
  peek(sessionKey: string): string | undefined {
    const existing = this.sessions.get(sessionKey);
    if (!existing || this.now() - existing.lastActiveAt > this.ttlMs) return undefined;
    return existing.accountId;
  }

  /**
   * Binds a sessionKey to a specific accountId.
   */
  set(sessionKey: string, accountId: string): void {
    const now = this.now();
    const existing = this.sessions.get(sessionKey);
    this.sessions.delete(sessionKey);
    this.sessions.set(
      sessionKey,
      existing
        ? {
            ...existing,
            accountId,
            lastActiveAt: now,
            requestCount: existing.requestCount + 1,
          }
        : {
            sessionKey,
            accountId,
            assignedAt: now,
            lastActiveAt: now,
            requestCount: 1,
          },
    );
    this.prune();
    while (this.sessions.size > this.maxEntries) {
      const oldest = this.sessions.keys().next();
      if (oldest.done) break;
      this.sessions.delete(oldest.value);
    }
  }

  /**
   * Removes affinity for a specific accountId when it hits rate limits or quota exhaustion.
   */
  evictAccount(accountId: string): number {
    let evicted = 0;
    for (const [key, session] of this.sessions.entries()) {
      if (session.accountId === accountId) {
        this.sessions.delete(key);
        evicted += 1;
      }
    }
    return evicted;
  }

  /**
   * Explicitly evicts a single sessionKey.
   */
  evictSession(sessionKey: string): boolean {
    return this.sessions.delete(sessionKey);
  }

  /**
   * Returns a snapshot of all active sessions.
   */
  list(): ProxySessionState[] {
    this.prune();
    return Array.from(this.sessions.values(), (session) => ({ ...session }));
  }

  /**
   * Returns count of active non-expired sessions.
   */
  count(): number {
    this.prune();
    return this.sessions.size;
  }

  clear(): void {
    this.sessions.clear();
  }

  /** Drops expired sessions from the old end; stops at the first live one. */
  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, session] of this.sessions.entries()) {
      if (session.lastActiveAt >= cutoff) break;
      this.sessions.delete(key);
    }
  }
}
