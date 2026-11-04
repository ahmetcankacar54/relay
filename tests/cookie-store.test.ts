import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CookieStoreError,
  LOGIN_ROWS,
  backupCookieFiles,
  decodeSnapshot,
  encodeSnapshot,
  hasWebLogin,
  restoreCookieFiles,
  sessionCreatedMs,
  sqliteCookieStorage,
  type CookieSnapshot,
} from "../electron/core/cookie-store";
import { CLAUDE_EXTENSION_ID } from "../shared/browser-extension";

const COLUMNS = [
  "creation_utc",
  "host_key",
  "top_frame_site_key",
  "name",
  "value",
  "encrypted_value",
  "path",
  "expires_utc",
  "is_secure",
  "is_httponly",
  "last_access_utc",
  "has_expires",
  "is_persistent",
  "priority",
  "samesite",
  "source_scheme",
  "source_port",
  "last_update_utc",
  "source_type",
  "has_cross_site_ancestor",
];
const SCHEMA = `CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,top_frame_site_key TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL,path TEXT NOT NULL,expires_utc INTEGER NOT NULL,is_secure INTEGER NOT NULL,is_httponly INTEGER NOT NULL,last_access_utc INTEGER NOT NULL,has_expires INTEGER NOT NULL,is_persistent INTEGER NOT NULL,priority INTEGER NOT NULL,samesite INTEGER NOT NULL,source_scheme INTEGER NOT NULL,source_port INTEGER NOT NULL,last_update_utc INTEGER NOT NULL,source_type INTEGER NOT NULL,has_cross_site_ancestor INTEGER NOT NULL);
CREATE UNIQUE INDEX cookies_unique_index ON cookies(host_key, top_frame_site_key, has_cross_site_ancestor, name, path, source_scheme, source_port);`;
/** Chromium's microseconds since 1601: far past 2^53. */
const CREATED = 13_433_947_693_265_311n;

interface Cookie {
  host: string;
  name: string;
  partition?: string;
  value?: string;
  httponly?: number;
  secure?: number;
}
function add(db: DatabaseSync, c: Cookie, tag: string) {
  db.prepare(
    `insert into cookies (${COLUMNS.join(",")}) values (${COLUMNS.map(() => "?").join(",")})`,
  ).run(
    CREATED,
    c.host,
    c.partition ?? "",
    c.name,
    "",
    new Uint8Array(Buffer.from(`v10${c.value ?? c.name}-${tag}`)),
    "/",
    13_500_000_000_000_000n,
    c.secure ?? 1,
    c.httponly ?? 1,
    CREATED,
    1,
    1,
    1,
    1,
    2,
    443,
    CREATED,
    0,
    1,
  );
}
const LOGIN = [
  ["sessionKey", ".claude.ai"],
  ["sessionKeyLC", ".claude.ai"],
  ["sessionKeyV3", ".claude.ai"],
  ["routingHint", ".claude.ai"],
  ["lastActiveOrg", ".claude.ai"],
  ["__Host-sessionBinding", "claude.ai"],
  ["__Host-ant_trusted_device", "claude.ai"],
  ["activitySessionId", "claude.ai"],
] as const;
const OTHERS: Cookie[] = [
  { host: "claude.ai", name: "anthropic-device-id", httponly: 0 },
  { host: ".claude.ai", name: "cf_clearance" },
  { host: ".claude.ai", name: "cf_clearance", partition: "https://claude.ai" },
  { host: ".claude.ai", name: "__cf_bm" },
  { host: ".platform.claude.com", name: "sessionKey" },
  { host: ".bank.example", name: "session" },
  { host: ".news.example", name: "uid" },
];

/** A profile folder with a Chromium-shaped cookie database (version 24) and a device-bound-session database. */
function profile(t: any, tag: string, options: { network?: boolean; version?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cookies-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const folder = options.network ? path.join(dir, "Network") : dir;
  fs.mkdirSync(folder, { recursive: true });
  const db = new DatabaseSync(path.join(folder, "Cookies"));
  db.exec(SCHEMA);
  db.prepare("insert into meta (key, value) values ('version', ?)").run(options.version ?? "24");
  for (const [name, host] of LOGIN) add(db, { host, name }, tag);
  add(db, { host: "claude.ai", name: "lastActiveOrg", partition: `chrome-extension://${CLAUDE_EXTENSION_ID}` }, tag);
  for (const other of OTHERS) add(db, other, "other");
  db.close();
  const dbsc = new DatabaseSync(path.join(folder, "Device Bound Sessions"));
  dbsc.exec("CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR); CREATE TABLE dbsc_session_tbl ( key TEXT, proto BLOB, PRIMARY KEY(key));");
  dbsc.prepare("insert into dbsc_session_tbl (key, proto) values (?, ?)").run("https://claude.ai", new Uint8Array([1, 2, 3]));
  dbsc.prepare("insert into dbsc_session_tbl (key, proto) values (?, ?)").run("https://other.example", new Uint8Array([9]));
  dbsc.close();
  return { dir, folder };
}
const dbscKeys = (folder: string) => {
  const db = new DatabaseSync(path.join(folder, "Device Bound Sessions"), { readOnly: true });
  const keys = (db.prepare("select key from dbsc_session_tbl order by key").all() as { key: string }[]).map((r) => r.key);
  db.close();
  return keys;
};
const everyRow = (folder: string) => {
  const db = new DatabaseSync(path.join(folder, "Cookies"), { readOnly: true });
  const st = db.prepare("select * from cookies order by host_key, top_frame_site_key, name");
  st.setReadBigInts(true);
  const rows = st.all().map((r) => JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v)));
  db.close();
  return rows;
};

