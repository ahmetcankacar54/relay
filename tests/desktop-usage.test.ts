import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  cookieHeader,
  cookieKey,
  decryptCookie,
  DesktopUsageReader,
  readCookieRows,
  safeStoragePassword,
  type WebResponse,
} from "../electron/core/desktop-usage";
import { UsageManager } from "../electron/core/usage";
import { UsageError } from "../electron/core/usage-credentials";
import { Store } from "../electron/core/store";
import { readsThroughApp, cliNeedsReconnect } from "../shared/account-state";
import { usageIdentity, historyIdentity } from "../shared/usage-statistics";
import { usageSignInStatus } from "../src/lib/account-health";
import type { Account } from "../shared/types";

const PASSWORD = "fixture-safe-storage-password";
const KEY = cookieKey(PASSWORD);
const ACCOUNT = "0d1e2f3a-38b0-4c1f-9d39-6f1f4c0a1b2c";
const ORG = "11111111-2222-4333-8444-555555555555";

/** Encrypts like Chromium on macOS, database version 24 and later. */
function encrypt(value: string, host: string, key = KEY): Buffer {
  const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const plain = Buffer.concat([crypto.createHash("sha256").update(host).digest(), Buffer.from(value)]);
  return Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
}

async function cookieDatabase(t: any, rows: [host: string, name: string, value: string][]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-desktop-usage-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "Cookies");
  const db = new DatabaseSync(file);
  db.exec("create table meta (key text primary key, value text)");
  db.exec("insert into meta values ('version', '24')");
  db.exec("create table cookies (host_key text, name text, value text, encrypted_value blob)");
  const insert = db.prepare("insert into cookies values (?, ?, '', ?)");
  for (const [host, name, value] of rows) insert.run(host, name, encrypt(value, host));
  db.close();
  return { Cookies: await fs.readFile(file) } as Record<string, Buffer | null>;
}

const json = (status: number, body: unknown, extra: Partial<WebResponse> = {}): WebResponse => ({
  status,
  contentType: "application/json",
  retryAfter: null,
  body: JSON.stringify(body),
  ...extra,
});

const account = (extra: Partial<Account> = {}): Account =>
  ({
    id: "a",
    name: "A",
    group: "g",
    color: "#000",
    createdAt: "2026-11-01T00:00:00.000Z",
    desktop: { accountUuid: ACCOUNT, orgId: ORG, savedAt: "2026-11-01T00:00:00.000Z" },
    ...extra,
  }) as Account;

test("Chromium's macOS cookie values decrypt with the Safe Storage key, and only with it", () => {
  assert.equal(decryptCookie(encrypt("sk-ant-sid01-abc", ".claude.ai"), KEY, ".claude.ai", 24), "sk-ant-sid01-abc");
  // The host digest guards against a value moved to another host.
  assert.equal(decryptCookie(encrypt("x", "claude.ai"), KEY, ".claude.ai", 24), undefined);
  assert.equal(decryptCookie(encrypt("x", ".claude.ai"), cookieKey("other"), ".claude.ai", 24), undefined);
  assert.equal(decryptCookie(Buffer.from("v11abcdefghijklmnopqrs"), KEY, ".claude.ai", 24), undefined);
  // Before version 24 there is no digest.
  const cipher = crypto.createCipheriv("aes-128-cbc", KEY, Buffer.alloc(16, 0x20));
  const old = Buffer.concat([Buffer.from("v10"), cipher.update("plain-old"), cipher.final()]);
  assert.equal(decryptCookie(old, KEY, ".claude.ai", 23), "plain-old");
});

test("the Cookie header carries the session and its routing hints, nothing else", async (t) => {
  const files = await cookieDatabase(t, [
    [".claude.ai", "sessionKey", "sk-ant-sid01-abc"],
    [".claude.ai", "lastActiveOrg", ORG],
    [".claude.ai", "cf_clearance", "never-sent"],
    ["claude.ai", "anthropic-device-id", "never-sent"],
    [".example.com", "sessionKey", "other-site"],
  ]);
  const { version, rows } = await readCookieRows(files);
  assert.equal(version, 24);
  assert.deepEqual(rows.map((r) => r.name).sort(), ["anthropic-device-id", "cf_clearance", "lastActiveOrg", "sessionKey"]);
  assert.equal(cookieHeader(rows, KEY, version), `sessionKey=sk-ant-sid01-abc; lastActiveOrg=${ORG}`);
  // Without a session there is nothing to send.
  assert.equal(cookieHeader(rows.filter((r) => r.name !== "sessionKey"), KEY, version), undefined);
  await assert.rejects(readCookieRows({}), (e: unknown) => e instanceof UsageError && e.issue === "credentials-missing");
});

