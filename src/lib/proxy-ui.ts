// Kept free of browser-only imports so it can be unit tested under Node.


import { clientHost, gatewayUrl } from "../../shared/proxy-url";
import type { ProxyPick, ProxyPickReason } from "../../shared/proxy-types";
import type { MessageId, T } from "../../shared/i18n/translate";
import { hoursMinutes } from "./time";

export { clientHost, gatewayUrl };

export const isLoopbackHost = (host: string) =>
  host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);

/** The key with all but its prefix and last four characters hidden. */
export function maskKey(key: string): string {
  const prefix = /^relay-sec-/.exec(key)?.[0] ?? "";
  const rest = key.slice(prefix.length);
  return rest.length <= 4 ? `${prefix}${"•".repeat(rest.length)}` : `${prefix}${"•".repeat(12)}${rest.slice(-4)}`;
}

/**
 * Claude Code CLI: point it at the gateway. ANTHROPIC_AUTH_TOKEN is sent as a bearer token, the
 * way Claude Code talks to an LLM gateway; behind one it caches for 5 minutes unless told 1 hour.
 * The key stays hidden when `mask` is set.
 */
export function claudeCodeSnippet(host: string, port: number, key: string | undefined, mask = false): string {
  const shown = key ? (mask ? maskKey(key) : key) : "<relay-key>";
  return `export ANTHROPIC_BASE_URL=${gatewayUrl(host, port)} && export ANTHROPIC_AUTH_TOKEN=${shown} && export CLAUDE_CODE_PROMPT_CACHE_TTL=1h`;
}

/** Cursor, VS Code and other OpenAI-compatible clients: base URL (with /v1) and key. */
export function openAiSnippet(host: string, port: number, key: string | undefined, mask = false): string {
  const shown = key ? (mask ? maskKey(key) : key) : "<relay-key>";
  return [`Base URL: ${gatewayUrl(host, port)}/v1`, `API key:  ${shown}`].join("\n");
}

/** What a port field holds: a whole number from 1 to 65535. */
export function parsePort(value: string): number | undefined {
  const text = value.trim();
  if (!/^\d{1,5}$/.test(text)) return undefined;
  const port = Number(text);
  return port >= 1 && port <= 65_535 ? port : undefined;
}

/** What a host field holds: an address, with no spaces or URL punctuation. */
export const validHost = (value: string) => {
  const host = value.trim();
  return host.length > 0 && host.length <= 255 && !/[\s/@?#]/.test(host);
};

/** "2 sa 10 dk" / "2 h 10 min" until a reset; "şimdi" at zero. */
export function resetLabel(minutes: number | undefined, t: T): string {
  if (minutes === undefined) return "—";
  if (minutes <= 0) return t("proxyUi.now");
  const days = Math.floor(minutes / 1_440);
  if (days >= 1) return t("libTime.dH", { days, hours: Math.floor((minutes % 1_440) / 60) });
  return hoursMinutes(Math.floor(minutes / 60), minutes % 60, t);
}

/** Codex, Cursor and the OpenAI SDK read the base URL (with /v1) and the key from the environment. */
export function codexSnippet(host: string, port: number, key: string | undefined, mask = false): string {
  const shown = key ? (mask ? maskKey(key) : key) : "<relay-key>";
  return `export OPENAI_BASE_URL=${gatewayUrl(host, port)}/v1 && export OPENAI_API_KEY=${shown}`;
}

/**
 * Lists the models the Antigravity accounts serve, through the gateway: the names to use in a
 * request. Antigravity OAuth runs behind Relay; this key only authenticates the local client.
 */
export function antigravitySnippet(host: string, port: number, key: string | undefined, mask = false): string {
  const shown = key ? (mask ? maskKey(key) : key) : "<relay-key>";
  return `curl ${gatewayUrl(host, port)}/v1/models -H "Authorization: Bearer ${shown}" -H "x-relay-provider: antigravity"`;
}

/** A one-line request that proves the gateway answers. */
export function proxyCurlSnippet(host: string, port: number, key: string | undefined, mask = false): string {
  const shown = key ? (mask ? maskKey(key) : key) : "<relay-key>";
  return [
    `curl ${gatewayUrl(host, port)}/v1/messages`,
    `  -H "x-api-key: ${shown}"`,
    `  -H "anthropic-version: 2023-06-01"`,
    `  -H "content-type: application/json"`,
    `  -d '{"model":"claude-sonnet-4-5","max_tokens":16,"messages":[{"role":"user","content":"ping"}]}'`,
  ].join(" \\\n");
}

/** How a quota reads at a glance: room left, running low, nearly full; "none" while unknown. */
export function quotaTone(percent: number | undefined): "ok" | "warn" | "crit" | "none" {
  if (percent === undefined || !Number.isFinite(percent)) return "none";
  return percent >= 90 ? "crit" : percent >= 75 ? "warn" : "ok";
}

/** "4 sn önce" / "4 s ago": how long ago a request was answered. */
export function agoLabel(at: number, now: number, t: T): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return t("proxyUi.sAgo", { seconds });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("proxyUi.minAgo", { minutes });
  return t("proxyUi.hAgo", { hours: Math.round(minutes / 60) });
}

