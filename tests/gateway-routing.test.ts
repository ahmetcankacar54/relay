import test from "node:test";
import assert from "node:assert/strict";
import { ProxyRouter, REBALANCE_GAP_MS, MIN_STAY_MS, modelFamily } from "../electron/core/proxy/proxy-router";
import { limitScopeOf } from "../electron/core/proxy/upstream-common";
import type { Account, AccountUsage } from "../shared/types";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 13, 23, 30);
const account = (id: string): Account => ({
  id,
  name: id,
  kind: "personal",
  group: "default",
  color: "#000",
  createdAt: "2026-11-01T00:00:00.000Z",
});
const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString();
const usage = (
  id: string,
  five: { used: number; resetIn?: number },
  week: { used: number; resetIn: number },
  fable?: { used: number; resetIn: number },
): AccountUsage => ({
  accountId: id,
  status: "ready",
  stale: false,
  fiveHour: { usedPercent: five.used, ...(five.resetIn !== undefined ? { resetsAt: at(five.resetIn) } : {}) },
  sevenDay: { usedPercent: week.used, resetsAt: at(week.resetIn) },
  ...(fable
    ? { modelWindows: [{ key: "seven_day_fable", label: "Fable", model: "fable", usedPercent: fable.used, resetsAt: at(fable.resetIn) }] }
    : {}),
});

// The pool as it stood on 2026-11-14 at 02:30 (Istanbul): Alto's 5-hour window running hot,
// Vertex's week ending in ~30 h with its Fable week spent, Nova untouched until the 20th.
const accounts = [account("vertex"), account("nova"), account("alto")];
const pool = (): Record<string, AccountUsage> => ({
  alto: usage("alto", { used: 81, resetIn: 2.2 }, { used: 27, resetIn: 124 }, { used: 12, resetIn: 124 }),
  vertex: usage("vertex", { used: 18, resetIn: 1.5 }, { used: 80, resetIn: 29.5 }, { used: 100, resetIn: 29.5 }),
  nova: usage("nova", { used: 0 }, { used: 0, resetIn: 165 }, { used: 0, resetIn: 165 }),
});

test("a new session goes to the account whose week ends first, not to the one whose 5-hour window is running", () => {
  const router = new ProxyRouter({ strategy: "soonest-reset", now: () => NOW });
  // Before: the earliest of either reset decided, so the account in use (its 5-hour window
  // ending in 2 h) always won over an account whose week ends in a day.
  const opus = router.selectAccount("s-opus", accounts, pool(), "claude", new Set(), undefined, { model: "claude-opus-5-5" });
  assert.equal(opus.account.id, "vertex");
  assert.equal(opus.reason, "soonest-reset");
});

test("a model whose own weekly limit is spent goes elsewhere, while the account keeps serving other models", () => {
  const router = new ProxyRouter({ strategy: "soonest-reset", now: () => NOW });
  const fable = router.selectAccount("s-fable", accounts, pool(), "claude", new Set(), undefined, { model: "claude-fable-5-2" });
  assert.equal(fable.account.id, "alto", "Vertex's Fable week is spent; Alto's week ends before Nova's");
  const opus = router.selectAccount("s-opus", accounts, pool(), "claude", new Set(), undefined, { model: "claude-opus-5-5" });
  assert.equal(opus.account.id, "vertex");
  // A Fable request in a session bound to Vertex moves: its model is out there.
  router.sessionCache.set("s-mixed", "vertex");
  const moved = router.selectAccount("s-mixed", accounts, pool(), "claude", new Set(), undefined, { model: "claude-fable-5-2" });
  assert.equal(moved.account.id, "alto");
  assert.equal(moved.moved, "limit");
  assert.equal(moved.from, "vertex");
});

