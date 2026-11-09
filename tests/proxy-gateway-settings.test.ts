import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store, settingsPatchSchema, settingsSchema } from "../electron/core/store";
import {
  PROXY_KEY_PREFIX,
  buildProxyStatus,
  generateProxyKey,
  proxyConfigurePatch,
  quotaPercent,
  resetInMinutes,
} from "../electron/core/proxy/proxy-status";
import { ProxyStats } from "../electron/core/proxy/proxy-stats";
import { ExtensionSwitcher } from "../electron/core/extension-switch";
import { ExtensionVault } from "../electron/core/extension-vault";
import { CookieVault } from "../electron/core/cookie-vault";
import { createSealer } from "../electron/core/vault-crypto";
import { extensionWorld, loginFor, signInFor } from "./extension-world";
import { DEFAULT_SETTINGS, type Account, type AccountUsage } from "../shared/types";
import { DEFAULT_PROXY_CONFIG } from "../shared/proxy-types";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const account = (id: string, name: string, email?: string): Account =>
  ({
    id,
    name,
    kind: "personal",
    group: "personal",
    color: "terra",
    createdAt: "2026-11-01T00:00:00Z",
    ...(email ? { auth: { loggedIn: true, email, checkedAt: "2026-11-09T00:00:00Z" } } : {}),
  }) as Account;
const usage = (id: string, five?: [number, string?], seven?: [number, string?]): AccountUsage => ({
  accountId: id,
  status: "ready",
  stale: false,
  ...(five ? { fiveHour: { usedPercent: five[0], resetsAt: five[1] } } : {}),
  ...(seven ? { sevenDay: { usedPercent: seven[0], resetsAt: seven[1] } } : {}),
});

