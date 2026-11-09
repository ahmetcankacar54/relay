// Kept free of browser-only imports so it can be unit tested under Node.

type T = (tr: string, en: string) => string;

import { clientHost, gatewayUrl } from "../../shared/proxy-url";

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
 * way Claude Code talks to an LLM gateway. The key stays hidden when `mask` is set.
 */
export function claudeCodeSnippet(host: string, port: number, key: string | undefined, mask = false): string {
  const shown = key ? (mask ? maskKey(key) : key) : "<relay-key>";
  return `export ANTHROPIC_BASE_URL=${gatewayUrl(host, port)} && export ANTHROPIC_AUTH_TOKEN=${shown}`;
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
  if (minutes <= 0) return t("şimdi", "now");
  const days = Math.floor(minutes / 1_440);
  if (days >= 1) return t(`${days} gün ${Math.floor((minutes % 1_440) / 60)} sa`, `${days} d ${Math.floor((minutes % 1_440) / 60)} h`);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours
    ? t(`${hours} sa${rest ? ` ${rest} dk` : ""}`, `${hours} h${rest ? ` ${rest} min` : ""}`)
    : t(`${rest} dk`, `${rest} min`);
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
  if (seconds < 60) return t(`${seconds} sn önce`, `${seconds} s ago`);
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t(`${minutes} dk önce`, `${minutes} min ago`);
  return t(`${Math.round(minutes / 60)} sa önce`, `${Math.round(minutes / 60)} h ago`);
}

/**
 * 1.2K, 3.4M: a token count that fits a narrow column. Always the K/M/B letters: Turkish
 * compact "412 B" (bin) reads as bytes; only the decimal mark follows the language.
 */
export function compactCount(value: number, locale: string): string {
  const text = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
  return locale.startsWith("tr") ? text.replace(".", ",") : text;
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

/** Moves `id` one place up (-1) or down (+1) in `order`; the same order when it cannot move. */
export function moveInOrder(order: readonly string[], id: string, by: -1 | 1): string[] {
  const next = [...order];
  const from = next.indexOf(id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= next.length) return next;
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}
