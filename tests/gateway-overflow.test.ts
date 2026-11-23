import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { ProxyServer } from "../electron/core/proxy/proxy-server";
import { GatewayRequestLog } from "../electron/core/proxy/proxy-request-log";
import {
  OpenRouterPrices,
  overflowHeaders,
  parseOpenRouterModels,
  testOverflowUpstream,
} from "../electron/core/proxy/overflow-upstream";
import { OverflowKeys } from "../electron/core/overflow-keys";
import { overflowUrlAllowed, proxyExtrasSchema } from "../electron/core/proxy/proxy-status";
import { createSealer } from "../electron/core/vault-crypto";
import {
  OVERFLOW_PRESETS,
  deepseekPeak,
  keyHint,
  localDayBounds,
  overflowCost,
  overflowModel,
  spentToday,
  type ApiUpstream,
  type ApiUpstreamPreset,
  type OverflowSettings,
} from "../shared/overflow";
import { responseCost } from "../shared/model-prices";
import type { Account, AccountUsage } from "../shared/types";

const KEY = "sk-test-overflow-key-0000-alto";
const account = (id: string): Account => ({
  id,
  name: `Vertex ${id}`,
  kind: "personal",
  group: "default",
  color: "#00ff00",
  createdAt: new Date().toISOString(),
});
const full = (id: string, now: number): AccountUsage => ({
  accountId: id,
  status: "ready",
  stale: false,
  fiveHour: { usedPercent: 100, resetsAt: new Date(now + 2 * 3_600_000).toISOString() },
  sevenDay: { usedPercent: 40 },
});

