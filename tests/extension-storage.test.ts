import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ClassicLevel } from "classic-level";
import {
  StorageError,
  backupFolder,
  clearScratch,
  levelExtensionStorage,
  restoreFolder,
} from "../electron/core/extension-storage";
import { pickSignIn } from "../shared/extension-auth";
import { signInFor } from "./extension-world";

function temp(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ext-storage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A LevelDB like the extension's: the sign-in keys and other keys, closed afterwards. */
async function extensionDb(dir: string, entries: Record<string, string>) {
  const db = new ClassicLevel<string, string>(dir, {
    keyEncoding: "utf8",
    valueEncoding: "utf8",
    createIfMissing: true,
  });
  await db.open();
  await db.batch(Object.entries(entries).map(([key, value]) => ({ type: "put" as const, key, value })));
  await db.close();
}
async function dump(dir: string): Promise<Record<string, string>> {
  const db = new ClassicLevel<string, string>(dir, { keyEncoding: "utf8", valueEncoding: "utf8" });
  await db.open();
  try {
    const out: Record<string, string> = {};
    for await (const [key, value] of db.iterator()) out[key] = value;
    return out;
  } finally {
    await db.close();
  }
}

/** The sign-in in a folder, as the step picks it. */
const signInOf = async (dir: string, known: string[]) =>
  pickSignIn(await levelExtensionStorage.read(dir), known)?.signIn;

test("read returns every entry, and the sign-in is picked out of them", async (t) => {
  const dir = path.join(temp(t), "ext");
  const a = randomUUID();
  await extensionDb(dir, { ...signInFor(a), savedPrompts: '["p"]', other: "1" });
  const entries = await levelExtensionStorage.read(dir);
  assert.deepEqual(entries.map(([k]) => k).sort(), ["accessToken", "accountUuid", "other", "refreshToken", "savedPrompts", "tokenExpiry"]);
  assert.deepEqual(await signInOf(dir, [a]), signInFor(a));
});

test("a store with no sign-in has none to pick", async (t) => {
  const dir = path.join(temp(t), "ext");
  await extensionDb(dir, { savedPrompts: '["p"]' });
  assert.equal(await signInOf(dir, [randomUUID()]), undefined);
});

test("write puts the sign-in keys, deletes the ones it lacks, and leaves every other key", async (t) => {
  const dir = path.join(temp(t), "ext");
  const a = randomUUID();
  const b = randomUUID();
  await extensionDb(dir, { ...signInFor(a, 1), savedPrompts: '["p"]', other: "1" });
  const wanted = signInFor(b, 2);
  delete wanted.tokenExpiry;
  await levelExtensionStorage.write(dir, wanted);
  const after = await dump(dir);
  assert.equal(after.accountUuid, wanted.accountUuid);
  assert.equal(after.refreshToken, wanted.refreshToken);
  // The old expiry belonged to the old account.
  assert.equal("tokenExpiry" in after, false);
  assert.equal(after.savedPrompts, '["p"]');
  assert.equal(after.other, "1");
  assert.deepEqual(await signInOf(dir, [b]), wanted);
});

test("write into a store with no sign-in puts one", async (t) => {
  const dir = path.join(temp(t), "ext");
  await extensionDb(dir, { other: "1" });
  const b = randomUUID();
  const wanted = signInFor(b);
  await levelExtensionStorage.write(dir, wanted);
  assert.deepEqual(await signInOf(dir, [b]), wanted);
});

test("a database another handle holds is refused as locked, and nothing is changed", async (t) => {
  const dir = path.join(temp(t), "ext");
  await extensionDb(dir, { ...signInFor(randomUUID()), other: "1" });
  const before = await dump(dir);
  const held = new ClassicLevel<string, string>(dir, { keyEncoding: "utf8", valueEncoding: "utf8" });
  await held.open();
  try {
    await assert.rejects(
      levelExtensionStorage.read(dir),
      (e) => e instanceof StorageError && e.reason === "locked",
    );
    await assert.rejects(
      levelExtensionStorage.write(dir, signInFor(randomUUID())),
      (e) => e instanceof StorageError && e.reason === "locked",
    );
  } finally {
    await held.close();
  }
  assert.deepEqual(await dump(dir), before);
});

test("a missing folder, a file and a link are refused, and nothing is created", async (t) => {
  const root = temp(t);
  const missing = path.join(root, "nope");
  await assert.rejects(
    levelExtensionStorage.read(missing),
    (e) => e instanceof StorageError && e.reason === "missing",
  );
  assert.equal(fs.existsSync(missing), false);
  const file = path.join(root, "file");
  fs.writeFileSync(file, "x");
  await assert.rejects(levelExtensionStorage.read(file), StorageError);
  const real = path.join(root, "real");
  await extensionDb(real, signInFor(randomUUID()) as any);
  const link = path.join(root, "link");
  fs.symlinkSync(real, link);
  await assert.rejects(levelExtensionStorage.read(link), StorageError);
});

test("a folder that is not a LevelDB is refused, not initialised", async (t) => {
  const dir = path.join(temp(t), "ext");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "data.txt"), "ORIGINAL");
  await assert.rejects(levelExtensionStorage.read(dir), StorageError);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n !== "LOG" && n !== "LOCK" && !n.startsWith("LOG")), ["data.txt"]);
});

test("a backup restores the folder as it was after a write", async (t) => {
  const root = temp(t);
  const dir = path.join(root, "ext");
  const scratch = path.join(root, "scratch");
  const a = randomUUID();
  await extensionDb(dir, { ...signInFor(a, 1), other: "1" });
  const before = await dump(dir);
  const backup = await backupFolder(dir, scratch);
  assert.ok(backup.startsWith(scratch));
  await levelExtensionStorage.write(dir, signInFor(randomUUID(), 2));
  assert.notDeepEqual(await dump(dir), before);
  await restoreFolder(dir, backup);
  assert.deepEqual(await dump(dir), before);
  await clearScratch(scratch);
  assert.equal(fs.existsSync(scratch), false);
});

test("a backup refuses a folder that holds a link", async (t) => {
  const root = temp(t);
  const dir = path.join(root, "ext");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(root, "target"), "x");
  fs.symlinkSync(path.join(root, "target"), path.join(dir, "link"));
  await assert.rejects(backupFolder(dir, path.join(root, "scratch")), /symbolic link/);
});

test("writing a sign-in removes the record of a failed one and the previous org hint, and keeps the rest", async (t) => {
  const dir = path.join(temp(t), "ext");
  const a = randomUUID();
  const b = randomUUID();
  await extensionDb(dir, {
    ...signInFor(a),
    lastActiveOrgHint: JSON.stringify(randomUUID()),
    lastAuthFailureReason: JSON.stringify("session_expired"),
    startupReauthState: JSON.stringify({ terminal: true, stop: "definitive" }),
    savedPrompts: '["p"]',
  });
  await levelExtensionStorage.write(dir, signInFor(b));
  assert.deepEqual(await dump(dir), { ...signInFor(b), savedPrompts: '["p"]' });
});
