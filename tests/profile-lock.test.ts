import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ProfileLockBusyError,
  acquireProfileLock,
  anyExclusiveProfileLock,
  profileLockHolders,
} from "../electron/core/profile-lock";
import { childReady } from "./lock-child";

const A = "0b7b2d6e-3c1f-4f8e-9a51-2a8d1c4b5e6f";
const B = "1c8c3e7f-4d20-4a9f-8b62-3b9e2d5c6f70";
function locksDir(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-profile-locks-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "profiles", ".locks");
}
const hold = (locks: string, account: string, kind: string) =>
  childReady("profile-lock-child.ts", [locks, account, kind]);

test("shared holders coexist; exclusive excludes everyone", async (t) => {
  const locks = locksDir(t);
  const one = await hold(locks, A, "shared");
  const two = await hold(locks, A, "shared");
  t.after(() => [one, two].forEach((c) => c.kill()));
  const release = acquireProfileLock(locks, A, "shared");
  assert.equal(profileLockHolders(locks, A).length, 3);
  release();
  assert.throws(
    () => acquireProfileLock(locks, A, "exclusive"),
    (e: any) =>
      e instanceof ProfileLockBusyError &&
      e.accountId === A &&
      e.holders.length === 2 &&
      e.holders.every((h: any) => h.kind === "shared"),
  );
  assert.equal(profileLockHolders(locks, A).length, 2);
  assert.equal(fs.statSync(path.join(locks, A)).mode & 0o777, 0o700);
});

test("an exclusive holder blocks shared, and other accounts are free", async (t) => {
  const locks = locksDir(t);
  const child = await hold(locks, A, "exclusive");
  t.after(() => child.kill());
  assert.throws(() => acquireProfileLock(locks, A, "shared"), ProfileLockBusyError);
  acquireProfileLock(locks, B, "exclusive")();
});

test("dead holders are swept", (t) => {
  const locks = locksDir(t);
  fs.mkdirSync(path.join(locks, A), { recursive: true });
  fs.writeFileSync(
    path.join(locks, A, "999999-2d9f4e80-5e31-4b0a-9c73-4caf3e6d7081.json"),
    JSON.stringify({ pid: 999_999, kind: "exclusive", startedAt: new Date().toISOString(), token: "x" }),
  );
  assert.deepEqual(profileLockHolders(locks, A), []);
  assert.deepEqual(fs.readdirSync(path.join(locks, A)), []);
  acquireProfileLock(locks, A, "exclusive")();
});

test("anyExclusiveProfileLock sees an exclusive lock on any account", async (t) => {
  const locks = locksDir(t);
  assert.equal(anyExclusiveProfileLock(locks), false);
  const shared = await hold(locks, A, "shared");
  t.after(() => shared.kill());
  assert.equal(anyExclusiveProfileLock(locks), false);
  const exclusive = await hold(locks, B, "exclusive");
  t.after(() => exclusive.kill());
  assert.equal(anyExclusiveProfileLock(locks), true);
  assert.equal(anyExclusiveProfileLock(locks, exclusive.pid), false);
});

test("an account id that is not a uuid is refused", (t) => {
  assert.throws(() => acquireProfileLock(locksDir(t), "../x", "shared"));
});
