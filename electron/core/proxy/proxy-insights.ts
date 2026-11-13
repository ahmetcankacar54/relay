import type {
  CacheMissReason,
  ProxyLoopAlarm,
  ProxySessionView,
} from "../../../shared/proxy-types";
import type { TokenTally } from "./upstream-common";

const HOUR_MS = 3_600_000;
const FIVE_MINUTES_MS = 5 * 60_000;
const MAX_SESSIONS = 500;
const MAX_PROMPTS = 300;
/** Claude Code's own rule: a rewrite counts as a miss past 5 % of the prompt and 2,000 tokens. */
const MISS_SHARE = 0.05;
const MISS_TOKENS = 2_000;
/**
 * One prompt with this many requests, or this many subagents, may be going round in circles. A
 * long autonomous task can run a few hundred turns on one prompt, so the bounds sit above that.
 */
export const LOOP_REQUESTS = 500;
export const LOOP_SUBAGENTS = 40;
/** An alarm stays on show this long after its prompt's last request. */
const ALARM_SHOWN_MS = 30 * 60_000;
/** The pace is read over the last half hour, from at least ten minutes of readings. */
const PACE_WINDOW_MS = 30 * 60_000;
const PACE_MIN_SPAN_MS = 10 * 60_000;
const MAX_PACE_POINTS = 120;

/** The first characters of an id, enough to tell sessions apart on screen. */
const shortId = (value: string) => value.replace(/^hdr:/, "").slice(0, 8);

interface SessionState {
  id: string;
  accountId: string;
  model?: string;
  lastAt: number;
  prefixTokens: number;
  ttlMs: number;
  requests: number;
  subagents: Set<string>;
  misses: number;
  lastMiss?: ProxySessionView["lastMiss"];
}

interface PromptState {
  id: string;
  sessionId?: string;
  accountId?: string;
  since: number;
  lastAt: number;
  requests: number;
  agents: Set<string>;
  alarmed: boolean;
}

/** One answer through the gateway, as far as the session's cache and the prompt go. */
export interface AnswerFacts {
  at: number;
  /** The gateway's session key (`hdr:<Claude Code session id>`). */
  sessionKey?: string;
  accountId: string;
  model?: string;
  requestClass?: string;
  /** Set on a subagent's requests: they do not touch the main conversation's cache. */
  agentId?: string;
  /** A compaction, or the first request after one: its prompt is new by design. */
  compacted?: boolean;
  tokens?: TokenTally;
}

/**
 * What the gateway learns from its traffic, in memory: each session's prompt cache (how big,
 * how long it lives, when it was written again and why), each prompt's request and subagent
 * counts (a loop alarm past a bound), and each account's pace from the windows its answers
 * report.
 */
export class GatewayInsights {
  private sessions = new Map<string, SessionState>();
  private prompts = new Map<string, PromptState>();
  private pace = new Map<string, { at: number; percent: number; resetsAt?: number }[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * One request arrived for a prompt. Answers the alarm when this request takes the prompt past
   * a bound for the first time.
   */
  countPrompt(
    promptId: string | undefined,
    facts: { sessionKey?: string; agentId?: string },
  ): ProxyLoopAlarm | undefined {
    if (!promptId) return undefined;
    const now = this.now();
    let prompt = this.prompts.get(promptId);
    if (!prompt) {
      prompt = {
        id: shortId(promptId),
        ...(facts.sessionKey ? { sessionId: shortId(facts.sessionKey) } : {}),
        since: now,
        lastAt: now,
        requests: 0,
        agents: new Set(),
        alarmed: false,
      };
      this.prompts.set(promptId, prompt);
      this.trim(this.prompts, MAX_PROMPTS, (p) => p.lastAt);
    }
    prompt.requests += 1;
    prompt.lastAt = now;
    if (facts.agentId && prompt.agents.size < LOOP_SUBAGENTS * 4) prompt.agents.add(facts.agentId);
    if (prompt.alarmed || (prompt.requests < LOOP_REQUESTS && prompt.agents.size < LOOP_SUBAGENTS))
      return undefined;
    prompt.alarmed = true;
    return this.alarmOf(prompt);
  }

  /** The account that served a prompt's latest request, for its alarm. */
  promptServedBy(promptId: string | undefined, accountId: string): void {
    const prompt = promptId ? this.prompts.get(promptId) : undefined;
    if (prompt) prompt.accountId = accountId;
  }

  /**
   * One answer with its tokens. A main-conversation answer that wrote again what the last one
   * left in the cache is a miss: the account changed, the model changed, the cache lived out
   * its time, or something else in the prompt changed. Answers the miss.
   */
  observeAnswer(facts: AnswerFacts): { reason: CacheMissReason; tokens: number } | undefined {
    if (!facts.sessionKey || !facts.tokens) return undefined;
    let session = this.sessions.get(facts.sessionKey);
    if (!session) {
      session = {
        id: shortId(facts.sessionKey),
        accountId: facts.accountId,
        lastAt: facts.at,
        prefixTokens: 0,
        ttlMs: FIVE_MINUTES_MS,
        requests: 0,
        subagents: new Set(),
        misses: 0,
      };
      this.sessions.set(facts.sessionKey, session);
      this.trim(this.sessions, MAX_SESSIONS, (s) => s.lastAt);
    }
    session.requests += 1;
    if (facts.agentId) {
      if (session.subagents.size < 1_000) session.subagents.add(facts.agentId);
      session.lastAt = Math.max(session.lastAt, facts.at);
      return undefined;
    }
    // Titles, classifiers and other background requests carry the session's id with a short
    // prompt of their own: they say nothing about the conversation's cache. Without Claude
    // Code's hints every request counts as the conversation's.
    if (facts.requestClass && facts.requestClass !== "main" && facts.requestClass !== "compaction") {
      session.lastAt = Math.max(session.lastAt, facts.at);
      return undefined;
    }
    const read = facts.tokens.cacheRead ?? 0;
    const write = facts.tokens.cacheWrite ?? 0;
    const prompt = read + write + (facts.tokens.input ?? 0);
    let miss: { reason: CacheMissReason; tokens: number } | undefined;
    const lost = session.prefixTokens - read;
    if (
      session.prefixTokens > 0 &&
      !facts.compacted &&
      facts.requestClass !== "compaction" &&
      write > 0 &&
      // A prompt that shrank was shortened on purpose (compacted, cleared, rewound): its new
      // tail is written by design. A miss is a prompt as long as before that was not read.
      prompt >= session.prefixTokens * 0.9 &&
      lost > Math.max(MISS_TOKENS, session.prefixTokens * MISS_SHARE)
    ) {
      const reason: CacheMissReason =
        session.accountId !== facts.accountId
          ? "account"
          : session.model && facts.model && session.model !== facts.model
            ? "model"
            : facts.at - session.lastAt > session.ttlMs
              ? "expired"
              : "unknown";
      miss = { reason, tokens: Math.min(lost, write) };
      session.misses += 1;
      session.lastMiss = { at: facts.at, ...miss };
    }
    session.prefixTokens = prompt;
    session.accountId = facts.accountId;
    if (facts.model) session.model = facts.model;
    session.lastAt = facts.at;
    // A write sets how long the cache lives; a read alone keeps (and refreshes) it.
    if ((facts.tokens.cacheWrite1h ?? 0) > 0) session.ttlMs = HOUR_MS;
    else if (write > 0) session.ttlMs = FIVE_MINUTES_MS;
    return miss;
  }

  /** The sessions heard from most recently, newest first. */
  sessionViews(limit = 8): ProxySessionView[] {
    return [...this.sessions.values()]
      .filter((s) => s.prefixTokens > 0)
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, limit)
      .map((s) => ({
        id: s.id,
        accountId: s.accountId,
        ...(s.model ? { model: s.model } : {}),
        lastAt: s.lastAt,
        prefixTokens: s.prefixTokens,
        ttlMs: s.ttlMs,
        requests: s.requests,
        subagents: s.subagents.size,
        misses: s.misses,
        ...(s.lastMiss ? { lastMiss: { ...s.lastMiss } } : {}),
      }));
  }