/**
 * 1.2K, 3.4M: a token count that fits a narrow column. Always the K/M/B letters: Turkish
 * compact "412 B" (bin) reads as bytes; only the decimal mark follows the language.
 */
export function compactCount(value: number, locale: string): string {
  const text = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
  const mark = new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === "decimal")?.value ?? ".";
  return text.replace(".", mark);
}

/** Within this many minutes of a weekly reset, room left on the window is about to be lost. */
export const WASTE_WINDOW_MINUTES = 48 * 60;
/** Room left (percent) that is worth a warning when the weekly window is about to reset. */
export const WASTE_MIN_PERCENT = 25;

/**
 * The weekly room an account will lose at its next reset if nobody uses it: the percent left and
 * the minutes until the reset; undefined when the reset is far off or little is left. Claude's
 * resets only refill: what is left at the reset is gone, so this account should go first.
 */
export function quotaAtRisk(account: {
  weeklyPercent?: number;
  weeklyResetMinutes?: number;
}): { percent: number; minutes: number } | undefined {
  const { weeklyPercent, weeklyResetMinutes } = account;
  if (weeklyPercent === undefined || weeklyResetMinutes === undefined) return undefined;
  const left = Math.max(0, 100 - weeklyPercent);
  if (weeklyResetMinutes > WASTE_WINDOW_MINUTES || left < WASTE_MIN_PERCENT) return undefined;
  return { percent: left, minutes: weeklyResetMinutes };
}

/**
 * Moves `id` past the next account of its own provider, up (-1) or down (+1): the pool shows each
 * provider on its own, so a move never jumps over another provider's accounts it cannot see. The
 * same order when it cannot move.
 */
export function moveWithinProvider(
  accounts: readonly { id: string; provider?: string }[],
  id: string,
  by: -1 | 1,
): string[] {
  const order = accounts.map((a) => a.id);
  const provider = accounts.find((a) => a.id === id)?.provider ?? "claude";
  const same = accounts.filter((a) => (a.provider ?? "claude") === provider).map((a) => a.id);
  const other = same[same.indexOf(id) + by];
  if (!same.includes(id) || !other) return order;
  const i = order.indexOf(id);
  const j = order.indexOf(other);
  [order[i], order[j]] = [order[j], order[i]];
  return order;
}

/** Moves `id` one place up (-1) or down (+1) in `order`; the same order when it cannot move. */
export function moveInOrder(order: readonly string[], id: string, by: -1 | 1): string[] {
  const next = [...order];
  const from = next.indexOf(id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= next.length) return next;
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

const CLIENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  "agent-sdk": "Agent SDK",
  codex: "Codex",
  omp: "omp",
};
const CLASS_LABELS: Record<string, MessageId> = {
  main: "proxyUi.classMain",
  subagent: "proxyUi.classSubagent",
  compaction: "proxyUi.classCompaction",
  auxiliary: "proxyUi.classAuxiliary",
  workflow: "proxyUi.classWorkflow",
};

/**
 * One request's details for the feed: who sent it, Claude Code's label for it, how long it took
 * and its tokens (with the share read from the cache), or why it was turned down.
 */
export function requestDetail(
  entry: {
    client?: string;
    requestClass?: string;
    ms?: number;
    note?: string;
    tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    cost?: number;
    miss?: { reason: string; tokens: number };
  },
  t: T,
  locale: string,
  /** The serving account's dollars per percent of its 5-hour window, when known. */
  dollarsPerPercent?: number,
): string {
  const parts: string[] = [];
  if (entry.client) parts.push(CLIENT_LABELS[entry.client] ?? entry.client);
  if (entry.requestClass) {
    const label = CLASS_LABELS[entry.requestClass];
    parts.push(label ? t(label) : entry.requestClass);
  }
  if (entry.ms !== undefined) {
    const seconds = (entry.ms / 1000).toLocaleString(locale, { maximumFractionDigits: 1 });
    parts.push(entry.ms < 1000 ? `${entry.ms} ms` : t("proxyUi.s", { seconds }));
  }
  const tokens = entry.tokens;
  if (tokens) {
    const sent = (tokens.input ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0);
    if (sent) {
      const cached = Math.round(((tokens.cacheRead ?? 0) / sent) * 100);
      const amount = compactCount(sent, locale);
      parts.push(
        cached
          ? t("proxyUi.inCached", { amount, cached })
          : t("proxyUi.in", { amount }),
      );
    }
    if (tokens.output) {
      const amount = compactCount(tokens.output, locale);
      parts.push(t("proxyUi.out", { amount }));
    }
  }
  if (entry.cost !== undefined && entry.cost > 0) parts.push(`≈ ${usd(entry.cost, locale)}`);
  if (entry.miss) {
    const amount = compactCount(entry.miss.tokens, locale);
    const why = t(MISS_LABELS[entry.miss.reason] ?? MISS_LABELS.unknown);
    parts.push(
      dollarsPerPercent && entry.cost
        ? t("proxyUi.cacheMissWrittenAgainShare", { why, amount, windowShare: windowShare(entry.cost / dollarsPerPercent, t, locale) })
        : t("proxyUi.cacheMissWrittenAgain", { why, amount }),
    );
  }
  if (entry.note === "refused")
    parts.push(t("proxyUi.notALimitAnthropicTurnedThe"));
  if (entry.note === "cold-move")
    parts.push(t("proxyUi.itsCacheWasColdMovedOff"));
  return parts.join(" · ");
}

