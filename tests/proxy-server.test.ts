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
  assert.equal(healthData.status, "running");
  assert.equal(healthData.state, undefined, "/health says nothing about the accounts");

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
  provider?: Account["provider"],
  antigravityResolver?: ConstructorParameters<typeof ProxyServer>[0]["antigravityResolver"],
) {
  const server = new ProxyServer({
    config: { port: 0, host: "127.0.0.1", enabled: true },
    credentialResolver: credential,
    antigravityResolver,
    usageProvider: () => ({
      accounts: [{ ...makeAccount("acc-1", "One"),
        ...((provider ?? (upstreams?.codexUrl || upstreams?.codexWebSocketUrl ? "codex" : undefined))
          ? { provider: provider ?? "codex" } : {}) }],
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
    assert.match(res.body, /Relay cannot use the sign-in of/, "names Relay, since the client's /login would not help");
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

test("OpenAI API keys use the public OpenAI endpoint, not the Codex OAuth endpoint", async () => {
  const upstream = await fakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "ok", choices: [] }));
  });
  const { server, port } = await startProxy(
    { openaiUrl: `${upstream.url}/v1` },
    async () => "sk-test-key",
    "codex",
  );
  try {
    const res = await request(port, { method: "POST", path: "/v1/chat/completions" },
      JSON.stringify({ model: "gpt-4.1", messages: [] }));
    assert.equal(res.status, 200);
    assert.equal(upstream.seen[0]?.url, "/v1/chat/completions");
    assert.equal(upstream.seen[0]?.headers.authorization, "Bearer sk-test-key");
  } finally {
    await server.stop();
    await upstream.close();
  }
});

test("Antigravity requests use the selected account's OAuth sidecar for all supported protocols", async () => {
  const upstream = await fakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "ok", choices: [] }));
  });
  const { server, port } = await startProxy(
    { codexUrl: `${upstream.url}/wrong` },
    async () => { throw new Error("Antigravity must not read a pasted API key"); },
    "antigravity",
    async () => ({ url: upstream.url, key: "sidecar-client-key" }),
  );
  try {
    const chat = await request(port, { method: "POST", path: "/v1/chat/completions" },
      JSON.stringify({ model: "gemini-3.8-flash", messages: [] }));
    assert.equal(chat.status, 200);
    assert.equal(upstream.seen[0]?.url, "/v1/chat/completions");
    assert.equal(upstream.seen[0]?.headers.authorization, "Bearer sidecar-client-key");
    const responses = await request(port, { method: "POST", path: "/v1/responses", headers: { "x-relay-provider": "antigravity" } }, "{}");
    assert.equal(responses.status, 200);
    const messages = await request(port, { method: "POST", path: "/v1/messages", headers: { "x-relay-provider": "antigravity" } }, "{}");
    assert.equal(messages.status, 200);
    assert.deepEqual(upstream.seen.map((entry) => entry.url), ["/v1/chat/completions", "/v1/responses", "/v1/messages"]);
  } finally {
    await server.stop();
    await upstream.close();
  }
});

