import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type net from "node:net";
import {
  UPSTREAM_AGENT_OPTIONS,
  classifyFailure,
  forwardUpstream,
  parseLimitReset,
  type ForwardSpec,
} from "../electron/core/proxy/upstream-common";
import { createAnthropicUsageExtractor } from "../electron/core/proxy/anthropic-upstream";
import { ProxyRouter, fullUntil } from "../electron/core/proxy/proxy-router";
import { ProxySessionCache } from "../electron/core/proxy/proxy-session-cache";
import type { Account, AccountUsage } from "../shared/types";

const now = Date.UTC(2026, 10, 13, 12);
const at = (hours: number) => String(Math.floor(now / 1000) + hours * 3600);

test("a limit's reset comes from the window that refused, not from the drifting overall header", () => {
  // The 5-hour window refused; the overall reset names the weekly one, three days out.
  assert.equal(
    parseLimitReset(
      {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": at(72),
        "anthropic-ratelimit-unified-5h-status": "rejected",
        "anthropic-ratelimit-unified-5h-reset": at(1),
        "anthropic-ratelimit-unified-7d-status": "allowed",
        "anthropic-ratelimit-unified-7d-reset": at(72),
      },
      now,
    ),
    now + 3600_000,
  );
  // A model's own weekly window, and both: the later one.
  assert.equal(
    parseLimitReset(
      {
        "anthropic-ratelimit-unified-7d_opus-status": "rejected",
        "anthropic-ratelimit-unified-7d_opus-reset": at(30),
        "anthropic-ratelimit-unified-5h-status": "rejected",
        "anthropic-ratelimit-unified-5h-reset": at(2),
      },
      now,
    ),
    now + 30 * 3600_000,
  );
  // No window named: the overall reset, capped at five hours when it says it is the 5-hour one.
  assert.equal(
    parseLimitReset(
      {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": at(72),
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
      },
      now,
    ),
    now + 5 * 3600_000,
  );
  assert.equal(
    parseLimitReset({ "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": at(30) }, now),
    now + 30 * 3600_000,
  );
  // Nothing refused: the reset sent with every answer says nothing.
  assert.equal(parseLimitReset({ "anthropic-ratelimit-unified-status": "allowed", "anthropic-ratelimit-unified-reset": at(3) }, now), undefined);
});

test("an error answer is read for what it says about the account", () => {
  const body = (type: string, message: string) => JSON.stringify({ type: "error", error: { type, message } });
  const jsonType = { "content-type": "application/json" };
  assert.equal(classifyFailure(429, jsonType, body("rate_limit_error", "Number of requests has exceeded your rate limit")), "limit");
  assert.equal(classifyFailure(429, jsonType, body("rate_limit_error", "Extra usage is required for long context requests.")), "extra-usage");
  assert.equal(classifyFailure(401, jsonType, body("authentication_error", "OAuth token has expired")), "auth");
  assert.equal(classifyFailure(403, jsonType, body("permission_error", "OAuth authentication is currently not supported.")), "auth");
  assert.equal(classifyFailure(403, jsonType, body("permission_error", "This organization has been disabled.")), "auth");
  assert.equal(classifyFailure(403, jsonType, body("permission_error", "Your plan does not include access to this model.")), "permission");
  assert.equal(classifyFailure(403, { "content-type": "text/html" }, "<html>Just a moment...</html>"), "transient");
  assert.equal(classifyFailure(529, jsonType, body("overloaded_error", "Overloaded")), "transient");
  assert.equal(classifyFailure(503, {}, undefined), "transient");
  assert.equal(classifyFailure(500, jsonType, body("api_error", "Internal")), undefined);
  assert.equal(classifyFailure(400, jsonType, body("invalid_request_error", "bad")), undefined);
});

/** A gateway-side server whose one route forwards to `upstream` with the given timeouts. */
async function forwarder(
  upstream: string,
  timeouts: Pick<ForwardSpec, "firstByteTimeoutMs" | "idleTimeoutMs" | "connectTimeoutMs" | "agent">,
) {
  const outcomes: Awaited<ReturnType<typeof forwardUpstream>>[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", async () => {
      outcomes.push(
        await forwardUpstream({
          clientRes: res,
          method: "POST",
          target: new URL(`${upstream}/v1/messages`),
          headers: {},
          body: Buffer.from("{}"),
          accountId: "a",
          usage: createAnthropicUsageExtractor(),
          errorLabel: "Gateway error",
          ...timeouts,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    outcomes,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function fakeServer(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test("a stream that goes quiet mid-answer is cut after the idle time, while a slow first byte gets its own, longer wait", async () => {
  const stalled = await fakeServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    // …and nothing more.
  });
  const slow = await fakeServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    }, 250);
  });
  const quiet = await forwarder(stalled.url, { firstByteTimeoutMs: 5_000, idleTimeoutMs: 150 });
  const patient = await forwarder(slow.url, { firstByteTimeoutMs: 2_000, idleTimeoutMs: 100 });
  try {
    const started = Date.now();
    await new Promise<void>((resolve) => {
      http
        .request({ host: "127.0.0.1", port: quiet.port, method: "POST", path: "/" }, (res) => {
          res.resume();
          res.on("close", () => resolve());
        })
        .on("error", () => resolve())
        .end("{}");
    });
    assert.ok(Date.now() - started < 3_000, "cut by the idle time, not the first-byte wait");
    const answer = await new Promise<number>((resolve, reject) =>
      http
        .request({ host: "127.0.0.1", port: patient.port, method: "POST", path: "/" }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        })
        .on("error", reject)
        .end("{}"),
    );
    assert.equal(answer, 200, "250 ms to the first byte is within its own wait, though longer than the idle time");
  } finally {
    await quiet.close();
    await patient.close();
    await stalled.close();
    await slow.close();
  }
});