interface Seen {
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A local stand-in for an upstream: records each request and answers with `reply`. */
async function fake(reply: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const entry = { url: req.url, headers: req.headers, body };
      seen.push(entry);
      reply(req, res, entry);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    seen,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

const json = (res: http.ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const message = (model: string, usage = { input_tokens: 1_000, output_tokens: 200 }) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model,
  content: [{ type: "text", text: "Hi" }],
  usage,
});

function upstream(preset: ApiUpstreamPreset, baseUrl: string, extra: Partial<ApiUpstream> = {}): ApiUpstream {
  return {
    id: `up-${preset}`,
    label: `Alto ${preset}`,
    preset,
    baseUrl,
    authStyle: OVERFLOW_PRESETS[preset].authStyle,
    modelMap: { ...OVERFLOW_PRESETS[preset].modelMap },
    enabled: true,
    order: 0,
    ...extra,
  };
}

/** A gateway with one Claude account (limited or not), the subscription upstream and the overflow given. */
async function gateway(options: {
  limited: boolean;
  overflow?: OverflowSettings;
  subscription?: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  requestLog?: GatewayRequestLog;
  now?: () => number;
  accounts?: Account[];
}) {
  const subscription = await fake(
    options.subscription ?? ((_req, res) => json(res, 200, message("claude-sonnet-5-5"))),
  );
  const accounts = options.accounts ?? [account("a")];
  const server = new ProxyServer({
    config: { port: 0, host: "127.0.0.1", enabled: true, ...(options.overflow ? { overflow: options.overflow } : {}) },
    credentialResolver: async () => "tok-subscription",
    usageProvider: () => ({ accounts, usageMap: options.limited ? { a: full("a", (options.now ?? Date.now)()) } : {} }),
    overflowKey: async () => KEY,
    timeZone: () => "UTC",
    upstreams: { anthropicUrl: subscription.url },
    ...(options.requestLog ? { requestLog: options.requestLog } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const state = await server.start();
  return {
    server,
    subscription,
    port: state.port,
    close: async () => {
      await server.stop();
      await subscription.close();
    },
  };
}

function post(
  port: number,
  body: unknown,
  headers: http.OutgoingHttpHeaders = {},
  pathname = "/v1/messages",
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: pathname,
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...headers },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

/** The client has the whole answer before the gateway logs and prices it: wait until it is done. */
async function idle(server: ProxyServer): Promise<void> {
  for (let i = 0; i < 10_000 && (server.getMetrics().activeRequests ?? 0) > 0; i++)
    await new Promise((resolve) => setImmediate(resolve));
}

const settings = (...upstreams: ApiUpstream[]): OverflowSettings => ({
  enabled: true,
  dailyCapUsd: 5,
  upstreams: upstreams.map((u, order) => ({ ...u, order })),
});

test("overflow takes a request only when every subscription account is limited", async () => {
  const api = await fake((_req, res) => json(res, 200, message("claude-sonnet-5-5")));
  const overflow = settings(upstream("anthropic", api.url));
  const free = await gateway({ limited: false, overflow });
  try {
    const answer = await post(free.port, { model: "claude-sonnet-5-5", max_tokens: 10, messages: [] });
    assert.equal(answer.status, 200);
    assert.equal(free.subscription.seen.length, 1, "a free account answers");
    assert.equal(api.seen.length, 0, "overflow is not used while an account has room");
  } finally {
    await free.close();
  }
  const limited = await gateway({ limited: true, overflow });
  try {
    const answer = await post(limited.port, { model: "claude-sonnet-5-5", max_tokens: 10, messages: [] });
    assert.equal(answer.status, 200);
    assert.equal(limited.subscription.seen.length, 0, "a full account is not tried");
    assert.equal(api.seen.length, 1, "the API key answers");
    await idle(limited.server);
    const entry = limited.server.stats.recent()[0];
    assert.equal(entry.upstream, "Alto anthropic");
    assert.equal(entry.pick?.reason, "overflow");
    assert.equal(entry.accountId, undefined);
  } finally {
    await limited.close();
    await api.close();
  }
});

test("with overflow off or disabled upstreams, an all-limited pool still answers 429", async () => {
  const api = await fake((_req, res) => json(res, 200, message("x")));
  for (const overflow of [
    { ...settings(upstream("anthropic", api.url)), enabled: false },
    settings(upstream("anthropic", api.url, { enabled: false })),
  ]) {
    const pool = await gateway({ limited: true, overflow });
    try {
      const answer = await post(pool.port, { model: "claude-sonnet-5-5", messages: [] });
      assert.equal(answer.status, 429);
      assert.equal(JSON.parse(answer.body).error.type, "rate_limit_error");
    } finally {
      await pool.close();
    }
  }
  assert.equal(api.seen.length, 0);
  await api.close();
});

test("a limit met live on the only account overflows, and the account cools down", async () => {
  const api = await fake((_req, res) => json(res, 200, message("claude-opus-5-5")));
  const pool = await gateway({
    limited: false,
    overflow: settings(upstream("anthropic", api.url)),
    subscription: (_req, res) =>
      json(res, 429, { type: "error", error: { type: "rate_limit_error", message: "limit" } }, {
        "retry-after": "600",
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-5h-status": "rejected",
      }),
  });
  try {
    const answer = await post(pool.port, { model: "claude-opus-5-5", messages: [] });
    assert.equal(answer.status, 200, answer.body);
    assert.equal(pool.subscription.seen.length, 1);
    assert.equal(api.seen.length, 1);
    assert.equal(pool.server.router.cooldownOf("a")?.reason, "limit");
    await idle(pool.server);
    const [served, held] = pool.server.stats.recent();
    assert.equal(served.pick?.after, "a", "the log says which account was held first");
    assert.equal(held.accountId, "a");
  } finally {
    await pool.close();
    await api.close();
  }
});

test("the model is rewritten by family and the key goes in the preset's header", async () => {
  const api = await fake((_req, res) => json(res, 200, message("x")));
  const pool = await gateway({
    limited: true,
    overflow: settings(upstream("deepseek", `${api.url}/anthropic`)),
  });
  try {
    for (const [asked, sent] of [
      ["claude-opus-5-5", "deepseek-v4-pro"],
      ["claude-sonnet-5-5[1m]", "deepseek-flash"],
      ["claude-haiku-5-5-20260101", "deepseek-flash"],
      ["claude-fable-5-2", "deepseek-flash"],
    ]) {
      await post(
        pool.port,
        { model: asked, max_tokens: 5, messages: [{ role: "user", content: "x" }] },
        {
          authorization: "Bearer relay-client",
          "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
          "x-claude-code-session-id": "s-1",
        },
      );
      const last = api.seen.at(-1)!;
      assert.equal(last.url, "/anthropic/v1/messages");
      const body = JSON.parse(last.body);
      assert.equal(body.model, sent, asked);
      assert.equal(body.max_tokens, 5, "the rest of the body is kept");
      assert.equal(last.headers["x-api-key"], KEY);
      assert.equal(last.headers.authorization, undefined, "the client's key never goes upstream");
      assert.equal(last.headers["anthropic-beta"], undefined, "third parties get no betas");
      assert.equal(last.headers["x-claude-code-session-id"], undefined);
    }
  } finally {
    await pool.close();
    await api.close();
  }
});

test("each preset sends its key as it should and Anthropic keeps all betas but OAuth's", () => {
  const source = { "anthropic-beta": "oauth-2025-04-20, context-1m-2025-08-07", "content-type": "application/json" };
  const anthropic = overflowHeaders(source, { preset: "anthropic", authStyle: "x-api-key" }, KEY);
  assert.equal(anthropic["x-api-key"], KEY);
  assert.equal(anthropic["anthropic-beta"], "context-1m-2025-08-07");
  assert.equal(anthropic["anthropic-version"], "2023-06-01");
  for (const preset of ["openrouter", "kimi", "kimi-cn", "glm", "glm-cn"] as const) {
    const headers = overflowHeaders(source, { preset, authStyle: OVERFLOW_PRESETS[preset].authStyle }, KEY);
    assert.equal(headers.authorization, `Bearer ${KEY}`, preset);
    assert.equal(headers["x-api-key"], undefined, preset);
    assert.equal(headers["anthropic-beta"], undefined, preset);
  }
  assert.equal(overflowModel(upstream("openrouter", "https://example.com"), "claude-opus-5-5"), "anthropic/claude-opus-5.5");
  assert.equal(overflowModel(upstream("kimi", "https://example.com"), "claude-haiku-5-5"), "kimi-k3");
  assert.equal(overflowModel(upstream("glm", "https://example.com"), "claude-sonnet-5-5"), "glm-5.4");
  assert.equal(overflowModel(upstream("anthropic", "https://example.com"), "claude-opus-5-5[1m]"), "claude-opus-5-5");
  assert.ok(!JSON.stringify(OVERFLOW_PRESETS).includes("k2"), "no preset targets Kimi K2");
});

test("an SSE answer streams through unchanged and is priced from its final usage", async () => {
  const events = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { ...message("deepseek-flash"), usage: { input_tokens: 2_000_000, output_tokens: 1 } } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 2_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ];
  const api = await fake((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events) res.write(event);
    res.end();
  });
  // A Saturday: DeepSeek's off-peak price all day.
  const at = Date.parse("2026-11-21T12:00:00Z");
  const pool = await gateway({
    limited: true,
    now: () => at,
    overflow: settings(upstream("deepseek", `${api.url}/anthropic`)),
  });
  try {
    const answer = await post(pool.port, { model: "claude-sonnet-5-5", stream: true, messages: [] });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers["content-type"], "text/event-stream");
    assert.equal(answer.body, events.join(""), "the stream reaches the client byte for byte");
    await idle(pool.server);
    const entry = pool.server.stats.recent()[0];
    assert.equal(entry.model, "deepseek-flash");
    assert.deepEqual(entry.tokens, { input: 2_000_000, output: 1_000_000, cacheRead: 0 });
    // 2M input at $0.15 and 1M output at $0.60.
    assert.equal(entry.cost, 0.9);
    assert.equal(pool.server.overflowSpentToday(), 0.9);
  } finally {
    await pool.close();
    await api.close();
  }
});

test("costs: Anthropic list prices, preset tables with DeepSeek's peak, user prices, else unknown", () => {
  const tokens = { input: 1_000_000, output: 1_000_000 };
  const offPeak = Date.parse("2026-11-21T12:00:00Z");
  const peak = Date.parse("2026-11-23T02:00:00Z");
  assert.equal(deepseekPeak(offPeak), false);
  assert.equal(deepseekPeak(peak), true);
  assert.equal(
    overflowCost({ preset: "anthropic" }, "claude-sonnet-5-5", tokens, offPeak),
    responseCost("claude-sonnet-5-5", { ...tokens, cacheRead: 0, cacheWrite: 0 }),
  );
  assert.equal(overflowCost({ preset: "deepseek" }, "deepseek-v4-pro", tokens, offPeak), 0.66 + 1.98);
  assert.equal(overflowCost({ preset: "deepseek" }, "deepseek-v4-pro", tokens, peak), (0.66 + 1.98) * 2);
  assert.equal(overflowCost({ preset: "glm" }, "glm-5.3-flash", tokens, offPeak), 0.15 + 0.5);
  assert.equal(overflowCost({ preset: "kimi" }, "kimi-k3", tokens, offPeak), undefined, "Kimi has no table");
  assert.equal(overflowCost({ preset: "kimi", prices: { input: 1, output: 4 } }, "kimi-k3", tokens, offPeak), 5);
  assert.equal(
    overflowCost({ preset: "openrouter" }, "anthropic/claude-opus-5.5", { input: 1_000_000, cacheRead: 1_000_000 }, offPeak, {
      input: 5,
      output: 25,
      cacheRead: 0.5,
    }),
    5.5,
  );
});

test("an answer with no known price is logged as unpriced and does not count toward the cap", async () => {
  const api = await fake((_req, res) => json(res, 200, message("kimi-k3.1-pro")));
  const pool = await gateway({ limited: true, overflow: settings(upstream("kimi", api.url)) });
  try {
    await post(pool.port, { model: "claude-sonnet-5-5", messages: [] });
    await idle(pool.server);
    const entry = pool.server.stats.recent()[0];
    assert.equal(entry.note, "unpriced");
    assert.equal(entry.cost, undefined);
    assert.equal(api.seen[0].headers.authorization, `Bearer ${KEY}`);
    assert.equal(pool.server.overflowSpentToday(), 0);
  } finally {
    await pool.close();
    await api.close();
  }
});

test("past the daily cap overflow answers 429 with Anthropic's error shape until the day ends", async () => {
  const api = await fake((_req, res) =>
    json(res, 200, message("claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 0 })),
  );
  const at = Date.parse("2026-11-23T20:00:00Z");
  const pool = await gateway({
    limited: true,
    now: () => at,
    overflow: { ...settings(upstream("anthropic", api.url)), dailyCapUsd: 1 },
  });
  try {
    const first = await post(pool.port, { model: "claude-opus-5-5", messages: [] });
    assert.equal(first.status, 200);
    await idle(pool.server);
    assert.ok(pool.server.overflowSpentToday() >= 1, "one request spent the cap");
    const second = await post(pool.port, { model: "claude-opus-5-5", messages: [] });
    assert.equal(second.status, 429);
    assert.deepEqual(JSON.parse(second.body), {
      type: "error",
      error: { type: "rate_limit_error", message: "Relay overflow daily cap of $1 reached" },
    });
    assert.equal(second.headers["retry-after"], String(4 * 3600), "until midnight in the planning zone (UTC)");
    assert.equal(api.seen.length, 1, "nothing more is sent past the cap");
    await idle(pool.server);
    assert.equal(pool.server.stats.recent()[0].note, "overflow-cap");
  } finally {
    await pool.close();
    await api.close();
  }
});

test("the cap's spend survives a restart through the request log, by planning day", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-overflow-"));
  try {
    const now = Date.parse("2026-11-23T10:00:00Z");
    const file = path.join(dir, "gateway-requests.jsonl");
    const first = new GatewayRequestLog(file, { now: () => now });
    first.load();
    first.record({ at: now - 3_600_000, status: 200, upstream: "Alto", cost: 0.75, tokens: { input: 1 } });
    first.record({ at: now - 30 * 3_600_000, status: 200, upstream: "Alto", cost: 2 });
    first.record({ at: now - 60_000, status: 200, accountId: "a", cost: 9, tokens: { input: 1 } });
    const again = new GatewayRequestLog(file, { now: () => now });
    again.load();
    assert.equal(spentToday(again.overflowCosts(), now, "UTC"), 0.75);
    // In Tokyo (UTC+9) 10:00 UTC is 19:00 and yesterday 04:00 UTC was 13:00 the day before.
    assert.equal(spentToday(again.overflowCosts(), now, "Asia/Tokyo"), 0.75);
    // In Honolulu (UTC-10) it is 00:00 now: an hour ago was yesterday.
    assert.equal(spentToday(again.overflowCosts(), now, "Pacific/Honolulu"), 0);
    const bounds = localDayBounds(now, "Europe/Istanbul");
    assert.equal(bounds.start, Date.parse("2026-11-22T21:00:00Z"));
    assert.equal(bounds.end, Date.parse("2026-11-23T21:00:00Z"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a refused key hands the request to the next upstream; the account is never touched", async () => {
  const refusing = await fake((_req, res) =>
    json(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }),
  );
  const working = await fake((_req, res) => json(res, 200, message("x")));
  const pool = await gateway({
    limited: true,
    overflow: settings(upstream("anthropic", refusing.url, { id: "one" }), upstream("glm", working.url, { id: "two" })),
  });
  try {
    const answer = await post(pool.port, { model: "claude-haiku-5-5", messages: [] });
    assert.equal(answer.status, 200);
    assert.equal(refusing.seen.length, 1);
    assert.equal(JSON.parse(working.seen[0].body).model, "glm-5.3-flash");
    await idle(pool.server);
    const [served, held] = pool.server.stats.recent();
    assert.equal(held.failover, true);
    assert.equal(held.error, "invalid x-api-key");
    assert.equal(served.upstream, "Alto glm");
    assert.equal(pool.server.router.cooldownOf("a")?.reason, undefined, "an upstream's answer says nothing about the account");
  } finally {
    await pool.close();
    await refusing.close();
    await working.close();
  }
});

test("'unavailable' also overflows a pool with no Claude account; 'limited' does not", async () => {
  const api = await fake((_req, res) => json(res, 200, message("x")));
  for (const trigger of ["limited", "unavailable"] as const) {
    const pool = await gateway({ limited: false, accounts: [], overflow: { ...settings(upstream("anthropic", api.url)), trigger } });
    try {
      const answer = await post(pool.port, { model: "claude-sonnet-5-5", messages: [] });
      assert.equal(answer.status, trigger === "unavailable" ? 200 : 503, trigger);
    } finally {
      await pool.close();
    }
  }
  assert.equal(api.seen.length, 1);
  await api.close();
});

test("Codex routes never overflow, and token counting is not a gateway path", async () => {
  const api = await fake((_req, res) => json(res, 200, message("x")));
  const pool = await gateway({ limited: true, overflow: { ...settings(upstream("anthropic", api.url)), trigger: "unavailable" } });
  try {
    const responses = await post(pool.port, { model: "gpt-5-codex", input: "x" }, {}, "/v1/responses");
    assert.equal(responses.status, 503);
    const count = await post(pool.port, { model: "claude-sonnet-5-5", messages: [] }, {}, "/v1/messages/count_tokens");
    assert.equal(count.status, 404);
    assert.equal(api.seen.length, 0);
  } finally {
    await pool.close();
    await api.close();
  }
});

test("the key is never in the gateway's feed, metrics or log file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-overflow-"));
  const api = await fake((_req, res) => json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "bad model" } }));
  const requestLog = new GatewayRequestLog(path.join(dir, "gateway-requests.jsonl"));
  requestLog.load();
  const pool = await gateway({ limited: true, overflow: settings(upstream("anthropic", api.url)), requestLog });
  try {
    await post(pool.port, { model: "claude-sonnet-5-5", messages: [] });
    const seen = JSON.stringify([pool.server.stats.recent(), pool.server.getMetrics()]);
    assert.ok(!seen.includes(KEY));
    assert.ok(!fs.readFileSync(path.join(dir, "gateway-requests.jsonl"), "utf8").includes(KEY));
  } finally {
    await pool.close();
    await api.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("keys are sealed in the vault and the page only gets a masked hint", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-overflow-vault-"));
  try {
    const sealer = createSealer(Buffer.alloc(32, 7));
    const keys = new OverflowKeys(dir, (text) => sealer.seal(text), (data) => sealer.unseal(data));
    assert.deepEqual(keys.hints(), {}, "nothing before the keys were read");
    await keys.set("one", KEY);
    const raw = fs.readFileSync(path.join(dir, "api-keys", "overflow.bin"));
    assert.ok(!raw.toString("latin1").includes(KEY), "the file holds no key in the clear");
    const fresh = new OverflowKeys(dir, (text) => sealer.seal(text), (data) => sealer.unseal(data));
    assert.equal(await fresh.get("one"), KEY);
    assert.deepEqual(fresh.hints(), { one: "sk-…alto" });
    assert.ok(!JSON.stringify(fresh.hints()).includes("overflow-key"));
    await fresh.remove("one");
    assert.equal(fs.existsSync(path.join(dir, "api-keys", "overflow.bin")), false);
    assert.equal(keyHint("short"), "…");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the Test button's request: one token, the right model, the upstream's own error", async () => {
  const api = await fake((req, res) =>
    req.headers["x-api-key"] === KEY
      ? json(res, 200, message("claude-haiku-5-5"))
      : json(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }),
  );
  try {
    const ok = await testOverflowUpstream(upstream("anthropic", api.url), KEY);
    assert.deepEqual(ok, { ok: true, model: "claude-haiku-5-5", status: 200 });
    const body = JSON.parse(api.seen[0].body);
    assert.equal(body.max_tokens, 1);
    const refused = await testOverflowUpstream(upstream("anthropic", api.url), "sk-wrong-key-000");
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 401);
    assert.equal(refused.message, "invalid x-api-key");
    assert.ok(!JSON.stringify(refused).includes("sk-wrong"));
  } finally {
    await api.close();
  }
});

