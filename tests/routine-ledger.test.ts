import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  RoutineLedger,
  routineKey,
  type RoutineRecord,
} from "../electron/core/routines";

const identityKey = "a".repeat(64);
const record: RoutineRecord = {
  key: routineKey(identityKey, "2026-10-13"),
  identityKey,
  date: "2026-10-13",
  accountId: "account-a",
  scheduledAt: "2026-10-13T08:00:00.000Z",
  status: "claimed",
};
async function fixture(t: any) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "relay-routine-ledger-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "routines");
  const ledger = new RoutineLedger(directory);
  const file = path.join(directory, `${record.key}.json`);
  return { root, directory, ledger, file };
}

test("ledger claims and atomic updates preserve private permissions and immutable identity", async (t) => {
  const { ledger, directory, file } = await fixture(t);
  assert.deepEqual(await ledger.list(), []);
  assert.equal(await ledger.claim(record), true);
  await ledger.update(record.key, {
    status: "verified",
    observedResetAt: "2026-10-13T13:00:00.000Z",
    finishedAt: "2026-10-13T08:00:15.000Z",
    accountId: "replacement-not-permitted",
    identityKey: "b".repeat(64),
    key: "b".repeat(64),
  });
  const entries = await ledger.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, "verified");
  assert.equal(entries[0].identityKey, identityKey);
  assert.equal(entries[0].accountId, record.accountId);
  assert.equal(entries[0].key, record.key);
  assert.deepEqual(await fs.readdir(directory), [`${record.key}.json`]);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  }
});
test("ledger rejects unknown fields, inconsistent keys, bad dates and nonsanitized reasons before claiming", async (t) => {
  const { ledger, directory } = await fixture(t);
  for (const invalid of [
    { ...record, accessToken: "fixture-never-persisted" },
    { ...record, key: "f".repeat(64) },
    {
      ...record,
      date: "2026-02-30",
      key: routineKey(identityKey, "2026-02-30"),
    },
    { ...record, scheduledAt: 1 },
    { ...record, finishedAt: "bad date" },
    { ...record, reason: "raw error with potentially private content" },
    { ...record, accountId: "" },
  ])
    await assert.rejects(
      ledger.claim(invalid as RoutineRecord),
      /Invalid routine record/,
    );
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});
test("malformed and oversized claims remain occupied without being read into the UI or overwritten", async (t) => {
  const { ledger, directory, file } = await fixture(t);
  await fs.mkdir(directory);
  for (const content of [
    "",
    "broken JSON",
    JSON.stringify({ ...record, accessToken: "fixture-invalid-field" }),
    JSON.stringify(record) + " ".repeat(16_384),
  ]) {
    await fs.writeFile(file, content);
    assert.deepEqual(await ledger.list(), []);
    assert.equal(await ledger.claim(record), false);
    await assert.rejects(ledger.update(record.key, { status: "failed" }));
    assert.equal(await fs.readFile(file, "utf8"), content);
  }
});
test("symlink record claims stay occupied and update/list never follow a foreign file", async (t) => {
  const { root, directory, ledger, file } = await fixture(t);
  await fs.mkdir(directory);
  const foreign = path.join(root, "foreign.json");
  const original = JSON.stringify(record);
  await fs.writeFile(foreign, original);
  await fs.symlink(foreign, file);
  assert.equal(await ledger.claim(record), false);
  assert.deepEqual(await ledger.list(), []);
  await assert.rejects(ledger.update(record.key, { status: "failed" }));
  assert.equal(await fs.readFile(foreign, "utf8"), original);
  assert.equal((await fs.lstat(file)).isSymbolicLink(), true);
});
test("symlink ledger directories and direct parents are rejected before external writes", async (t) => {
  const { root, directory } = await fixture(t);
  const foreign = path.join(root, "foreign-directory");
  await fs.mkdir(foreign, { mode: 0o755 });
  await fs.symlink(foreign, directory);
  const ledgers = [
    new RoutineLedger(directory),
    new RoutineLedger(path.join(directory, "nested")),
  ];
  for (const ledger of ledgers) {
    await assert.rejects(
      ledger.claim(record),
      /Invalid routine ledger directory/,
    );
    await assert.rejects(ledger.list(), /Invalid routine ledger directory/);
    await assert.rejects(
      ledger.update(record.key, { status: "failed" }),
      /Invalid routine ledger directory/,
    );
  }
  assert.deepEqual(await fs.readdir(foreign), []);
});
test("invalid update preserves the existing record bytes and leaves no temporary file", async (t) => {
  const { ledger, directory, file } = await fixture(t);
  await ledger.claim(record);
  const original = await fs.readFile(file, "utf8");
  await assert.rejects(
    ledger.update(record.key, { reason: "arbitrary untrusted error text" }),
    /Invalid routine record/,
  );
  await assert.rejects(
    ledger.update(record.key, {
      accessToken: "not-allowed",
    } as Partial<RoutineRecord>),
    /Invalid routine record/,
  );
  assert.equal(await fs.readFile(file, "utf8"), original);
  assert.deepEqual(await fs.readdir(directory), [`${record.key}.json`]);
});
