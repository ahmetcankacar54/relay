import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CLAUDE_EXTENSION_ID } from "../../shared/browser-extension";

/**
 * Why a browser's cookie database could not be used: a browser holds it, it is missing, it is
 * not laid out as Relay expects (a newer Chromium), it was not closed cleanly, or a write did not
 * read back.
 */
export class CookieStoreError extends Error {
  constructor(
    readonly reason:
      | "locked"
      | "missing"
      | "failed"
      | "mismatch"
      | "schema-changed"
      | "journal-pending",
    message: string,
  ) {
    super(message);
  }
}

/** The extension's own (partitioned) cookies carry this top-frame site. */
const EXTENSION_PARTITION = `chrome-extension://${CLAUDE_EXTENSION_ID}`;

interface LoginRow {
  host: string;
  /** "" (not partitioned) or the extension's partition. */
  partition: string;
  name: string;
}
/**
 * The rows that are "the account's claude.ai login": an allow-list, never every claude.ai row.
 * The device's identity (`anthropic-device-id`), Cloudflare's bot management and the page's
 * preferences stay where they are. Device-bound session credentials are not moved: Brave drops a
 * restored one once another account has signed in (live test, 2026-10-22), so the swap deletes
 * the site's row in `Device Bound Sessions` instead.
 */
export const LOGIN_ROWS: readonly LoginRow[] = [
  ...["sessionKey", "sessionKeyLC", "sessionKeyV3", "sessionKeyV3LC", "routingHint", "lastActiveOrg"].map(
    (name) => ({ host: ".claude.ai", partition: "", name }),
  ),
  ...[
    "__Host-sessionBinding",
    "__Host-sessionBindingGrace",
    "__Host-ant_trusted_device",
    "activitySessionId",
  ].map((name) => ({ host: "claude.ai", partition: "", name })),
  { host: "claude.ai", partition: EXTENSION_PARTITION, name: "lastActiveOrg" },
];
/** The site row of Chromium's `Device Bound Sessions` that belongs to the login. */
const DBSC_KEY = "https://claude.ai";
const SESSION_NAME = "sessionKey";
/** claude.ai cookies that look like a login but are not listed: the layout changed. */
const LOGIN_LIKE = /session|auth|token|login|credential/i;
const WEB_HOSTS = new Set(["claude.ai", ".claude.ai"]);

export type CookieValue = string | bigint | Uint8Array | null;
/** One `cookies` row, each column as the database holds it (integers as bigint). */
export type CookieRow = Record<string, CookieValue>;

/** The login rows of a cookie database, with what is needed to put them back. */
export interface CookieSnapshot {
  /** `meta.version` of the database the rows came from. */
  version: string;
  /** The `cookies` table's columns, in order. */
  columns: string[];
  rows: CookieRow[];
  /** Names of claude.ai cookies that look like login cookies and are not in `LOGIN_ROWS`. */
  unlisted: string[];
}

const isLoginRow = (row: CookieRow) =>
  LOGIN_ROWS.some(
    (l) => row.host_key === l.host && row.top_frame_site_key === l.partition && row.name === l.name,
  );

export const hasWebLogin = (snapshot: CookieSnapshot) =>
  snapshot.rows.some((row) => row.name === SESSION_NAME && row.host_key === ".claude.ai");

const unpartitioned = (snapshot: CookieSnapshot, name: string) =>
  snapshot.rows.find(
    (r) =>
      r.name === name &&
      (r.top_frame_site_key ?? "") === "" &&
      (r.host_key === ".claude.ai" || r.host_key === "claude.ai"),
  );
const bytes = (value: CookieValue | undefined) =>
  value instanceof Uint8Array ? Buffer.from(value) : undefined;

/**
 * Whether two snapshots hold the same web login: their `sessionKey` rows were created at the same
 * moment. The browser keeps a cookie's creation time when the site sets it again, so a login the
 * server renewed still matches; two separate logins never share the microsecond.
 */
export function sameLogin(a: CookieSnapshot, b: CookieSnapshot): boolean {
  const x = loginId(a);
  return x !== undefined && x === loginId(b);
}

/** A web login's identity: its `sessionKey` row's creation time (see `sameLogin`). */
export function loginId(snapshot: CookieSnapshot): string | undefined {
  const created = unpartitioned(snapshot, SESSION_NAME)?.creation_utc;
  return typeof created === "bigint" ? created.toString() : undefined;
}

/**
 * Whether two snapshots' web logins are on the same organization: their `lastActiveOrg` cookies
 * hold the same encrypted bytes. On macOS the browser encrypts a cookie the same way every time
 * (one key, a fixed IV), so the same organization id gives the same bytes; nothing is decrypted.
 * Where a browser encrypts with a random IV this never matches, which only makes it say less.
 */
