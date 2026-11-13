import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { ProxyServer, clientOf } from "../electron/core/proxy/proxy-server";
import { classifyFailure, parseLiveLimits } from "../electron/core/proxy/upstream-common";
import { GatewayRequestLog, cleanEntry } from "../electron/core/proxy/proxy-request-log";
import { ProxyStats } from "../electron/core/proxy/proxy-stats";
import { attribute } from "../electron/core/token-attribution";
import { UsageManager } from "../electron/core/usage";
import { Store } from "../electron/core/store";
import type { Account } from "../shared/types";
import type { ProxyRequestLog } from "../shared/proxy-types";

/** The rate-limit headers of a real answer through the gateway (2026-11-13), request id shortened. */
const ALLOWED = {
  "anthropic-ratelimit-unified-5h-reset": "1794582600",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.0",
  "anthropic-ratelimit-unified-7d-reset": "1795060800",
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-7d-utilization": "0.28",
  "anthropic-ratelimit-unified-fallback-percentage": "0.5",
  "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
  "anthropic-ratelimit-unified-overage-status": "rejected",
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
  "anthropic-ratelimit-unified-reset": "1794582600",
  "anthropic-ratelimit-unified-status": "allowed",
};
const errorBody = (type: string, message: string) => JSON.stringify({ type: "error", error: { type, message } });

test("an answer's windows are read as percents with their resets", () => {
  assert.deepEqual(parseLiveLimits(ALLOWED), {
    fiveHour: { usedPercent: 0, resetsAt: new Date(1794582600 * 1000).toISOString() },
    sevenDay: { usedPercent: 28, resetsAt: new Date(1795060800 * 1000).toISOString() },
  });
  assert.equal(parseLiveLimits({ "content-type": "application/json" }), undefined);
  assert.equal(parseLiveLimits({ "anthropic-ratelimit-unified-5h-utilization": "lots" }), undefined);
  assert.deepEqual(parseLiveLimits({ "anthropic-ratelimit-unified-5h-utilization": "1.2" }), { fiveHour: { usedPercent: 100 } });
  assert.deepEqual(parseLiveLimits({ "anthropic-ratelimit-unified-7d-utilization": "0.973" }), { sevenDay: { usedPercent: 97.3 } });
});

test("a 429 is a limit only when a window says so; one that says none is spent is a refusal", () => {
  const json = { "content-type": "application/json" };
  assert.equal(classifyFailure(429, { ...json, ...ALLOWED }, errorBody("rate_limit_error", "Error")), "refused");
  // A spent window, or no rate-limit headers at all: a limit, as before.
  assert.equal(
    classifyFailure(429, { ...json, ...ALLOWED, "anthropic-ratelimit-unified-5h-status": "rejected" }, errorBody("rate_limit_error", "Error")),
    "limit",
  );
  assert.equal(classifyFailure(429, { ...json, ...ALLOWED, "anthropic-ratelimit-unified-status": "rejected" }, errorBody("rate_limit_error", "Error")), "limit");
  assert.equal(classifyFailure(429, json, errorBody("rate_limit_error", "Error")), "limit");
  // Without a message it may be a short limit: wait out its Retry-After, as before.
  assert.equal(classifyFailure(429, { ...json, ...ALLOWED }, "{}"), "limit");
  // A burst limit names itself: another account may take the request.
  assert.equal(
    classifyFailure(429, { ...json, ...ALLOWED }, errorBody("rate_limit_error", "Number of requests has exceeded your rate limit")),
    "limit",
  );
  assert.equal(classifyFailure(429, { ...json, ...ALLOWED }, errorBody("rate_limit_error", "Extra usage is required for long context requests.")), "extra-usage");
});

test("the client is told apart by its user agent", () => {
  assert.equal(clientOf({ "user-agent": "claude-cli/2.1.322 (external, cli)" }), "claude-code");
  assert.equal(clientOf({ "user-agent": "claude-cli/2.1.322 (external, sdk-cli)" }), "claude-code");
  assert.equal(clientOf({ "user-agent": "claude-cli/2.1.322 (external, sdk-ts, agent-sdk/0.2.1)" }), "agent-sdk");
  assert.equal(clientOf({ "user-agent": "codex_cli_rs/0.80.0 (Mac OS 26.5.0; arm64)" }), "codex");
  assert.equal(clientOf({ "user-agent": "curl/8.7.1" }), "curl");
  assert.equal(clientOf({}), undefined);
});

