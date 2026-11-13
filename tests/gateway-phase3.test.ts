import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { GatewayInsights, LOOP_REQUESTS, LOOP_SUBAGENTS } from "../electron/core/proxy/proxy-insights";
import { ProxyRouter, nearlyFull } from "../electron/core/proxy/proxy-router";
import { ProxySessionCache } from "../electron/core/proxy/proxy-session-cache";
import { ProxyServer } from "../electron/core/proxy/proxy-server";
import { GatewayRequestLog } from "../electron/core/proxy/proxy-request-log";
import { createAnthropicUsageExtractor } from "../electron/core/proxy/anthropic-upstream";
import type { Account, AccountUsage } from "../shared/types";

const MINUTE = 60_000;
const account = (id: string): Account => ({
  id,
  name: id.toUpperCase(),
  kind: "personal",
  group: "default",
  color: "#000",
  createdAt: new Date().toISOString(),
});
const usage = (id: string, fiveHour: number, week = 10, resetInHours = 2): AccountUsage => ({
  accountId: id,
  status: "ready",
  stale: false,
  fiveHour: { usedPercent: fiveHour, resetsAt: new Date(Date.now() + resetInHours * 3_600_000).toISOString() },
  sevenDay: { usedPercent: week, resetsAt: new Date(Date.now() + 5 * 86_400_000).toISOString() },
});

test("the usage of an answer says how much of its cache write lasts an hour", () => {
  const usage = createAnthropicUsageExtractor();
  usage.onEvent({
    type: "message_start",
    message: { usage: { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 900, cache_creation: { ephemeral_1h_input_tokens: 800, ephemeral_5m_input_tokens: 100 } } },
  });
  assert.deepEqual(usage.result(), { input: 3, cacheRead: 100, cacheWrite: 900, cacheWrite1h: 800 });
});

test("a session's cache: a write again is a miss, with the reason it happened", () => {
  const clock = { now: Date.UTC(2026, 10, 13, 12) };
  const insights = new GatewayInsights(() => clock.now);
  const answer = (over: Partial<Parameters<GatewayInsights["observeAnswer"]>[0]> = {}) =>
    insights.observeAnswer({ at: clock.now, sessionKey: "hdr:6cf63d7f-aaaa", accountId: "a", model: "claude-opus-5-5", requestClass: "main", ...over, tokens: over.tokens ?? { input: 2, cacheRead: 100_000, cacheWrite: 1_000, cacheWrite1h: 1_000 } });

  assert.equal(answer({ tokens: { input: 2, cacheWrite: 100_000, cacheWrite1h: 100_000 } }), undefined, "the first request writes, as it must");
  clock.now += 2 * MINUTE;
  assert.equal(answer({ tokens: { input: 2, cacheRead: 100_002, cacheWrite: 900, cacheWrite1h: 900 } }), undefined, "read back: no miss");
  // The session moved to another account: everything is written again there.
  clock.now += MINUTE;
  assert.deepEqual(answer({ accountId: "b", tokens: { input: 2, cacheWrite: 101_500, cacheWrite1h: 101_500 } }), { reason: "account", tokens: 100_904 });
  // An hour and more of quiet: the cache lived out its time.
  clock.now += 61 * MINUTE;
  assert.equal(answer({ accountId: "b", tokens: { input: 2, cacheWrite: 102_000, cacheWrite1h: 102_000 } })?.reason, "expired");
  clock.now += MINUTE;
  assert.equal(answer({ accountId: "b", model: "claude-sonnet-5-5", tokens: { input: 2, cacheWrite: 102_500 } })?.reason, "model");
  // A compaction writes a new prompt by design; a subagent has a cache of its own.
  clock.now += MINUTE;
  assert.equal(answer({ accountId: "b", model: "claude-sonnet-5-5", requestClass: "compaction", tokens: { input: 2, cacheWrite: 20_000 } }), undefined);
  clock.now += MINUTE;
  assert.equal(answer({ accountId: "c", agentId: "a2919ea8825dbfc96", requestClass: "subagent", tokens: { input: 2, cacheWrite: 30_000 } }), undefined);

  const [view] = insights.sessionViews();
  assert.equal(view.id, "6cf63d7f");
  assert.equal(view.accountId, "b", "a subagent elsewhere does not move the session");
  assert.equal(view.prefixTokens, 20_002);
  assert.equal(view.ttlMs, 5 * MINUTE, "its last write was a five-minute one");
  assert.equal(view.misses, 3);
  assert.equal(view.subagents, 1);
  assert.equal(view.requests, 7);
  assert.equal(view.lastMiss?.reason, "model");
});