export function sameOrganization(a: CookieSnapshot, b: CookieSnapshot): boolean {
  const x = bytes(unpartitioned(a, "lastActiveOrg")?.encrypted_value);
  const y = bytes(unpartitioned(b, "lastActiveOrg")?.encrypted_value);
  return !!x && !!y && x.length > 0 && x.equals(y);
}

/** When the web session was created (ms since the epoch), from `creation_utc`; undefined without one. */
export function sessionCreatedMs(snapshot: CookieSnapshot): number | undefined {
  const row = snapshot.rows.find(
    (r) => r.name === SESSION_NAME && r.host_key === ".claude.ai",
  );
  const micros = row?.creation_utc;
  if (typeof micros !== "bigint") return undefined;
  // Chromium counts microseconds from 1601-01-01.
  return Number(micros / 1000n) - 11_644_473_600_000;
}

/**
 * The cookie database operations, on a browser profile folder. `read` works on a copy as well as
 * on a closed browser's folder; `write` only while the browser is not running. Never prints or
 * logs a value.
 */
export interface CookieStorage {
  /** Whether SQLite can be loaded here (`node:sqlite`); asked before a browser is quit. */
  available(): Promise<boolean>;
  /** The login rows in `dir` (a profile folder or a copy of the cookie files). */
  read(dir: string): Promise<CookieSnapshot>;
  /**
   * Replaces the profile's login rows with `snapshot`'s, deletes the site's device-bound session
   * row, then reads everything back: the rows equal, every other row unchanged, the database
   * intact. Throws a `CookieStoreError`; the caller restores its backup.
   */
  write(dir: string, snapshot: CookieSnapshot): Promise<void>;
}

/** The cookie database's place: a profile's `Network/Cookies` (newer browsers) or `Cookies`. */
const COOKIE_CANDIDATES = ["Network/Cookies", "Cookies"];
const SIDE_SUFFIXES = ["", "-journal", "-wal", "-shm"];
const DBSC_NAME = "Device Bound Sessions";
const COOKIE_FILES = [
  ...COOKIE_CANDIDATES.flatMap((f) => SIDE_SUFFIXES.map((s) => f + s)),
  ...["Network/", ""].flatMap((d) => SIDE_SUFFIXES.map((s) => `${d}${DBSC_NAME}${s}`)),
];

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch {
    return false;
  }
}

async function cookiesFile(dir: string): Promise<string> {
  let best: { file: string; mtime: number } | undefined;
  for (const rel of COOKIE_CANDIDATES) {
    const file = path.join(dir, rel);
    try {
      const st = await fs.lstat(file);
      // A real file only: a link could lead into somebody else's files.
      if (!st.isFile()) throw new CookieStoreError("failed", "The cookie database is not a file.");
      if (!best || st.mtimeMs > best.mtime) best = { file, mtime: st.mtimeMs };
    } catch (error) {
      if (error instanceof CookieStoreError) throw error;
    }
  }
  if (!best) throw new CookieStoreError("missing", "The cookie database is missing.");
  return best.file;
}

async function assertQuiet(file: string) {
  for (const side of ["-journal", "-wal"]) {
    try {
      if ((await fs.stat(file + side)).size > 0)
        throw new CookieStoreError(
          "journal-pending",
          "The cookie database was not closed cleanly.",
        );
    } catch (error) {
      if (error instanceof CookieStoreError) throw error;
    }
  }
}

async function loadSqlite() {
  try {
    return (await import("node:sqlite")).DatabaseSync;
  } catch {
    throw new CookieStoreError("failed", "SQLite is not available here.");
  }
}

const fail = (error: unknown): never => {
  if (error instanceof CookieStoreError) throw error;
  const text = String((error as Error)?.message ?? "");
  throw new CookieStoreError(
    /locked|busy/i.test(text) ? "locked" : "failed",
    "The cookie database could not be used.",
  );
};

const encodeValue = (value: CookieValue): unknown =>
  typeof value === "bigint"
    ? { i: value.toString() }
    : value instanceof Uint8Array
      ? { b: Buffer.from(value).toString("base64") }
      : value;
const sameValue = (a: CookieValue, b: CookieValue) =>
  JSON.stringify(encodeValue(a)) === JSON.stringify(encodeValue(b));
const rowKey = (row: CookieRow) =>
  JSON.stringify(Object.keys(row).sort().map((c) => [c, encodeValue(row[c])]));

interface Read {
  snapshot: CookieSnapshot;
  /** A digest of every row that is not part of the login. */
  others: string;
  count: number;
  quick: string;
}

function tableColumns(db: DatabaseSync): string[] {
  const rows = db.prepare("pragma table_info(cookies)").all() as { name: string }[];
  return rows.map((r) => String(r.name));
}

