import test from "node:test";
import assert from "node:assert/strict";
import {
  NoEligibleAccountError,
  NoProviderAccountError,
  ProxyRouter,
} from "../electron/core/proxy/proxy-router";
import { ProxySessionCache } from "../electron/core/proxy/proxy-session-cache";
import { proxyExtrasSchema } from "../electron/core/proxy/proxy-status";
import { proxyConfigSchema } from "../electron/core/store";
import { readFileSync } from "node:fs";
import {
  AFFINITY_REVISION,
  currentAffinityTtl,
  DEFAULT_PROXY_CONFIG,
  LEGACY_AFFINITY_TTL_SECONDS,
} from "../shared/proxy-types";
import type { Account, AccountUsage } from "../shared/types";

const makeAccount = (id: string, name: string): Account => ({
  id,
  name,
  kind: "personal",
  group: "default",
  color: "#ff0000",
  createdAt: new Date().toISOString(),
});

test("ProxySessionCache preserves affinity and respects TTL", () => {
  let currentTime = 1000;
  const cache = new ProxySessionCache({
    ttlSeconds: 10,
    now: () => currentTime,
  });

  cache.set("session-1", "acc-1");
  assert.equal(cache.get("session-1"), "acc-1");

  // Advance time past TTL
  currentTime += 15000;
  assert.equal(cache.get("session-1"), undefined);
});

test("ProxyRouter preserves KV prompt cache via session affinity", () => {
  const router = new ProxyRouter();
  const acc1 = makeAccount("acc-1", "Account 1");
  const acc2 = makeAccount("acc-2", "Account 2");
  const accounts = [acc1, acc2];
  const usageMap: Record<string, AccountUsage> = {};

  const sel1 = router.selectAccount("thread-xyz", accounts, usageMap);
  assert.ok(sel1.account);

  // Subsequent call with same session key should return the exact same account
  const sel2 = router.selectAccount("thread-xyz", accounts, usageMap);
  assert.equal(sel2.account.id, sel1.account.id);
  assert.equal(sel2.sessionAffinityHit, true);
});

test("ProxyRouter prioritizes account resetting soonest (token burn optimization)", () => {
  const now = Date.now();
  const router = new ProxyRouter({
    strategy: "soonest-reset",
    now: () => now,
  });

  const accSoon = makeAccount("acc-soon", "Reset Tomorrow");
  const accLate = makeAccount("acc-late", "Reset In 5 Days");

  const usageSoon: AccountUsage = {
    accountId: "acc-soon",
    status: "ready",
    stale: false,
    fiveHour: {
      usedPercent: 20,
      resetsAt: new Date(now + 2 * 3600 * 1000).toISOString(),
    },
    sevenDay: {
      usedPercent: 30,
      resetsAt: new Date(now + 24 * 3600 * 1000).toISOString(),
    },
  };

  const usageLate: AccountUsage = {
    accountId: "acc-late",
    status: "ready",
    stale: false,
    fiveHour: {
      usedPercent: 10,
      resetsAt: new Date(now + 4 * 3600 * 1000).toISOString(),
    },
    sevenDay: {
      usedPercent: 10,
      resetsAt: new Date(now + 5 * 24 * 3600 * 1000).toISOString(),
    },
  };

  const usageMap: Record<string, AccountUsage> = {
    "acc-soon": usageSoon,
    "acc-late": usageLate,
  };

  const sel = router.selectAccount(undefined, [accLate, accSoon], usageMap);
  // acc-soon resets in 2 hours (5h) and 24 hours (7d), while acc-late resets in 4 hours and 5 days.
  // acc-soon should be picked to burn its imminent quota!
  assert.equal(sel.account.id, "acc-soon");
});

