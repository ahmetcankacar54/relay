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

test("every write stamps schema 2, and the app's default options stamp a schema-less file on open", (t) => {
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
  assert.equal(app.fileSchema, 2);
  assert.equal(raw(dir).schema, 2);
});

test("a newer file is read leniently and every write is refused", (t) => {
  const dir = folder(t);
  new Store(dir).create({ name: "A", kind: "personal" });
  const newer = raw(dir);
  newer.schema = 3;
  newer.settings.futureKey = true;
  newer.settings.planning.futurePlanning = 1;
  newer.accounts[0].futureField = "x";
  writeRaw(dir, newer);
  const before = fs.readFileSync(path.join(dir, "state.json"), "utf8");
  const store = new Store(dir, CLI);
  assert.equal(store.state.accounts[0].name, "A");
  assert.equal(store.fileSchema, 3);
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