/** Sends one request to a forwarder; resolves with the status and body the client got. */
const ask = (port: number) =>
  new Promise<{ status: number; body: string }>((resolve, reject) =>
    http
      .request({ host: "127.0.0.1", port, method: "POST", path: "/" }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject)
      .end("{}"),
  );

test("the pool's own short socket timeout does not end a request that is within the gateway's wait", async () => {
  // Found live: Node's pool times sockets out after 5 s, also while a slow connection is being
  // opened (an IPv6 attempt hanging after a dropped IPv4 one), and that event was taken for the
  // 10-minute first-byte wait. Here opening the connection outlasts the pool's socket timeout.
  const upstream = await fakeServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const slowLookup = ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) =>
    setTimeout(
      () =>
        options.all
          ? callback(null, [{ address: "127.0.0.1", family: 4 }])
          : callback(null, "127.0.0.1", 4),
      200,
    )) as unknown as net.LookupFunction;
  const agent = new http.Agent({ keepAlive: true, timeout: 50, lookup: slowLookup });
  const gateway = await forwarder(`http://upstream.test:${new URL(upstream.url).port}`, {
    firstByteTimeoutMs: 5_000,
    agent,
  });
  try {
    assert.equal((await ask(gateway.port)).status, 200);
    assert.equal(gateway.outcomes[0]?.statusCode, 200);
  } finally {
    agent.destroy();
    await gateway.close();
    await upstream.close();
  }
  // Each address of a host gets long enough for a slow IPv4 handshake before IPv6 is tried.
  assert.equal(UPSTREAM_AGENT_OPTIONS.keepAlive, true);
  assert.ok(UPSTREAM_AGENT_OPTIONS.autoSelectFamilyAttemptTimeout >= 1000);
});

test("a connection that never opens is given up after the connect time, with a message that says so", async () => {
  // A lookup that never answers keeps the socket connecting forever.
  const agent = new http.Agent({ lookup: () => {} });
  const gateway = await forwarder("http://upstream.invalid", {
    firstByteTimeoutMs: 5_000,
    connectTimeoutMs: 150,
    agent,
  });
  try {
    const started = Date.now();
    const answer = await ask(gateway.port);
    assert.equal(answer.status, 504);
    assert.match(answer.body, /could not connect to the upstream within 150 ms/);
    assert.ok(Date.now() - started < 3_000, "the connect time, not the first-byte wait");
    assert.equal(gateway.outcomes[0]?.statusCode, 504);
  } finally {
    agent.destroy();
    await gateway.close();
  }
});

const account = (id: string): Account => ({
  id,
  name: id,
  kind: "personal",
  group: "default",
  color: "#000",
  createdAt: new Date(now).toISOString(),
});

test("a window read at 100 % keeps the account out until it resets, and only while its reset is ahead", () => {
  const ahead = new Date(now + 3600_000).toISOString();
  const past = new Date(now - 60_000).toISOString();
  assert.equal(fullUntil({ accountId: "a", status: "ready", stale: false, sevenDay: { usedPercent: 100, resetsAt: ahead } }, now), now + 3600_000);
  assert.equal(fullUntil({ accountId: "a", status: "ready", stale: false, sevenDay: { usedPercent: 100, resetsAt: past } }, now), 0);
  assert.equal(fullUntil({ accountId: "a", status: "ready", stale: false, fiveHour: { usedPercent: 99, resetsAt: ahead } }, now), 0);
  const router = new ProxyRouter({ strategy: "strict-priority", now: () => now });
  const usage: Record<string, AccountUsage> = {
    a: { accountId: "a", status: "ready", stale: false, fiveHour: { usedPercent: 100, resetsAt: ahead } },
  };
  assert.equal(router.selectAccount(undefined, [account("a"), account("b")], usage).account.id, "b");
});

test("a session keeps its account through a sign-in or overload cooldown, and moves on a limit", () => {
  const clock = { now };
  const cache = new ProxySessionCache({ now: () => clock.now });
  const router = new ProxyRouter({ strategy: "strict-priority", sessionCache: cache, now: () => clock.now });
  const pool = [account("a"), account("b")];
  assert.equal(router.selectAccount("s", pool, {}).account.id, "a");
  router.markUnavailable("a", 30_000, "auth");
  assert.equal(router.selectAccount("s", pool, {}).account.id, "b", "served elsewhere meanwhile");
  assert.equal(cache.peek("s"), "a");
  clock.now += 31_000;
  assert.equal(router.selectAccount("s", pool, {}).account.id, "a");
  router.markUnavailable("a", 10_000, "transient");
  router.markUnavailable("a", 3600_000, "limit");
  assert.equal(router.cooldownOf("a")?.reason, "limit", "the longer limit wins over the brief outage");
  cache.evictAccount("a");
  assert.equal(router.selectAccount("s", pool, {}).account.id, "b");
  assert.equal(cache.peek("s"), "b");
});

test("a pool out only for its sign-ins says so; one with a limit among them does not", () => {
  const router = new ProxyRouter({ now: () => now });
  router.markUnavailable("a", 30_000, "auth");
  router.markUnavailable("b", 30_000, "auth");
  assert.throws(() => router.selectAccount(undefined, [account("a"), account("b")], {}), (err: any) => err.signInOnly === true);
  router.markUnavailable("b", 3600_000, "limit");
  assert.throws(() => router.selectAccount(undefined, [account("a"), account("b")], {}), (err: any) => err.signInOnly === false);
});