test("ProxyRouter evicts exhausted account from session affinity", () => {
  const router = new ProxyRouter();
  const acc1 = makeAccount("acc-1", "Account 1");
  const acc2 = makeAccount("acc-2", "Account 2");

  router.sessionCache.set("sess-abc", "acc-1");

  const usageMap: Record<string, AccountUsage> = {
    "acc-1": {
      accountId: "acc-1",
      status: "ready",
      stale: false,
      // Spent until its reset an hour from now (a reset already past would make it empty again).
      fiveHour: { usedPercent: 100, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
    },
    "acc-2": {
      accountId: "acc-2",
      status: "ready",
      stale: false,
      fiveHour: { usedPercent: 10, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
    },
  };

  const sel = router.selectAccount("sess-abc", [acc1, acc2], usageMap);
  assert.equal(sel.account.id, "acc-2");
  assert.equal(sel.sessionAffinityHit, false);
});

test("ProxySessionCache stays bounded and drops the least recently used session", () => {
  let currentTime = 1000;
  const cache = new ProxySessionCache({
    ttlSeconds: 600,
    maxEntries: 3,
    now: () => currentTime,
  });

  cache.set("a", "acc-1");
  cache.set("b", "acc-1");
  cache.set("c", "acc-1");
  // Touching "a" makes "b" the oldest.
  currentTime += 1;
  assert.equal(cache.get("a"), "acc-1");
  cache.set("d", "acc-1");

  assert.equal(cache.count(), 3);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), "acc-1");
  assert.equal(cache.get("d"), "acc-1");
});

test("ProxySessionCache prunes expired sessions without being read", () => {
  let currentTime = 1000;
  const cache = new ProxySessionCache({
    ttlSeconds: 10,
    now: () => currentTime,
  });
  for (let i = 0; i < 50; i += 1) cache.set(`s${i}`, "acc-1");
  currentTime += 11_000;
  cache.set("fresh", "acc-2");
  assert.equal(cache.count(), 1);
  assert.deepEqual(
    cache.list().map((s) => s.sessionKey),
    ["fresh"],
  );
});

test("ProxyRouter keeps a rate-limited account out until its cooldown ends", () => {
  let currentTime = 1_000_000;
  const router = new ProxyRouter({ now: () => currentTime });
  const acc1 = makeAccount("acc-1", "Account 1");
  const acc2 = makeAccount("acc-2", "Account 2");

  router.markUnavailable("acc-1", 60_000);
  assert.equal(
    router.selectAccount(undefined, [acc1, acc2], {}).account.id,
    "acc-2",
  );

  router.markUnavailable("acc-2", 30_000);
  assert.throws(
    () => router.selectAccount(undefined, [acc1, acc2], {}),
    (error: unknown) =>
      error instanceof NoEligibleAccountError && error.retryAfterSeconds === 30,
  );

  currentTime += 31_000;
  assert.equal(
    router.selectAccount(undefined, [acc1, acc2], {}).account.id,
    "acc-2",
  );
  currentTime += 60_000;
  // Both back: the cooldown map holds nothing stale.
  assert.ok(router.selectAccount(undefined, [acc1, acc2], {}).account);
});

test("ProxyRouter strict-priority follows registry order and skips used-up accounts", () => {
  const router = new ProxyRouter({ strategy: "strict-priority" });
  const acc1 = makeAccount("acc-1", "Account 1");
  const acc2 = makeAccount("acc-2", "Account 2");
  const full: AccountUsage = {
    accountId: "acc-1",
    status: "ready",
    stale: false,
    fiveHour: {
      usedPercent: 98,
      resetsAt: new Date(Date.now() + 3600_000).toISOString(),
    },
  };

  assert.equal(
    router.selectAccount(undefined, [acc1, acc2], {}).account.id,
    "acc-1",
  );
  assert.equal(
    router.selectAccount(undefined, [acc1, acc2], { "acc-1": full }).account.id,
    "acc-2",
  );
});

test("ProxyRouter keeps a request on its provider and says when that provider has no account", () => {
  const router = new ProxyRouter();
  const claudeAcc: Account = { ...makeAccount("claude-1", "Claude 1"), provider: "claude" };
  const codexAcc: Account = { ...makeAccount("codex-1", "Codex 1"), provider: "codex" };
  const both = [claudeAcc, codexAcc];

  assert.equal(router.selectAccount(undefined, both, {}, "claude").account.id, "claude-1");
  assert.equal(router.selectAccount(undefined, both, {}, "codex").account.id, "codex-1");

  // The only Claude account cooling down: the request waits, it never goes to Codex.
  router.markUnavailable("claude-1", 60_000);
  assert.throws(
    () => router.selectAccount(undefined, both, {}, "claude"),
    (err: unknown) => err instanceof NoEligibleAccountError && (err.retryAfterSeconds ?? 0) > 0,
  );
  // Codex is not blocked by Claude's cooldown.
  assert.equal(router.selectAccount(undefined, both, {}, "codex").account.id, "codex-1");
  // No Antigravity account at all is a different answer from "cooling down".
  assert.throws(
    () => router.selectAccount(undefined, both, {}, "antigravity"),
    NoProviderAccountError,
  );
});

