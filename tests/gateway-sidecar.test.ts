import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import {
  GatewaySidecar,
  type GatewaySidecarHooks,
} from "../electron/main/gateway-sidecar";
import type { Account } from "../shared/types";
import type { ProxyConfig, ProxyRequestLog } from "../shared/proxy-types";

/** The Rust gateway's sidecar example, built once for these tests (`relay __gateway` stands in). */
const ROOT = path.join(import.meta.dirname, "..");
const BINARY = path.join(
  ROOT,
  "target",
  "debug",
  "examples",
  `sidecar${process.platform === "win32" ? ".exe" : ""}`,
);
function buildSidecar(): string | undefined {
  try {
    execFileSync(
      "cargo",
      ["build", "-p", "relay-gateway", "--example", "sidecar"],
      { cwd: ROOT, stdio: "ignore" },
    );
  } catch {
    return "cargo is unavailable or the sidecar example does not build";
  }
  return existsSync(BINARY)
    ? undefined
    : `the sidecar example is not at ${BINARY}`;
}
const unavailable = buildSidecar();
const needsCargo = { skip: unavailable && `Skipped: ${unavailable}` };

const account = (id: string, name: string): Account => ({
  id,
  name,
  kind: "personal",
  group: "default",
  color: "#000",
  createdAt: "2026-11-01T00:00:00.000Z",
});

const config = (port = 0): ProxyConfig => ({
  enabled: true,
  port,
  host: "127.0.0.1",
  affinityTtlSeconds: 3_600,
  routingStrategy: "soonest-reset",
});

/** A stand-in for Anthropic: records each request's credential and answers with a message. */
async function fakeUpstream() {
  const tokens: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      tokens.push(String(req.headers.authorization));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        '{"type":"message","usage":{"input_tokens":2,"output_tokens":3}}',
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    tokens,
    url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function post(
  port: number,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/v1/messages",
        headers,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ model: "claude-opus-5-5" }));
  });
}

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(check(), what);
};

function hooks(extra: Partial<GatewaySidecarHooks> = {}) {
  const recorded: ProxyRequestLog[] = [];
  const asked: string[] = [];
  const value: GatewaySidecarHooks = {
    credential: async (a) => {
      asked.push(a.id);
      return `tok-${a.id}`;
    },
    usage: () => ({ accounts: [account("a", "Alto")], usageMap: {} }),
    requestLog: {
      record: (entry) => recorded.push(entry),
      bind: () => {},
      recent: () => [],
      overflowCosts: () => [],
    },
    timeZone: () => "UTC",
    ...extra,
  };
  return { value, recorded, asked };
}

test(
  "the gateway runs as a child process: it starts, asks for a sign-in, serves, reports and stops",
  needsCargo,
  async () => {
    const upstream = await fakeUpstream();
    const { value, recorded, asked } = hooks();
    const sidecar = new GatewaySidecar({
      binary: BINARY,
      config: config(),
      hooks: value,
      upstreams: { anthropicUrl: upstream.url },
      pollMs: 50,
    });
    try {
      const state = await sidecar.start();
      assert.equal(state.status, "running");
      assert.ok(state.port > 0);
      assert.equal(
        sidecar.getState().endpointUrl,
        `http://127.0.0.1:${state.port}`,
      );

      assert.equal(
        await post(state.port, { "x-claude-code-session-id": "s-1" }),
        200,
      );
      assert.deepEqual(
        asked,
        ["a"],
        "the sign-in came from the app's credential path",
      );
      assert.deepEqual(upstream.tokens, ["Bearer tok-a"]);
      await until(
        () => recorded.length === 1,
        "the answer reached the app's request log",
      );
      assert.equal(recorded[0].accountId, "a");

      await sidecar.refresh();
      assert.equal(sidecar.getMetrics()?.totalRequests, 1);
      assert.equal(sidecar.stats.recent()[0]?.accountId, "a");
      assert.deepEqual(sidecar.nextPicks().claude?.accountId, "a");
      await until(
        () => sidecar.sessionCache.list().length === 1,
        "the session cache arrives on its interval",
      );
      assert.equal(sidecar.sessionCache.list()[0].sessionKey, "hdr:s-1");
      assert.equal(sidecar.sessionCache.evictAccount("a"), 1);
      // The evict goes down the same pipe before the status request: the gateway answers after it.
      await sidecar.refresh();
      assert.equal(
        sidecar.getState().activeSessionsCount,
        0,
        "the gateway dropped them too",
      );

      // A new routing strategy applies in place: same port, still running.
      sidecar.updateConfig({ routingStrategy: "strict-priority" });
      await sidecar.refresh();
      assert.equal(sidecar.getState().port, state.port);
      assert.equal(sidecar.getState().status, "running");

      await sidecar.stop();
      assert.equal(sidecar.getState().status, "stopped");
      await assert.rejects(post(state.port), "nothing listens once it stopped");
    } finally {
      await sidecar.stop();
      await upstream.close();
    }
  },
);

test(
  "a taken port fails the start as EADDRINUSE, the code the app words for the user",
  needsCargo,
  async () => {
    const taken = net.createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const port = (taken.address() as net.AddressInfo).port;
    const sidecar = new GatewaySidecar({
      binary: BINARY,
      config: config(port),
      hooks: hooks().value,
    });
    try {
      await assert.rejects(
        sidecar.start(),
        (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE",
      );
      assert.equal(sidecar.getState().status, "stopped");
    } finally {
      await sidecar.stop();
      taken.close();
    }
  },
);

test(
  "a gateway that dies on its own is reported once, and the sidecar reads as stopped",
  needsCargo,
  async () => {
    const exits: string[] = [];
    const sidecar = new GatewaySidecar({
      binary: BINARY,
      config: config(),
      hooks: hooks({ onExit: (message) => exits.push(message) }).value,
    });
    await sidecar.start();
    process.kill(sidecar.pid!, "SIGKILL");
    await until(() => exits.length === 1, "the app heard the gateway stopped");
    assert.match(exits[0], /exited/);
    assert.equal(sidecar.getState().status, "stopped");
    assert.deepEqual(sidecar.sessionCache.list(), []);
    await sidecar.stop();
    assert.equal(exits.length, 1, "a stop of a gone gateway says nothing more");
  },
);

test("a binary that is not there fails the start with its own error", async () => {
  const sidecar = new GatewaySidecar({
    binary: path.join(ROOT, "target", "no-such-relay"),
    config: config(),
    hooks: hooks().value,
  });
  await assert.rejects(
    sidecar.start(),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  assert.equal(sidecar.getState().status, "stopped");
});