test("Antigravity cannot be served without an OAuth sidecar credential", async () => {
  const { server, port } = await startProxy({}, async () => "wrong-token", "antigravity");
  try {
    const result = await request(port, { method: "POST", path: "/v1/chat/completions" },
      JSON.stringify({ model: "gemini-3.8-flash", messages: [] }));
    assert.equal(result.status, 401);
  } finally {
    await server.stop();
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

async function startPool(
  upstreams: ConstructorParameters<typeof ProxyServer>[0]["upstreams"],
  accounts: Account[],
  config: Partial<ConstructorParameters<typeof ProxyServer>[0]["config"]> = {},
  credential: (account: Account) => Promise<string | undefined> = async (a) => `tok-${a.id}`,
) {
  const server = new ProxyServer({
    config: { port: 0, host: "127.0.0.1", enabled: true, routingStrategy: "strict-priority", ...config },
    credentialResolver: credential,
    usageProvider: () => ({ accounts, usageMap: {} }),
    upstreams,
  });
  const state = await server.start();
  return { server, port: state.port };
}

test("a limited account's request is retried on the next account before anything reaches the client", async () => {
  const upstream = await fakeUpstream((req, res) => {
    if (req.headers.authorization === "Bearer tok-a") {
      res.writeHead(429, {
        "content-type": "application/json",
        // The 5-hour window is exhausted until this reset (epoch seconds).
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 3 * 3600),
      });
      res.end('{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  const accounts = [makeAccount("a", "A"), makeAccount("b", "B")];
  const { server, port } = await startPool({ anthropicUrl: upstream.url }, accounts);
  try {
    const res = await request(port, { method: "POST", path: "/v1/messages" }, "{}");
    assert.equal(res.status, 200, "the client sees the second account's answer");
    assert.deepEqual(upstream.seen.map((s) => s.headers.authorization), ["Bearer tok-a", "Bearer tok-b"]);
    // A is out until its window resets, not for a minute: the next request goes straight to B.
    const next = await request(port, { method: "POST", path: "/v1/messages" }, "{}");
    assert.equal(next.status, 200);
    assert.equal(upstream.seen.length, 3);
    assert.equal(upstream.seen[2].headers.authorization, "Bearer tok-b");
    const cooldown = server.router.cooldownOf("a")!.until;
    assert.ok(cooldown - Date.now() > 2.9 * 3600_000, "cooldown follows the reset header");
  } finally {
    await server.stop();
    await upstream.close();
  }
});

test("an account without a readable sign-in is skipped for the next one", async () => {
  const upstream = await fakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const accounts = [makeAccount("a", "A"), makeAccount("b", "B")];
  const { server, port } = await startPool({ anthropicUrl: upstream.url }, accounts, {}, async (a) =>
    a.id === "a" ? undefined : "tok-b",
  );
  try {
    const res = await request(port, { method: "POST", path: "/v1/messages" }, "{}");
    assert.equal(res.status, 200);
    assert.deepEqual(upstream.seen.map((s) => s.headers.authorization), ["Bearer tok-b"]);
  } finally {
    await server.stop();
    await upstream.close();
  }
});

test("the client key is accepted in any of its headers, compared exactly, and never forwarded", async () => {
  const upstream = await fakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const key = "relay-sec-test-key";
  const { server, port } = await startPool({ anthropicUrl: upstream.url }, [makeAccount("a", "A")], { apiKey: key });
  try {
    const post = (headers: http.OutgoingHttpHeaders) =>
      request(port, { method: "POST", path: "/v1/messages", headers }, "{}");
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ "x-api-key": "relay-sec-wrong-key" })).status, 401);
    assert.equal((await post({ "x-api-key": `${key}x` })).status, 401);
    assert.equal((await post({ authorization: `Bearer ${key}` })).status, 200);
    assert.equal((await post({ "x-api-key": key })).status, 200);
    // A client holding its own OAuth token in Authorization still gets in with the key elsewhere.
    assert.equal((await post({ authorization: "Bearer sk-ant-oat-own", "x-relay-key": key, "x-relay-provider": "claude" })).status, 200);
    for (const seen of upstream.seen) {
      assert.equal(seen.headers["x-relay-key"], undefined);
      assert.equal(seen.headers["x-relay-provider"], undefined);
      assert.equal(seen.headers["x-api-key"], undefined);
      assert.equal(seen.headers.authorization, "Bearer tok-a");
    }
    // /status needs the key; /health does not.
    assert.equal((await request(port, { path: "/status" })).status, 401);
    assert.equal((await request(port, { path: "/status", headers: { "x-api-key": key } })).status, 200);
    assert.equal((await request(port, { path: "/health" })).status, 200);
  } finally {
    await server.stop();
    await upstream.close();
  }
});

test("a loopback gateway refuses a foreign Host name (DNS rebinding)", async () => {
  const { server, port } = await startPool({ anthropicUrl: "http://127.0.0.1:9" }, [makeAccount("a", "A")]);
  try {
    const foreign = await request(port, { path: "/status", headers: { host: "evil.example:80" } });
    assert.equal(foreign.status, 403);
    const local = await request(port, { path: "/status", headers: { host: `localhost:${port}` } });
    assert.equal(local.status, 200);
  } finally {
    await server.stop();
  }
});

test("a provider without an account is a 503, not a cooldown", async () => {
  const { server, port } = await startPool({ anthropicUrl: "http://127.0.0.1:9" }, [makeAccount("a", "A")]);
  try {
    const res = await request(port, { method: "POST", path: "/v1/responses" }, '{"model":"gpt-5"}');
    assert.equal(res.status, 503);
    assert.match(res.body, /No codex account/);
  } finally {
    await server.stop();
  }
});

test("a short 429 cools an account for its Retry-After, not until the window's ordinary reset", async () => {
  const upstream = await fakeUpstream((_req, res) => {
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": "10",
      // Sent with every answer; the window itself is not exhausted.
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 5 * 3600),
    });
    res.end("{}");
  });
  const { server, port } = await startPool({ anthropicUrl: upstream.url }, [makeAccount("a", "A")]);
  try {
    await request(port, { method: "POST", path: "/v1/messages" }, "{}");
    const cooldown = server.router.cooldownOf("a")!.until;
    assert.ok(cooldown - Date.now() <= 11_000, "only the Retry-After");
  } finally {
    await server.stop();
    await upstream.close();
  }
});

