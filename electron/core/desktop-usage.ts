import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import type { Account } from "../../shared/types";
import { UsageError } from "./usage-credentials";
import { retryTime } from "./usage";

/**
 * Usage read through the Claude app's own sign-in, for an account with no Claude Code sign-in.
 *
 * Claude keeps its claude.ai login as cookies in its `Cookies` database (Relay saves a copy of
 * each account's in the Desktop vault). Their values are encrypted with "Claude Safe Storage",
 * a Keychain item Claude created. Relay reads that item through `/usr/bin/security` (the user
 * allows it once), decrypts the session cookies in memory and asks claude.ai for the same usage
 * the app's Settings → Usage page shows. Nothing decrypted is ever written or logged.
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
const MAX_BODY = 262_144;

/** Chromium's macOS cookie key: PBKDF2-SHA1 of the Safe Storage password. */
export function cookieKey(password: string): Buffer {
  return crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

/**
 * One cookie value as Chromium stores it on macOS: `v10`, then AES-128-CBC with a blank IV.
 * From database version 24 the plain text starts with the SHA-256 of the cookie's host.
 * Undefined when the value is not one Relay can read (another scheme, another key).
 */
export function decryptCookie(
  encrypted: Uint8Array,
  key: Buffer,
  host: string,
  dbVersion: number,
): string | undefined {
  const data = Buffer.from(encrypted);
  if (data.length < 3 + 16 || data.subarray(0, 3).toString("latin1") !== "v10") return;
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
}

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
      const rows = db
        .prepare(
          `select host_key, name, value, encrypted_value from cookies where host_key in (${HOSTS.map(() => "?").join(",")})`,
        )
        .all(...HOSTS) as Record<string, unknown>[];
      return {
        version: Number.isFinite(version) ? version : 0,
        rows: rows.map((r) => ({
          host: String(r.host_key),
          name: String(r.name),
          value: typeof r.value === "string" ? r.value : "",
          encrypted: r.encrypted_value instanceof Uint8Array ? r.encrypted_value : new Uint8Array(),
        })),
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

/** The `Cookie` header for claude.ai, from the login rows; undefined without a session. */
export function cookieHeader(
  rows: EncryptedCookie[],
  key: Buffer,
  dbVersion: number,
): string | undefined {
  const values = new Map<string, string>();
  for (const row of rows) {
    if (!SENT.has(row.name) || values.has(row.name)) continue;
    const value = row.value || decryptCookie(row.encrypted, key, row.host, dbVersion);
    if (value && /^[\x21-\x7e]+$/.test(value) && !/[;,]/.test(value)) values.set(row.name, value);
  }
  if (!values.has("sessionKey")) return;
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
}): SafeStoragePassword {
  let cached: string | undefined;
  return async (allowPrompt) => {
    if (cached) return cached;
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
    return password;
  };
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
    },
  ) {}

  /** Whether this account has a Claude app sign-in to read through. */
  static usable(account: Account): boolean {
    return !!account.desktop?.accountUuid && !!account.desktop.orgId;
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
    const key = cookieKey(await this.deps.password(allowPrompt));
    const cookie = cookieHeader(rows, key, version);
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
}