test("read finds exactly the login rows, in their place and partition, and nothing else", async (t) => {
  const { dir } = profile(t, "A");
  const snap = await sqliteCookieStorage.read(dir);
  assert.equal(snap.version, "24");
  assert.deepEqual(snap.columns, COLUMNS);
  assert.equal(snap.rows.length, LOGIN.length + 1);
  const names = snap.rows.map((r) => `${r.host_key}|${r.top_frame_site_key ? "ext" : ""}|${r.name}`).sort();
  assert.ok(names.includes("claude.ai|ext|lastActiveOrg"));
  assert.ok(!names.some((n) => /cf_clearance|__cf_bm|device-id|bank|news|platform/.test(n)));
  assert.equal(hasWebLogin(snap), true);
  assert.deepEqual(snap.unlisted, []);
  // Integers past 2^53 and blobs survive exactly.
  assert.equal(snap.rows[0].creation_utc, CREATED);
  assert.ok(snap.rows[0].encrypted_value instanceof Uint8Array);
  assert.equal(typeof sessionCreatedMs(snap), "number");
});

test("a login-like claude.ai cookie that is not listed is reported by name, never by value", async (t) => {
  const { dir, folder } = profile(t, "A");
  const db = new DatabaseSync(path.join(folder, "Cookies"));
  add(db, { host: ".claude.ai", name: "sessionKeyV9" }, "A");
  add(db, { host: ".claude.ai", name: "theme", httponly: 0 }, "A");
  db.close();
  const snap = await sqliteCookieStorage.read(dir);
  assert.deepEqual(snap.unlisted, ["sessionKeyV9"]);
});

test("write puts the saved login in place, leaves every other row byte-identical, and drops the site's device-bound session row", async (t) => {
  const a = profile(t, "A");
  const b = profile(t, "B");
  const saved = await sqliteCookieStorage.read(b.dir);
  const other = everyRow(a.dir).filter((r) => !LOGIN.some(([n]) => r.includes(`"name":"${n}"`)) && !r.includes("chrome-extension"));
  await sqliteCookieStorage.write(a.dir, saved);
  const after = await sqliteCookieStorage.read(a.dir);
  assert.deepEqual(encodeSnapshot(after), encodeSnapshot(saved));
  assert.ok(Buffer.from(after.rows[0].encrypted_value as Uint8Array).toString().endsWith("-B"));
  // Every row that was not the login is exactly as it was.
  const now = everyRow(a.dir);
  for (const row of other) assert.ok(now.includes(row), "an unrelated row changed");
  assert.equal(now.length, everyRow(b.dir).length);
  assert.deepEqual(dbscKeys(a.folder), ["https://other.example"]);
});

test("a profile whose cookies live in Network/ is found there", async (t) => {
  const { dir } = profile(t, "A", { network: true });
  assert.equal((await sqliteCookieStorage.read(dir)).rows.length, LOGIN.length + 1);
  await sqliteCookieStorage.write(dir, await sqliteCookieStorage.read(dir));
});

test("write refuses a database that is not the one the login was saved from", async (t) => {
  const a = profile(t, "A");
  const newer = profile(t, "B", { version: "25" });
  const saved = await sqliteCookieStorage.read(newer.dir);
  await assert.rejects(sqliteCookieStorage.write(a.dir, saved), (e: any) => e instanceof CookieStoreError && e.reason === "schema-changed");
  const odd = profile(t, "C");
  const db = new DatabaseSync(path.join(odd.folder, "Cookies"));
  db.exec("alter table cookies add column extra integer default 0");
  db.close();
  await assert.rejects(sqliteCookieStorage.write(odd.dir, await sqliteCookieStorage.read(profile(t, "D").dir)), (e: any) => e.reason === "schema-changed");
  // Nothing was written.
  assert.ok(Buffer.from((await sqliteCookieStorage.read(a.dir)).rows[0].encrypted_value as Uint8Array).toString().endsWith("-A"));
});

