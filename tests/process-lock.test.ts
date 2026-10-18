import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LockBusyError,
  ProcessLock,
  processStartedAt,
} from "../electron/core/process-lock";
import { exited, holdInChild } from "./lock-child";

function tempLock(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "vault", "operation.lock");
}
/** A pid no process has: far above macOS's pid range. */
const DEAD_PID = 999_999;

test("a live holder in another process makes tryAcquire throw LockBusyError naming it", async (t) => {
  const file = tempLock(t);
  const child = await holdInChild(file, "switch");
  t.after(() => child.kill());
  assert.throws(
    () => new ProcessLock(file, "app").tryAcquire("switch"),
    (e: any) =>
      e instanceof LockBusyError &&
      e.holder.by === "cli" &&
      e.holder.kind === "switch" &&
      e.holder.pid === child.pid,
  );
  assert.equal(new ProcessLock(file, "app").holder()?.pid, child.pid);
});

test("a dead holder's lock is swept and taken", (t) => {
  const file = tempLock(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ pid: DEAD_PID, token: "x", by: "cli", kind: "switch", startedAt: new Date().toISOString() }),
  );
  const lock = new ProcessLock(file, "app");
  assert.equal(lock.holder(), undefined);
  lock.tryAcquire("merge");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, process.pid);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  lock.release();
  assert.equal(fs.existsSync(file), false);
});

test("a pid reused by a newer process counts as stale", (t) => {
  const file = tempLock(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ pid: process.ppid, token: "x", by: "app", kind: "switch", startedAt: "2026-01-01T00:00:00.000Z" }),
  );
  const lock = new ProcessLock(file, "cli", {
    startedAt: () => Date.parse("2026-06-01T00:00:00.000Z"),
  });
  lock.tryAcquire("switch");
  assert.ok(lock.held);
  lock.release();
});

test("reentrant within one instance: two acquires need two releases", (t) => {
  const file = tempLock(t);
  const lock = new ProcessLock(file, "app");
  lock.tryAcquire("operation");
  lock.tryAcquire("switch");
  lock.release();
  assert.ok(fs.existsSync(file));
  assert.ok(lock.held);
  lock.release();
  assert.equal(fs.existsSync(file), false);
  assert.equal(lock.held, false);
});

test("acquireSync waits for a short holder and gives up after waitMs", async (t) => {
  const file = tempLock(t);
  const short = await holdInChild(file, "state", "cli", 150);
  const lock = new ProcessLock(file, "app");
  // The child releases after 150 ms; the wait must outlast it. Run the blocking wait after
  // the event loop has started the child's timer.
  lock.acquireSync("state", 3000);
  assert.ok(lock.held);
  lock.release();
  await exited(short);
  const held = await holdInChild(file, "state");
  t.after(() => held.kill());
  const started = Date.now();
  assert.throws(() => new ProcessLock(file, "app").acquireSync("state", 200), LockBusyError);
  assert.ok(Date.now() - started >= 200);
});

test("release never removes a lock whose token is not ours", (t) => {
  const file = tempLock(t);
  const lock = new ProcessLock(file, "app");
  lock.tryAcquire("switch");
  const other = { pid: process.pid, token: "someone-else", by: "cli", kind: "switch", startedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(other));
  lock.release();
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).token, "someone-else");
});

test("processStartedAt reads this process's start, before now", () => {
  const started = processStartedAt(process.pid);
  assert.ok(started !== undefined && started <= Date.now());
  assert.equal(processStartedAt(DEAD_PID), undefined);
});
