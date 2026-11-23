/**
 * Read-only usage meters for other AI tools on this computer (GitHub Copilot, Cursor, Gemini CLI).
 * They are not Relay accounts: nothing is saved in the vault, nothing is switched, routed or
 * planned, and their windows (a day, a billing month) are not the five-hour and weekly ones the
 * router and the planner read, so they have their own shape instead of `AccountUsage`.
 *
 * Each meter reads the token the tool itself saved, in main, at most every `METER_INTERVAL_MS`,
 * and only while it is turned on in Settings → Other tools. The renderer sees the reading below,
 * never a token.
 */

export const METER_PROVIDERS = ["copilot", "cursor", "gemini-cli"] as const;
export type MeterProvider = (typeof METER_PROVIDERS)[number];

/** The tools' own product names: shown as they are in every language. */
export const METER_NAMES: Record<MeterProvider, string> = {
  copilot: "GitHub Copilot",
  cursor: "Cursor",
  "gemini-cli": "Gemini CLI",
};

/** How long a meter waits between two reads, even when asked sooner. */
export const METER_INTERVAL_MS = 10 * 60_000;

/** What a window counts: requests, Copilot's premium requests, or dollars of a plan's budget. */
export type MeterUnit = "requests" | "premium requests" | "$";

/**
 * One limit of a meter, by name: Copilot's premium requests, chat and completions; Cursor's plan
 * budget, its Auto and API shares and on-demand spend, or an older plan's requests; Gemini's model
 * families.
 */
export type MeterWindowName =
  | "premium"
  | "chat"
  | "completions"
  | "included"
  | "auto"
  | "api"
  | "on-demand"
  | "requests"
  | "pro"
  | "flash"
  | "flash-lite";

export interface MeterWindow {
  name: MeterWindowName;
  /** A daily window (Gemini) or a billing month (Copilot, Cursor). */
  kind: "daily" | "monthly" | "other";
  usedPercent?: number;
  used?: number;
  limit?: number;
  unit: MeterUnit;
  resetsAt?: string;
}

/**
 * Why a meter has no current reading:
 * - `not-signed-in`: the tool's saved sign-in is not on this computer;
 * - `expired`: it is there but out of date, and the tool renews it the next time it runs (Relay
 *   never renews another tool's sign-in);
 * - `encrypted`: the tool keeps it encrypted under a Keychain item Relay does not open;
 * - `not-available`: the provider does not offer this meter to the account (Gemini CLI with a
 *   personal Google account since 2026-06-18, an ended Copilot subscription);
 * - `unsupported-auth`: the tool signs in another way that has no quota to read (a Gemini API key);
 * - `rate-limited`, `unavailable`, `unsupported`: the provider answered too often, not at all, or
 *   in a shape Relay does not read.
 */
export type MeterIssue =
  | "not-signed-in"
  | "expired"
  | "encrypted"
  | "not-available"
  | "unsupported-auth"
  | "rate-limited"
  | "unavailable"
  | "unsupported";

export const METER_ISSUES = [
  "not-signed-in",
  "expired",
  "encrypted",
  "not-available",
  "unsupported-auth",
  "rate-limited",
  "unavailable",
  "unsupported",
] as const satisfies readonly MeterIssue[];

export interface MeterReading {
  provider: MeterProvider;
  /** The plan or login the provider reported ("individual", "pro", "Standard"). */
  label?: string;
  windows: MeterWindow[];
  /** Official: a documented API. Unofficial: an endpoint the tool itself uses, undocumented. */
  source: "official" | "unofficial";
  /** When `windows` were read; absent before the first good read. */
  readAt?: string;
  /** The last read failed: shown beside the windows of the read before it, if any. */
  error?: { issue: MeterIssue; retryAt?: string };
}

/** The meters turned on, once each, in Relay's order. */
export const enabledMeters = (settings: {
  meters?: readonly MeterProvider[];
}): MeterProvider[] =>
  METER_PROVIDERS.filter((provider) => settings.meters?.includes(provider));