async function upstreamServer(reply: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const seen: http.IncomingMessage[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push(req);
      reply(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    seen,
    url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const ask = (port: number, options: http.RequestOptions, body = "{}") =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, ...options }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });

const account = (id: string): Account => ({
  id,
  name: id.toUpperCase(),
  kind: "personal",
  group: "default",
  color: "#000",
  createdAt: new Date().toISOString(),
});

test("each answer reports its windows and request id as its headers arrive, and the log keeps who asked, how long and the tokens", async () => {
  const upstream = await upstreamServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_011CgzTest", ...ALLOWED });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":900,"cache_creation_input_tokens":40,"output_tokens":1}}}\n\n');
    res.end('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n');
  });
  const live: unknown[] = [];
  const bound: [string, string][] = [];
  const recorded: ProxyRequestLog[] = [];
  const server = new ProxyServer({
    config: { port: 0, host: "127.0.0.1", enabled: true },
    credentialResolver: async () => "tok",
    usageProvider: () => ({ accounts: [account("a")], usageMap: {} }),
    upstreams: { anthropicUrl: upstream.url },
    onLiveLimits: (accountId, windows) => live.push({ accountId, windows }),
    requestLog: { recent: () => [], record: (entry) => recorded.push(entry), bind: (id, accountId) => bound.push([id, accountId]) },
  });
  const { port } = await server.start();
  try {
    const answer = await ask(port, {
      method: "POST",
      path: "/v1/messages",
      headers: { "user-agent": "claude-cli/2.1.322 (external, cli)", "x-claude-code-request-class": "subagent" },
    });
    assert.equal(answer.status, 200);
    assert.deepEqual(bound, [["req_011CgzTest", "a"]]);
    assert.deepEqual(live, [{ accountId: "a", windows: parseLiveLimits(ALLOWED) }]);
    assert.equal(recorded.length, 1);
    const entry = recorded[0];
    assert.equal(entry.accountId, "a");
    assert.equal(entry.requestId, "req_011CgzTest");
    assert.equal(entry.client, "claude-code");
    assert.equal(entry.requestClass, "subagent");
    assert.deepEqual(entry.tokens, { input: 3, output: 7, cacheRead: 900, cacheWrite: 40 });
    assert.equal(typeof entry.ms, "number");
    // Claude Code's start-up check needs no key, as with Anthropic.
    assert.equal((await ask(port, { method: "GET", path: "/api/hello" }, "")).status, 200);
  } finally {
    await server.stop();
    await upstream.close();
  }
});

test("a 429 that says no window is spent goes back to the client at once: no account is paused, none other is tried", async () => {
  const upstream = await upstreamServer((_req, res) => {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "40", ...ALLOWED });
    res.end(errorBody("rate_limit_error", "Error"));
  });
  const server = new ProxyServer({
    config: { port: 0, host: "127.0.0.1", enabled: true, routingStrategy: "strict-priority" },
    credentialResolver: async (a) => `tok-${a.id}`,
    usageProvider: () => ({ accounts: [account("a"), account("b")], usageMap: {} }),
    upstreams: { anthropicUrl: upstream.url },
  });
  const { port } = await server.start();
  try {
    const answer = await ask(port, { method: "POST", path: "/v1/messages", headers: { "user-agent": "curl/8.7.1" } });
    assert.equal(answer.status, 429);
    assert.match(answer.body, /none of the account's limits is spent/);
    assert.match(answer.body, /did not pause the account/);
    assert.equal(upstream.seen.length, 1, "the other account was not tried");
    assert.equal(server.router.cooldownOf("a"), undefined);
    const [entry] = server.stats.recent();
    assert.equal(entry.note, "refused");
    assert.equal(entry.error, "Error");
    assert.equal(entry.client, "curl");
    // The next request goes out as usual.
    await ask(port, { method: "POST", path: "/v1/messages" });
    assert.equal(upstream.seen.length, 2);
  } finally {
    await server.stop();
    await upstream.close();
  }
});