function readDatabase(db: DatabaseSync): Read {
  const columns = tableColumns(db);
  const version = db.prepare("select value from meta where key = 'version'").get() as
    | { value: unknown }
    | undefined;
  if (!columns.length || !columns.includes("host_key") || version === undefined)
    throw new CookieStoreError("schema-changed", "The cookie database is not laid out as expected.");
  const statement = db.prepare(
    "select * from cookies order by host_key, top_frame_site_key, name, path, source_scheme, source_port, has_cross_site_ancestor",
  );
  statement.setReadBigInts(true);
  const all = statement.all() as CookieRow[];
  const rows: CookieRow[] = [];
  const unlisted: string[] = [];
  const hash = crypto.createHash("sha256");
  for (const row of all) {
    if (isLoginRow(row)) {
      rows.push(row);
      continue;
    }
    if (
      WEB_HOSTS.has(String(row.host_key)) &&
      Number(row.is_httponly) === 1 &&
      Number(row.is_secure) === 1 &&
      LOGIN_LIKE.test(String(row.name))
    )
      unlisted.push(String(row.name));
    hash.update(rowKey(row));
  }
  const quick = String(
    Object.values(db.prepare("pragma quick_check").get() as Record<string, unknown>)[0],
  );
  return {
    snapshot: { version: String(version.value), columns, rows, unlisted },
    others: hash.digest("hex"),
    count: all.length - rows.length,
    quick,
  };
}

const IDENTITY =
  "host_key = ? and top_frame_site_key = ? and name = ? and path = ? and source_scheme = ? and source_port = ? and has_cross_site_ancestor = ?";
const identityOf = (row: CookieRow) =>
  [
    row.host_key,
    row.top_frame_site_key,
    row.name,
    row.path,
    row.source_scheme,
    row.source_port,
    row.has_cross_site_ancestor,
  ] as (string | bigint)[];

/** Whether the site's device-bound session row is present; false without the file or the table. */
function dbscPresent(db: DatabaseSync): boolean {
  const table = db
    .prepare("select name from sqlite_master where type = 'table' and name = 'dbsc_session_tbl'")
    .get();
  if (!table) return false;
  return !!db.prepare("select 1 from dbsc_session_tbl where key = ?").get(DBSC_KEY);
}

export const sqliteCookieStorage: CookieStorage = {
  available: () =>
    import("node:sqlite").then(
      (m) => typeof m.DatabaseSync === "function",
      () => false,
    ),
  async read(dir) {
    const file = await cookiesFile(dir);
    const Database = await loadSqlite();
    let db: DatabaseSync | undefined;
    try {
      db = new Database(file, { readOnly: true });
      return readDatabase(db).snapshot;
    } catch (error) {
      return fail(error);
    } finally {
      try {
        db?.close();
      } catch {
        // Closed already.
      }
    }
  },
  async write(dir, snapshot) {
    if (!snapshot.rows.length || !snapshot.rows.every(isLoginRow))
      throw new CookieStoreError("failed", "The saved login holds rows that are not a login.");
    const file = await cookiesFile(dir);
    await assertQuiet(file);
    const Database = await loadSqlite();
    const dbscFile = path.join(path.dirname(file), DBSC_NAME);
    const hasDbsc = await exists(dbscFile);
    if (hasDbsc) await assertQuiet(dbscFile);
    let before: Read;
    let db: DatabaseSync | undefined;
    try {
      db = new Database(file);
      before = readDatabase(db);
      if (
        before.quick !== "ok" ||
        before.snapshot.version !== snapshot.version ||
        before.snapshot.columns.join(",") !== snapshot.columns.join(",")
      )
        throw new CookieStoreError(
          "schema-changed",
          "The cookie database is not the one the login was saved from.",
        );
      db.exec("BEGIN IMMEDIATE");
      try {
        const remove = db.prepare(`delete from cookies where ${IDENTITY}`);
        for (const row of before.snapshot.rows) remove.run(...identityOf(row));
        const insert = db.prepare(
          `insert into cookies (${snapshot.columns.join(", ")}) values (${snapshot.columns.map(() => "?").join(", ")})`,
        );
        for (const row of snapshot.rows) insert.run(...snapshot.columns.map((c) => row[c] ?? null));
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Nothing was open.
        }
        throw error;
      }
    } catch (error) {
      return fail(error);
    } finally {
      try {
        db?.close();
      } catch {
        // Closed already.
      }
    }
    if (hasDbsc) {
      let dbsc: DatabaseSync | undefined;
      try {
        dbsc = new Database(dbscFile);
        if (dbscPresent(dbsc)) {
          dbsc.exec("BEGIN IMMEDIATE");
          try {
            dbsc.prepare("delete from dbsc_session_tbl where key = ?").run(DBSC_KEY);
            dbsc.exec("COMMIT");
          } catch (error) {
            try {
              dbsc.exec("ROLLBACK");
            } catch {
              // Nothing was open.
            }
            throw error;
          }
        }
      } catch (error) {
        return fail(error);
      } finally {
        try {
          dbsc?.close();
        } catch {
          // Closed already.
        }
      }
    }
    // A second, separate open: what the browser will read, not what this handle remembers.
    let after: Read;
    let stillThere = false;
    try {
      const reader = new Database(file, { readOnly: true });
      try {
        after = readDatabase(reader);
      } finally {
        reader.close();
      }
      if (hasDbsc) {
        const side = new Database(dbscFile, { readOnly: true });
        try {
          stillThere = dbscPresent(side);
        } finally {
          side.close();
        }
      }
    } catch (error) {
      return fail(error);
    }
    if (
      after.quick !== "ok" ||
      after.others !== before.others ||
      after.count !== before.count ||
      stillThere ||
      after.snapshot.rows.length !== snapshot.rows.length ||
      !snapshot.rows.every((row) => {
        const found = after.snapshot.rows.find((r) => rowKey(r) === rowKey(row));
        return !!found && snapshot.columns.every((c) => sameValue(found[c] ?? null, row[c] ?? null));
      })
    )
      throw new CookieStoreError("mismatch", "The login did not read back.");
  },
};

