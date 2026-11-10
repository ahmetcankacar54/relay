import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../electron/core/store";
import { DesktopManager, DesktopSwitchRefused, type DesktopHost } from "../electron/core/desktop";
import { jsonBytes, readBytes, writeBytes } from "../electron/core/desktop-files";
import {
  SignInNotSettled,
  sessionPresence,
  type SessionPresence,
} from "../electron/core/desktop-session";
import { signOutsIn, signedOutSinceStart } from "../electron/core/desktop-launch";

/** A Chromium cookie database with the given claude.ai cookie names, as bytes. */
async function cookieDb(names: string[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-cookie-db-"));
  try {
    const file = path.join(dir, "Cookies");
    const db = new DatabaseSync(file);
    db.exec(
      "create table meta(key text primary key, value text); insert into meta values('version','24');" +
        "create table cookies(host_key text, name text, value text, encrypted_value blob)",
    );
    const add = db.prepare("insert into cookies values(?,?,?,?)");
    for (const name of names) add.run(".claude.ai", name, "", Buffer.from("v10-sealed"));
    db.close();
    return await fs.readFile(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("a cookie database holds a session only while it has a sessionKey row", async () => {
  assert.equal(await sessionPresence({ Cookies: await cookieDb(["sessionKey", "routingHint"]) }), "present");
  assert.equal(await sessionPresence({ "Network/Cookies": await cookieDb(["sessionKeyV3"]) }), "present");
  // Signed out, or a sign-in Chromium has not written yet: the other cookies stay.
  assert.equal(await sessionPresence({ Cookies: await cookieDb(["cf_clearance", "lastActiveOrg"]) }), "absent");
  // Bytes that are no database, and no database at all, say nothing.
  assert.equal(await sessionPresence({ Cookies: Buffer.from("deleted sessionKey row residue") }), "unknown");
  assert.equal(await sessionPresence({ Cookies: null }), "unknown");
});

const A = "00000000-0000-4000-8000-0000000000a1";
const LOG = [
  "2026-11-10 13:30:00 [info] Starting app {",
  `2026-11-10 13:34:08 [info] [account] Navigated to /logout, synthesizing logged-out`,
  `2026-11-10 13:34:08 [info] [account] Login-state transition (loggedOut: false → true, uuid: ${A} → <none>), clearing oauth cache`,
].join("\n");

test("Claude's log tells a start that signed itself out, and which account signed out when", () => {
  assert.equal(signedOutSinceStart("nothing"), undefined);
  assert.equal(signedOutSinceStart("x] Starting app {\n loaded"), false);
  assert.equal(signedOutSinceStart(LOG), true);
  // A sign-in after it, in the same run, and a later start both end it.
  assert.equal(
    signedOutSinceStart(LOG + "\n2026-11-10 13:35:00 [info] [account] Login-state transition (loggedOut: true → false, uuid: <none> → x)"),
    false,
  );
  assert.equal(signedOutSinceStart(LOG + "\n2026-11-10 14:00:00 [info] Starting app {"), false);
  assert.deepEqual(signOutsIn(LOG), [{ accountUuid: A, at: new Date(2026, 10, 10, 13, 34, 8).getTime() }]);
});

async function fixture(t: any) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "relay-sign-in-session-"));
  const root = path.join(temp, "Claude");
  await fs.mkdir(root);
  const store = new Store(path.join(temp, "Relay"));
  const state = {
    running: false,
    quits: 0,
    starts: 0,
    signedOut: false as boolean | undefined,
    session: "present" as SessionPresence,
    signOuts: [] as { accountUuid: string; at: number }[],
  };
  const host: DesktopHost = {
    available: async () => true,
    running: async () => state.running,
    quit: async () => {
      state.quits++;
      state.running = false;
    },
    launch: async () => {
      state.running = true;
      state.starts++;
    },
    signedOut: async () => state.signedOut,
    signOuts: async () => state.signOuts,
    seal: (s) => Buffer.from("TEST-ENCRYPTED:" + Buffer.from(s).toString("base64")),
    unseal: (b) => Buffer.from(b.toString().slice(15), "base64").toString(),
    draftScratchDir: path.join(temp, "tmp"),
  };
  const manager = new DesktopManager(root, store, host, path.join(temp, ".claude"));
  manager.sessionOf = async () => state.session;
  manager.sessionSettleMs = 60;
  manager.sessionPollMs = 5;
  manager.signInVerifyMs = [1, 2];
  await manager.initialize();
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  async function signIn(name: string, accountUuid: string = randomUUID(), orgId: string = randomUUID()) {
    await writeBytes(
      root,
      "config.json",
      jsonBytes({ "oauth:tokenCacheV2": `encrypted:${name}`, lastKnownAccountUuid: accountUuid }),
    );
    await fs.mkdir(path.join(root, "claude-code-sessions", accountUuid, orgId), { recursive: true });
    await writeBytes(root, "Cookies", Buffer.from(`cookie-${name}`));
    return { accountUuid, orgId };
  }
  async function account(name: string) {
    const a = store.create({ name, kind: "personal" });
    const { orgId } = await signIn(name);
    await manager.capture(a.id, orgId);
    return store.account(a.id);
  }
  const vault = (accountUuid: string) =>
    readBytes(path.join(temp, "Relay", "desktop-vault"), `accounts/${accountUuid}.bin`);
  return { temp, root, store, host, manager, state, signIn, account, vault };
}

test("a sign-in whose session is not in the cookie file yet is not saved, and Claude is not quit", async (t) => {
  const f = await fixture(t);
  const a = f.store.create({ name: "A", kind: "personal" });
  const { accountUuid, orgId } = await f.signIn("A");
  f.state.running = true;
  f.state.session = "absent";
  await assert.rejects(f.manager.capture(a.id, orgId), SignInNotSettled);
  assert.equal(f.state.quits, 0);
  assert.equal(await f.vault(accountUuid), null);
  assert.equal(f.store.account(a.id).desktop, undefined);
  // Chromium writes it while Relay waits: the same save then goes through.
  setTimeout(() => (f.state.session = "present"), 15);
  await f.manager.capture(a.id, orgId);
  assert.equal(f.state.quits, 1);
  assert.ok(await f.vault(accountUuid));
  assert.equal(f.store.account(a.id).desktop!.accountUuid, accountUuid);
});

test("a Claude that signed itself out is not waited for, and a closed one's session-less sign-in is refused", async (t) => {
  const f = await fixture(t);
  const a = f.store.create({ name: "A", kind: "personal" });
  const { accountUuid, orgId } = await f.signIn("A");
  f.state.session = "absent";
  f.state.running = true;
  f.state.signedOut = true;
  await assert.rejects(f.manager.capture(a.id, orgId), /signed out/);
  assert.equal(f.state.quits, 0);
  f.state.running = false;
  f.state.signedOut = false;
  await assert.rejects(f.manager.capture(a.id, orgId), /holds no session/);
  assert.equal(await f.vault(accountUuid), null);
});

test("a switch never replaces a saved sign-in with one that lost its session", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const b = await f.account("B");
  const savedB = await f.vault(b.desktop!.accountUuid);
  // B is open; its cookies lose the session (a sign-in Claude was quit on too early).
  await writeBytes(f.root, "Cookies", Buffer.from("cookie-B-without-session"));
  f.state.session = "absent";
  await f.manager.switchTo(a.id);
  await f.manager.signInVerified;
  assert.deepEqual(await f.vault(b.desktop!.accountUuid), savedB);
  assert.equal((await readBytes(f.root, "Cookies"))!.toString(), "cookie-A");
});