test("chat completions skip a Codex ChatGPT sign-in for an OpenAI API key account", async () => {
  const openai = await fakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const chatgpt: Account = {
    ...makeAccount("chatgpt", "ChatGPT"),
    provider: "codex",
    auth: { loggedIn: true, checkedAt: new Date().toISOString(), accountUuid: "33333333-3333-4333-8333-333333333333" },
  };
  const key: Account = { ...makeAccount("key", "Key"), provider: "codex" };
  const { server, port } = await startPool({ openaiUrl: openai.url, codexUrl: "http://127.0.0.1:9" }, [chatgpt, key], {}, async (a) =>
    a.id === "key" ? "sk-test" : "chatgpt-token",
  );
  try {
    const res = await request(port, { method: "POST", path: "/v1/chat/completions" }, '{"model":"gpt-5"}');
    assert.equal(res.status, 200);
    assert.deepEqual(openai.seen.map((s) => s.headers.authorization), ["Bearer sk-test"]);
  } finally {
    await server.stop();
    await openai.close();
  }
  // With only the ChatGPT sign-in, the answer says what is missing.
  const only = await startPool({ codexUrl: "http://127.0.0.1:9" }, [chatgpt], {}, async () => "chatgpt-token");
  try {
    const res = await request(only.port, { method: "POST", path: "/v1/chat/completions" }, '{"model":"gpt-5"}');
    assert.equal(res.status, 501);
    assert.match(res.body, /Responses API only/);
  } finally {
    await only.server.stop();
  }
});

test("a Claude Code session keeps its account by its session header, whatever its body says", async () => {
  const upstream = await fakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  const accounts = [makeAccount("a", "A"), makeAccount("b", "B")];
  const usageMap: Record<string, AccountUsage> = {};
  const server = new ProxyServer({
    config: { port: 0, host: "127.0.0.1", enabled: true, routingStrategy: "strict-priority" },
    credentialResolver: async (a) => `tok-${a.id}`,
    usageProvider: () => ({ accounts, usageMap }),
    upstreams: { anthropicUrl: upstream.url },
  });
  const { port } = await server.start();
  const send = (session: string, body: unknown) =>
    request(
      port,
      { method: "POST", path: "/v1/messages", headers: { "x-claude-code-session-id": session } },
      JSON.stringify(body),
    );
  try {
    await send("s-1", { messages: [{ role: "user", content: "The first prompt of this conversation." }] });
    // A is nearly full: new sessions go to B, a session already on A stays for its cache.
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    usageMap.a = {
      accountId: "a",
      status: "ready",
      stale: false,
      checkedAt: new Date().toISOString(),
      fiveHour: { usedPercent: 97, resetsAt: soon },
      sevenDay: { usedPercent: 10, resetsAt: soon },
    };
    // The same session after a compaction: another first message, and a subagent's own metadata.
    await send("s-1", { messages: [{ role: "user", content: "A summary that replaced the history." }], metadata: { user_id: "another" } });
    await send("s-2", { messages: [{ role: "user", content: "The first prompt of this conversation." }] });
    assert.deepEqual(
      upstream.seen.map((s) => s.headers.authorization),
      ["Bearer tok-a", "Bearer tok-a", "Bearer tok-b"],
    );
  } finally {
    await server.stop();
    await upstream.close();
  }
});

