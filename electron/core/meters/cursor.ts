import { promises as fs } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import type { MeterWindow } from "../../../shared/meters";
import { MeterError, clampPercent, isoDate, num, plainLabel, requestJson, type Json, type MeterRead, type MeterReaderOptions } from "./common";

/**
 * Cursor's monthly usage, from `cursor.com/api/usage-summary`: the call cursor.com's own dashboard
 * makes (CodexBar's CursorStatusProbe reads it the same way). It takes the dashboard's session
 * cookie, which is the Cursor app's access token with its user id in front, so the meter reads the
 * token the app saved in its `state.vscdb` and sends it only while it is valid. Relay never renews
 * it, and never opens the "Cursor Safe Storage" Keychain item a token encrypted with it needs.
 */

export const CURSOR_ORIGIN = "https://cursor.com";
const TOKEN_KEY = "cursorAuth/accessToken";
/** CodexBar's margin: a token this close to its end is not sent. */
const EXPIRY_MARGIN_MS = 60_000;

type SqliteDatabase = typeof DatabaseSync;
export interface CursorReaderOptions extends MeterReaderOptions {
  loadSqlite?: () => Promise<SqliteDatabase>;
}

/** Where the Cursor app keeps its state: the VS Code layout under the system's app-data folder. */
export function cursorStatePath(home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const base =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : platform === "win32"
        ? env.APPDATA || path.join(home, "AppData", "Roaming")
        : env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(base, "Cursor", "User", "globalStorage", "state.vscdb");
}

/** A value of `ItemTable`: the token as text, or JSON text holding it. */
function itemText(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : undefined;
  if (!text) return;
  if (text.startsWith('"')) {
    try {
      const parsed = JSON.parse(text);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return;
    }
  }
  return text;
}

function queryToken(Database: SqliteDatabase, file: string, readOnly: boolean): string | undefined {
  const db = new Database(file, readOnly ? { readOnly: true } : {});
  try {
    const row = db.prepare("select value from ItemTable where key = ?").get(TOKEN_KEY) as { value?: unknown } | undefined;
    return itemText(row?.value);
  } finally {
    db.close();
  }
}

/**
 * The app's access token from `state.vscdb`, opened read-only in place. When that fails (a
 * write-ahead log the read-only open cannot use), from a private copy of the database and its log.
 */
export async function readCursorStateToken(file: string, loadSqlite: () => Promise<SqliteDatabase>): Promise<string | undefined> {
  try {
    await fs.access(file);
  } catch {
    return undefined;
  }
  const Database = await loadSqlite();
  try {
    return queryToken(Database, file, true);
  } catch {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-meter-"));
    try {
      for (const suffix of ["", "-wal", "-shm"]) await fs.copyFile(file + suffix, path.join(dir, "state.vscdb" + suffix)).catch(() => {});
      return queryToken(Database, path.join(dir, "state.vscdb"), false);
    } catch {
      return undefined;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
}

/** The `cursor-agent` sign-in on Linux: `~/.config/cursor/auth.json`'s `accessToken`. */
async function readAgentToken(home: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "cursor", "auth.json"), "utf8"));
    return typeof value?.accessToken === "string" ? value.accessToken : undefined;
  } catch {
    return undefined;
  }
}

/** A JWT's claims, unverified: only to tell its user and its end, never to trust it. */
export function jwtClaims(token: string): Json | undefined {
  const part = token.split(".")[1];
  if (!part) return;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return claims && typeof claims === "object" ? claims : undefined;
  } catch {
    return;
  }
}

/**
 * The dashboard's session cookie for a token: `WorkosCursorSessionToken=<user id>%3A%3A<token>`, the
 * user id being the part of the JWT's `sub` after `|`. Refuses a token that is not a JWT or ends
 * within a minute.
 */
export function cursorSessionCookie(token: string, now: number): { cookie: string; userId: string } {
  const claims = jwtClaims(token);
  if (!claims || !/^[\w.-]+\.[\w-]+\.[\w-]*$/.test(token)) throw new MeterError("unsupported", undefined, "cursor: token is not a JWT");
  const exp = num(claims.exp);
  if (exp !== undefined && exp * 1000 - now <= EXPIRY_MARGIN_MS) throw new MeterError("expired", undefined, "cursor: token ended");
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  const userId = sub.includes("|") ? sub.slice(sub.lastIndexOf("|") + 1) : sub;
  if (!/^[\w-]{1,128}$/.test(userId)) throw new MeterError("unsupported", undefined, "cursor: token names no user");
  return { cookie: `WorkosCursorSessionToken=${userId}%3A%3A${token}`, userId };
}

