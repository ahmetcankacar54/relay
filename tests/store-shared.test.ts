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

test("a schema 3 registry with a browser profile opens without it and is written as the current schema", (t) => {
  const dir = folder(t);
  new Store(dir).create({ name: "A", kind: "personal" });
  const old = raw(dir);
  old.schema = 3;
  old.accounts[0].browser = { app: "brave", profile: "Default", name: "Work" };
  writeRaw(dir, old);
  const store = new Store(dir);
  assert.equal(STATE_SCHEMA, 6);
  assert.equal(raw(dir).schema, 6);
  assert.equal("browser" in raw(dir).accounts[0], false);
  assert.equal("browser" in store.state.accounts[0], false);
  // The rest of the account is as it was.
  assert.equal(store.state.accounts[0].name, "A");
});

test("the Claude extension setting survives a round trip, and a missing one means the default", (t) => {
  const dir = folder(t);
  const store = new Store(dir);
  assert.equal(store.state.settings.claudeExtension, undefined);
  store.update((state) => {
    state.settings.claudeExtension = {
      mode: "closed",
      browser: { app: "brave", profile: "Profile 1" },
    };
  });
  assert.deepEqual(new Store(dir, CLI).state.settings.claudeExtension, {
    mode: "closed",
    browser: { app: "brave", profile: "Profile 1" },
  });
  store.update((state) => {
    state.settings.claudeExtension = { mode: "off" };
  });
  assert.deepEqual(new Store(dir, CLI).state.settings.claudeExtension, { mode: "off" });
});

test("an extension setting with an unsafe folder, an unknown browser or an unknown mode is refused", (t) => {
  const store = new Store(folder(t));
  for (const bad of [
    { mode: "restart", browser: { app: "brave", profile: "../Default" } },
    { mode: "restart", browser: { app: "brave", profile: "--flag" } },
    { mode: "restart", browser: { app: "safari", profile: "Default" } },
    { mode: "always" },
    { mode: "restart", extra: 1 },
  ])
    assert.throws(() =>
      store.update((state) => {
        state.settings.claudeExtension = bad as any;
      }),
    );
  assert.equal(store.state.settings.claudeExtension, undefined);
});

test("a schema 4 registry's extension mode never turns into one that writes to a browser", (t) => {
  for (const [mode, expected] of [
    ["restart", "guide"],
    ["closed", "guide"],
    ["off", "off"],
  ] as const) {
    const dir = folder(t);
    new Store(dir).create({ name: "A", kind: "personal" });
    const old = raw(dir);
    old.schema = 4;
    old.settings.claudeExtension = { mode, browser: { app: "brave", profile: "Default" } };
    writeRaw(dir, old);
    const store = new Store(dir);
    assert.equal(store.state.settings.claudeExtension?.mode, expected);
    // The chosen browser profile stays.
    assert.deepEqual(store.state.settings.claudeExtension?.browser, { app: "brave", profile: "Default" });
    assert.equal(raw(dir).schema, 6);
    assert.equal(raw(dir).settings.claudeExtension.mode, expected);
  }
});

test("a schema 5 registry keeps the modes that write to a browser, and accepts guide", (t) => {
  for (const mode of ["restart", "closed", "guide", "off"] as const) {
    const dir = folder(t);
    const first = new Store(dir);
    first.update((state) => {
      state.settings.claudeExtension = { mode };
    });
    assert.equal(raw(dir).schema, 6);
    assert.equal(new Store(dir).state.settings.claudeExtension?.mode, mode);
  }
});
