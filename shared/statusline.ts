import path from "node:path";

/**
 * Claude Code's status line, as `relay statusline` prints it. Relay.app writes a small snapshot,
 * `<userData>/statusline.json`, every time what it shows may have changed; the command reads that
 * file and the JSON Claude Code passes on stdin, and nothing else: no network, no Keychain, no
 * account list. Claude Code runs the command after every answer, so it must stay well under 100 ms,
 * which is why this module imports no catalog: the app writes every label already translated.
 */

/** The snapshot's file name in Relay's data folder. */
export const STATUSLINE_FILE = "statusline.json";
/** The layout this reader understands. */
export const STATUSLINE_SNAPSHOT_VERSION = 1;
/** Past this age the line says when Relay last wrote it: the app may be closed. */
export const STATUSLINE_STALE_MS = 15 * 60_000;
/** Sessions the gateway routed that the snapshot remembers, the most recent first. */
export const STATUSLINE_GATEWAY_SESSIONS = 200;

/** A limit period as Relay last read it. */
export interface StatuslineWindow {
  /** Percent used, 0–100, rounded down. */
  used: number;
  /** When the period renews, epoch milliseconds. */
  resetsAt?: number;
  /** "resets 14:30" / "14:30’da yenilenir", in the app's language and time zone. */
  resets?: string;
}

/** A Claude account Claude Code can be on. */
export interface StatuslineAccount {
  id: string;
  name: string;
  /** The Claude sign-ins (person and organization, lowercase) that are this account's. */
  identities: { accountUuid: string; orgId: string }[];
  fiveHour?: StatuslineWindow;
  week?: StatuslineWindow;
}

export interface StatuslineSnapshot {
  version: typeof STATUSLINE_SNAPSHOT_VERSION;
  generatedAt: number;
  /** The BCP 47 tag the texts are in; numbers and ages are formatted with it at read time. */
  formatLocale: string;
  /** Relay's account profiles folder: a CLAUDE_CONFIG_DIR inside it is that account (`relay run`). */
  profiles: string;
  /** The account open in the Claude app. */
  desktopAccountId?: string;
  /** The terminal's `claude` follows the Claude app's account at a switch. */
  terminalFollows: boolean;
  accounts: StatuslineAccount[];
  /** While the gateway runs: each Claude Code session id it served, and the account it last used. */
  gateway?: { sessions: Record<string, string> };
  /** Templates in the app's language; `{percent}`, `{age}` are filled in here. */
  text: {
    fiveHour: string;
    week: string;
    viaGateway: string;
    updatedAgo: string;
  };
}

/** The parts of Claude Code's status line JSON Relay reads. */
export interface StatuslineInput {
  session_id?: string;
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number };
    seven_day?: { used_percentage?: number; resets_at?: number };
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Claude Code's stdin JSON; anything unreadable is an empty object, so the line still shows. */
export function parseStatuslineInput(text: string | undefined): StatuslineInput {
  if (!text?.trim()) return {};
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? (value as StatuslineInput) : {};
  } catch {
    return {};
  }
}

/** The snapshot, or undefined when the file is missing, unreadable or another layout. */
export function parseStatuslineSnapshot(text: string | undefined): StatuslineSnapshot | undefined {
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (
      !isObject(value) ||
      value.version !== STATUSLINE_SNAPSHOT_VERSION ||
      typeof value.generatedAt !== "number" ||
      !Array.isArray(value.accounts) ||
      !isObject(value.text)
    )
      return undefined;
    return value as unknown as StatuslineSnapshot;
  } catch {
    return undefined;
  }
}

/** Who Claude Code is signed in to, from its `.claude.json` (`oauthAccount`); undefined when signed out. */
export function claudeSignIn(text: string | undefined): { accountUuid: string; orgId: string } | undefined {
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    const account = isObject(value) ? value.oauthAccount : undefined;
    if (!isObject(account)) return undefined;
    const { accountUuid, organizationUuid } = account;
    return typeof accountUuid === "string" && typeof organizationUuid === "string"
      ? { accountUuid: accountUuid.toLowerCase(), orgId: organizationUuid.toLowerCase() }
      : undefined;
  } catch {
    return undefined;
  }
}