  /** Prompts past a bound whose last request was within the last half hour. */
  alarms(): ProxyLoopAlarm[] {
    const now = this.now();
    return [...this.prompts.values()]
      .filter((p) => p.alarmed && now - p.lastAt <= ALARM_SHOWN_MS)
      .sort((a, b) => b.lastAt - a.lastAt)
      .map((p) => this.alarmOf(p));
  }

  /** An account's 5-hour window as an answer reported it. */
  observeLimits(accountId: string, fiveHour: { usedPercent: number; resetsAt?: string } | undefined): void {
    if (!fiveHour) return;
    const at = this.now();
    const reset = fiveHour.resetsAt ? Date.parse(fiveHour.resetsAt) : NaN;
    const point = { at, percent: fiveHour.usedPercent, ...(Number.isFinite(reset) ? { resetsAt: reset } : {}) };
    let points = this.pace.get(accountId) ?? [];
    const last = points[points.length - 1];
    // A new window began: the old readings say nothing about its pace.
    if (
      last &&
      (point.percent < last.percent ||
        (last.resetsAt !== undefined && point.resetsAt !== undefined && point.resetsAt - last.resetsAt >= HOUR_MS))
    )
      points = [];
    points.push(point);
    points = points.filter((p) => at - p.at <= PACE_WINDOW_MS).slice(-MAX_PACE_POINTS);
    this.pace.set(accountId, points);
  }

  /**
   * When the account's 5-hour window fills at the pace of the last half hour: only when that is
   * before the window resets, and from at least ten minutes of readings that rose.
   */
  fullAt(accountId: string): number | undefined {
    const now = this.now();
    const points = (this.pace.get(accountId) ?? []).filter((p) => now - p.at <= PACE_WINDOW_MS);
    if (points.length < 2) return undefined;
    const first = points[0];
    const last = points[points.length - 1];
    const span = last.at - first.at;
    const rise = last.percent - first.percent;
    if (span < PACE_MIN_SPAN_MS || rise < 1 || last.percent >= 100) return undefined;
    const at = Math.round(last.at + ((100 - last.percent) * span) / rise);
    return last.resetsAt === undefined || at < last.resetsAt ? at : undefined;
  }

  private alarmOf(prompt: PromptState): ProxyLoopAlarm {
    return {
      id: prompt.id,
      ...(prompt.sessionId ? { sessionId: prompt.sessionId } : {}),
      ...(prompt.accountId ? { accountId: prompt.accountId } : {}),
      since: prompt.since,
      lastAt: prompt.lastAt,
      requests: prompt.requests,
      subagents: prompt.agents.size,
    };
  }

  /** Drops the entries heard from longest ago past `max`. */
  private trim<T>(map: Map<string, T>, max: number, lastAt: (value: T) => number): void {
    if (map.size <= max) return;
    const oldest = [...map.entries()].sort((a, b) => lastAt(a[1]) - lastAt(b[1])).slice(0, map.size - max);
    for (const [key] of oldest) map.delete(key);
  }
}