test("a prompt past the loop bounds raises one alarm, which stays on show for half an hour", () => {
  const clock = { now: Date.UTC(2026, 10, 13, 12) };
  const insights = new GatewayInsights(() => clock.now);
  let raised = 0;
  for (let i = 0; i < LOOP_REQUESTS + 20; i++)
    if (insights.countPrompt("f5601bf9-prompt", { sessionKey: "hdr:6cf63d7f-aaaa" })) raised += 1;
  assert.equal(raised, 1);
  insights.promptServedBy("f5601bf9-prompt", "a");
  const [alarm] = insights.alarms();
  assert.deepEqual(
    { id: alarm.id, sessionId: alarm.sessionId, accountId: alarm.accountId, requests: alarm.requests },
    { id: "f5601bf9", sessionId: "6cf63d7f", accountId: "a", requests: LOOP_REQUESTS + 20 },
  );
  clock.now += 31 * MINUTE;
  assert.deepEqual(insights.alarms(), []);

  // Subagents count too.
  const fresh = new GatewayInsights(() => clock.now);
  let alarm2;
  for (let i = 0; i < LOOP_SUBAGENTS; i++) alarm2 = fresh.countPrompt("p2", { agentId: `agent-${i}` }) ?? alarm2;
  assert.equal(alarm2?.subagents, LOOP_SUBAGENTS);
  assert.equal(fresh.countPrompt(undefined, {}), undefined, "no prompt id, nothing counted");
});

test("an account's pace says when its 5-hour window fills, only from a rise over ten minutes and before it resets", () => {
  const clock = { now: Date.UTC(2026, 10, 13, 12) };
  const insights = new GatewayInsights(() => clock.now);
  const reset = new Date(clock.now + 3 * 3_600_000).toISOString();
  insights.observeLimits("a", { usedPercent: 60, resetsAt: reset });
  clock.now += 5 * MINUTE;
  insights.observeLimits("a", { usedPercent: 62, resetsAt: reset });
  assert.equal(insights.fullAt("a"), undefined, "five minutes are too few");
  clock.now += 5 * MINUTE;
  insights.observeLimits("a", { usedPercent: 64, resetsAt: reset });
  // 4 % in 10 minutes: the 36 % left take 90 minutes.
  assert.equal(insights.fullAt("a"), clock.now + 90 * MINUTE);
  // Slower than the reset: no warning.
  const slow = new GatewayInsights(() => clock.now);
  slow.observeLimits("b", { usedPercent: 10, resetsAt: reset });
  clock.now += 10 * MINUTE;
  slow.observeLimits("b", { usedPercent: 11, resetsAt: reset });
  assert.equal(slow.fullAt("b"), undefined);
  // A new window starts the pace afresh.
  insights.observeLimits("a", { usedPercent: 2, resetsAt: new Date(clock.now + 5 * 3_600_000).toISOString() });
  assert.equal(insights.fullAt("a"), undefined);
});

test("a new session skips an account close to its limit while another has room; a running one keeps its account", () => {
  const cache = new ProxySessionCache();
  const router = new ProxyRouter({ strategy: "soonest-reset", sessionCache: cache });
  const pool = [account("a"), account("b")];
  // A resets sooner, so soonest-reset would choose it, but it is at 92 %.
  const map = { a: usage("a", 92, 10, 1), b: usage("b", 40, 10, 4) };
  assert.equal(nearlyFull(map.a), true);
  assert.equal(nearlyFull(usage("x", 50, 98)), true, "a week at 98 % too");
  assert.equal(router.selectAccount("new", pool, map).account.id, "b");
  cache.set("running", "a");
  assert.equal(router.selectAccount("running", pool, map).account.id, "a", "its cache is on A");
  // When every account is that close, the strategy picks among them all.
  assert.equal(router.selectAccount("other", pool, { a: map.a, b: usage("b", 95, 10, 4) }).account.id, "a");
  // Strict priority keeps its order.
  const strict = new ProxyRouter({ strategy: "strict-priority", sessionCache: new ProxySessionCache() });
  assert.equal(strict.selectAccount("new", pool, map).account.id, "a");
  // `avoid` leaves an account out of a new pick while another can take it.
  assert.equal(router.selectAccount("sub", pool, { a: usage("a", 10, 10, 1), b: usage("b", 10, 10, 4) }, undefined, new Set(), "a").account.id, "b");
  assert.equal(router.selectAccount("solo", [account("a")], {}, undefined, new Set(), "a").account.id, "a", "alone, it is used all the same");
});

async function pool(ids: string[], overflow: boolean) {
  const seen: { token: string; agent?: string }[] = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({ token: String(req.headers.authorization).replace("Bearer ", ""), agent: req.headers["x-claude-code-agent-id"] as string | undefined });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2,"cache_read_input_tokens":1000,"cache_creation_input_tokens":0,"output_tokens":3}}}\n\n');
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const server = new ProxyServer({
    config: { port: 0, host: "127.0.0.1", enabled: true, routingStrategy: "strict-priority", subagentOverflow: overflow },
    credentialResolver: async (a) => `tok-${a.id}`,
    usageProvider: () => ({ accounts: ids.map(account), usageMap: {} }),
    upstreams: { anthropicUrl: `http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}` },
  });
  const { port } = await server.start();
  const send = (headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) =>
      http
        .request({ host: "127.0.0.1", port, method: "POST", path: "/v1/messages", headers: { "x-claude-code-session-id": "s-1", ...headers } }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        })
        .on("error", reject)
        .end(JSON.stringify({ model: "claude-opus-5-5" })),
    );
  return {
    server,
    seen,
    send,
    close: async () => {
      await server.stop();
      await new Promise<void>((resolve) => {
        upstream.closeAllConnections();
        upstream.close(() => resolve());
      });
    },
  };
}

