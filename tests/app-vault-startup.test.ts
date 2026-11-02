import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSealer } from "../electron/core/vault-crypto";
import { prepareVault, vaultState } from "../electron/core/vault-migration";
import { readBytes, writeBytes } from "../electron/core/desktop-files";
import { fakeSecurity } from "./fake-security";

const legacySeal = (text: string) =>
  Buffer.from("v10" + Buffer.from(text).toString("base64"));
const legacyUnseal = (data: Buffer) => {
  const text = data.toString();
  if (!text.startsWith("v10")) throw new Error("safeStorage could not decrypt");
  return Buffer.from(text.slice(3), "base64").toString();
};
const ACCOUNT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
async function vaultDir(t: any) {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "relay-prepare-"));
  t.after(() => fs.rm(vault, { recursive: true, force: true }));
  return vault;
}

test("prepareVault migrates a format-1 vault and returns a sealer that opens both formats", async (t) => {
  const vault = await vaultDir(t);
  const security = fakeSecurity({});
  t.after(security.remove);
  await writeBytes(vault, `accounts/${ACCOUNT}.bin`, legacySeal("account"));
  const r = await prepareVault({ vault, legacyUnseal, tool: security.tool });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.migration, { migrated: 1, movedAside: [] });
  assert.equal((await vaultState(vault)).kind, "ready");
  assert.equal(r.sealer.unseal((await readBytes(vault, `accounts/${ACCOUNT}.bin`))!), "account");
  assert.equal(r.sealer.unseal(legacySeal("old")), "old");
  assert.equal(r.sealer.unseal(r.sealer.seal("new")), "new");
});

test("prepareVault never creates a key for a ready vault whose key is missing", async (t) => {
  const vault = await vaultDir(t);
  const security = fakeSecurity({});
  t.after(security.remove);
  await writeBytes(
    vault,
    `accounts/${ACCOUNT}.bin`,
    createSealer(crypto.randomBytes(32)).seal("account"),
  );
  const r = await prepareVault({ vault, legacyUnseal, tool: security.tool });
  assert.match(r.error!, /Relay Vault Key/);
  assert.equal(security.stdinLog(), "");
  assert.throws(() => r.sealer.seal("x"), /Relay Vault Key/);
});

test("prepareVault gives an empty vault a key and the marker", async (t) => {
  const vault = await vaultDir(t);
  const security = fakeSecurity({});
  t.after(security.remove);
  const r = await prepareVault({ vault, legacyUnseal, tool: security.tool });
  assert.equal(r.error, undefined);
  assert.notEqual(security.stored(), "");
  assert.deepEqual(JSON.parse((await readBytes(vault, "format.json"))!.toString()), { version: 2 });
});

test("prepareVault reports a newer vault and seals nothing", async (t) => {
  const vault = await vaultDir(t);
  const security = fakeSecurity({});
  t.after(security.remove);
  await writeBytes(vault, "format.json", Buffer.from('{"version":3}'));
  const r = await prepareVault({ vault, legacyUnseal, tool: security.tool });
  assert.match(r.error!, /newer/);
  assert.throws(() => r.sealer.seal("x"));
  assert.equal(security.argvLog(), "");
});

test("prepareVault keeps old files readable when the Keychain is locked", async (t) => {
  const vault = await vaultDir(t);
  const security = fakeSecurity({ exit: 51 });
  t.after(security.remove);
  await writeBytes(vault, `accounts/${ACCOUNT}.bin`, legacySeal("account"));
  const r = await prepareVault({ vault, legacyUnseal, tool: security.tool });
  assert.match(r.error!, /Relay Vault Key/);
  assert.equal(r.sealer.unseal(legacySeal("account")), "account");
  assert.equal((await vaultState(vault)).kind, "legacy");
});

test("prepareVault leaves an old vault alone while safeStorage cannot be used", async (t) => {
  const vault = await vaultDir(t);
  const security = fakeSecurity({});
  t.after(security.remove);
  await writeBytes(vault, `accounts/${ACCOUNT}.bin`, legacySeal("account"));
  const r = await prepareVault({ vault, legacyUnseal, legacyAvailable: () => false, tool: security.tool });
  assert.match(r.error!, /Nothing was moved/);
  assert.equal(r.migration, undefined);
  assert.equal((await vaultState(vault)).kind, "legacy");
  assert.equal((await readBytes(vault, `accounts/${ACCOUNT}.bin`))!.toString(), legacySeal("account").toString());
});

test("prepareVault reports files it set aside", async (t) => {
  const vault = await vaultDir(t);
  const security = fakeSecurity({});
  t.after(security.remove);
  await writeBytes(vault, `accounts/${ACCOUNT}.bin`, legacySeal("account"));
  await writeBytes(vault, "backups/99999999-2222-4333-8444-555555555555.bin", Buffer.from("v10broken!"));
  const r = await prepareVault({ vault, legacyUnseal: (d) => { if (d.toString().includes("broken")) throw new Error("no"); return legacyUnseal(d); }, tool: security.tool });
  assert.match(r.error!, /unreadable/);
  assert.equal(r.migration!.movedAside.length, 1);
});

test("prepareVault never creates a key for a half-migrated vault", async (t) => {
  const vault = await vaultDir(t);
  const security = fakeSecurity({});
  t.after(security.remove);
  await writeBytes(vault, `accounts/${ACCOUNT}.bin`, createSealer(crypto.randomBytes(32)).seal("migrated"));
  await writeBytes(vault, "backups/11111111-2222-4333-8444-555555555555.bin", legacySeal("old"));
  const r = await prepareVault({ vault, legacyUnseal, tool: security.tool });
  assert.match(r.error!, /Relay Vault Key/);
  assert.equal(security.stdinLog(), "");
  assert.equal((await vaultState(vault)).kind, "legacy");
});