/** A pool of accounts with tokens `tok-<id>`, a clock the test moves, and a hook per upstream token. */
async function startClocked(
  reply: (token: string, req: http.IncomingMessage, res: http.ServerResponse) => void,
  ids: string[],
  extra: Partial<ConstructorParameters<typeof ProxyServer>[0]> = {},
  usageMap: Record<string, AccountUsage> = {},
) {
  const upstream = await fakeUpstream((req, res) =>
    reply(String(req.headers.authorization).replace("Bearer ", ""), req, res),
  );
  const clock = { now: Date.now() };
  const server = new ProxyServer({
    config: { port: 0, host: "127.0.0.1", enabled: true, routingStrategy: "strict-priority" },
    credentialResolver: async (a) => `tok-${a.id}`,
    usageProvider: () => ({ accounts: ids.map((id) => makeAccount(id, id.toUpperCase())), usageMap }),
    upstreams: { anthropicUrl: upstream.url },
    now: () => clock.now,
    ...extra,
  });
  const { port } = await server.start();
  const send = (session = "s-1") =>
    request(port, { method: "POST", path: "/v1/messages", headers: { "x-claude-code-session-id": session } }, "{}");
  return {
    server,
    upstream,
    clock,
    send,
    tokens: () => upstream.seen.map((s) => String(s.headers.authorization).replace("Bearer ", "")),
    close: async () => {
      await server.stop();
      await upstream.close();
    },
  };
}

const ok = (res: http.ServerResponse) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end('{"type":"message"}');
};
const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

