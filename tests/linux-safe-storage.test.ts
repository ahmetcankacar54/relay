import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cookieKey,
  decryptCookie,
  DESKTOP_USAGE_MARKER,
  desktopUsageReadable,
  DesktopUsageReader,
  type EncryptedCookie,
} from "../electron/core/desktop-usage";
import {
  LINUX_V10_KEY,
  linuxCookieKey,
  linuxKeyring,
  linuxKeyringReachable,
  linuxSafeStoragePassword,
  type Run,
  type RunResult,
} from "../electron/core/linux-safe-storage";
import { UsageError } from "../electron/core/usage-credentials";
import type { Account } from "../shared/types";

const SECRET = "fixture-keyring-secret";
const ORG = "11111111-2222-4333-8444-555555555555";
const KDE6 = { XDG_CURRENT_DESKTOP: "KDE", KDE_SESSION_VERSION: "6" };

/** Encrypts like Chromium on Linux, database version 24 and later. */
function encrypt(value: string, host: string, prefix: "v10" | "v11", key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const plain = Buffer.concat([crypto.createHash("sha256").update(host).digest(), Buffer.from(value)]);
  return Buffer.concat([Buffer.from(prefix), cipher.update(plain), cipher.final()]);
}

const issueOf = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: UsageError) => e.issue,
  );

test("Chromium's Linux keys: one PBKDF2 iteration, v10 from 'peanuts', v11 from the keyring", () => {
  // Known answer, independent of the code under test.
  assert.equal(
    LINUX_V10_KEY.toString("hex"),
    crypto.pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1").toString("hex"),
  );
  const keys = { v10: LINUX_V10_KEY, v11: linuxCookieKey(SECRET) };
  assert.equal(decryptCookie(encrypt("sk-ant-sid01-abc", ".claude.ai", "v11", keys.v11), keys, ".claude.ai", 24), "sk-ant-sid01-abc");
  assert.equal(decryptCookie(encrypt("plain", ".claude.ai", "v10", LINUX_V10_KEY), keys, ".claude.ai", 24), "plain");
  // The macOS derivation (1003 iterations) is not Linux's.
  assert.equal(decryptCookie(encrypt("x", ".claude.ai", "v11", cookieKey(SECRET)), keys, ".claude.ai", 24), undefined);
  // A v11 value needs the keyring key; the host digest still guards against a moved value.
  assert.equal(decryptCookie(encrypt("x", ".claude.ai", "v11", keys.v11), { v10: LINUX_V10_KEY }, ".claude.ai", 24), undefined);
  assert.equal(decryptCookie(encrypt("x", "claude.ai", "v11", keys.v11), keys, ".claude.ai", 24), undefined);
});

test("on Linux the keyring is asked only for v11 login cookies", async () => {
  const account = {
    id: "a",
    name: "A",
    desktop: { accountUuid: "0d1e2f3a-38b0-4c1f-9d39-6f1f4c0a1b2c", orgId: ORG, savedAt: "" },
  } as Account;
  const row = (name: string, value: string, prefix: "v10" | "v11"): EncryptedCookie => ({
    host: ".claude.ai",
    name,
    value: "",
    encrypted: encrypt(value, ".claude.ai", prefix, prefix === "v10" ? LINUX_V10_KEY : linuxCookieKey(SECRET)),
  });
  let rows: EncryptedCookie[] = [];
  const prompts: boolean[] = [];
  const cookies: string[] = [];
  const reader = new DesktopUsageReader({
    cookieFiles: async () => ({}),
    readRows: async () => ({ version: 24, rows }),
    password: async (allowPrompt) => {
      prompts.push(allowPrompt);
      return SECRET;
    },
    request: async (_url, cookie) => {
      cookies.push(cookie);
      return { status: 200, contentType: "application/json", retryAfter: null, body: "{}" };
    },
    platform: "linux",
  });
  // --password-store=basic: no keyring at all.
  rows = [row("sessionKey", "sk-basic", "v10")];
  await reader.read(account, false);
  assert.deepEqual(prompts, []);
  rows = [row("sessionKey", "sk-keyring", "v11"), row("lastActiveOrg", ORG, "v11")];
  await reader.read(account, true);
  assert.deepEqual(prompts, [true]);
  assert.deepEqual(cookies, ["sessionKey=sk-basic", `sessionKey=sk-keyring; lastActiveOrg=${ORG}`]);
});

test("Chromium's keyring choice follows the desktop", () => {
  assert.deepEqual(linuxKeyring(KDE6), { kind: "kwallet", service: "org.kde.kwalletd6", objectPath: "/modules/kwalletd6" });
  assert.deepEqual(linuxKeyring({ XDG_CURRENT_DESKTOP: "KDE", KDE_SESSION_VERSION: "5" }), {
    kind: "kwallet",
    service: "org.kde.kwalletd5",
    objectPath: "/modules/kwalletd5",
  });
  assert.deepEqual(linuxKeyring({ XDG_CURRENT_DESKTOP: "ubuntu:GNOME" }), { kind: "secret-service" });
  assert.deepEqual(linuxKeyring({}), { kind: "secret-service" });
  assert.equal(linuxKeyringReachable(KDE6, (f) => f === "/usr/bin/busctl"), true);
  assert.equal(linuxKeyringReachable({ XDG_CURRENT_DESKTOP: "GNOME" }, (f) => f === "/usr/bin/busctl"), false);
});

