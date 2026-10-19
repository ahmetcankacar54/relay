import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSealer, isSealedV2 } from "../electron/core/vault-crypto";
import {
  markVaultFormat,
  migrateVault,
  sealedFiles,
  vaultState,
} from "../electron/core/vault-migration";
import { jsonBytes, readBytes, writeBytes } from "../electron/core/desktop-files";

const legacySeal = (text: string) =>
  Buffer.from("v10" + Buffer.from(text).toString("base64"));
const legacyUnseal = (data: Buffer) => {
  const text = data.toString();
  if (!text.startsWith("v10") || text.includes("BROKEN"))
    throw new Error("safeStorage could not decrypt");
  return Buffer.from(text.slice(3), "base64").toString();
};
const BACKUP = "11111111-2222-4333-8444-555555555555";
const ACCOUNT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

async function legacyVault(t: any) {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "relay-vault-mig-"));
  t.after(() => fs.rm(vault, { recursive: true, force: true }));
  await writeBytes(vault, `accounts/${ACCOUNT}.bin`, legacySeal("account-a"));
  await writeBytes(vault, `backups/${BACKUP}.bin`, legacySeal("backup-b"));
  await writeBytes(vault, "drafts/pending.bin", legacySeal("drafts"));
  await writeBytes(vault, "history-seen.json", jsonBytes({}));
  return vault;
}
const sealer = createSealer(crypto.randomBytes(32), legacyUnseal);

test("a format-1 vault migrates every sealed file and gets the marker", async (t) => {
  const vault = await legacyVault(t);
  assert.deepEqual(await sealedFiles(vault), [
    `accounts/${ACCOUNT}.bin`,
    `backups/${BACKUP}.bin`,
    "drafts/pending.bin",
  ]);
  const before = await vaultState(vault);
  assert.equal(before.kind, "legacy");
  assert.equal(before.kind === "legacy" && before.files.length, 3);
  const r = await migrateVault(vault, sealer, legacyUnseal);
  assert.equal(r.migrated, 3);
  assert.deepEqual(r.movedAside, []);
  assert.equal((await vaultState(vault)).kind, "ready");
  const account = (await readBytes(vault, `accounts/${ACCOUNT}.bin`))!;
  assert.ok(isSealedV2(account));
  assert.equal(sealer.unseal(account), "account-a");
  assert.deepEqual(JSON.parse((await readBytes(vault, "format.json"))!.toString()), {
    version: 2,
  });
});

test("migration keeps each file's mtime so backup pruning keeps its order", async (t) => {
  const vault = await legacyVault(t);
  const file = path.join(vault, `backups/${BACKUP}.bin`);
  const old = new Date("2026-01-02T03:04:05Z");
  await fs.utimes(file, old, old);
  await migrateVault(vault, sealer, legacyUnseal);
  assert.equal((await fs.stat(file)).mtimeMs, old.getTime());
});

test("a second run is a no-op and a run stopped half-way resumes", async (t) => {
  const vault = await legacyVault(t);
  await writeBytes(vault, `accounts/${ACCOUNT}.bin`, sealer.seal("account-a"));
  assert.equal((await migrateVault(vault, sealer, legacyUnseal)).migrated, 2);
  assert.equal((await migrateVault(vault, sealer, legacyUnseal)).migrated, 0);
  assert.equal((await vaultState(vault)).kind, "ready");
});

test("an unreadable file other than the journal's backup is moved aside and the rest migrates", async (t) => {
  const vault = await legacyVault(t);
  const old = "99999999-2222-4333-8444-555555555555";
  await writeBytes(vault, `backups/${old}.bin`, Buffer.from("v10BROKEN"));
  const r = await migrateVault(vault, sealer, legacyUnseal);
  assert.deepEqual(r.movedAside, [`backups/${old}.bin`]);
  assert.equal(r.migrated, 3);
  assert.equal(
    (await readBytes(vault, `unreadable/backups/${old}.bin`))!.toString(),
    "v10BROKEN",
  );
  assert.equal(await readBytes(vault, `backups/${old}.bin`), null);
  assert.equal((await vaultState(vault)).kind, "ready");
});

