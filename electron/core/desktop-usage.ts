import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import type { Account } from "../../shared/types";
import { UsageError } from "./usage-credentials";
import { retryTime } from "./usage";
import { LINUX_V10_KEY, linuxCookieKey } from "./linux-safe-storage";

/**
 * Usage read through the Claude app's own sign-in, for an account with no Claude Code sign-in.
 *
 * Claude keeps its claude.ai login as cookies in its `Cookies` database (Relay saves a copy of
 * each account's in the Desktop vault). Their values are encrypted with "Claude Safe Storage",
 * a Keychain item Claude created. Relay reads that item through `/usr/bin/security` (the user
 * allows it once), decrypts the session cookies in memory and asks claude.ai for the same usage
 * the app's Settings → Usage page shows. Nothing decrypted is ever written or logged. On Linux the
 * same secret lives in the desktop's keyring instead (linux-safe-storage.ts).
 */

export const SAFE_STORAGE_SERVICE = "Claude Safe Storage";
export const SAFE_STORAGE_ACCOUNT = "Claude";
/** Exit status of `security find-generic-password` when no item matches. */
const ITEM_NOT_FOUND = 44;
/** claude.ai's own hosts in a cookie database. */
const HOSTS = [".claude.ai", "claude.ai"];
/**
 * The login cookies a request carries: the session and the hints that route it. Device ids,
 * Cloudflare's and analytics' cookies stay out.
 */
const SENT = new Set([
  "sessionKey",
  "sessionKeyLC",
  "sessionKeyV3",
  "sessionKeyV3LC",
  "routingHint",
  "lastActiveOrg",
]);
/** In Relay's data folder: the user allowed the Safe Storage read. Never the password itself. */
export const DESKTOP_USAGE_MARKER = "desktop-usage-keychain.json";

/**
 * Whether limits can be read through the Claude app's sign-in. macOS asks the Keychain when
 * needed, so always; Linux only once a keyring read has succeeded (a failure removes the mark).
 */
export async function desktopUsageReadable(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform === "darwin") return true;
  if (platform !== "linux") return false;
  try {
    return JSON.parse(await fs.readFile(path.join(dataDir, DESKTOP_USAGE_MARKER), "utf8"))?.allowed === true;
  } catch {
    return false;
  }
}
const MAX_BODY = 262_144;

/** Chromium's macOS cookie key: PBKDF2-SHA1 of the Safe Storage password. */
export function cookieKey(password: string): Buffer {
  return crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

/** The AES key for each value prefix: macOS has only `v10`; Linux `v10` and `v11`. */
export type CookieKeys = Partial<Record<"v10" | "v11", Buffer>>;

/** A stored value's scheme prefix (`v10`, `v11`, …). */
const prefixOf = (encrypted: Uint8Array) => Buffer.from(encrypted.subarray(0, 3)).toString("latin1");

/**
 * One cookie value as Chromium stores it: a prefix naming the key, then AES-128-CBC with a blank
 * IV. From database version 24 the plain text starts with the SHA-256 of the cookie's host.
 * Undefined when the value is not one Relay can read (another scheme, another key).
 */
export function decryptCookie(
  encrypted: Uint8Array,
  keys: CookieKeys,
  host: string,
  dbVersion: number,
): string | undefined {
  const data = Buffer.from(encrypted);
  const prefix = prefixOf(data);
  const key = prefix === "v10" || prefix === "v11" ? keys[prefix] : undefined;
  if (data.length < 3 + 16 || !key) return;
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    let plain = Buffer.concat([decipher.update(data.subarray(3)), decipher.final()]);
    if (dbVersion >= 24) {
      const digest = crypto.createHash("sha256").update(host).digest();
      if (plain.length < 32 || !plain.subarray(0, 32).equals(digest)) return;
      plain = plain.subarray(32);
    }
    const text = plain.toString("utf8");
    // A cookie value is printable ASCII; anything else is a wrong key that padded by chance.
    return /^[\x21-\x7e]{1,4096}$/.test(text) ? text : undefined;
  } catch {
    return;
  }
}

export interface EncryptedCookie {
  host: string;
  name: string;
  /** Set only by databases that keep a value unencrypted. */
  value: string;
  encrypted: Uint8Array;
  /** When the cookie ends (ms since the epoch); undefined for one that lasts the browser's run. */
  expiresMs?: number;
  /** The cookie's own attributes, where the database keeps them (Chromium's does). */
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  /** Chromium's value: -1 unspecified, 0 none, 1 lax, 2 strict. */
  sameSite?: number;
  /** Seconds since 1970; undefined for a session cookie. */
  expires?: number;
  /** When the cookie was first set, seconds since 1970: for the session, when it signed in. */
  created?: number;
}