test("a 429 that spent only one model's limit keeps that model off the account, not the account", () => {
  const router = new ProxyRouter({ strategy: "soonest-reset", now: () => NOW });
  const usageMap = pool();
  usageMap.vertex.modelWindows = [];
  router.markModelUnavailable("vertex", "fable", 30 * HOUR);
  assert.equal(router.selectAccount(undefined, accounts, usageMap, "claude", new Set(), undefined, { model: "claude-fable-5-2" }).account.id, "alto");
  assert.equal(router.selectAccount(undefined, accounts, usageMap, "claude", new Set(), undefined, { model: "claude-opus-5-5" }).account.id, "vertex");
  assert.equal(limitScopeOf({ "anthropic-ratelimit-unified-7d_fable-status": "rejected", "anthropic-ratelimit-unified-5h-status": "allowed" }), "model");
  assert.equal(limitScopeOf({ "anthropic-ratelimit-unified-7d_fable-status": "rejected", "anthropic-ratelimit-unified-7d-status": "rejected" }), "account");
  assert.equal(limitScopeOf({ "anthropic-ratelimit-unified-7d_oauth_apps-status": "rejected" }), "account", "a client-scoped limit stops every request");
  assert.equal(limitScopeOf({ "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-representative-claim": "five_hour" }), "account");
  assert.equal(limitScopeOf({}), "account");
  assert.equal(modelFamily("claude-fable-5-2"), "fable");
  assert.equal(modelFamily("gpt-5.3-codex"), undefined);
});

test("a busy session moves to the expiring week at the start of a prompt, never mid-turn, and not back and forth", () => {
  let now = NOW;
  const router = new ProxyRouter({ strategy: "soonest-reset", now: () => now });
  router.sessionCache.set("s", "alto");
  const opus = { model: "claude-opus-5-5" };
  // Mid-turn (tool calls, subagents' parent turns): the session stays with its cache.
  const mid = router.selectAccount("s", accounts, pool(), "claude", new Set(), undefined, opus);
  assert.equal(mid.account.id, "alto");
  assert.equal(mid.reason, "bound");
  // A new prompt begins: Vertex's week ends four days before Alto's, so the session moves.
  const turn = router.selectAccount("s", accounts, pool(), "claude", new Set(), undefined, { ...opus, turnStart: true });
  assert.equal(turn.account.id, "vertex");
  assert.equal(turn.moved, "rebalance");
  assert.equal(turn.from, "alto");
  // Next prompts stay: it is already where it should be.
  const again = router.selectAccount("s", accounts, pool(), "claude", new Set(), undefined, { ...opus, turnStart: true });
  assert.equal(again.reason, "bound");

  // Vertex's 5-hour window fills: at the next prompt the session drains to the next account.
  const hot = pool();
  hot.vertex.fiveHour = { usedPercent: 93, resetsAt: at(1) };
  now += MIN_STAY_MS / 2;
  const drained = router.selectAccount("s", accounts, hot, "claude", new Set(), undefined, { ...opus, turnStart: true });
  assert.equal(drained.account.id, "alto");
  assert.equal(drained.moved, "drain");
  // The window resets a moment later; the session just moved, so it stays a while first.
  now += 60_000;
  const settled = router.selectAccount("s", accounts, pool(), "claude", new Set(), undefined, { ...opus, turnStart: true });
  assert.equal(settled.account.id, "alto");
  now += MIN_STAY_MS;
  const back = router.selectAccount("s", accounts, pool(), "claude", new Set(), undefined, { ...opus, turnStart: true });
  assert.equal(back.account.id, "vertex");
  assert.equal(back.moved, "rebalance");
});

test("weeks ending within a few hours of each other do not move a session; the 5-hour window decides new ones", () => {
  const router = new ProxyRouter({ strategy: "soonest-reset", now: () => NOW });
  const close = {
    a: usage("a", { used: 40, resetIn: 1 }, { used: 30, resetIn: 50 }),
    b: usage("b", { used: 10, resetIn: 4 }, { used: 30, resetIn: 50 + REBALANCE_GAP_MS / HOUR / 2 }),
  };
  router.sessionCache.set("s", "b");
  const kept = router.selectAccount("s", [account("a"), account("b")], close, "claude", new Set(), undefined, { turnStart: true });
  assert.equal(kept.account.id, "b", "half a day apart is not worth a cache write");
  const fresh = router.selectAccount("new", [account("a"), account("b")], close, "claude");
  assert.equal(fresh.account.id, "a");
});