test("write refuses a database with a pending journal and rows that are not a login", async (t) => {
  const a = profile(t, "A");
  const saved = await sqliteCookieStorage.read(profile(t, "B").dir);
  fs.writeFileSync(path.join(a.folder, "Cookies-journal"), "hot");
  await assert.rejects(sqliteCookieStorage.write(a.dir, saved), (e: any) => e.reason === "journal-pending");
  fs.rmSync(path.join(a.folder, "Cookies-journal"));
  const bad: CookieSnapshot = { ...saved, rows: [{ ...saved.rows[0], host_key: ".bank.example", name: "session" }] };
  await assert.rejects(sqliteCookieStorage.write(a.dir, bad), (e: any) => e.reason === "failed");
  await assert.rejects(sqliteCookieStorage.write(a.dir, { ...saved, rows: [] }));
});

test("a missing database is reported as missing, and a link is refused", async (t) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cookies-none-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  await assert.rejects(sqliteCookieStorage.read(empty), (e: any) => e.reason === "missing");
  const a = profile(t, "A");
  fs.renameSync(path.join(a.folder, "Cookies"), path.join(a.folder, "Real"));
  fs.symlinkSync(path.join(a.folder, "Real"), path.join(a.folder, "Cookies"));
  await assert.rejects(sqliteCookieStorage.read(a.dir));
});

test("a failed write is undone by the backup of the cookie files", async (t) => {
  const a = profile(t, "A");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cookies-scratch-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const before = everyRow(a.dir);
  const backup = await backupCookieFiles(a.dir, scratch);
  assert.equal((fs.statSync(backup).mode & 0o777), 0o700);
  await sqliteCookieStorage.write(a.dir, await sqliteCookieStorage.read(profile(t, "B").dir));
  assert.notDeepEqual(everyRow(a.dir), before);
  fs.writeFileSync(path.join(a.folder, "Cookies-journal"), "left behind");
  await restoreCookieFiles(a.dir, backup);
  assert.deepEqual(everyRow(a.dir), before);
  assert.deepEqual(dbscKeys(a.folder), ["https://claude.ai", "https://other.example"]);
  assert.equal(fs.existsSync(path.join(a.folder, "Cookies-journal")), false, "a journal the backup lacked is removed");
});

test("a backup refuses cookie files that are links", async (t) => {
  const a = profile(t, "A");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cookies-scratch-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  fs.renameSync(path.join(a.folder, "Cookies"), path.join(a.folder, "Real"));
  fs.symlinkSync(path.join(a.folder, "Real"), path.join(a.folder, "Cookies"));
  await assert.rejects(backupCookieFiles(a.dir, scratch));
});

test("a saved login encodes to JSON text and decodes to the same rows; foreign rows never decode", async (t) => {
  const snap = await sqliteCookieStorage.read(profile(t, "A").dir);
  const text = JSON.stringify(encodeSnapshot(snap));
  const back = decodeSnapshot(JSON.parse(text));
  assert.deepEqual(encodeSnapshot(back), encodeSnapshot(snap));
  assert.equal(back.rows[0].creation_utc, CREATED);
  assert.ok(back.rows[0].encrypted_value instanceof Uint8Array);
  const foreign = JSON.parse(text);
  foreign.rows[0].host_key = ".bank.example";
  assert.throws(() => decodeSnapshot(foreign));
  const injected = JSON.parse(text);
  injected.columns.push("x; drop table cookies");
  assert.throws(() => decodeSnapshot(injected));
  assert.throws(() => decodeSnapshot({}));
  assert.ok(LOGIN_ROWS.every((l) => l.host === "claude.ai" || l.host === ".claude.ai"));
});

test("SQLite is available here", async () => {
  assert.equal(await sqliteCookieStorage.available(), true);
});

test("two snapshots are the same login by the session's creation time, and on one organization by its bytes", async () => {
  const { sameLogin, sameOrganization } = await import("../electron/core/cookie-store");
  const row = (name: string, created: bigint, value: string) => ({
    creation_utc: created,
    host_key: name === "lastActiveOrg" || name === "sessionKey" ? ".claude.ai" : "claude.ai",
    top_frame_site_key: "",
    name,
    encrypted_value: new Uint8Array(Buffer.from(value)),
  });
  const snap = (created: bigint, session: string, org?: string) => ({
    version: "24",
    columns: ["creation_utc", "host_key", "top_frame_site_key", "name", "encrypted_value"],
    rows: [row("sessionKey", created, session), ...(org ? [row("lastActiveOrg", created, org)] : [])],
    unlisted: [],
  });
  // The server set the session again (new bytes): the browser kept its creation time.
  assert.equal(sameLogin(snap(10n, "v10a"), snap(10n, "v10b")), true);
  assert.equal(sameLogin(snap(10n, "v10a"), snap(11n, "v10a")), false);
  assert.equal(sameLogin(snap(10n, "v10a"), { ...snap(10n, "v10a"), rows: [] }), false);
  assert.equal(sameOrganization(snap(1n, "x", "v10ORG"), snap(2n, "y", "v10ORG")), true);
  assert.equal(sameOrganization(snap(1n, "x", "v10ORG"), snap(2n, "y", "v10OTHER")), false);
  assert.equal(sameOrganization(snap(1n, "x"), snap(2n, "y", "v10ORG")), false);
});
