import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type net from "node:net";
import { ProxyServer } from "../electron/core/proxy/proxy-server";
import type { Account, AccountUsage } from "../shared/types";

const makeAccount = (id: string, name: string): Account => ({
  id,
  name,
  kind: "personal",
  group: "default",
  color: "#00ff00",
  createdAt: new Date().toISOString(),
});

test("ProxyServer starts, serves /health and /status, and stops cleanly", async () => {
  const testPort = 18317;
  const acc = makeAccount("acc-test", "Test Account");

  const server = new ProxyServer({
    config: {
      port: testPort,
      host: "127.0.0.1",
      enabled: true,
    },
    credentialResolver: async () => "mock-token-123",
    usageProvider: () => ({
      accounts: [acc],
      usageMap: {},
    }),
  });

  const state = await server.start();
  assert.equal(state.status, "running");
  assert.equal(state.port, testPort);

  // Request /health
  const healthData = await new Promise<any>((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${testPort}/health`, (res) => {
        assert.equal(res.statusCode, 200);
        let chunks = "";
        res.on("data", (c) => (chunks += c));
        res.on("end", () => resolve(JSON.parse(chunks)));
      })
      .on("error", reject);
  });

  assert.equal(healthData.ok, true);
  assert.equal(healthData.state.status, "running");

  // Request /status
  const statusData = await new Promise<any>((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${testPort}/status`, (res) => {
        assert.equal(res.statusCode, 200);
        let chunks = "";
        res.on("data", (c) => (chunks += c));
        res.on("end", () => resolve(JSON.parse(chunks)));
      })
      .on("error", reject);
  });

  assert.equal(statusData.ok, true);
  assert.equal(statusData.state.activeSessionsCount, 0);

  await server.stop();
  assert.equal(server.getState().status, "stopped");
});

interface Seen {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A stand-in for the real upstream: records what it got and answers with `reply`. */
async function fakeUpstream(
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
      const entry = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      };
      seen.push(entry);
      reply(req, res, entry);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    seen,
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function request(
  port: number,
  options: http.RequestOptions,
  body?: string,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, ...options }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: text,
        }),
      );
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function startProxy(
  upstreams: ConstructorParameters<typeof ProxyServer>[0]["upstreams"],
  credential: () => Promise<string | undefined> = async () => "tok-1",
) {
  const server = new ProxyServer({
    config: { port: 0, host: "127.0.0.1", enabled: true },
    credentialResolver: credential,
    usageProvider: () => ({
      accounts: [makeAccount("acc-1", "One")],
      usageMap: {},
    }),
    upstreams,
  });
  const state = await server.start();
  return { server, port: state.port };
}

test("ProxyServer swaps the credential, keeps the client's betas and records streamed usage", async () => {
  const upstream = await fakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    // Split in the middle of an event: the parser must cope with chunk boundaries.
    const events =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":4,"cache_creation_input_tokens":2,"output_tokens":1}}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":25}}\n\n';
    res.write(events.slice(0, 40));
    setTimeout(() => res.end(events.slice(40)), 10);
  });
  const { server, port } = await startProxy({ anthropicUrl: upstream.url });
  try {
    const res = await request(
      port,
      {
        method: "POST",
        path: "/v1/messages?beta=true",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer client-key",
          "x-api-key": "sk-client",
          "anthropic-beta": "claude-code-20250219",
        },
      },
      JSON.stringify({ model: "m", messages: [] }),
    );
    assert.equal(res.status, 200);
    assert.match(res.body, /message_delta/);

    const got = upstream.seen[0];
    assert.equal(got.url, "/v1/messages?beta=true");
    assert.equal(got.headers.authorization, "Bearer tok-1");
    assert.equal(got.headers["x-api-key"], undefined);
    assert.deepEqual(String(got.headers["anthropic-beta"]).split(","), [
      "claude-code-20250219",
      "oauth-2025-04-20",
    ]);

    // Output is the final cumulative count, not message_start's plus message_delta's.
    assert.deepEqual(server.getMetrics().tokensByAccount["acc-1"], {
      input: 10,
      output: 25,
      cacheRead: 4,
      cacheWrite: 2,
    });
  } finally {
    await server.stop();
    await upstream.close();
  }
});

test("ProxyServer never lets a request target steer the token to another host", async () => {
  const upstream = await fakeUpstream((_req, res) => res.end("{}"));
  const { server, port } = await startProxy({ anthropicUrl: upstream.url });
  try {
    for (const path of [
      "//evil.example/v1/messages",
      "/\\evil.example/v1/messages",
    ]) {
      const res = await request(port, { method: "POST", path }, "{}");
      assert.equal(res.status, 400, path);
    }
    assert.equal(upstream.seen.length, 0);
  } finally {
    await server.stop();
    await upstream.close();
  }
});

test("ProxyServer surfaces 429 with Retry-After, then cools the account down", async () => {
  const upstream = await fakeUpstream((_req, res) => {
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": "42",
    });
    res.end(
      '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}',
    );
  });
  const { server, port } = await startProxy({ anthropicUrl: upstream.url });
  try {
    const first = await request(
      port,
      { method: "POST", path: "/v1/messages" },
      "{}",
    );
    assert.equal(first.status, 429);
    assert.match(first.body, /slow down/);

    // The only account is cooling down: answered by the gateway, upstream not bothered again.
    const second = await request(
      port,
      { method: "POST", path: "/v1/messages" },
      "{}",
    );
    assert.equal(second.status, 429);
    assert.ok(Number(second.headers["retry-after"]) > 0);
    assert.equal(upstream.seen.length, 1);
  } finally {
    await server.stop();
    await upstream.close();
  }
});

