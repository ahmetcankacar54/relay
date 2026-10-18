import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  VaultFormatError,
  createSealer,
  isSealedV2,
} from "../electron/core/vault-crypto";

const key = crypto.randomBytes(32);

test("format 2 round-trips, uses a fresh nonce, and starts with RLY2", () => {
  const s = createSealer(key);
  const a = s.seal("hello"),
    b = s.seal("hello");
  assert.equal(a.subarray(0, 4).toString(), "RLY2");
  assert.notDeepEqual(a, b);
  assert.equal(a.length, 4 + 12 + 5 + 16);
  assert.equal(s.unseal(a), "hello");
  assert.equal(isSealedV2(a), true);
  assert.equal(s.unseal(s.seal("ğüşİ — ✓")), "ğüşİ — ✓");
});

test("a tampered or truncated file is invalid, never partly read", () => {
  const s = createSealer(key),
    sealed = s.seal("secret");
  sealed[20] ^= 1;
  assert.throws(
    () => s.unseal(sealed),
    (e: any) => e instanceof VaultFormatError && e.reason === "invalid",
  );
  assert.throws(
    () => s.unseal(Buffer.from("RLY2short")),
    (e: any) => e instanceof VaultFormatError && e.reason === "invalid",
  );
});

test("a format-1 buffer goes to the legacy unseal, or is refused without one", () => {
  const v10 = Buffer.from("v10" + "x".repeat(29));
  assert.throws(
    () => createSealer(key).unseal(v10),
    (e: any) => e instanceof VaultFormatError && e.reason === "legacy",
  );
  assert.equal(createSealer(key, () => "old").unseal(v10), "old");
  assert.equal(isSealedV2(v10), false);
});

test("another key cannot open it", () => {
  assert.throws(
    () => createSealer(crypto.randomBytes(32)).unseal(createSealer(key).seal("x")),
    (e: any) => e.reason === "invalid",
  );
});

test("only a 32-byte key is accepted", () => {
  assert.throws(() => createSealer(Buffer.alloc(16)));
});