/** A busctl stand-in answering KWallet's D-Bus methods as `busctl --json=short` does. */
function kwallet(answers: Record<string, unknown>, failing?: string) {
  const calls: string[][] = [];
  const run: Run = async (file, args) => {
    assert.equal(file, "/usr/bin/busctl");
    calls.push(args);
    const method = args[7];
    if (method === failing) return { code: 1, stdout: "", stderr: "Call failed" };
    return { stdout: JSON.stringify({ type: "x", data: [answers[method]] }), stderr: "" } satisfies RunResult;
  };
  return { run, calls, methods: () => calls.map((c) => c[7]) };
}

test("KWallet: Claude's own folder and key, never opened in the background while closed", async () => {
  const remembered: boolean[] = [];
  let allowed = false;
  const make = (run: Run) =>
    linuxSafeStoragePassword({
      allowed: async () => allowed,
      remember: async (a) => {
        remembered.push(a);
      },
      env: KDE6,
      run,
    });
  const answers = { networkWallet: "kdewallet", isOpen: true, open: 7, hasEntry: true, readPassword: SECRET, close: 0 };

  // Not allowed yet: no D-Bus call at all.
  const quiet = kwallet(answers);
  assert.equal(await issueOf(make(quiet.run)(false)), "keychain-locked");
  assert.deepEqual(quiet.calls, []);

  // Allowed, but the wallet is closed: opening it would show its unlock dialog.
  allowed = true;
  const closed = kwallet({ ...answers, isOpen: false });
  assert.equal(await issueOf(make(closed.run)(false)), "keychain-locked");
  assert.deepEqual(closed.methods(), ["networkWallet", "isOpen"]);
  assert.deepEqual(remembered, []);

  const open = kwallet(answers);
  const read = make(open.run);
  assert.equal(await read(false), SECRET);
  assert.deepEqual(open.methods(), ["networkWallet", "isOpen", "open", "hasEntry", "readPassword", "close"]);
  assert.deepEqual(open.calls[4].slice(-4), ["7", "Claude Keys", "Claude Safe Storage", "Relay"]);
  assert.ok(open.calls[0].includes("org.kde.kwalletd6") && open.calls[0].includes("/modules/kwalletd6"));
  assert.deepEqual(remembered, [true]);
  // Kept for the run.
  assert.equal(await read(false), SECRET);
  assert.equal(open.calls.length, 6);

  // Asked for: the wallet may be opened (its dialog is the user's answer).
  const asked = kwallet({ ...answers, isOpen: false });
  assert.equal(await make(asked.run)(true), SECRET);
  assert.ok(!asked.methods().includes("isOpen"));

  const missing = kwallet({ ...answers, hasEntry: false });
  assert.equal(await issueOf(make(missing.run)(true)), "credentials-missing");
  assert.equal(missing.methods().at(-1), "close");

  remembered.length = 0;
  const refused = kwallet(answers, "open");
  assert.equal(await issueOf(make(refused.run)(true)), "keychain-locked");
  assert.deepEqual(remembered, [false]);
});

test("Secret Service: the item Chromium's schema files under Claude's name", async () => {
  const calls: string[][] = [];
  let answer: RunResult = { stdout: `${SECRET}\n`, stderr: "" };
  const read = () =>
    linuxSafeStoragePassword({
      allowed: async () => true,
      remember: async () => {},
      env: { XDG_CURRENT_DESKTOP: "GNOME" },
      run: async (file, args) => {
        assert.equal(file, "secret-tool");
        calls.push(args);
        return answer;
      },
    })(false);
  assert.equal(await read(), SECRET);
  assert.deepEqual(calls[0], ["lookup", "xdg:schema", "chrome_libsecret_os_crypt_password_v2", "application", "Claude"]);
  answer = { code: 1, stdout: "", stderr: "" };
  assert.equal(await issueOf(read()), "credentials-missing");
  answer = { code: 1, stdout: "", stderr: "secret-tool: Cannot create an item in a locked collection" };
  assert.equal(await issueOf(read()), "keychain-locked");
  answer = { code: "ENOENT", stdout: "", stderr: "" };
  assert.equal(await issueOf(read()), "keychain-locked");
});

test("the Claude app reads limits on macOS always, on Linux only after a keyring read succeeded", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-desktop-readable-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  assert.equal(await desktopUsageReadable(dir, "darwin"), true);
  assert.equal(await desktopUsageReadable(dir, "linux"), false);
  assert.equal(await desktopUsageReadable(dir, "win32"), false);
  await fs.writeFile(path.join(dir, DESKTOP_USAGE_MARKER), JSON.stringify({ allowed: true }));
  assert.equal(await desktopUsageReadable(dir, "linux"), true);
  assert.equal(await desktopUsageReadable(dir, "win32"), false);
});
