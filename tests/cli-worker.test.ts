import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cliFixture } from "./cli-fixture";
import { insideClaudeDesktop, lastWorkerRecord } from "../cli/src/inside-desktop";
import { readObject } from "../electron/core/desktop-files";

const EXE = "/Applications/Claude.app/Contents/MacOS/Claude";

test("the ancestry walk finds Claude Desktop above this process, and stops on loops", () => {
  const listing = [
    `  300     1 ${EXE}`,
    `  400   300 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper`,
    `  450   400 /Users/x/.local/bin/claude`,
    `  500   450 /bin/zsh`,
    `  600   500 /usr/local/bin/node`,
    `  700     1 /usr/sbin/sshd`,
    `  800   700 /bin/zsh`,
    `  901   902 /bin/a`,
    `  902   901 /bin/b`,
  ].join("\n");
  assert.equal(insideClaudeDesktop(listing, 600, EXE), true);
  assert.equal(insideClaudeDesktop(listing, 800, EXE), false);
  assert.equal(insideClaudeDesktop(listing, 901, EXE), false);
  assert.equal(insideClaudeDesktop(listing, 12345, EXE), false);
});

async function insideFixture(t: any, options = {}) {
  const f = await cliFixture(t, options);
  const exe = path.join(f.temp, "Claude.app", "Contents", "MacOS", "Claude");
  f.deps.processList = async () => `  300     1 ${exe}\n  ${process.pid}   300 /usr/local/bin/node\n`;
  const spawned: { args: string[]; options: any }[] = [];
  f.deps.spawn = ((command: string, args: string[], opts: any) => {
    spawned.push({ args: [command, ...args], options: opts });
    return { unref() {}, once() {}, on() {} } as any;
  }) as any;
  return { f, spawned };
}

test("inside Claude Desktop, switch hands the work to a detached worker and quits nothing itself", async (t) => {
  const { f, spawned } = await insideFixture(t, { tty: true, answers: ["y"] });
  await f.saved("A");
  await f.saved("B");
  assert.equal(await f.run("switch", "A"), 0);
  assert.match(f.out(), /This session will end too/);
  assert.equal(f.state.quits, 0);
  assert.equal(spawned.length, 1);
  const [exec, self, worker, id] = spawned[0].args;
  assert.equal(exec, process.execPath);
  assert.equal(self, path.join(f.temp, "relay-cli.js"));
  assert.equal(worker, "__worker");
  assert.equal(spawned[0].options.detached, true);
  assert.equal(spawned[0].options.stdio, "ignore");
  assert.equal(spawned[0].options.env.RELAY_WORKER, "1");
  const record = lastWorkerRecord(path.join(f.home, "cli-operations"))!;
  assert.equal(record.id, id);
  assert.equal(record.status, "pending");
  assert.deepEqual(record.argv, ["switch", "A"]);
});

test("the worker runs the switch, records it, and status shows the result once", async (t) => {
  const { f } = await insideFixture(t);
  const a = await f.saved("A");
  await f.saved("B");
  assert.equal(await f.run("switch", "A", "--yes"), 0);
  const id = lastWorkerRecord(path.join(f.home, "cli-operations"))!.id;
  f.io.env.RELAY_WORKER = "1";
  f.io.env.RELAY_WORKER_DELAY_MS = "0";
  assert.equal(await f.run("__worker", id), 0);
  assert.equal((await readObject(f.claude, "config.json"))?.lastKnownAccountUuid, a.desktop!.accountUuid);
  const record = lastWorkerRecord(path.join(f.home, "cli-operations"))!;
  assert.equal(record.status, "done");
  f.clear();
  await f.run("status");
  assert.match(f.out(), /switch A: done/);
  f.clear();
  await f.run("status");
  assert.doesNotMatch(f.out(), /switch A: done/);
});

test("a failing worker records the failure without secrets", async (t) => {
  const { f } = await insideFixture(t);
  await f.saved("A");
  await f.saved("B");
  await f.run("switch", "A", "--yes");
  const id = lastWorkerRecord(path.join(f.home, "cli-operations"))!.id;
  f.io.env.RELAY_WORKER = "1";
  f.io.env.RELAY_WORKER_DELAY_MS = "0";
  f.state.failQuit = new Error("boom sk-ant-oat01-SECRETSECRETSECRETSECRETSECRETSECRET");
  assert.equal(await f.run("__worker", id), 1);
  const record = lastWorkerRecord(path.join(f.home, "cli-operations"))!;
  assert.equal(record.status, "failed");
  assert.ok(record.error && !record.error.includes("sk-ant-"));
  assert.match(record.error, /boom/);
});

test("an unwritable operations folder means a sandbox: exit 5 before any quit", async (t) => {
  const { f, spawned } = await insideFixture(t);
  await f.saved("A");
  await f.saved("B");
  const dir = path.join(f.home, "cli-operations");
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o500);
  assert.equal(await f.run("switch", "A", "--yes"), 5);
  assert.match(f.err(), /sandbox/);
  assert.equal(spawned.length, 0);
  assert.equal(f.state.quits, 0);
  fs.chmodSync(dir, 0o700);
});