test("an unreadable backup named in journal.json stops the migration and moves nothing", async (t) => {
  const vault = await legacyVault(t);
  await writeBytes(vault, `backups/${BACKUP}.bin`, Buffer.from("v10BROKEN"));
  await writeBytes(vault, "journal.json", jsonBytes({ backup: BACKUP }));
  await assert.rejects(migrateVault(vault, sealer, legacyUnseal), /recovery backup/);
  assert.equal((await vaultState(vault)).kind, "legacy");
  assert.equal(
    (await readBytes(vault, `backups/${BACKUP}.bin`))!.toString(),
    "v10BROKEN",
  );
  await assert.rejects(fs.access(path.join(vault, "unreadable")));
});

test("a newer marker is reported, an empty vault is empty, and a marked empty vault is ready", async (t) => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "relay-vault-state-"));
  t.after(() => fs.rm(vault, { recursive: true, force: true }));
  assert.equal((await vaultState(vault)).kind, "empty");
  await markVaultFormat(vault);
  assert.equal((await vaultState(vault)).kind, "ready");
  await writeBytes(vault, "format.json", jsonBytes({ version: 3 }));
  assert.deepEqual(await vaultState(vault), { kind: "newer", version: 3 });
});

test("an unmarked vault whose files are all format 2 is ready", async (t) => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "relay-vault-state-"));
  t.after(() => fs.rm(vault, { recursive: true, force: true }));
  await writeBytes(vault, `accounts/${ACCOUNT}.bin`, sealer.seal("a"));
  assert.equal((await vaultState(vault)).kind, "ready");
});

test("when no old file can be opened, nothing is moved and no marker is written", async (t) => {
  const vault = await legacyVault(t);
  for (const file of [`accounts/${ACCOUNT}.bin`, `backups/${BACKUP}.bin`, "drafts/pending.bin"])
    await writeBytes(vault, file, Buffer.from("v10BROKEN"));
  await assert.rejects(migrateVault(vault, sealer, legacyUnseal), /none of/i);
  assert.equal((await readBytes(vault, `accounts/${ACCOUNT}.bin`))!.toString(), "v10BROKEN");
  await assert.rejects(fs.access(path.join(vault, "unreadable")));
  assert.equal((await vaultState(vault)).kind, "legacy");
});

test("a broken journal backup stops the migration before any other file is moved", async (t) => {
  const vault = await legacyVault(t);
  await writeBytes(vault, `accounts/${ACCOUNT}.bin`, Buffer.from("v10BROKEN"));
  await writeBytes(vault, `backups/${BACKUP}.bin`, Buffer.from("v10BROKEN"));
  await writeBytes(vault, "journal.json", jsonBytes({ backup: BACKUP }));
  await assert.rejects(migrateVault(vault, sealer, legacyUnseal), /recovery backup/);
  assert.equal((await readBytes(vault, `accounts/${ACCOUNT}.bin`))!.toString(), "v10BROKEN");
  await assert.rejects(fs.access(path.join(vault, "unreadable")));
});

test("a corrupt old file left after the rest migrated is set aside, so the migration can finish", async (t) => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "relay-vault-mig-"));
  t.after(() => fs.rm(vault, { recursive: true, force: true }));
  await writeBytes(vault, `accounts/${ACCOUNT}.bin`, sealer.seal("already migrated"));
  await writeBytes(vault, "backups/99999999-2222-4333-8444-555555555555.bin", Buffer.from("v10BROKEN"));
  const r = await migrateVault(vault, sealer, legacyUnseal);
  assert.deepEqual(r.movedAside, ["backups/99999999-2222-4333-8444-555555555555.bin"]);
  assert.equal((await vaultState(vault)).kind, "ready");
});
