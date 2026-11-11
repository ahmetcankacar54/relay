import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cliFixture } from "./cli-fixture";
import { holdInChild } from "./lock-child";
import { jsonBytes, writeBytes } from "../electron/core/desktop-files";

test("list marks the account Claude Desktop is signed in to, in a table and as JSON", { skip: process.platform === "win32" && "macOS only: the relay CLI refuses other systems" }, async (t) => {
  const f = await cliFixture(t);
  const a = await f.saved("A");
  const b = await f.saved("Work", "Vertex"); // Desktop is now signed in to Work
  assert.equal(await f.run("list"), 0);
  const lines = f.out().split("\n");
  assert.match(lines.find((l) => l.includes("Work"))!, /^\*/);
  assert.match(lines.find((l) => /\bA\b/.test(l))!, /^ /);
  assert.match(f.out(), /work · Vertex/);
  f.clear();
  assert.equal(await f.run("list", "--json"), 0);
  const rows = JSON.parse(f.out());
  assert.deepEqual(
    rows.map((r: any) => [r.id, r.name, r.kind, r.active, r.desktop.linked, r.limits]),
    [
      [a.id, "A", "personal", false, true, "not-connected"],
      [b.id, "Work", "work", true, true, "not-connected"],
    ],
  );
  assert.ok(!f.out().includes("FIXTURE-SECRET"));
});

test("list with no accounts says how to add one", { skip: process.platform === "win32" && "macOS only: the relay CLI refuses other systems" }, async (t) => {
  const f = await cliFixture(t);
  assert.equal(await f.run("ls"), 0);
  assert.match(f.out(), /relay add/);
});

test("status names the active account, and an unknown one as unsaved", { skip: process.platform === "win32" && "macOS only: the relay CLI refuses other systems" }, async (t) => {
  const f = await cliFixture(t);
  await f.saved("A");
  f.state.running = true;
  assert.equal(await f.run("status"), 0);
  assert.match(f.out(), /running/);
  assert.match(f.out(), /signed in as A/);
  f.clear();
  await writeBytes(
    f.claude,
    "config.json",
    jsonBytes({ "oauth:tokenCacheV2": "FIXTURE-SECRET-x", lastKnownAccountUuid: randomUUID() }),
  );
  assert.equal(await f.run("status", "--json"), 0);
  const s = JSON.parse(f.out());
  assert.equal(s.desktop.running, true);
  assert.equal(s.desktop.account.id, undefined);
  assert.equal(s.relay.vault, "ready");
  assert.equal(s.relay.appRunning, false);
  assert.equal(s.relay.historyMode, "same-group");
  f.clear();
  await f.run("status");
  assert.match(f.out(), /unsaved account/);
  assert.ok(!f.out().includes("FIXTURE-SECRET"));
});

test("status shows a pending sign-in and a lock held by another process", { skip: process.platform === "win32" && "macOS only: the relay CLI refuses other systems" }, async (t) => {
  const f = await cliFixture(t);
  const a = await f.saved("A");
  await writeBytes(
    path.join(f.home, "desktop-vault"),
    "pending.json",
    jsonBytes({ profileId: a.id, startedAt: "2026-10-19T09:00:00.000Z" }),
  );
  const child = await holdInChild(path.join(f.home, "desktop-vault", "operation.lock"), "switch");
  t.after(() => child.kill());
  assert.equal(await f.run("status", "--json"), 0);
  const s = JSON.parse(f.out());
  assert.deepEqual(s.desktop.pendingSignIn, { name: "A", since: "2026-10-19T09:00:00.000Z" });
  assert.equal(s.relay.lock.by, "cli");
  assert.equal(s.relay.lock.kind, "switch");
  f.clear();
  await f.run("status", "--lang", "tr");
  assert.match(f.out(), /relay add --resume/);
  assert.match(f.out(), /Başka bir relay komutu/);
});

test("Relay.app shows as running from the process list", { skip: process.platform === "win32" && "macOS only: the relay CLI refuses other systems" }, async (t) => {
  const f = await cliFixture(t, { appVersion: "0.12.0" });
  f.deps.processList = async () => "  501     1 /Applications/Relay.app/Contents/MacOS/Relay\n";
  await f.run("status", "--json");
  const s = JSON.parse(f.out());
  assert.equal(s.relay.appRunning, true);
  assert.equal(s.relay.appVersion, "0.12.0");
});

test("status and list never write the registry", { skip: process.platform === "win32" && "macOS only: the relay CLI refuses other systems" }, async (t) => {
  const f = await cliFixture(t);
  await f.saved("A");
  const file = path.join(f.home, "state.json");
  const before = fs.statSync(file).mtimeMs;
  await f.run("status");
  await f.run("list");
  assert.equal(fs.statSync(file).mtimeMs, before);
});

test("a lock held for an app task is described in words, not as a raw kind", { skip: process.platform === "win32" && "macOS only: the relay CLI refuses other systems" }, async (t) => {
  const f = await cliFixture(t);
  await f.saved("A");
  await f.saved("B"); // B is open in Claude, so switching to A needs the lock
  const child = await holdInChild(path.join(f.home, "desktop-vault", "operation.lock"), "draft-retype", "app");
  t.after(() => child.kill());
  await f.run("status");
  assert.match(f.out(), /re-typing a draft/);
  f.clear();
  assert.equal(await f.run("switch", "A", "--yes"), 3);
  assert.match(f.err(), /Relay\.app is re-typing a draft/);
});
