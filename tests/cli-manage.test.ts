import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { cliFixture } from "./cli-fixture";
import { childReady } from "./lock-child";

function digest(dir: string): string {
  const hash = crypto.createHash("sha256");
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else hash.update(p).update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return hash.digest("hex");
}
function fakeClaude(dir: string) {
  const file = path.join(dir, "fake-claude");
  const log = path.join(dir, "claude.log");
  fs.writeFileSync(file, `#!/bin/sh\necho "$*|$CLAUDE_CONFIG_DIR" >> "${log}"\nexit 0\n`, { mode: 0o755 });
  return { file, log: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "") };
}

test("remove forgets an account, its sealed sign-in and its profile, and leaves Claude's data alone", async (t) => {
  const f = await cliFixture(t);
  await f.saved("A");
  const b = await f.saved("B");
  await f.run("switch", "A", "--yes");
  const store = f.store();
  store.update((s) => {
    s.settings.desktopHistoryAccounts = [b.id];
    s.settings.autoSwitchAccounts = [b.id];
    s.settings.planning.accounts = [{ id: b.id }];
  });
  const sealed = path.join(f.home, "desktop-vault", "accounts", `${b.desktop!.accountUuid}.bin`);
  assert.ok(fs.existsSync(sealed));
  // The Claude extension's saved sign-in for B goes too; A's stays.
  const extension = path.join(f.home, "desktop-vault", "extension");
  fs.mkdirSync(extension, { recursive: true });
  fs.writeFileSync(path.join(extension, `${b.desktop!.accountUuid}.bin`), "sealed");
  fs.writeFileSync(path.join(extension, "other.bin"), "sealed");
  const before = digest(f.claude);
  assert.equal(await f.run("remove", "B", "--yes"), 0);
  assert.equal(fs.existsSync(sealed), false);
  assert.equal(fs.existsSync(path.join(extension, `${b.desktop!.accountUuid}.bin`)), false);
  assert.ok(fs.existsSync(path.join(extension, "other.bin")));
  assert.equal(fs.existsSync(path.join(f.home, "profiles", b.id)), false);
  const after = f.store().state;
  assert.deepEqual(after.accounts.map((a) => a.name), ["A"]);
  assert.deepEqual(after.settings.desktopHistoryAccounts, []);
  assert.deepEqual(after.settings.autoSwitchAccounts, []);
  assert.deepEqual(after.settings.planning.accounts, []);
  assert.equal(digest(f.claude), before);
});

test("remove refuses the active account and asks first without a terminal", async (t) => {
  const f = await cliFixture(t);
  await f.saved("A");
  await f.saved("B");
  assert.equal(await f.run("remove", "B", "--yes"), 3);
  assert.equal(await f.run("remove", "A"), 4);
  assert.equal(f.store().state.accounts.length, 2);
});

test("a connected account is signed out with the official CLI in its own profile", async (t) => {
  const f = await cliFixture(t);
  const a = await f.saved("A");
  await f.saved("B");
  const claude = fakeClaude(f.temp);
  f.deps.claude = () => claude.file;
  f.store().update((s) => {
    s.accounts[0].auth = { loggedIn: true, checkedAt: new Date().toISOString() };
  });
  assert.equal(await f.run("remove", "A", "--yes"), 0);
  assert.equal(claude.log().trim(), `auth logout|${path.join(f.home, "profiles", a.id)}`);
});

test("a held profile lock exits 3", async (t) => {
  const f = await cliFixture(t);
  const a = await f.saved("A");
  await f.saved("B");
  const child = await childReady("profile-lock-child.ts", [path.join(f.home, "profiles", ".locks"), a.id, "shared"]);
  t.after(() => child.kill());
  assert.equal(await f.run("remove", "A", "--yes"), 3);
  assert.equal(f.store().state.accounts.length, 2);
});

test("rename renames, and refuses a name another account has", async (t) => {
  const f = await cliFixture(t);
  await f.saved("A");
  await f.saved("B");
  assert.equal(await f.run("rename", "A", "Ana"), 0);
  assert.deepEqual(f.store().state.accounts.map((a) => a.name), ["Ana", "B"]);
  assert.equal(await f.run("rename", "Ana", "b"), 2);
  assert.equal(await f.run("rename", "Ana"), 2);
});

test("history mode persists; selected needs two accounts", async (t) => {
  const f = await cliFixture(t);
  const a = await f.saved("A");
  const b = await f.saved("B");
  assert.equal(await f.run("history", "mode", "off"), 0);
  assert.equal(f.store().state.settings.desktopHistoryTransfer, "off");
  assert.equal(await f.run("history", "mode", "selected", "--accounts", "A"), 2);
  assert.equal(await f.run("history", "mode", "selected", "--accounts", "A,B"), 0);
  const s = f.store().state.settings;
  assert.equal(s.desktopHistoryTransfer, "selected");
  assert.deepEqual(s.desktopHistoryAccounts, [a.id, b.id]);
  assert.equal(await f.run("history", "mode", "sometimes"), 2);
});

test("history --json reports the mode and the active account's summary", async (t) => {
  const f = await cliFixture(t);
  await f.saved("A");
  const b = await f.saved("B");
  assert.equal(await f.run("history", "--json"), 0);
  const h = JSON.parse(f.out());
  assert.equal(h.mode, "same-group");
  assert.equal(h.account.id, b.id);
  assert.deepEqual(h.sources, ["A"]);
  assert.equal(typeof h.summary.indexed, "number");
});

test("history sync --yes restarts Claude once", async (t) => {
  const f = await cliFixture(t);
  await f.saved("A");
  await f.saved("B");
  assert.equal(await f.run("history", "sync", "--yes"), 0);
  assert.equal(f.state.quits, 1);
  assert.equal(f.state.starts, 1);
});