/** How the gateway chose an account that was not the session's own, in words. */
const PICK_LABELS: Record<Exclude<ProxyPickReason, "bound">, MessageId> = {
  "soonest-reset": "proxyUi.pickedSoonestReset",
  balanced: "proxyUi.pickedBalanced",
  priority: "proxyUi.pickedPriority",
  only: "proxyUi.pickedOnly",
};

/** A routing reason alone, for the pool's next-session line: what the strategy looks for. */
const REASON_LABELS: Record<ProxyPickReason, MessageId> = {
  bound: "proxyUi.reasonBound",
  "soonest-reset": "proxyUi.reasonSoonestReset",
  balanced: "proxyUi.reasonBalanced",
  priority: "proxyUi.reasonPriority",
  only: "proxyUi.reasonOnly",
};
export function pickReasonLabel(reason: ProxyPickReason, t: T): string {
  return t(REASON_LABELS[reason]);
}

/**
 * Why the gateway gave a request its account, in a few words: how it was picked, which accounts
 * it passed over and why. Nothing for a session that simply stayed on its account.
 */
export function pickLine(
  pick: ProxyPick | undefined,
  nameOf: (accountId: string) => string | undefined,
  t: T,
): string {
  if (!pick) return "";
  const names = (list: readonly string[]) => list.map((id) => nameOf(id) ?? "?").join(", ");
  const parts: string[] = [];
  if (pick.reason !== "bound") parts.push(t(PICK_LABELS[pick.reason]));
  if (pick.moved && pick.from) {
    const from = names([pick.from]);
    parts.push(
      {
        limit: t("proxyUi.atItsLimitSessionMoved", { from }),
        cold: t("proxyUi.cacheHadExpiredMovedOffAt", { from }),
        drain: t("proxyUi.nearItsLimitMovedAtA", { from }),
        rebalance: t("proxyUi.movedOffAtANewPrompt", { from }),
      }[pick.moved],
    );
  }
  if (pick.overflow) parts.push(t("proxyUi.subagentKeptOffItsSessionS"));
  if (pick.after) parts.push(t("proxyUi.triedFirst", { names: names([pick.after]) }));
  if (pick.boundWaiting)
    parts.push(
      t("proxyUi.itsSessionSAccountIsWaiting", { names: names([pick.boundWaiting]) }),
    );
  if (pick.nearlyFull?.length)
    parts.push(t("proxyUi.nearTheLimitPassedOver", { names: names(pick.nearlyFull) }));
  if (pick.noSignIn?.length)
    parts.push(t("proxyUi.signInUnreadable", { names: names(pick.noSignIn) }));
  return parts.join(" · ");
}

/** Why a session's cache was written again, in words. */
const MISS_LABELS: Record<string, MessageId> = {
  account: "proxyUi.missAccount",
  model: "proxyUi.missModel",
  expired: "proxyUi.missExpired",
  unknown: "proxyUi.missUnknown",
};

/** A share of a 5-hour window, without a suffix: "~%0,4", "<%0,1". */
export function windowShare(percent: number, t: T, locale: string): string {
  if (percent < 0.1) return t("proxyUi.n01");
  const text = percent.toLocaleString(locale, { maximumFractionDigits: percent < 10 ? 1 : 0 });
  return t("proxyUi.msg", { text });
}

