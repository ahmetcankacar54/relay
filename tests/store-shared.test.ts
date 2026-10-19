import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STATE_SCHEMA, Store, StoreWriteRefused } from "../electron/core/store";
import { LockBusyError } from "../electron/core/process-lock";
import { holdInChild } from "./lock-child";

const CLI = { by: "cli", backupOnOpen: false, migrateOnOpen: false } as const;
function folder(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-store-shared-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const raw = (dir: string) =>
  JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
const writeRaw = (dir: string, value: unknown) =>
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(value));

test("two stores on one folder never lose each other's writes", (t) => {
  const dir = folder(t);
  const a = new Store(dir),
    b = new Store(dir, CLI);
  a.create({ name: "A", kind: "personal" });
  b.create({ name: "B", kind: "personal" });
  a.update((s) => {
    s.accounts[0].name = "A2";
  });
  assert.deepEqual(
    new Store(dir).state.accounts.map((x) => x.name),
    ["A2", "B"],
  );
  assert.equal(fs.existsSync(path.join(dir, "state.lock")), false);
});

test("reload sees another process's write, and only then reports a change", (t) => {
  const dir = folder(t);
  const a = new Store(dir),
    b = new Store(dir, CLI);
  b.create({ name: "B", kind: "personal" });
  assert.equal(a.reload(), true);
  assert.equal(a.state.accounts.length, 1);
  assert.equal(a.reload(), false);
});

test("every write stamps this build's schema, and the app's default options stamp a schema-less file on open", (t) => {
  const dir = folder(t);
  new Store(dir).create({ name: "A", kind: "personal" });
  assert.equal(raw(dir).schema, STATE_SCHEMA);
  const old = raw(dir);
  delete old.schema;
  writeRaw(dir, old);
  const cli = new Store(dir, { ...CLI, adoptUnversioned: false });
  assert.equal(cli.fileSchema, 1);
  assert.equal(raw(dir).schema, undefined);
  const app = new Store(dir);
  assert.equal(app.fileSchema, STATE_SCHEMA);
  assert.equal(raw(dir).schema, STATE_SCHEMA);
});

test("a newer file is read leniently and every write is refused", (t) => {
  const dir = folder(t);
  new Store(dir).create({ name: "A", kind: "personal" });
  const newer = raw(dir);
  newer.schema = STATE_SCHEMA + 1;
  newer.settings.futureKey = true;
  newer.settings.planning.futurePlanning = 1;
  newer.accounts[0].futureField = "x";
  writeRaw(dir, newer);
  const before = fs.readFileSync(path.join(dir, "state.json"), "utf8");
  const store = new Store(dir, CLI);
  assert.equal(store.state.accounts[0].name, "A");
  assert.equal(store.fileSchema, STATE_SCHEMA + 1);
  assert.throws(
    () => store.create({ name: "B", kind: "personal" }),
    (e: any) => e instanceof StoreWriteRefused && e.reason === "newer-schema",
  );
  assert.equal(fs.readFileSync(path.join(dir, "state.json"), "utf8"), before);
});

test("an unversioned file is refused when adoptUnversioned is false", (t) => {
  const dir = folder(t);
  new Store(dir).create({ name: "A", kind: "personal" });
  const old = raw(dir);
  delete old.schema;
  writeRaw(dir, old);
  const store = new Store(dir, { ...CLI, adoptUnversioned: false });
  assert.throws(
    () => store.update(() => {}),
    (e: any) => e instanceof StoreWriteRefused && e.reason === "unversioned",
  );
});

test("the CLI's options skip open-time backups and migrations", (t) => {
  const dir = folder(t);
  new Store(dir).create({ name: "A", kind: "personal" });
  const old = raw(dir);
  delete old.settings.historyPolicyVersion;
  writeRaw(dir, old);
  const backups = () =>
    fs.existsSync(path.join(dir, "state-backups"))
      ? fs.readdirSync(path.join(dir, "state-backups")).length
      : 0;
  const count = backups();
  new Store(dir, CLI);
  assert.equal(backups(), count);
  assert.equal(raw(dir).settings.historyPolicyVersion, undefined);
});

test("a state.lock held by another process makes update wait, then throw after lockWaitMs", async (t) => {
  const dir = folder(t);
  const store = new Store(dir, { ...CLI, lockWaitMs: 200 });
  const child = await holdInChild(path.join(dir, "state.lock"), "state");
  t.after(() => child.kill());
  const started = Date.now();
  assert.throws(() => store.create({ name: "A", kind: "personal" }), LockBusyError);
  assert.ok(Date.now() - started >= 200);
});

test("a schema 2 registry opens with no browser profiles and is written as schema 3", (t) => {
  const dir = folder(t);
  new Store(dir).create({ name: "A", kind: "personal" });
  const old = raw(dir);
  old.schema = 2;
  writeRaw(dir, old);
  const store = new Store(dir);
  assert.equal(STATE_SCHEMA, 3);
  assert.equal(raw(dir).schema, 3);
  assert.equal(store.state.accounts[0].browser, undefined);
});

test("an account's browser profile survives a round trip, is cleared, and is never shared", (t) => {
  const dir = folder(t);
  const store = new Store(dir);
  const a = store.create({ name: "A", kind: "personal" });
  const b = store.create({ name: "B", kind: "personal" });
  const work = { app: "brave", profile: "Default", name: "Work" } as const;
  assert.deepEqual(store.setBrowser(a.id, work).browser, work);
  assert.deepEqual(new Store(dir, CLI).account(a.id).browser, work);
  assert.throws(
    () => store.setBrowser(b.id, { ...work, name: "Other" }),
    /Another account already uses this browser profile/,
  );
  // The same folder in another browser is another profile.
  store.setBrowser(b.id, { ...work, app: "chrome" });
  // Choosing it again for the same account is fine.
  store.setBrowser(a.id, work);
  assert.equal(store.setBrowser(a.id, undefined).browser, undefined);
  assert.equal("browser" in raw(dir).accounts[0], false);
  assert.deepEqual(store.setBrowser(b.id, work).browser, work);
});

test("a browser profile with an unsafe folder or an unknown browser is refused", (t) => {
  const store = new Store(folder(t));
  const a = store.create({ name: "A", kind: "personal" });
  for (const bad of [
    { app: "brave", profile: "../Default", name: "x" },
    { app: "brave", profile: "--flag", name: "x" },
    { app: "safari", profile: "Default", name: "x" },
    { app: "brave", profile: "Default", name: "" },
  ])
    assert.throws(() => store.setBrowser(a.id, bad as any));
  assert.equal(store.account(a.id).browser, undefined);
});