test("ProxyServer passes a 401 through, answers 401 for an unreadable credential and 502 for a dead upstream", async () => {
  const upstream = await fakeUpstream((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end('{"error":"expired"}');
  });
  const { server, port } = await startProxy({ anthropicUrl: upstream.url });
  try {
    const res = await request(
      port,
      { method: "POST", path: "/v1/messages" },
      "{}",
    );
    assert.equal(res.status, 401);
    assert.match(res.body, /expired/);
  } finally {
    await server.stop();
    await upstream.close();
  }

  const noToken = await startProxy(
    { anthropicUrl: upstream.url },
    async () => undefined,
  );
  try {
    const res = await request(
      noToken.port,
      { method: "POST", path: "/v1/messages" },
      "{}",
    );
    assert.equal(res.status, 401);
    assert.match(res.body, /No active credential/);
  } finally {
    await noToken.server.stop();
  }

  // upstream.url is closed now: nothing listens there.
  const dead = await startProxy({ anthropicUrl: upstream.url });
  try {
    const res = await request(
      dead.port,
      { method: "POST", path: "/v1/messages" },
      "{}",
    );
    assert.equal(res.status, 502);
    assert.match(res.body, /Gateway error/);
  } finally {
    await dead.server.stop();
  }
});

test("ProxyServer cancels the upstream call when the client hangs up", async () => {
  let upstreamClosed: () => void;
  const closed = new Promise<void>((resolve) => (upstreamClosed = resolve));
  const upstream = await fakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: ping\ndata: {}\n\n");
    res.on("close", () => upstreamClosed());
    // never ends
  });
  const { server, port } = await startProxy({ anthropicUrl: upstream.url });
  try {
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method: "POST", path: "/v1/messages" },
        (res) => {
          res.once("data", () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on("error", () => {});
      req.end("{}");
      setTimeout(() => reject(new Error("no first chunk")), 3000).unref();
    });
    await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("upstream socket was left open")),
          3000,
        ).unref(),
      ),
    ]);
  } finally {
    await server.stop();
    await upstream.close();
  }
});

test("ProxyServer sends Codex requests under the upstream's path and reads Responses usage", async () => {
  const upstream = await fakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":7,"input_tokens_details":{"cached_tokens":60}}}}\n\n',
    );
  });
  const { server, port } = await startProxy({
    codexUrl: `${upstream.url}/backend-api/codex`,
  });
  try {
    for (const path of ["/v1/responses", "/responses"]) {
      const res = await request(port, { method: "POST", path }, "{}");
      assert.equal(res.status, 200);
    }
    assert.deepEqual(
      upstream.seen.map((s) => s.url),
      ["/backend-api/codex/responses", "/backend-api/codex/responses"],
    );
    assert.deepEqual(server.getMetrics().tokensByAccount["acc-1"], {
      input: 80,
      output: 14,
      cacheRead: 120,
      cacheWrite: 0,
    });
  } finally {
    await server.stop();
    await upstream.close();
  }
});

test("ProxyServer bridges a WebSocket upgrade and answers 502 when the upstream is down", async () => {
  const upstream = http.createServer();
  upstream.on("upgrade", (req, socket) => {
    socket.on("error", () => {});
    assert.equal(req.headers.authorization, "Bearer tok-1");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
    socket.on("data", (d) => socket.write(`echo:${d}`));
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  const { server, port } = await startProxy({
    codexWebSocketUrl: `ws://127.0.0.1:${upstreamPort}/ws`,
  });
  try {
    const echoed = await new Promise<string>((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port,
        path: "/responses",
        headers: { connection: "Upgrade", upgrade: "websocket" },
      });
      req.on("upgrade", (_res, socket) => {
        socket.on("error", () => {});
        socket.once("data", (d) => {
          socket.destroy();
          resolve(String(d));
        });
        socket.write("hi");
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(echoed, "echo:hi");
  } finally {
    await server.stop();
    upstream.close();
    upstream.closeAllConnections();
  }

  // Nothing listens on that port any more.
  const dead = await startProxy({
    codexWebSocketUrl: `ws://127.0.0.1:${upstreamPort}/ws`,
  });
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port: dead.port,
        path: "/responses",
        headers: { connection: "Upgrade", upgrade: "websocket" },
      });
      req.on("response", (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("upgrade", () => reject(new Error("unexpected upgrade")));
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 502);
  } finally {
    await dead.server.stop();
  }
});

test("ProxyServer.stop() returns while a stream is still open and a second start works", async () => {
  const upstream = await fakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: ping\ndata: {}\n\n");
  });
  const { server, port } = await startProxy({ anthropicUrl: upstream.url });
  const req = http.request(
    { host: "127.0.0.1", port, method: "POST", path: "/v1/messages" },
    (res) => {
      res.on("data", () => {});
      res.on("error", () => {});
    },
  );
  req.on("error", () => {});
  req.end("{}");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await server.stop();
  assert.equal(server.getState().status, "stopped");
  const again = await server.start();
  assert.equal(again.status, "running");
  await server.stop();
  await upstream.close();
});