/** An API-price amount, with the locale's decimal mark: three decimals under ten cents. */
export function usd(amount: number, locale: string): string {
  const digits = amount < 0.095 ? 3 : 2;
  return `$${amount.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/**
 * Today's gateway traffic by request class, as shares: of the API-price cost when the answers
 * have one, else of the tokens.
 */
export function classShareLine(
  shares: { requestClass: string; tokens: number; cost: number }[],
  t: T,
): string {
  const byCost = shares.some((share) => share.cost > 0);
  const total = shares.reduce((sum, share) => sum + (byCost ? share.cost : share.tokens), 0);
  if (!total) return "";
  const parts = shares
    .map((share) => ({ share, part: Math.round(((byCost ? share.cost : share.tokens) / total) * 100) }))
    .filter(({ part }) => part > 0)
    .map(({ share, part }) => {
      const label = CLASS_LABELS[share.requestClass];
      const name = label ? t(label) : share.requestClass === "other" ? t("proxyUi.other") : share.requestClass;
      return t("proxyUi.msg2", { name, part });
    });
  return byCost
    ? t("proxyUi.todayAtApiPrices", { join: parts.join(" · ") })
    : t("proxyUi.todayInTokens", { join: parts.join(" · ") });
}

/**
 * A session's prompt cache in words: warm with the minutes it has left, or cold with what
 * coming back would write again; plus its size, subagents and misses.
 */
export function sessionCacheLine(
  session: {
    lastAt: number;
    ttlMs: number;
    prefixTokens: number;
    subagents: number;
    misses: number;
    lastMiss?: { reason: string };
    moveCost?: { dollars: number; percent?: number };
  },
  now: number,
  t: T,
  locale: string,
): { warm: boolean; state: string; detail: string } {
  const left = session.lastAt + session.ttlMs - now;
  const warm = left > 0;
  const size = compactCount(session.prefixTokens, locale);
  const minutes = Math.max(1, Math.ceil(left / 60_000));
  const lifetime = session.ttlMs >= 3_600_000 ? t("proxyUi.n1Hour") : t("proxyUi.n5Minute");
  const cost = !session.moveCost
    ? ""
    : session.moveCost.percent !== undefined
      ? t("proxyUi.costShare", { usd: usd(session.moveCost.dollars, locale), windowShare: windowShare(session.moveCost.percent, t, locale) })
      : `≈ ${usd(session.moveCost.dollars, locale)}`;
  const parts = [
    agoLabel(session.lastAt, now, t),
    warm
      ? t("proxyUi.tokensCached", { size, lifetime })
      : cost
        ? t("proxyUi.comingBackWritesTokensAgainCost", { size, cost })
        : t("proxyUi.comingBackWritesTokensAgain", { size }),
  ];
  if (warm && cost) parts.push(t("proxyUi.movingItToAnotherAccount", { cost }));
  if (session.subagents) parts.push(t("proxyUi.subagents", { sessionSubagents: session.subagents }));
  if (session.misses) {
    const why = t(MISS_LABELS[session.lastMiss?.reason ?? "unknown"] ?? MISS_LABELS.unknown);
    parts.push(t("proxyUi.missesLast", { sessionMisses: session.misses, why }));
  }
  return {
    warm,
    state: warm ? t("proxyUi.warmMin", { minutes }) : t("proxyUi.cold"),
    detail: parts.join(" · "),
  };
}

/** "A, B and C": commas, and the word only before the last name. */
export function nameList(names: readonly string[], t: T): string {
  return names.length > 1 ? t("proxyUi.namesAnd", { names: names.slice(0, -1).join(", "), last: names[names.length - 1] }) : names.join("");
}

const BOUND_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex CLI", omp: "omp" };

/**
 * The Overview's line about the gateway: which tools go through it and where its last request
 * went, since they do not follow the account open in the Claude app; or that a tool is bound
 * while the gateway is off. Nothing when there is nothing to say.
 */
export function gatewayLine(
  status:
    | {
        running: boolean;
        clients?: { id: string; bound: boolean }[];
        recent?: { at: number; accountId?: string }[];
        accounts: { id: string; name: string }[];
      }
    | undefined,
  t: T,
  now: number,
): { tone: "ok" | "crit"; text: string } | undefined {
  if (!status) return undefined;
  const bound = (status.clients ?? []).filter((c) => c.bound).map((c) => BOUND_NAMES[c.id] ?? c.id);
  const names = nameList(bound, t);
  const count = bound.length;
  if (!status.running)
    return count ? { tone: "crit", text: t("proxyUi.boundToTheGatewayButIt", { names, count }) } : undefined;
  const last = status.recent?.find((entry) => entry.accountId);
  const lastName = last && status.accounts.find((a) => a.id === last.accountId)?.name;
  const lastText = last && lastName
    ? t("proxyUi.lastRequest", { lastName, agoLabel: agoLabel(last.at, now, t) })
    : undefined;
  if (!bound.length)
    return lastText ? { tone: "ok", text: t("proxyUi.gatewayOn", { lastText }) } : undefined;
  const head = t("proxyUi.throughTheGatewayNotTheClaude", { names, count });
  return { tone: "ok", text: lastText ? `${head} · ${lastText}` : head };
}
