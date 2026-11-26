import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { GatewayRequestLog } from "../electron/core/gateway-request-log";
import { overflowHeaders, testOverflowUpstream } from "../electron/core/overflow-test";
import { OverflowKeys } from "../electron/core/overflow-keys";
import { overflowUrlAllowed, proxyExtrasSchema } from "../shared/proxy-status";
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

const KEY = "sk-test-overflow-key-0000-alto";

interface Seen {
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A local stand-in for an upstream: records each request and answers with `reply`. */
async function fake(
  reply: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    seen: Seen,
  ) => void,
) {
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

const json = (
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: http.OutgoingHttpHeaders = {},
) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const message = (
  model: string,
  usage = { input_tokens: 1_000, output_tokens: 200 },
) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model,
  content: [{ type: "text", text: "Hi" }],
  usage,
});

function upstream(
  preset: ApiUpstreamPreset,
  baseUrl: string,
  extra: Partial<ApiUpstream> = {},
): ApiUpstream {
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

const settings = (...upstreams: ApiUpstream[]): OverflowSettings => ({
  enabled: true,
  dailyCapUsd: 5,
  upstreams: upstreams.map((u, order) => ({ ...u, order })),
});

test("each preset sends its key as it should and Anthropic keeps all betas but OAuth's", () => {
  const source = {
    "anthropic-beta": "oauth-2025-04-20, context-1m-2025-08-07",
    "content-type": "application/json",
  };
  const anthropic = overflowHeaders(
    source,
    { preset: "anthropic", authStyle: "x-api-key" },
    KEY,
  );
  assert.equal(anthropic["x-api-key"], KEY);
  assert.equal(anthropic["anthropic-beta"], "context-1m-2025-08-07");
  assert.equal(anthropic["anthropic-version"], "2023-06-01");
  for (const preset of [
    "openrouter",
    "kimi",
    "kimi-cn",
    "glm",
    "glm-cn",
  ] as const) {
    const headers = overflowHeaders(
      source,
      { preset, authStyle: OVERFLOW_PRESETS[preset].authStyle },
      KEY,
    );
    assert.equal(headers.authorization, `Bearer ${KEY}`, preset);
    assert.equal(headers["x-api-key"], undefined, preset);
    assert.equal(headers["anthropic-beta"], undefined, preset);
  }
  assert.equal(
    overflowModel(
      upstream("openrouter", "https://example.com"),
      "claude-opus-5-5",
    ),
    "anthropic/claude-opus-5.5",
  );
  assert.equal(
    overflowModel(upstream("kimi", "https://example.com"), "claude-haiku-5-5"),
    "kimi-k3",
  );
  assert.equal(
    overflowModel(upstream("glm", "https://example.com"), "claude-sonnet-5-5"),
    "glm-5.4",
  );
  assert.equal(
    overflowModel(
      upstream("anthropic", "https://example.com"),
      "claude-opus-5-5[1m]",
    ),
    "claude-opus-5-5",
  );
  assert.ok(
    !JSON.stringify(OVERFLOW_PRESETS).includes("k2"),
    "no preset targets Kimi K2",
  );
});

test("costs: Anthropic list prices, preset tables with DeepSeek's peak, user prices, else unknown", () => {
  const tokens = { input: 1_000_000, output: 1_000_000 };
  const offPeak = Date.parse("2026-11-21T12:00:00Z");
  const peak = Date.parse("2026-11-23T02:00:00Z");
  assert.equal(deepseekPeak(offPeak), false);
  assert.equal(deepseekPeak(peak), true);
  assert.equal(
    overflowCost({ preset: "anthropic" }, "claude-sonnet-5-5", tokens, offPeak),
    responseCost("claude-sonnet-5-5", {
      ...tokens,
      cacheRead: 0,
      cacheWrite: 0,
    }),
  );
  assert.equal(
    overflowCost({ preset: "deepseek" }, "deepseek-v4-pro", tokens, offPeak),
    0.66 + 1.98,
  );
  assert.equal(
    overflowCost({ preset: "deepseek" }, "deepseek-v4-pro", tokens, peak),
    (0.66 + 1.98) * 2,
  );
  assert.equal(
    overflowCost({ preset: "glm" }, "glm-5.3-flash", tokens, offPeak),
    0.15 + 0.5,
  );
  assert.equal(
    overflowCost({ preset: "kimi" }, "kimi-k3", tokens, offPeak),
    undefined,
    "Kimi has no table",
  );
  assert.equal(
    overflowCost(
      { preset: "kimi", prices: { input: 1, output: 4 } },
      "kimi-k3",
      tokens,
      offPeak,
    ),
    5,
  );
  assert.equal(
    overflowCost(
      { preset: "openrouter" },
      "anthropic/claude-opus-5.5",
      { input: 1_000_000, cacheRead: 1_000_000 },
      offPeak,
      {
        input: 5,
        output: 25,
        cacheRead: 0.5,
      },
    ),
    5.5,
  );
});

test("the cap's spend survives a restart through the request log, by planning day", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-overflow-"));
  try {
    const now = Date.parse("2026-11-23T10:00:00Z");
    const file = path.join(dir, "gateway-requests.jsonl");
    const first = new GatewayRequestLog(file, { now: () => now });
    first.load();
    first.record({
      at: now - 3_600_000,
      status: 200,
      upstream: "Alto",
      cost: 0.75,
      tokens: { input: 1 },
    });
    first.record({
      at: now - 30 * 3_600_000,
      status: 200,
      upstream: "Alto",
      cost: 2,
    });
    first.record({
      at: now - 60_000,
      status: 200,
      accountId: "a",
      cost: 9,
      tokens: { input: 1 },
    });
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

test("keys are sealed in the vault and the page only gets a masked hint", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-overflow-vault-"));
  try {
    const sealer = createSealer(Buffer.alloc(32, 7));
    const keys = new OverflowKeys(
      dir,
      (text) => sealer.seal(text),
      (data) => sealer.unseal(data),
    );
    assert.deepEqual(keys.hints(), {}, "nothing before the keys were read");
    await keys.set("one", KEY);
    const raw = fs.readFileSync(path.join(dir, "api-keys", "overflow.bin"));
    assert.ok(
      !raw.toString("latin1").includes(KEY),
      "the file holds no key in the clear",
    );
    const fresh = new OverflowKeys(
      dir,
      (text) => sealer.seal(text),
      (data) => sealer.unseal(data),
    );
    assert.equal(await fresh.get("one"), KEY);
    assert.deepEqual(fresh.hints(), { one: "sk-…alto" });
    assert.ok(!JSON.stringify(fresh.hints()).includes("overflow-key"));
    await fresh.remove("one");
    assert.equal(
      fs.existsSync(path.join(dir, "api-keys", "overflow.bin")),
      false,
    );
    assert.equal(keyHint("short"), "…");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the Test button's request: one token, the right model, the upstream's own error", async () => {
  const api = await fake((req, res) =>
    req.headers["x-api-key"] === KEY
      ? json(res, 200, message("claude-haiku-5-5"))
      : json(res, 401, {
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        }),
  );
  try {
    const ok = await testOverflowUpstream(upstream("anthropic", api.url), KEY);
    assert.deepEqual(ok, { ok: true, model: "claude-haiku-5-5", status: 200 });
    const body = JSON.parse(api.seen[0].body);
    assert.equal(body.max_tokens, 1);
    const refused = await testOverflowUpstream(
      upstream("anthropic", api.url),
      "sk-wrong-key-000",
    );
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 401);
    assert.equal(refused.message, "invalid x-api-key");
    assert.ok(!JSON.stringify(refused).includes("sk-wrong"));
  } finally {
    await api.close();
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
    overflow: {
      enabled: true,
      upstreams: [{ id: "x", baseUrl: "ftp://nope" }],
    },
  });
  assert.deepEqual(extras.accountOrder, ["b", "a"]);
  assert.equal(extras.overflow, undefined);
  const kept = proxyExtrasSchema.parse({
    overflow: settings(
      upstream("deepseek", "https://api.deepseek.com/anthropic"),
    ),
  });
  assert.equal(kept.overflow?.upstreams[0].preset, "deepseek");
});