test("with overflow on, a session's fresh subagents go to one other account and stay there; forks stay with the session", async () => {
  const on = await pool(["a", "b", "c"], true);
  try {
    await on.send({ "x-claude-code-request-class": "main" });
    const sub = { "x-claude-code-request-class": "subagent", "x-claude-code-agent-type": "Explore" };
    await on.send({ ...sub, "x-claude-code-agent-id": "agent1" });
    await on.send({ ...sub, "x-claude-code-agent-id": "agent2" });
    await on.send({ "x-claude-code-request-class": "subagent", "x-claude-code-agent-type": "fork", "x-claude-code-agent-id": "agent3" });
    await on.send({ "x-claude-code-request-class": "main" });
    assert.deepEqual(on.seen.map((s) => s.token), ["tok-a", "tok-b", "tok-b", "tok-a", "tok-a"]);
    // The subagents' answers do not touch the session's cache view.
    assert.equal(on.server.insights.sessionViews()[0].accountId, "a");
    assert.equal(on.server.insights.sessionViews()[0].subagents, 3, "the fork is a subagent too");
    // The feed prices each answer.
    const [last] = on.server.stats.recent();
    assert.ok(typeof last.cost === "number" && last.cost > 0);
  } finally {
    await on.close();
  }
  const off = await pool(["a", "b"], false);
  try {
    await off.send({ "x-claude-code-request-class": "main" });
    await off.send({ "x-claude-code-request-class": "subagent", "x-claude-code-agent-type": "Explore", "x-claude-code-agent-id": "agent1" });
    assert.deepEqual(off.seen.map((s) => s.token), ["tok-a", "tok-a"], "off: the session's account, as before");
  } finally {
    await off.close();
  }
});

test("the request log adds up today's answers by request class, the costliest first", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-class-share-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  const log = new GatewayRequestLog(path.join(dir, "gateway-requests.jsonl"), { now: () => now });
  log.load();
  log.record({ at: now, status: 200, requestClass: "main", tokens: { input: 2, cacheRead: 1000, output: 10 }, cost: 0.02 });
  log.record({ at: now, status: 200, requestClass: "subagent", tokens: { input: 5, cacheWrite: 30_000, output: 400 }, cost: 0.31 });
  log.record({ at: now, status: 200, requestClass: "subagent", tokens: { input: 5, cacheWrite: 20_000, output: 100 }, cost: 0.2 });
  log.record({ at: now, status: 429, requestClass: "main" });
  log.record({ at: now - 2 * 86_400_000, status: 200, requestClass: "main", tokens: { input: 1 }, cost: 9 });
  assert.deepEqual(log.todayByClass(), [
    { requestClass: "subagent", requests: 2, tokens: 50_510, cost: 0.51 },
    { requestClass: "main", requests: 1, tokens: 1012, cost: 0.02 },
  ]);
  // Read back after a restart.
  const again = new GatewayRequestLog(path.join(dir, "gateway-requests.jsonl"), { now: () => now });
  again.load();
  assert.deepEqual(again.todayByClass().map((s) => s.requestClass), ["subagent", "main"]);
});

test("background requests and a shortened conversation are not cache misses", () => {
  const clock = { now: Date.UTC(2026, 10, 13, 12) };
  const insights = new GatewayInsights(() => clock.now);
  const key = "hdr:1d3cf2c3-bbbb";
  const main = (tokens: { input?: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number }) =>
    insights.observeAnswer({ at: clock.now, sessionKey: key, accountId: "a", model: "claude-opus-5-5", requestClass: "main", tokens });
  main({ input: 2, cacheWrite: 150_000, cacheWrite1h: 150_000 });
  clock.now += MINUTE;
  // A title or classifier: the session's id, a short prompt of its own.
  assert.equal(
    insights.observeAnswer({ at: clock.now, sessionKey: key, accountId: "a", model: "claude-haiku-5-5", requestClass: "auxiliary", tokens: { input: 300, cacheWrite: 2_500 } }),
    undefined,
  );
  assert.equal(insights.sessionViews()[0].prefixTokens, 150_002, "the conversation's cache is unchanged");
  clock.now += MINUTE;
  assert.equal(main({ input: 2, cacheRead: 150_002, cacheWrite: 700, cacheWrite1h: 700 }), undefined);
  // Cleared or compacted without the hint: a much shorter prompt is written by design.
  clock.now += MINUTE;
  assert.equal(main({ input: 2, cacheRead: 14_000, cacheWrite: 9_000, cacheWrite1h: 9_000 }), undefined);
  assert.equal(insights.sessionViews()[0].misses, 0);
});
