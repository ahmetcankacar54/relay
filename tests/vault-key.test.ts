import test from "node:test";
import assert from "node:assert/strict";
import {
  VaultKeyError,
  loadVaultKey,
  readVaultKey,
} from "../electron/core/vault-key";
import { fakeSecurity } from "./fake-security";

test("reads an existing key with find-generic-password and the exact item names", { skip: process.platform === "win32" && "macOS only: the Keychain, through a shell stand-in for security" }, async (t) => {
  const f = fakeSecurity({ stored: Buffer.alloc(32, 7).toString("base64") });
  t.after(f.remove);
  assert.deepEqual(await readVaultKey(f.tool), Buffer.alloc(32, 7));
  assert.match(f.argvLog(), /find-generic-password -s Relay Vault Key -a relay-vault -w/);
});

test("a missing key is created through stdin, never argv, and read back", { skip: process.platform === "win32" && "macOS only: the Keychain, through a shell stand-in for security" }, async (t) => {
  const f = fakeSecurity({});
  t.after(f.remove);
  const key = await loadVaultKey({ tool: f.tool, mayCreate: true });
  assert.equal(key.length, 32);
  assert.ok(!f.argvLog().includes(key.toString("base64")));
  assert.ok(f.stdinLog().includes(key.toString("base64")));
  assert.match(f.stdinLog(), /add-generic-password -s "Relay Vault Key" -a relay-vault/);
  assert.equal(f.stored(), key.toString("base64"));
});

test("a race keeps the key that is stored, not the one generated", { skip: process.platform === "win32" && "macOS only: the Keychain, through a shell stand-in for security" }, async (t) => {
  const winner = Buffer.alloc(32, 1).toString("base64");
  const f = fakeSecurity({ storeOnFirstFind: winner });
  t.after(f.remove);
  const key = await loadVaultKey({ tool: f.tool, mayCreate: true });
  assert.equal(key.toString("base64"), winner);
});

test("missing without mayCreate, locked and malformed are distinct errors", { skip: process.platform === "win32" && "macOS only: the Keychain, through a shell stand-in for security" }, async (t) => {
  const missing = fakeSecurity({});
  const locked = fakeSecurity({ exit: 51 });
  const short = fakeSecurity({ stored: "c2hvcnQ=" });
  t.after(() => [missing, locked, short].forEach((f) => f.remove()));
  await assert.rejects(
    loadVaultKey({ tool: missing.tool, mayCreate: false }),
    (e: any) => e instanceof VaultKeyError && e.reason === "missing",
  );
  assert.equal(missing.stdinLog(), "");
  await assert.rejects(readVaultKey(locked.tool), (e: any) => e.reason === "locked");
  await assert.rejects(readVaultKey(short.tool), (e: any) => e.reason === "invalid");
});