/** The vault's JSON form of a snapshot: integers and blobs as tagged strings. */
export function encodeSnapshot(snapshot: CookieSnapshot): unknown {
  return {
    version: snapshot.version,
    columns: snapshot.columns,
    rows: snapshot.rows.map((row) =>
      Object.fromEntries(snapshot.columns.map((c) => [c, encodeValue(row[c] ?? null)])),
    ),
  };
}

/** The snapshot a vault record holds; throws unless every row is one of the login's. */
export function decodeSnapshot(value: unknown): CookieSnapshot {
  const record = value as { version?: unknown; columns?: unknown; rows?: unknown };
  if (
    !record ||
    typeof record.version !== "string" ||
    !Array.isArray(record.columns) ||
    !record.columns.every((c) => typeof c === "string" && /^[a-z_]+$/.test(c)) ||
    !Array.isArray(record.rows)
  )
    throw new Error("Invalid saved claude.ai login.");
  const columns = record.columns as string[];
  const rows = (record.rows as Record<string, unknown>[]).map((raw) => {
    const row: CookieRow = {};
    for (const column of columns) {
      const v = raw?.[column];
      if (v === null) row[column] = null;
      else if (typeof v === "string") row[column] = v;
      else if (v && typeof v === "object" && typeof (v as { i?: unknown }).i === "string")
        row[column] = BigInt((v as { i: string }).i);
      else if (v && typeof v === "object" && typeof (v as { b?: unknown }).b === "string")
        row[column] = new Uint8Array(Buffer.from((v as { b: string }).b, "base64"));
      else throw new Error("Invalid saved claude.ai login.");
    }
    return row;
  });
  if (!rows.length || !rows.every(isLoginRow)) throw new Error("Invalid saved claude.ai login.");
  return { version: record.version, columns, rows, unlisted: [] };
}

/**
 * Copies the cookie files that exist in a profile folder into a new folder in `scratch` (mode
 * 0700), keeping their relative places, and returns it. Used for a backup before a write and for
 * a copy of a running browser's database that a check reads.
 */
export async function backupCookieFiles(dir: string, scratch: string): Promise<string> {
  await fs.mkdir(scratch, { recursive: true, mode: 0o700 });
  const backup = path.join(scratch, crypto.randomUUID());
  await fs.mkdir(backup, { mode: 0o700 });
  for (const rel of COOKIE_FILES) {
    const source = path.join(dir, rel);
    let st;
    try {
      st = await fs.lstat(source);
    } catch {
      continue;
    }
    if (!st.isFile()) throw new Error("The browser's cookie files hold a link or a folder.");
    const target = path.join(backup, rel);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.copyFile(source, target);
    await fs.chmod(target, 0o600);
  }
  return backup;
}

/** Puts a backup's cookie files back; a file the backup lacks is removed (a journal a write left). */
export async function restoreCookieFiles(dir: string, backup: string): Promise<void> {
  for (const rel of COOKIE_FILES) {
    const target = path.join(dir, rel);
    const saved = path.join(backup, rel);
    if (await exists(saved)) {
      // Never through a link someone put in place.
      if (await exists(target)) {
        if (!(await fs.lstat(target)).isFile()) throw new Error("A cookie file became a link.");
      }
      await fs.copyFile(saved, target);
    } else if (await exists(target)) {
      if (!(await fs.lstat(target)).isFile()) throw new Error("A cookie file became a link.");
      await fs.rm(target, { force: true });
    }
  }
}