const samePath = (a: string, b: string) => {
  const norm = (p: string) => {
    const resolved = path.resolve(p);
    return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
};

/**
 * The account this Claude Code session is on, first match wins:
 * 1. the gateway served the session (`session_id`) through an account;
 * 2. CLAUDE_CONFIG_DIR is a Relay profile, as `relay run` and Relay's terminals set it;
 * 3. the sign-in in Claude Code's `.claude.json` is one of Relay's accounts;
 * 4. no sign-in could be read and the terminal follows the Claude app: the app's account.
 * `signIn` is read only when it is needed.
 */
export function statuslineAccount(
  snapshot: StatuslineSnapshot,
  input: StatuslineInput,
  configDir: string | undefined,
  signIn: () => { accountUuid: string; orgId: string } | undefined,
): { account?: StatuslineAccount; viaGateway: boolean } {
  const byId = (id: string | undefined) => (id ? snapshot.accounts.find((a) => a.id === id) : undefined);
  const session = typeof input.session_id === "string" ? input.session_id : undefined;
  const routed = session ? byId(snapshot.gateway?.sessions[session]) : undefined;
  if (routed) return { account: routed, viaGateway: true };
  if (configDir && path.isAbsolute(configDir) && samePath(path.dirname(configDir), snapshot.profiles)) {
    const account = byId(path.basename(configDir));
    if (account) return { account, viaGateway: false };
  }
  const who = signIn();
  if (who)
    return {
      account: snapshot.accounts.find((a) =>
        a.identities.some((x) => x.accountUuid === who.accountUuid && x.orgId === who.orgId),
      ),
      viaGateway: false,
    };
  return { account: snapshot.terminalFollows ? byId(snapshot.desktopAccountId) : undefined, viaGateway: false };
}

export type StatuslineStyle = "bold" | "dim" | "green" | "yellow" | "red";

/** Everything the line is made from; `paint` adds color, or returns the text as it is. */
export interface StatuslineRender {
  snapshot: StatuslineSnapshot;
  input: StatuslineInput;
  /** Claude Code's CLAUDE_CONFIG_DIR, when it set one. */
  configDir?: string;
  signIn: () => { accountUuid: string; orgId: string } | undefined;
  now: number;
  paint: (style: StatuslineStyle, text: string) => string;
}

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);

/** A live window from Claude Code's own stdin: newer than any read, for the session's own account. */
function liveUsed(window: { used_percentage?: number; resets_at?: number } | undefined, now: number) {
  const used = window?.used_percentage;
  if (typeof used !== "number" || !Number.isFinite(used)) return undefined;
  if (typeof window?.resets_at === "number" && window.resets_at * 1000 <= now) return undefined;
  return Math.floor(Math.max(0, Math.min(100, used)));
}

/** A read window, unless the period it counts has renewed since. */
const current = (window: StatuslineWindow | undefined, now: number) =>
  window && (window.resetsAt === undefined || window.resetsAt > now) ? window : undefined;

const percentStyle = (used: number): StatuslineStyle => (used >= 100 ? "red" : used >= 80 ? "yellow" : "green");

/** "17 min ago" in the snapshot's language. */
function ageText(locale: string, ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  const format = new Intl.RelativeTimeFormat(locale, { style: "short", numeric: "always" });
  if (minutes < 60) return format.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? format.format(-hours, "hour") : format.format(-Math.floor(hours / 24), "day");
}

/**
 * One line: the account, its five-hour and weekly use, when the five-hour period renews, whether
 * the gateway carried the session, and the snapshot's age once it is old. The percentages Claude
 * Code passes on stdin win over Relay's last read: they came with the session's latest answer.
 * Empty when there is nothing to show.
 */
export function renderStatusline(render: StatuslineRender): string {
  const { snapshot, input, now, paint } = render;
  const { account, viaGateway } = statuslineAccount(snapshot, input, render.configDir, render.signIn);
  let percent: Intl.NumberFormat;
  try {
    percent = new Intl.NumberFormat(snapshot.formatLocale, { style: "percent", maximumFractionDigits: 0, useGrouping: false });
  } catch {
    percent = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 0, useGrouping: false });
  }
  const fiveHourRead = current(account?.fiveHour, now);
  const weekRead = current(account?.week, now);
  const fiveHour = liveUsed(input.rate_limits?.five_hour, now) ?? fiveHourRead?.used;
  const week = liveUsed(input.rate_limits?.seven_day, now) ?? weekRead?.used;
  const parts: string[] = [];
  if (account) parts.push(paint("bold", account.name));
  if (viaGateway) parts.push(snapshot.text.viaGateway);
  const used = (template: string, value: number) =>
    fill(template, { percent: paint(percentStyle(value), percent.format(value / 100)) });
  if (fiveHour !== undefined) parts.push(used(snapshot.text.fiveHour, fiveHour));
  if (week !== undefined) parts.push(used(snapshot.text.week, week));
  // The next renewal: the five-hour period's, or the week's for an account without one.
  const resets = fiveHourRead?.resets ?? (fiveHour === undefined ? weekRead?.resets : undefined);
  if (resets) parts.push(paint("dim", resets));
  if (!parts.length) return "";
  const age = now - snapshot.generatedAt;
  if (age > STATUSLINE_STALE_MS) {
    let locale = snapshot.formatLocale;
    try {
      new Intl.RelativeTimeFormat(locale);
    } catch {
      locale = "en";
    }
    parts.push(paint("yellow", fill(snapshot.text.updatedAgo, { age: ageText(locale, age) })));
  }
  return parts.join(" · ");
}