test("a cold session goes where a new one would, at no cost; strict priority never rebalances", () => {
  const router = new ProxyRouter({ strategy: "soonest-reset", now: () => NOW });
  router.sessionCache.set("s", "alto");
  const cold = router.selectAccount("s", accounts, pool(), "claude", new Set(), undefined, { model: "claude-opus-5-5", cold: true });
  assert.equal(cold.account.id, "vertex");
  assert.equal(cold.moved, "cold");

  const strict = new ProxyRouter({ strategy: "strict-priority", now: () => NOW });
  strict.sessionCache.set("s", "alto");
  assert.equal(
    strict.selectAccount("s", accounts, pool(), "claude", new Set(), undefined, { model: "claude-opus-5-5", turnStart: true }).account.id,
    "alto",
  );
});

test("through the gateway: a session moves only on a new prompt id, and the log says why", async () => {
  const http = await import("node:http");
  const { ProxyServer } = await import("../electron/core/proxy/proxy-server");
  const clock = { now: NOW };
  const usageMap: Record<string, AccountUsage> = {
    soon: usage("soon", { used: 95, resetIn: 0.5 }, { used: 40, resetIn: 24 }),
    late: usage("late", { used: 10, resetIn: 3 }, { used: 20, resetIn: 120 }),
  };
  const tokens: string[] = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      tokens.push(String(req.headers.authorization).replace("Bearer ", ""));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2,"cache_read_input_tokens":30000,"cache_creation_input_tokens":0,"output_tokens":3}}}\n\n');
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const server = new ProxyServer({
    config: { port: 0, host: "127.0.0.1", enabled: true, routingStrategy: "soonest-reset" },
    credentialResolver: async (a) => `tok-${a.id}`,
    usageProvider: () => ({ accounts: [account("soon"), account("late")], usageMap }),
    upstreams: { anthropicUrl: `http://127.0.0.1:${(upstream.address() as import("node:net").AddressInfo).port}` },
    now: () => clock.now,
  });
  const { port } = await server.start();
  const send = (prompt: string) =>
    new Promise<void>((resolve, reject) =>
      http
        .request(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: "/v1/messages",
            headers: { "x-claude-code-session-id": "s-1", "x-claude-code-request-class": "main", "x-claude-code-prompt-id": prompt },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve());
          },
        )
        .on("error", reject)
        .end(JSON.stringify({ model: "claude-opus-5-5" })),
    );
  try {
    await send("p1");
    assert.deepEqual(tokens, ["tok-late"], "the account whose week ends first is past its 5-hour soft stop");
    // Its 5-hour window resets; the turn goes on with tool calls on the same prompt.
    usageMap.soon = usage("soon", { used: 5, resetIn: 5 }, { used: 40, resetIn: 24 });
    clock.now += 3 * 60_000;
    await send("p1");
    assert.deepEqual(tokens, ["tok-late", "tok-late"], "never mid-turn");
    clock.now += 60_000;
    await send("p2");
    assert.deepEqual(tokens, ["tok-late", "tok-late", "tok-soon"]);
    const [moved] = server.stats.recent();
    assert.equal(moved.note, "rebalance-move");
    assert.deepEqual(moved.pick, { reason: "soonest-reset", moved: "rebalance", from: "late" });
  } finally {
    await server.stop();
    await new Promise<void>((resolve) => {
      upstream.closeAllConnections();
      upstream.close(() => resolve());
    });
  }
});

test("an answer's own window of one model is read as that model's limit", async () => {
  const { parseLiveLimits } = await import("../electron/core/proxy/upstream-common");
  const reset = Math.floor(NOW / 1000) + 3600;
  const live = parseLiveLimits({
    "anthropic-ratelimit-unified-5h-utilization": "0.31",
    "anthropic-ratelimit-unified-7d_fable-utilization": "0.995",
    "anthropic-ratelimit-unified-7d_fable-reset": String(reset),
    "anthropic-ratelimit-unified-7d_oauth_apps-utilization": "0.2",
  });
  assert.equal(live?.fiveHour?.usedPercent, 31);
  assert.deepEqual(live?.models, [{ model: "fable", weekly: true, usedPercent: 99.5, resetsAt: new Date(reset * 1000).toISOString() }]);
  assert.equal(parseLiveLimits({ "anthropic-ratelimit-unified-7d_opus-utilization": "0.4" })?.models?.[0]?.model, "opus");
  assert.equal(parseLiveLimits({}), undefined);
});