test("a new install's settings hold a stopped gateway on 8317", () => {
  assert.deepEqual(
    { ...DEFAULT_SETTINGS.proxy },
    { ...DEFAULT_PROXY_CONFIG, enabled: false, port: 8317, host: "127.0.0.1" },
  );
  assert.doesNotThrow(() => settingsSchema.parse(DEFAULT_SETTINGS));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-proxy-store-"));
  try {
    const store = new Store(root);
    assert.equal(store.state.settings.proxy?.enabled, false);
    assert.equal(store.state.settings.proxy?.port, 8317);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a registry saved before the gateway still reads, and the gateway settings are validated", () => {
  const { proxy: _p, ...saved } = DEFAULT_SETTINGS;
  const read = settingsSchema.parse(saved);
  assert.equal(read.proxy, undefined);
  for (const bad of [
    { ...DEFAULT_SETTINGS.proxy, port: 0 },
    { ...DEFAULT_SETTINGS.proxy, port: 70_000 },
    { ...DEFAULT_SETTINGS.proxy, host: "http://evil/" },
    { ...DEFAULT_SETTINGS.proxy, host: "a b" },
    { ...DEFAULT_SETTINGS.proxy, extra: true },
  ])
    assert.throws(() => settingsSchema.parse({ ...saved, proxy: bad }));
});

test("updateSettings never sets the gateway: it has its own calls", () => {
  assert.deepEqual(settingsPatchSchema.parse({}), {});
  assert.throws(() => settingsPatchSchema.parse({ proxy: { ...DEFAULT_SETTINGS.proxy, host: "0.0.0.0" } }));
});

test("a client key is relay-sec- and 256 random bits, never repeated", () => {
  const keys = new Set(Array.from({ length: 50 }, generateProxyKey));
  assert.equal(keys.size, 50);
  for (const key of keys) {
    assert.ok(key.startsWith(PROXY_KEY_PREFIX));
    assert.match(key.slice(PROXY_KEY_PREFIX.length), /^[A-Za-z0-9_-]{43}$/);
  }
});

test("configuring takes a valid port, a host and the routing choice, and nothing else", () => {
  assert.deepEqual(proxyConfigurePatch.parse({ port: 9000, host: " 0.0.0.0 ", routingStrategy: "balanced" }), {
    port: 9000,
    host: "0.0.0.0",
    routingStrategy: "balanced",
  });
  for (const bad of [{ allowCrossProviderFallback: true }, { port: 0 }, { port: 1.5 }, { port: "80" }, { host: "" }, { host: "x/y" }, { apiKey: "mine" }, { enabled: true }])
    assert.throws(() => proxyConfigurePatch.parse(bad), JSON.stringify(bad));
});

test("quota is the fuller window, and the reset is the soonest one that is still ahead", () => {
  const soon = new Date(NOW + 90 * 60_000 + 1).toISOString();
  const later = new Date(NOW + 3 * 86_400_000).toISOString();
  const past = new Date(NOW - 1000).toISOString();
  const u = usage("a", [42.4, soon], [71.6, later]);
  assert.equal(quotaPercent(u), 72);
  assert.equal(resetInMinutes(u, NOW), 91);
  assert.equal(resetInMinutes(usage("a", [10, past], [10, later]), NOW), 3 * 1440);
  assert.equal(resetInMinutes(usage("a", [10, past]), NOW), undefined);
  assert.equal(quotaPercent(undefined), undefined);
  assert.equal(resetInMinutes(usage("a", [10]), NOW), undefined);
  assert.equal(quotaPercent(usage("a", [130])), 100);
});

test("the status lists every account with its room left, marks the latest one, and carries the key", () => {
  const a = account("a", "Personal", "p@example.com");
  const b = account("b", "Work");
  const status = buildProxyStatus({
    running: true,
    config: { ...DEFAULT_PROXY_CONFIG, enabled: true, apiKey: "relay-sec-k" },
    metrics: {
      totalRequests: 12,
      activeSessions: 1,
      requestsByAccount: {},
      tokensByAccount: {},
      cacheHitRatio: 0.8456,
      activeRequests: 2,
      promptCacheHits: 9,
      lastAccountId: "b",
    },
    accounts: [a, b],
    usage: { a: usage("a", [20, new Date(NOW + 60_000).toISOString()]) },
    now: NOW,
  });
  assert.equal(status.running, true);
  assert.equal(status.port, 8317);
  assert.equal(status.host, "127.0.0.1");
  assert.equal(status.clientApiKey, "relay-sec-k");
  assert.deepEqual(status.stats, { totalRequests: 12, activeRequests: 2, promptCacheHits: 9, cacheHitRate: 84.6 });
  assert.deepEqual(status.accounts, [
    { id: "a", name: "Personal", provider: "claude", email: "p@example.com", active: false, signedIn: true, quotaPercent: 20, resetInMinutes: 1 },
    { id: "b", name: "Work", provider: "claude", active: true, signedIn: false },
  ]);
});

test("a stopped gateway shows zero counters, no active account, and why it did not start", () => {
  const status = buildProxyStatus({
    running: false,
    config: DEFAULT_PROXY_CONFIG,
    accounts: [account("a", "Personal")],
    usage: {},
    now: NOW,
    error: "port in use",
  });
  assert.equal(status.running, false);
  assert.equal(status.clientApiKey, undefined);
  assert.deepEqual(status.stats, { totalRequests: 0, activeRequests: 0, promptCacheHits: 0, cacheHitRate: 0 });
  assert.equal(status.accounts[0].active, false);
  assert.equal(status.error, "port in use");
  // Even a stale "last account" is not active while the gateway is down.
  assert.equal(
    buildProxyStatus({
      running: false,
      config: DEFAULT_PROXY_CONFIG,
      metrics: { totalRequests: 1, activeSessions: 0, requestsByAccount: {}, tokensByAccount: {}, cacheHitRatio: 0, lastAccountId: "a" },
      accounts: [account("a", "Personal")],
      usage: {},
      now: NOW,
    }).accounts[0].active,
    false,
  );
});

test("the gateway's counters: requests in flight, answers that read the cache, the latest account", () => {
  const stats = new ProxyStats();
  stats.requestStarted();
  stats.requestStarted();
  stats.requestEnded();
  stats.recordRequest("a");
  stats.recordRequest("b");
  stats.recordTokens("a", { input: 100, cacheRead: 300 });
  stats.recordTokens("b", { input: 50, cacheRead: 0 });
  stats.recordTokens("b", { cacheRead: 10 });
  const metrics = stats.getMetrics(0);
  assert.equal(metrics.activeRequests, 1);
  assert.equal(metrics.promptCacheHits, 2);
  assert.equal(metrics.lastAccountId, "b");
  stats.requestEnded();
  stats.requestEnded();
  assert.equal(stats.getMetrics(0).activeRequests, 0, "never below zero");
  stats.reset();
  assert.equal(stats.getMetrics(0).promptCacheHits, 0);
  assert.equal(stats.getMetrics(0).lastAccountId, undefined);
});