test("OpenRouter prices are read at most once a day and kept on disk", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-openrouter-"));
  let calls = 0;
  let now = Date.parse("2026-11-23T10:00:00Z");
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ data: [{ id: "anthropic/claude-opus-5.5", pricing: { prompt: "0.000005", completion: "0.000025", input_cache_read: "0.0000005" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const file = path.join(dir, "openrouter-prices.json");
    const prices = new OpenRouterPrices({ file, fetch: fetchImpl, now: () => now });
    const rate = await prices.rate("anthropic/claude-opus-5.5");
    assert.ok(rate && Math.abs(rate.input - 5) < 1e-9 && Math.abs(rate.output - 25) < 1e-9);
    await prices.rate("anthropic/claude-opus-5.5");
    assert.equal(calls, 1);
    const reopened = new OpenRouterPrices({ file, fetch: fetchImpl, now: () => now });
    assert.ok(await reopened.rate("anthropic/claude-opus-5.5"));
    assert.equal(calls, 1, "the kept prices are used");
    now += 25 * 3_600_000;
    await reopened.rate("anthropic/claude-opus-5.5");
    assert.equal(calls, 2, "a day later they are read again");
    assert.equal(parseOpenRouterModels({ data: [{ id: "x", pricing: { prompt: "-1", completion: "0" } }] }).size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saved overflow upstreams: https only (http on this computer), and a bad one never costs the pool order", () => {
  assert.equal(overflowUrlAllowed("https://api.example.com/anthropic"), true);
  assert.equal(overflowUrlAllowed("http://127.0.0.1:4000"), true);
  assert.equal(overflowUrlAllowed("http://example.com"), false);
  assert.equal(overflowUrlAllowed("https://user:pw@example.com"), false);
  assert.equal(overflowUrlAllowed("https://example.com/?key=1"), false);
  const extras = proxyExtrasSchema.parse({
    accountOrder: ["b", "a"],
    overflow: { enabled: true, upstreams: [{ id: "x", baseUrl: "ftp://nope" }] },
  });
  assert.deepEqual(extras.accountOrder, ["b", "a"]);
  assert.equal(extras.overflow, undefined);
  const kept = proxyExtrasSchema.parse({ overflow: settings(upstream("deepseek", "https://api.deepseek.com/anthropic")) });
  assert.equal(kept.overflow?.upstreams[0].preset, "deepseek");
});