test("ProxyRouter skips accounts already tried for the request", () => {
  const router = new ProxyRouter({ strategy: "strict-priority" });
  const a = makeAccount("a", "A");
  const b = makeAccount("b", "B");
  assert.equal(router.selectAccount(undefined, [a, b], {}).account.id, "a");
  assert.equal(router.selectAccount(undefined, [a, b], {}, undefined, new Set(["a"])).account.id, "b");
  assert.throws(
    () => router.selectAccount(undefined, [a, b], {}, undefined, new Set(["a", "b"])),
    NoProviderAccountError,
  );
});

test("soonest-reset ranks accounts with unknown limits after accounts with known room", () => {
  const now = Date.now();
  const router = new ProxyRouter({ strategy: "soonest-reset", now: () => now });
  const unknown = makeAccount("unknown", "Never read");
  const known = makeAccount("known", "Read");
  const usage: Record<string, AccountUsage> = {
    known: { accountId: "known", status: "ready", stale: false, sevenDay: { usedPercent: 40, resetsAt: new Date(now + 86_400_000).toISOString() } } as AccountUsage,
  };
  assert.equal(router.selectAccount(undefined, [unknown, known], usage).account.id, "known");
  // With no room left on the known one, the unknown one is tried instead of the full one.
  usage.known = { accountId: "known", status: "ready", stale: false, sevenDay: { usedPercent: 99, resetsAt: new Date(now + 86_400_000).toISOString() } } as AccountUsage;
  assert.equal(router.selectAccount(undefined, [unknown, known], usage).account.id, "unknown");
});

test("a paused session keeps its account for the hour Claude Code's cache lives", () => {
  // The cache is the account's: a session that moves writes its whole history again.
  assert.equal(DEFAULT_PROXY_CONFIG.affinityTtlSeconds, 3_600);
  let now = 0;
  const cache = new ProxySessionCache({ now: () => now });
  cache.set("s", "a");
  now += 59 * 60_000;
  assert.equal(cache.get("s"), "a");
  // Each request starts the hour again, as a cache hit does.
  now += 59 * 60_000;
  assert.equal(cache.get("s"), "a");
  now += 61 * 60_000;
  assert.equal(cache.get("s"), undefined);
});

test("a saved lifetime that is the old five-minute default moves to the hour, once", () => {
  // Saved before the default changed: never a choice.
  assert.equal(currentAffinityTtl(LEGACY_AFFINITY_TTL_SECONDS, undefined), 3_600);
  assert.equal(currentAffinityTtl(LEGACY_AFFINITY_TTL_SECONDS, 0), 3_600);
  // Any other saved value was chosen, and stays.
  assert.equal(currentAffinityTtl(900, undefined), 900);
  assert.equal(currentAffinityTtl(3_600, undefined), 3_600);
  // Five minutes chosen after the move stays five minutes.
  assert.equal(currentAffinityTtl(LEGACY_AFFINITY_TTL_SECONDS, AFFINITY_REVISION), LEGACY_AFFINITY_TTL_SECONDS);
  assert.equal(currentAffinityTtl(undefined, undefined), undefined);
});

test("the move is recorded beside the registry, which stays readable by older versions", () => {
  // The registry's proxy settings are strict: the revision may only live in proxy-pool.json.
  assert.equal(proxyExtrasSchema.parse({ affinityRevision: 1 }).affinityRevision, 1);
  assert.throws(() =>
    proxyConfigSchema.parse({ enabled: true, port: 8317, host: "127.0.0.1", affinityRevision: 1 }),
  );
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  // Saving the settings keeps the revision, or the next start would move a chosen lifetime again.
  assert.match(main, /const \{ accountOrder, excludedAccountIds, clientBindings, affinityRevision, subagentOverflow, \.\.\.base \} = config;/);
  assert.match(main, /affinityRevision !== undefined \? \{ affinityRevision \} : \{\}/);
});