test("the request log keeps 35 days across restarts, answers which account served a request id, and reads back only what it wrote", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-gateway-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "gateway-requests.jsonl");
  const clock = { now: Date.UTC(2026, 10, 13, 12) };
  const day = 86_400_000;
  const old = { at: clock.now - 40 * day, status: 200, accountId: "a", requestId: "req_old" };
  fs.writeFileSync(file, JSON.stringify(old) + "\nnot json\n" + JSON.stringify({ at: "yesterday", status: 200 }) + "\n");
  const log = new GatewayRequestLog(file, { now: () => clock.now, feedSize: 2 });
  assert.deepEqual(log.load(), []);
  assert.equal(log.accountFor("req_old"), undefined, "older than 35 days");
  assert.equal(fs.readFileSync(file, "utf8"), "", "the file was rewritten without what it dropped");

  log.bind("req_early", "b");
  assert.equal(log.accountFor("req_early"), "b", "known from the headers, before the request is recorded");
  for (const [i, id] of ["req_1", "req_2", "req_3"].entries())
    log.record({ at: clock.now + i, status: 200, accountId: "a", requestId: id, model: "m".repeat(200), client: "claude-code" });
  assert.deepEqual(log.recent().map((e) => e.requestId), ["req_2", "req_3"]);
  assert.equal(log.recent()[0].model?.length, 80);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const again = new GatewayRequestLog(file, { now: () => clock.now + day, feedSize: 2 });
  assert.deepEqual(again.load().map((e) => e.requestId), ["req_2", "req_3"]);
  assert.equal(again.accountFor("req_1"), "a");

  assert.equal(cleanEntry({ at: 1, status: 200, prompt: "secret", tokens: { input: -4, output: 9 } })?.tokens?.output, 9);
  assert.equal("prompt" in (cleanEntry({ at: 1, status: 200, prompt: "secret" }) ?? {}), false);
  assert.equal(cleanEntry({ at: 1, status: 2000 }), undefined);

  // The gateway's feed starts from what the log kept.
  const stats = new ProxyStats(again);
  assert.deepEqual(stats.recent().map((e) => e.requestId), ["req_3", "req_2"]);
});

test("a response that came through the gateway is the serving account's, whatever its entry point", () => {
  const accounts = [account("a"), account("b")];
  const deps = {
    timeline: { accountAt: () => undefined },
    samples: [],
    accounts,
    gatewayAccount: (id: string) => ({ req_a: "a", req_gone: "removed" })[id],
  };
  assert.deepEqual(attribute({ time: 1, entrypoint: "cli", requestId: "req_a" }, deps), { kind: "account", accountId: "a", estimated: false });
  assert.deepEqual(attribute({ time: 1, entrypoint: "sdk-ts", requestId: "req_a" }, deps), { kind: "account", accountId: "a", estimated: false });
  // Not through the gateway, or an account since removed: as before.
  assert.deepEqual(attribute({ time: 1, entrypoint: "cli", requestId: "req_other" }, deps), { kind: "terminal" });
  assert.deepEqual(attribute({ time: 1, entrypoint: "cli", requestId: "req_gone" }, deps), { kind: "terminal" });
  // A Relay profile's own sign-in still decides first.
  assert.deepEqual(attribute({ time: 1, profileAccountId: "b", requestId: "req_a" }, deps), { kind: "account", accountId: "b", estimated: false });
});