test("an overload on a session's account is served elsewhere once, and the session comes back to its cache", async () => {
  let overloaded = false;
  const pool = await startClocked((token, _req, res) => {
    if (token === "tok-a" && overloaded) {
      overloaded = false;
      return json(res, 529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    }
    ok(res);
  }, ["a", "b"]);
  try {
    await pool.send();
    overloaded = true;
    assert.equal((await pool.send()).status, 200, "B answered in its place");
    assert.equal(pool.server.sessionCache.peek("hdr:s-1"), "a", "the session is still A's");
    assert.equal(pool.server.router.cooldownOf("a")?.reason, "transient");
    pool.clock.now += 11_000;
    await pool.send();
    assert.deepEqual(pool.tokens(), ["tok-a", "tok-a", "tok-b", "tok-a"]);
  } finally {
    await pool.close();
  }
});

test("a refused sign-in drops the token and asks for a renewal, but the session waits for its account", async () => {
  const rejected: string[] = [];
  const renew: string[] = [];
  let refuse = false;
  const pool = await startClocked(
    (token, _req, res) =>
      token === "tok-a" && refuse
        ? json(res, 401, { type: "error", error: { type: "authentication_error", message: "OAuth token has expired" } })
        : ok(res),
    ["a", "b"],
    { onCredentialRejected: (id) => rejected.push(id), onCredentialMissing: (id) => renew.push(id) },
  );
  try {
    await pool.send("x");
    await pool.send("y");
    refuse = true;
    await pool.send("x");
    refuse = false;
    assert.deepEqual(rejected, ["a"]);
    assert.equal(pool.server.sessionCache.peek("hdr:x"), "a");
    assert.equal(pool.server.sessionCache.peek("hdr:y"), "a", "the account's other sessions stay too");
    pool.clock.now += 31_000;
    await pool.send("y");
    assert.equal(pool.tokens().at(-1), "tok-a");
  } finally {
    await pool.close();
  }
});

test("a 403 about a model moves only that session and leaves the account and its token alone", async () => {
  const rejected: string[] = [];
  const pool = await startClocked(
    (token, req, res) =>
      token === "tok-a" && req.headers["x-claude-code-session-id"] === "opus"
        ? json(res, 403, { type: "error", error: { type: "permission_error", message: "This model is not available on your plan" } })
        : ok(res),
    ["a", "b"],
    { onCredentialRejected: (id) => rejected.push(id) },
  );
  try {
    await pool.send("other");
    assert.equal((await pool.send("opus")).status, 200);
    assert.deepEqual(rejected, []);
    assert.equal(pool.server.router.cooldownOf("a"), undefined);
    assert.equal(pool.server.sessionCache.peek("hdr:opus"), "b");
    assert.equal(pool.server.sessionCache.peek("hdr:other"), "a");
  } finally {
    await pool.close();
  }
});

test("a challenge page in front of the API is not a refused sign-in", async () => {
  const rejected: string[] = [];
  let challenge = true;
  const pool = await startClocked(
    (token, _req, res) => {
      if (token === "tok-a" && challenge) {
        challenge = false;
        res.writeHead(403, { "content-type": "text/html" });
        res.end("<html>Just a moment...</html>");
        return;
      }
      ok(res);
    },
    ["a", "b"],
    { onCredentialRejected: (id) => rejected.push(id) },
  );
  try {
    assert.equal((await pool.send()).status, 200);
    assert.deepEqual(rejected, []);
    assert.equal(pool.server.router.cooldownOf("a")?.reason, "transient");
    assert.equal(pool.server.sessionCache.peek("hdr:s-1"), "a");
  } finally {
    await pool.close();
  }
});

test("a 5-hour limit keeps the account out until the 5-hour reset, not the weekly one the overall header names", async () => {
  const fiveHours = Math.floor(Date.now() / 1000) + 3600;
  const week = Math.floor(Date.now() / 1000) + 3 * 86_400;
  const pool = await startClocked(
    (token, _req, res) =>
      token === "tok-a"
        ? json(res, 429, { type: "error", error: { type: "rate_limit_error", message: "limit" } }, {
            "anthropic-ratelimit-unified-status": "rejected",
            "anthropic-ratelimit-unified-reset": String(week),
            "anthropic-ratelimit-unified-5h-status": "rejected",
            "anthropic-ratelimit-unified-5h-reset": String(fiveHours),
            "anthropic-ratelimit-unified-7d-status": "allowed",
            "anthropic-ratelimit-unified-7d-reset": String(week),
          })
        : ok(res),
    ["a", "b"],
  );
  try {
    await pool.send();
    const until = pool.server.router.cooldownOf("a")!.until;
    assert.ok(Math.abs(until - fiveHours * 1000) < 2_000, "the 5-hour window's own reset");
  } finally {
    await pool.close();
  }
});

test("an account Relay read as full is not tried, and a pool with no room answers at once with the first reset", async () => {
  const reset = new Date(Date.now() + 2 * 3600_000).toISOString();
  const usageMap: Record<string, AccountUsage> = {
    b: { accountId: "b", status: "ready", stale: false, fiveHour: { usedPercent: 0 }, sevenDay: { usedPercent: 100, resetsAt: reset } },
  };
  const pool = await startClocked(
    (token, _req, res) =>
      token === "tok-a"
        ? json(res, 429, { type: "error", error: { type: "rate_limit_error", message: "limit" } }, { "retry-after": "600" })
        : ok(res),
    ["a", "b"],
    {},
    usageMap,
  );
  try {
    const first = await pool.send();
    assert.equal(first.status, 429);
    assert.deepEqual(pool.tokens(), ["tok-a"], "B is full until its weekly reset: no request is spent on it");
    const second = await pool.send("s-2");
    assert.equal(second.status, 429);
    assert.equal(pool.tokens().length, 1, "answered by the gateway itself");
    assert.ok(Number(second.headers["retry-after"]) >= 590);
  } finally {
    await pool.close();
  }
});

test("accounts whose sign-in cannot be read do not use up the tries, and are sent for renewal", async () => {
  const renew: string[] = [];
  const upstream = await fakeUpstream((_req, res) => ok(res));
  const ids = ["a", "b", "c", "good"];
  const server = new ProxyServer({
    config: { port: 0, host: "127.0.0.1", enabled: true, routingStrategy: "strict-priority" },
    credentialResolver: async (a) => (a.id === "good" ? "tok-good" : undefined),
    onCredentialMissing: (id) => renew.push(id),
    usageProvider: () => ({ accounts: ids.map((id) => makeAccount(id, id.toUpperCase())), usageMap: {} }),
    upstreams: { anthropicUrl: upstream.url },
  });
  const { port } = await server.start();
  try {
    const res = await request(port, { method: "POST", path: "/v1/messages" }, "{}");
    assert.equal(res.status, 200);
    assert.deepEqual(renew, ["a", "b", "c"]);
  } finally {
    await server.stop();
    await upstream.close();
  }
});

test("when no sign-in can be used the client hears so, not a rate limit it would wait out", async () => {
  const upstream = await fakeUpstream((_req, res) => ok(res));
  const server = new ProxyServer({
    config: { port: 0, host: "127.0.0.1", enabled: true },
    credentialResolver: async () => undefined,
    usageProvider: () => ({ accounts: [makeAccount("a", "Alto")], usageMap: {} }),
    upstreams: { anthropicUrl: upstream.url },
  });
  const { port } = await server.start();
  try {
    const first = await request(port, { method: "POST", path: "/v1/messages" }, "{}");
    assert.equal(first.status, 401);
    assert.match(first.body, /sign-in of Alto/);
    const second = await request(port, { method: "POST", path: "/v1/messages" }, "{}");
    assert.equal(second.status, 401, "still a sign-in problem while the account waits");
    assert.match(second.body, /Renew it in Relay/);
  } finally {
    await server.stop();
    await upstream.close();
  }
});

test("an answer billed as extra usage moves the account's sessions and keeps it out until its window resets", async () => {
  const reset = new Date(Date.now() + 90 * 60_000).toISOString();
  const usageMap: Record<string, AccountUsage> = {
    a: { accountId: "a", status: "ready", stale: false, fiveHour: { usedPercent: 92, resetsAt: reset } },
  };
  const pool = await startClocked(
    (token, _req, res) => {
      if (token === "tok-a") {
        res.writeHead(200, { "content-type": "application/json", "anthropic-ratelimit-unified-overage-in-use": "true" });
        res.end('{"type":"message"}');
        return;
      }
      ok(res);
    },
    ["a", "b"],
    {},
    usageMap,
  );
  try {
    await pool.send();
    // The answer reached the client; the gateway settles its outcome right after.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const cooldown = pool.server.router.cooldownOf("a")!;
    assert.equal(cooldown.reason, "limit");
    assert.ok(Math.abs(cooldown.until - Date.parse(reset)) < 2_000);
    assert.equal(pool.server.sessionCache.peek("hdr:s-1"), undefined);
    assert.equal(pool.server.getMetrics().extraUsage?.a.kind, "billed");
    await pool.send();
    assert.deepEqual(pool.tokens(), ["tok-a", "tok-b"]);
  } finally {
    await pool.close();
  }
});

test("a request that needs extra usage moves to another account without benching this one", async () => {
  const pool = await startClocked(
    (token, _req, res) =>
      token === "tok-a"
        ? json(res, 429, { type: "error", error: { type: "rate_limit_error", message: "Extra usage is required for long context requests." } })
        : ok(res),
    ["a", "b"],
  );
  try {
    assert.equal((await pool.send()).status, 200);
    assert.equal(pool.server.router.cooldownOf("a"), undefined);
    assert.equal(pool.server.sessionCache.peek("hdr:s-1"), "b");
    assert.equal(pool.server.getMetrics().extraUsage?.a.kind, "required");
  } finally {
    await pool.close();
  }
});