test("an account Claude signs out right after a switch is marked, skipped by unattended switches, and cleared by a new sign-in", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const b = await f.account("B");
  const rejected: string[] = [];
  f.manager.onSignInRejected = (account) => rejected.push(account.name);
  f.state.signedOut = true;
  await f.manager.switchTo(a.id);
  await f.manager.signInVerified;
  assert.ok(f.store.account(a.id).desktop!.rejectedAt);
  assert.deepEqual(rejected, ["A"]);
  // Claude dropped the cookies; the copy Relay keeps is not replaced by them.
  f.state.session = "absent";
  await f.manager.switchTo(b.id);
  f.state.signedOut = false;
  await f.manager.signInVerified;
  f.state.session = "present";
  assert.equal(f.store.account(b.id).desktop!.rejectedAt, undefined);
  assert.ok(f.store.account(a.id).desktop!.rejectedAt);
  await assert.rejects(f.manager.switchTo(a.id, { automatic: true }), DesktopSwitchRefused);
  // By hand it still opens, so the user can sign in there; a sign-in saved again clears the mark.
  await f.manager.beginLogin(a.id);
  await f.signIn("A", a.desktop!.accountUuid, a.desktop!.orgId);
  await f.manager.capture(a.id, a.desktop!.orgId);
  assert.equal(f.store.account(a.id).desktop!.rejectedAt, undefined);
});

test("signing out inside Claude ends the saved sign-in: the account is marked unless Claude is in it again", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const b = await f.account("B");
  f.state.signOuts = [
    { accountUuid: a.desktop!.accountUuid, at: Date.now() + 60_000 },
    // B's is older than its saved copy, and B is the account open now.
    { accountUuid: b.desktop!.accountUuid, at: Date.now() - 3_600_000 },
  ];
  await f.manager.noteSignOuts();
  assert.ok(f.store.account(a.id).desktop!.rejectedAt);
  assert.equal(f.store.account(b.id).desktop!.rejectedAt, undefined);
});