/** A claude.ai cookie as the hidden renewal window sets it: its value and attributes. */
export interface PlainCookie {
  host: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
  expires?: number;
  created?: number;
}

/** Chromium time (microseconds from 1601-01-01) as ms since the epoch; undefined for none. */
const chromiumMs = (micros: unknown): number | undefined => {
  const n = typeof micros === "bigint" ? Number(micros / 1000n) : typeof micros === "number" ? micros / 1000 : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) - 11_644_473_600_000 : undefined;
};

/**
 * claude.ai's login rows from a copy of a Cookies database (its files by name: `Cookies`,
 * `Cookies-journal`, …). The copy is written to a private temporary folder, read and removed.
 */
export async function readCookieRows(
  files: Record<string, Buffer | null>,
  loadSqlite: () => Promise<typeof import("node:sqlite").DatabaseSync> = async () =>
    (await import("node:sqlite")).DatabaseSync,
): Promise<{ version: number; rows: EncryptedCookie[] }> {
  const main = files["Network/Cookies"] ? "Network/Cookies" : files.Cookies ? "Cookies" : undefined;
  if (!main) throw new UsageError("credentials-missing", undefined, "desktop: no cookie database");
  const Database = await loadSqlite();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-usage-"));
  try {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      const data = files[main + suffix];
      if (data) await fs.writeFile(path.join(dir, "Cookies" + suffix), data, { mode: 0o600 });
    }
    // Not read-only: a journal left behind must be rolled back before the rows can be read.
    const db = new Database(path.join(dir, "Cookies"));
    try {
      const meta = db.prepare("select value from meta where key = 'version'").get() as
        | { value?: unknown }
        | undefined;
      const version = Number(meta?.value);
      // Every column the database has (older or trimmed ones lack some); Chromium's times pass
      // 2^53 microseconds, so integers are read as bigint.
      const statement = db.prepare(
        `select * from cookies where host_key in (${HOSTS.map(() => "?").join(",")})`,
      );
      statement.setReadBigInts?.(true);
      const rows = statement.all(...HOSTS) as Record<string, unknown>[];
      const int = (v: unknown) => (typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : undefined);
      return {
        version: Number.isFinite(version) ? version : 0,
        rows: rows.map((r) => {
          const expires = typeof r.expires_utc === "bigint" ? r.expires_utc : undefined;
          const seconds = expires && expires > 0n ? Number(expires / 1_000_000n) - 11_644_473_600 : undefined;
          const creation = typeof r.creation_utc === "bigint" ? r.creation_utc : undefined;
          const created = creation && creation > 0n ? Number(creation / 1_000_000n) - 11_644_473_600 : undefined;
          return {
            host: String(r.host_key),
            name: String(r.name),
            value: typeof r.value === "string" ? r.value : "",
            encrypted: r.encrypted_value instanceof Uint8Array ? r.encrypted_value : new Uint8Array(),
            ...(typeof r.path === "string" ? { path: r.path } : {}),
            ...(int(r.is_secure) !== undefined ? { secure: int(r.is_secure) === 1 } : {}),
            ...(int(r.is_httponly) !== undefined ? { httpOnly: int(r.is_httponly) === 1 } : {}),
            ...(int(r.samesite) !== undefined ? { sameSite: int(r.samesite) } : {}),
            ...(Number(r.has_expires) === 1 && chromiumMs(r.expires_utc) !== undefined
              ? { expiresMs: chromiumMs(r.expires_utc) }
              : {}),
            ...(seconds !== undefined && seconds > 0 ? { expires: seconds } : {}),
            ...(created !== undefined && created > 0 ? { created } : {}),
          };
        }),
      };
    } finally {
      db.close();
    }
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError("unavailable", undefined, "desktop: cookie database unreadable");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** The login cookies by name, from the login rows; undefined without a session. */
export function sessionCookies(
  rows: EncryptedCookie[],
  keys: CookieKeys,
  dbVersion: number,
): Map<string, string> | undefined {
  const values = new Map<string, string>();
  for (const row of rows) {
    if (!SENT.has(row.name) || values.has(row.name)) continue;
    const value = row.value || decryptCookie(row.encrypted, keys, row.host, dbVersion);
    if (value && /^[\x21-\x7e]+$/.test(value) && !/[;,]/.test(value)) values.set(row.name, value);
  }
  return values.has("sessionKey") ? values : undefined;
}

/** The `Cookie` header for claude.ai, from the login rows; undefined without a session. */
export function cookieHeader(
  rows: EncryptedCookie[],
  keys: CookieKeys,
  dbVersion: number,
): string | undefined {
  const values = sessionCookies(rows, keys, dbVersion);
  if (!values) return;
  return [...values].map(([name, value]) => `${name}=${value}`).join("; ");
}

export interface WebResponse {
  status: number;
  contentType: string;
  retryAfter: string | null;
  body: string;
}

/** Reads the Safe Storage password; never opens a dialog unless `allowPrompt`. */
export type SafeStoragePassword = (allowPrompt: boolean) => Promise<string>;

/**
 * Reads "Claude Safe Storage" through `security`. A background read is only tried once the user
 * has allowed it in this run or before (`allowed`), so Relay never opens a Keychain dialog on
 * its own; when one appears anyway it is closed after a short wait.
 */
export function safeStoragePassword(options: {
  allowed: () => Promise<boolean>;
  remember: (allowed: boolean) => Promise<void>;
  tool?: string;
  /**
   * Where a password read once is kept between runs (Relay's sealed vault). macOS cannot let
   * `security` read Claude's item for good: the item is limited to Anthropic's team, which
   * "Always Allow" does not change, so without this every run asks again.
   */
  saved?: { load: () => Promise<string | undefined>; store: (password: string) => Promise<void> };
}): SafeStoragePassword {
  let cached: string | undefined;
  // One read at a time: reads asked together share it, so macOS asks once, not once per read.
  let reading: { promise: Promise<string>; prompts: boolean } | undefined;
  return async (allowPrompt) => {
    if (cached) return cached;
    // A read under way answers this one too; only one that may not prompt is followed, when it
    // fails, by this one's prompting read.
    while (reading) {
      const running = reading;
      try {
        return await running.promise;
      } catch (error) {
        if (!allowPrompt || running.prompts) throw error;
      }
      if (reading === running) break;
    }
    if (cached) return cached;
    const current = {
      prompts: allowPrompt,
      promise: readPassword(allowPrompt).finally(() => {
        if (reading === current) reading = undefined;
      }),
    };
    reading = current;
    return current.promise;
  };
  async function readPassword(allowPrompt: boolean): Promise<string> {
    if (cached) return cached;
    const kept = await options.saved?.load().catch(() => undefined);
    if (kept) return (cached = kept);
    if (!allowPrompt && !(await options.allowed().catch(() => false)))
      throw new UsageError("keychain-locked", undefined, "desktop: Keychain not allowed yet");
    const result = await new Promise<{ code?: number | string | null; stdout: string }>(
      (resolve) =>
        execFile(
          options.tool ?? "/usr/bin/security",
          ["find-generic-password", "-s", SAFE_STORAGE_SERVICE, "-a", SAFE_STORAGE_ACCOUNT, "-w"],
          {
            timeout: allowPrompt ? 120_000 : 15_000,
            killSignal: "SIGKILL",
            maxBuffer: 4096,
            windowsHide: true,
          },
          (error, stdout) =>
            resolve({ code: error ? (error.code ?? "failed") : undefined, stdout: String(stdout) }),
        ),
    );
    if (result.code === ITEM_NOT_FOUND)
      throw new UsageError("credentials-missing", undefined, "desktop: no Claude Safe Storage item");
    const password = result.stdout.replace(/\n$/, "");
    if (result.code !== undefined || !password) {
      await options.remember(false).catch(() => {});
      throw new UsageError("keychain-locked", undefined, `desktop: security exit ${result.code}`);
    }
    cached = password;
    await options.remember(true).catch(() => {});
    await options.saved?.store(password).catch(() => {});
    return password;
  }
}

/**
 * Reads one account's usage the way claude.ai's Settings → Usage does. Answers with the same
 * shape as the CLI's usage endpoint (`five_hour`, `seven_day`, …), for `parseUsage`.
 */
export class DesktopUsageReader {
  constructor(
    private readonly deps: {
      /** The cookie files of the account's Claude app sign-in: live, or as saved in the vault. */
      cookieFiles: (accountUuid: string) => Promise<Record<string, Buffer | null>>;
      password: SafeStoragePassword;
      /** A GET to claude.ai with this `Cookie` header; never follows a redirect. */
      request: (url: string, cookie: string) => Promise<WebResponse>;
      readRows?: typeof readCookieRows;
      now?: () => number;
      /** Whose cookie scheme the rows use; this machine's by default. */
      platform?: NodeJS.Platform;
    },
  ) {}

  /** Whether this account has a Claude app sign-in to read through. */
  static usable(account: Account): boolean {
    return !!account.desktop?.accountUuid && !!account.desktop.orgId;
  }

  /**
   * All of the account's claude.ai cookies with their attributes, in memory only: for the hidden
   * window that renews its Claude Code sign-in. The session alone is not enough there: claude.ai
   * also asks for the device's own cookies (a trusted-device mark that organizations can require,
   * the device id). Never asks for the Keychain; undefined when there is no session.
   */
  async cookies(account: Account): Promise<PlainCookie[] | undefined> {
    const desktop = account.desktop;
    if (!desktop || !/^[0-9a-f-]{36}$/i.test(desktop.orgId)) return;
    const files = await this.deps.cookieFiles(desktop.accountUuid);
    const { version, rows } = await (this.deps.readRows ?? readCookieRows)(files);
    const keys = await this.keys(rows, false);
    const now = (this.deps.now ?? Date.now)() / 1000;
    const sameSite = ["no_restriction", "lax", "strict"] as const;
    const cookies: PlainCookie[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const value = row.value || decryptCookie(row.encrypted, keys, row.host, version);
      if (!value || !/^[\x21-\x7e]+$/.test(value) || /[;,]/.test(value)) continue;
      if (row.expires !== undefined && row.expires <= now) continue;
      const id = `${row.host}|${row.path ?? "/"}|${row.name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      cookies.push({
        host: row.host,
        name: row.name,
        // The workspace the sign-in is for, whatever the Claude app last opened.
        value: row.name === "lastActiveOrg" ? desktop.orgId.toLowerCase() : value,
        path: row.path ?? "/",
        secure: row.secure ?? true,
        httpOnly: row.httpOnly ?? row.name.startsWith("sessionKey"),
        sameSite: sameSite[row.sameSite ?? -1] ?? "unspecified",
        ...(row.expires !== undefined ? { expires: row.expires } : {}),
        ...(row.created !== undefined ? { created: row.created } : {}),
      });
    }
    return cookies.some((c) => c.name === "sessionKey") ? cookies : undefined;
  }

  /** Asks macOS once to let Relay read the Claude app's sign-in ("Claude Safe Storage"). */
  async allowKeychain(): Promise<void> {
    await this.deps.password(true);
  }

  async read(account: Account, allowPrompt: boolean): Promise<unknown> {
    const desktop = account.desktop;
    if (!desktop || !/^[0-9a-f-]{36}$/i.test(desktop.orgId))
      throw new UsageError("credentials-missing", undefined, "desktop: no Claude app sign-in");
    let files: Record<string, Buffer | null>;
    try {
      files = await this.deps.cookieFiles(desktop.accountUuid);
    } catch {
      throw new UsageError("credentials-missing", undefined, "desktop: no saved Claude app sign-in");
    }
    const { version, rows } = await (this.deps.readRows ?? readCookieRows)(files);
    const keys = await this.keys(rows, allowPrompt);
    const cookie = cookieHeader(rows, keys, version);
    if (!cookie) {
      // Rows that cannot be decrypted mean another key, not a signed-out app.
      const session = rows.some((r) => r.name === "sessionKey");
      throw new UsageError(
        session ? "unsupported" : "expired",
        undefined,
        session ? "desktop: session cookie not readable" : "desktop: no session cookie",
      );
    }
    const response = await this.deps.request(
      `https://claude.ai/api/organizations/${desktop.orgId.toLowerCase()}/usage`,
      cookie,
    );
    const detail = `desktop usage ${response.status}`;
    const json = /json/i.test(response.contentType);
    if (response.status === 401) throw new UsageError("expired", undefined, detail);
    // A JSON refusal is claude.ai's own: the session no longer has this organization.
    // An HTML one is a gateway (Cloudflare) and passes on its own.
    if (response.status === 403)
      throw new UsageError(json ? "expired" : "unavailable", undefined, `${detail}${json ? "" : " html"}`);
    if (response.status === 429)
      throw new UsageError(
        "rate-limited",
        retryTime(response.retryAfter, (this.deps.now ?? Date.now)()),
        detail,
      );
    if (response.status !== 200 || !json) throw new UsageError("unavailable", undefined, detail);
    if (response.body.length > MAX_BODY) throw new UsageError("unsupported", undefined, detail);
    try {
      return JSON.parse(response.body);
    } catch {
      throw new UsageError("unsupported", undefined, `${detail} not JSON`);
    }
  }

  /**
   * macOS: the Keychain password's key for `v10`. Linux: `v10` has Chromium's fixed key, so the
   * keyring is only asked when a login cookie is `v11`.
   */
  private async keys(rows: EncryptedCookie[], allowPrompt: boolean): Promise<CookieKeys> {
    if ((this.deps.platform ?? process.platform) !== "linux")
      return { v10: cookieKey(await this.deps.password(allowPrompt)) };
    const keyring = rows.some((r) => SENT.has(r.name) && !r.value && prefixOf(r.encrypted) === "v11");
    return {
      v10: LINUX_V10_KEY,
      ...(keyring ? { v11: linuxCookieKey(await this.deps.password(allowPrompt)) } : {}),
    };
  }
}