test("a Claude app sign-in reads claude.ai's usage for the account's organization", async (t) => {
  const files = await cookieDatabase(t, [[".claude.ai", "sessionKey", "sk-ant-sid01-abc"]]);
  const calls: { url: string; cookie: string }[] = [];
  let answer: WebResponse = json(200, { five_hour: { utilization: 12, resets_at: "2026-11-07T15:00:00Z" } });
  const prompts: boolean[] = [];
  const reader = new DesktopUsageReader({
    cookieFiles: async (uuid) => {
      assert.equal(uuid, ACCOUNT);
      return files;
    },
    password: async (allowPrompt) => {
      prompts.push(allowPrompt);
      return PASSWORD;
    },
    request: async (url, cookie) => {
      calls.push({ url, cookie });
      return answer;
    },
    now: () => 0,
  });
  assert.deepEqual(await reader.read(account(), false), {
    five_hour: { utilization: 12, resets_at: "2026-11-07T15:00:00Z" },
  });
  assert.deepEqual(calls, [
    { url: `https://claude.ai/api/organizations/${ORG}/usage`, cookie: "sessionKey=sk-ant-sid01-abc" },
  ]);
  assert.deepEqual(prompts, [false]);
  const issue = async (response: WebResponse) => {
    answer = response;
    try {
      await reader.read(account(), false);
    } catch (e) {
      return (e as UsageError).issue;
    }
  };
  assert.equal(await issue(json(401, {})), "expired");
  assert.equal(await issue(json(403, { error: { type: "permission_error" } })), "expired");
  // Cloudflare's challenge page passes on its own.
  assert.equal(await issue({ status: 403, contentType: "text/html", retryAfter: null, body: "<html>" }), "unavailable");
  assert.equal(await issue(json(429, {}, { retryAfter: "120" })), "rate-limited");
  assert.equal(await issue(json(500, {})), "unavailable");
  assert.equal(await issue({ status: 200, contentType: "application/json", retryAfter: null, body: "{" }), "unsupported");
});

test("a signed-out Claude app sign-in, a missing one and a refused Keychain each say so", async (t) => {
  const signedOut = await cookieDatabase(t, [[".claude.ai", "lastActiveOrg", ORG]]);
  const base = {
    password: async () => PASSWORD,
    request: async () => json(200, {}),
  };
  const issue = (reader: DesktopUsageReader) =>
    reader.read(account(), false).then(
      () => undefined,
      (e: UsageError) => e.issue,
    );
  assert.equal(await issue(new DesktopUsageReader({ ...base, cookieFiles: async () => signedOut })), "expired");
  assert.equal(
    await issue(new DesktopUsageReader({ ...base, cookieFiles: async () => Promise.reject(new Error("missing")) })),
    "credentials-missing",
  );
  const locked = new DesktopUsageReader({
    ...base,
    cookieFiles: async () => signedOut,
    password: async () => {
      throw new UsageError("keychain-locked");
    },
  });
  assert.equal(await issue(locked), "keychain-locked");
});

test("the Safe Storage password is read only once allowed, then kept for the run", { skip: process.platform === "win32" && "macOS only: the Keychain, through a shell stand-in for security" }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-safe-storage-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const tool = path.join(dir, "security");
  const log = path.join(dir, "calls");
  await fs.writeFile(tool, `#!/bin/sh\necho "$@" >> "${log}"\necho "${PASSWORD}"\n`, { mode: 0o755 });
  let allowed = false;
  const remembered: boolean[] = [];
  const read = safeStoragePassword({
    allowed: async () => allowed,
    remember: async (value) => {
      remembered.push(value);
    },
    tool,
  });
  // In the background, before the user allowed it, no Keychain dialog may open.
  await assert.rejects(read(false), (e: unknown) => e instanceof UsageError && e.issue === "keychain-locked");
  await assert.rejects(fs.readFile(log, "utf8"));
  assert.equal(await read(true), PASSWORD);
  assert.deepEqual(remembered, [true]);
  assert.equal(
    (await fs.readFile(log, "utf8")).trim(),
    "find-generic-password -s Claude Safe Storage -a Claude -w",
  );
  allowed = true;
  assert.equal(await read(false), PASSWORD);
  // Kept in memory: the tool ran once.
  assert.equal((await fs.readFile(log, "utf8")).trim().split("\n").length, 1);
});