/** The token found on this computer: the app's own, else the agent's on Linux. */
export async function findCursorToken(options: CursorReaderOptions = {}): Promise<string | undefined> {
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  // Loaded on first use, as cookie-store does: only a Cursor meter needs SQLite in main.
  const loadSqlite = options.loadSqlite ?? (async () => (await import("node:sqlite")).DatabaseSync);
  const token = await readCursorStateToken(cursorStatePath(home, env, platform), loadSqlite);
  if (token) return token;
  return platform === "linux" ? readAgentToken(home, env) : undefined;
}

/** Cents as dollars. */
const dollars = (cents: number) => Math.round(cents) / 100;

/** The windows and plan in a `usage-summary` answer. Money is in cents, shares in percent. */
export function parseCursorSummary(value: unknown): MeterRead {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MeterError("unsupported", undefined, "cursor: not an object");
  const root = value as Json;
  const resetsAt = isoDate(root.billingCycleEnd);
  const reset = resetsAt ? { resetsAt } : {};
  const individual = root.individualUsage && typeof root.individualUsage === "object" ? (root.individualUsage as Json) : {};
  const plan = individual.plan && typeof individual.plan === "object" ? (individual.plan as Json) : undefined;
  const windows: MeterWindow[] = [];
  if (plan && plan.enabled !== false && root.isUnlimited !== true) {
    const used = num(plan.used);
    const limit = num(plan.limit);
    const total = num(plan.totalPercentUsed) ?? num(root.totalPercentUsed);
    const usedPercent = total ?? (used !== undefined && limit ? (used / limit) * 100 : undefined);
    if (usedPercent !== undefined)
      windows.push({
        name: "included",
        kind: "monthly",
        unit: "$",
        usedPercent: clampPercent(usedPercent),
        ...(used !== undefined && limit !== undefined ? { used: dollars(used), limit: dollars(limit) } : {}),
        ...reset,
      });
    for (const [name, key] of [["auto", "autoPercentUsed"], ["api", "apiPercentUsed"]] as const) {
      const share = num(plan[key]) ?? num(root[key]);
      if (share !== undefined) windows.push({ name, kind: "monthly", unit: "$", usedPercent: clampPercent(share), ...reset });
    }
  }
  const onDemand = individual.onDemand && typeof individual.onDemand === "object" ? (individual.onDemand as Json) : undefined;
  const demandLimit = num(onDemand?.limit);
  const demandUsed = num(onDemand?.used);
  if (onDemand?.enabled === true && demandLimit && demandUsed !== undefined)
    windows.push({
      name: "on-demand",
      kind: "monthly",
      unit: "$",
      usedPercent: clampPercent((demandUsed / demandLimit) * 100),
      used: dollars(demandUsed),
      limit: dollars(demandLimit),
      ...reset,
    });
  const label = plainLabel(root.membershipType);
  return { ...(label ? { label } : {}), windows };
}

/** An older request-based plan's month, from `/api/usage`: `gpt-4`'s requests out of its maximum. */
export function parseCursorLegacyUsage(value: unknown): MeterWindow[] {
  if (!value || typeof value !== "object") return [];
  const root = value as Json;
  const premium = root["gpt-4"] && typeof root["gpt-4"] === "object" ? (root["gpt-4"] as Json) : undefined;
  const used = num(premium?.numRequests) ?? num(premium?.numRequestsTotal);
  const limit = num(premium?.maxRequestUsage);
  if (used === undefined || !limit) return [];
  const start = Date.parse(typeof root.startOfMonth === "string" ? root.startOfMonth : "");
  let resetsAt: string | undefined;
  if (Number.isFinite(start)) {
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    resetsAt = end.toISOString();
  }
  return [{ name: "requests", kind: "monthly", unit: "requests", usedPercent: clampPercent((used / limit) * 100), used, limit, ...(resetsAt ? { resetsAt } : {}) }];
}

/** Reads the usage of the Cursor sign-in found on this computer. */
export async function readCursor(options: CursorReaderOptions = {}): Promise<MeterRead> {
  const token = await findCursorToken(options);
  if (!token) throw new MeterError("not-signed-in", undefined, "cursor: no saved sign-in");
  // Encrypted with the app's Keychain key; reading that item could ask for the Keychain.
  if (token.startsWith("cursor-safe-storage:")) throw new MeterError("encrypted", undefined, "cursor: token encrypted");
  const now = (options.now ?? Date.now)();
  const { cookie, userId } = cursorSessionCookie(token, now);
  const headers = { Accept: "application/json", Cookie: cookie };
  const summary = await requestJson(`${CURSOR_ORIGIN}/api/usage-summary`, { headers }, "cursor summary", options);
  const read = parseCursorSummary(summary.body);
  if (read.windows.length || (summary.body as Json).isUnlimited === true) return read;
  // A plan counted in requests, not dollars, has no budget in the summary.
  const legacy = await requestJson(`${CURSOR_ORIGIN}/api/usage?user=${encodeURIComponent(userId)}`, { headers }, "cursor usage", options);
  return { ...read, windows: parseCursorLegacyUsage(legacy.body) };
}
