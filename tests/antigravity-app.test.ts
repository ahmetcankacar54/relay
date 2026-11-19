import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { antigravityDataDir, antigravityLastLogin, matchAntigravityApp } from "../electron/core/antigravity-app";

const accounts = [
  { id: "c", provider: "claude" as const, auth: { loggedIn: true, email: "same@example.test" } },
  { id: "g1", provider: "antigravity" as const, auth: { loggedIn: true, email: "One@Example.test" } },
  { id: "g2", provider: "antigravity" as const, auth: { loggedIn: true, email: "two@example.test" } },
];

test("the Antigravity app's last sign-in is read from its settings file, and only a valid e-mail counts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-app-"));
  try {
    assert.deepEqual(await antigravityLastLogin(path.join(dir, "missing")), { installed: false });
    assert.deepEqual(await antigravityLastLogin(dir), { installed: true });
    fs.writeFileSync(path.join(dir, "app_storage.json"), JSON.stringify({ "agy.onboarding.lastLoginUsername": "one@example.test", other: "x" }));
    assert.deepEqual(await antigravityLastLogin(dir), { installed: true, email: "one@example.test" });
    fs.writeFileSync(path.join(dir, "app_storage.json"), JSON.stringify({ "agy.onboarding.lastLoginUsername": "not an e-mail" }));
    assert.deepEqual(await antigravityLastLogin(dir), { installed: true });
    fs.writeFileSync(path.join(dir, "app_storage.json"), "{broken");
    assert.deepEqual(await antigravityLastLogin(dir), { installed: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the app's sign-in names a Relay Antigravity account by id, never by e-mail, and ignores other providers", () => {
  assert.deepEqual(matchAntigravityApp({ installed: true, email: "one@example.test" }, accounts, true), {
    installed: true,
    canOpen: true,
    accountId: "g1",
  });
  // A Claude account with the same e-mail is not the app's account.
  assert.deepEqual(matchAntigravityApp({ installed: true, email: "same@example.test" }, accounts, false), {
    installed: true,
    canOpen: false,
    otherSignIn: true,
  });
  assert.deepEqual(matchAntigravityApp({ installed: true }, accounts, true), { installed: true, canOpen: true });
  assert.deepEqual(matchAntigravityApp({ installed: false, email: "one@example.test" }, accounts, true), {
    installed: false,
    canOpen: false,
  });
  assert.equal(JSON.stringify(matchAntigravityApp({ installed: true, email: "two@example.test" }, accounts, true)).includes("@"), false);
});

test("the app's data folder follows each platform's convention", () => {
  assert.equal(antigravityDataDir("darwin", "/Users/u", {}), "/Users/u/Library/Application Support/Antigravity");
  assert.equal(antigravityDataDir("linux", "/home/u", {}), "/home/u/.config/Antigravity");
  assert.equal(antigravityDataDir("linux", "/home/u", { XDG_CONFIG_HOME: "/x" }), "/x/Antigravity");
  assert.equal(antigravityDataDir("win32", "C:\\Users\\u", { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }).endsWith("Antigravity"), true);
});