test("an account without a Claude Code sign-in reads its limits through the Claude app", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-usage-app-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const created = store.create({ name: "A", kind: "personal" });
  store.update((s) => {
    s.accounts[0].desktop = { accountUuid: ACCOUNT, orgId: ORG, savedAt: "2026-11-01T00:00:00.000Z" };
  });
  const credentials = async () => {
    throw new Error("the CLI credential must not be read");
  };
  const reads: boolean[] = [];
  const samples: string[] = [];
  const manager = new UsageManager(
    store,
    credentials,
    undefined,
    () => Date.parse("2026-11-07T12:00:00Z"),
    (_account, usage) => samples.push(usage.source ?? ""),
    undefined,
    undefined,
    undefined,
    {
      usable: (a) => !!a.desktop,
      read: async (_a, allowPrompt) => {
        reads.push(allowPrompt);
        return { five_hour: { utilization: 40, resets_at: "2026-11-07T15:00:00Z" }, seven_day: null };
      },
    },
  );
  const usage = await manager.refresh(created.id, true);
  assert.equal(usage.status, "ready");
  assert.equal(usage.source, "desktop");
  assert.equal(usage.fiveHour?.usedPercent, 40);
  assert.equal(usage.issue, undefined);
  assert.deepEqual(reads, [true]);
  assert.deepEqual(samples, ["desktop"]);

  // Without the second source (Windows, Linux) the account still asks for a usage sign-in.
  const plain = new UsageManager(store, credentials);
  assert.equal(plain.snapshot()[created.id].issue, "connect-cli");
  // An account without any Claude app sign-in has no source either.
  store.update((s) => {
    delete s.accounts[0].desktop;
  });
  assert.equal(manager.snapshot()[created.id].issue, "connect-cli");
});

test("a failed read through the Claude app keeps its source, so the app knows which sign-in to fix", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-usage-app-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const created = store.create({ name: "A", kind: "personal" });
  store.update((s) => {
    s.accounts[0].desktop = { accountUuid: ACCOUNT, orgId: ORG, savedAt: "2026-11-01T00:00:00.000Z" };
  });
  const manager = new UsageManager(
    store,
    async () => {
      throw new Error("unused");
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      usable: () => true,
      read: async () => {
        throw new UsageError("keychain-locked");
      },
    },
  );
  const usage = await manager.refresh(created.id);
  assert.equal(usage.issue, "keychain-locked");
  assert.equal(usage.source, "desktop");
});

test("the account's status names the Claude app as its usage source", () => {
  const t = (_tr: string, en: string) => en;
  const ready = { accountId: "a", status: "ready" as const, stale: false, source: "desktop" as const, checkedAt: "2026-11-07T12:00:00Z" };
  assert.equal(readsThroughApp(account(), ready), true);
  assert.equal(cliNeedsReconnect(account(), ready), false);
  assert.deepEqual(usageSignInStatus(account(), ready, false, t), { tone: "ok", label: "Through the Claude app" });
  const expired = { ...ready, status: "error" as const, issue: "expired" as const };
  assert.equal(cliNeedsReconnect(account(), expired), true);
  // Without a usage source the CLI sign-in is still asked for.
  const none = { accountId: "a", status: "idle" as const, stale: false, issue: "connect-cli" as const };
  assert.equal(readsThroughApp(account(), none), false);
  assert.equal(cliNeedsReconnect(account(), none), true);
  // Samples read through the app are filed under the app's identity.
  assert.equal(usageIdentity(account()), JSON.stringify(["uuid", ACCOUNT, ORG]));
  assert.equal(historyIdentity(account()), JSON.stringify(["uuid", ACCOUNT, ORG]));
});

test("claude.ai's usage answer, as seen live on 2026-11-07, parses like the CLI endpoint's", async () => {
  const { parseUsage } = await import("../electron/core/usage");
  const window = (utilization: number, resets_at: string) => ({
    utilization,
    resets_at,
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
    locked_reason: null,
  });
  // Shape only: the many other keys (null model windows, extra_usage, limits, spend) are ignored.
  assert.deepEqual(
    parseUsage({
      five_hour: window(9, "2026-11-07T03:40:00.996524+00:00"),
      seven_day: window(2, "2026-11-13T21:00:00.996541+00:00"),
      seven_day_oauth_apps: null,
      seven_day_opus: null,
      seven_day_sonnet: null,
      seven_day_cowork: null,
      pace: null,
      indicator: null,
      extra_usage: { is_enabled: false, utilization: null },
      limits: [{}, {}, {}],
      spend: { used: { amount_minor: 0, currency: "USD", exponent: 2 }, percent: 0 },
    }),
    {
      fiveHour: { usedPercent: 9, resetsAt: "2026-11-07T03:40:00.996Z" },
      sevenDay: { usedPercent: 2, resetsAt: "2026-11-13T21:00:00.996Z" },
    },
  );
});
