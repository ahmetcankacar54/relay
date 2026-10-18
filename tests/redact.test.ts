import test from "node:test";
import assert from "node:assert/strict";
import { redact } from "../electron/core/redact";

test("redact removes token-like text and keeps one short line", () => {
  const out = redact(
    new Error(
      "fail sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAA\nsecond line eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
    ),
  );
  assert.ok(!out.includes("sk-ant-"));
  assert.ok(!out.includes("\n"));
  assert.equal(out, "fail [redacted]");
  assert.ok(!redact("x eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl").includes("eyJ"));
  assert.match(redact("x " + "a".repeat(40)), /x \[redacted\]/);
  assert.ok(redact("y ".repeat(1000)).length <= 300);
  assert.equal(redact({ weird: true }), "Unknown error");
  assert.equal(redact("Claude Desktop did not close."), "Claude Desktop did not close.");
});

test("ordinary paths and uuids stay readable", () => {
  const id = "0b7b2d6e-3c1f-4f8e-9a51-2a8d1c4b5e6f";
  assert.equal(redact(`Missing ${id}`), `Missing ${id}`);
  assert.equal(redact("/Users/x/Library/Application Support/Relay"), "/Users/x/Library/Application Support/Relay");
});