test("an answer's windows make the account fresh for everything that reads limits, while reads keep their own pace", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-live-usage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(fs.realpathSync(root));
  const claude = store.create({ name: "Claude", kind: "personal" });
  const clock = { now: Date.UTC(2026, 10, 13, 12) };
  const accountUuid = "11111111-2222-4333-8444-555555555555";
  const orgId = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  store.update((state) => {
    state.accounts[0].auth = { loggedIn: true, accountUuid, orgId, email: "dev@example.com", checkedAt: new Date(clock.now).toISOString() };
    state.accounts[0].desktop = { accountUuid, orgId, savedAt: new Date(clock.now).toISOString() };
    state.settings.usageRefreshMinutes = 5;
  });
  const profile = { account: { uuid: accountUuid, email_address: "dev@example.com" }, organization: { uuid: orgId } };
  let reads = 0;
  const samples: unknown[] = [];
  const manager = new UsageManager(
    store,
    async () => ({ accessToken: "fixture-token", expiresAt: clock.now + 86_400_000, scopes: ["user:profile", "user:inference"] }),
    async (endpoint) => {
      if (endpoint === "profile") return profile;
      reads += 1;
      return {
        five_hour: { utilization: 10, resets_at: "2026-11-13T15:00:00Z" },
        seven_day: { utilization: 20, resets_at: "2026-11-18T08:00:00Z" },
        seven_day_opus: { utilization: 5, resets_at: "2026-11-18T08:00:00Z" },
      };
    },
    () => clock.now,
    (_account, usage) => samples.push(usage),
  );
  await manager.refresh(claude.id);
  assert.equal(reads, 1);
  const read = manager.snapshot()[claude.id];
  assert.equal(read.fiveHour?.usedPercent, 10);

  clock.now += 4 * 60_000;
  manager.observe(claude.id, parseLiveLimits(ALLOWED)!);
  const live = manager.snapshot()[claude.id];
  assert.equal(live.status, "ready");
  assert.equal(live.stale, false);
  assert.equal(live.fiveHour?.usedPercent, 0);
  assert.equal(live.sevenDay?.usedPercent, 28);
  assert.equal(live.liveAt, new Date(clock.now).toISOString());
  assert.equal(live.checkedAt, live.liveAt);
  assert.deepEqual(live.modelWindows, read.modelWindows, "what only a read knows stays");
  assert.equal(samples.length, 2, "the read, then the first live reading");

  // The same percents a minute later add no sample; a moved percent does, once a minute.
  clock.now += 61_000;
  manager.observe(claude.id, parseLiveLimits(ALLOWED)!);
  assert.equal(samples.length, 2);
  manager.observe(claude.id, { fiveHour: { usedPercent: 3 } });
  assert.equal(samples.length, 3);
  manager.observe(claude.id, { fiveHour: { usedPercent: 4 } });
  assert.equal(samples.length, 3, "not twice within a minute");

  // The read's own schedule: five minutes after the last read, not after the last answer.
  manager.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2, "polled although the live reading is a second old");

  // Codex and accounts without a sign-in are left alone.
  const codex = store.create({ name: "Codex", kind: "personal", provider: "codex" });
  manager.observe(codex.id, { fiveHour: { usedPercent: 50 } });
  assert.equal(manager.snapshot()[codex.id].fiveHour, undefined);
});

test("the feed says who asked, what kind of request, how long and how much was cached", async () => {
  const { requestDetail } = await import("../src/lib/proxy-ui");
  const tr = (a: string) => a;
  const en = (_a: string, b: string) => b;
  const entry = {
    client: "claude-code",
    requestClass: "subagent",
    ms: 1430,
    tokens: { input: 3, cacheRead: 9_000, cacheWrite: 997, output: 412 },
  };
  assert.equal(requestDetail(entry, tr, "tr-TR"), "Claude Code · alt ajan · 1,4 sn · 10K girdi, %90 önbellekten · 412 çıktı");
  assert.equal(requestDetail(entry, en, "en-US"), "Claude Code · subagent · 1.4 s · 10K in, 90% cached · 412 out");
  assert.equal(requestDetail({ client: "curl", ms: 220, note: "refused" }, en, "en-US"), "curl · 220 ms · not a limit: Anthropic turned the request down");
  assert.equal(requestDetail({}, en, "en-US"), "");
});

test("the Overview says which tools go through the gateway and where the last request went", async () => {
  const { gatewayLine } = await import("../src/lib/proxy-ui");
  const en = (_a: string, b: string) => b;
  const now = Date.UTC(2026, 10, 13, 12);
  const accounts = [{ id: "a", name: "Alto" }];
  const recent = [{ at: now - 120_000, accountId: "a" }];
  const claude = { id: "claude-code", bound: true };
  assert.deepEqual(gatewayLine({ running: true, clients: [claude], recent, accounts }, en, now), {
    tone: "ok",
    text: "Claude Code goes through the gateway, not the Claude app's account · last request Alto, 2 min ago",
  });
  assert.deepEqual(gatewayLine({ running: false, clients: [claude, { id: "codex", bound: true }], accounts }, en, now), {
    tone: "crit",
    text: "Claude Code and Codex CLI are bound to the gateway, but it is off: requests fail.",
  });
  assert.equal(gatewayLine({ running: false, clients: [{ id: "codex", bound: false }], accounts }, en, now), undefined);
  assert.equal(gatewayLine({ running: true, clients: [], accounts }, en, now), undefined);
  assert.equal(gatewayLine(undefined, en, now), undefined);
});
