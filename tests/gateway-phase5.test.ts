import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type net from "node:net";
import { ProxyServer } from "../electron/core/proxy/proxy-server";
import type { Account, AccountUsage } from "../shared/types";

const HOUR = 3_600_000;

test("requests that arrive together read an account's sign-in once and report it missing once", async () => {
  const now = Date.now();
  const account = (id: string): Account => ({ id, name: id, kind: "personal", group: "default", color: "#000", createdAt: new Date(now).toISOString() });
  // A resets first, so every new session picks it before B.
  const usage: Record<string, AccountUsage> = {
    a: { accountId: "a", status: "ready", stale: false, fiveHour: { usedPercent: 10, resetsAt: new Date(now + HOUR).toISOString() } },
    b: { accountId: "b", status: "ready", stale: false, fiveHour: { usedPercent: 10, resetsAt: new Date(now + 3 * HOUR).toISOString() } },
  };
  const reads: string[] = [];
  const missing: string[] = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"usage":{"input_tokens":1,"output_tokens":1}}');
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const server = new ProxyServer({
    config: { port: 0, host: "127.0.0.1", enabled: true, routingStrategy: "soonest-reset" },
    // A's sign-in has expired: the read takes a moment and finds nothing usable.
    credentialResolver: async (a) => {
      reads.push(a.id);
      await new Promise((resolve) => setTimeout(resolve, 40));
      return a.id === "a" ? undefined : `tok-${a.id}`;
    },
    onCredentialMissing: (id) => missing.push(id),
    usageProvider: () => ({ accounts: [account("a"), account("b")], usageMap: usage }),
    upstreams: { anthropicUrl: `http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}` },
  });
  const { port } = await server.start();
  const send = (session: string) =>
    new Promise<number>((resolve, reject) =>
      http
        .request({ host: "127.0.0.1", port, method: "POST", path: "/v1/messages", headers: { "x-claude-code-session-id": session } }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        })
        .on("error", reject)
        .end(JSON.stringify({ model: "claude-haiku-4-5" })),
    );
  try {
    const statuses = await Promise.all(Array.from({ length: 8 }, (_, i) => send(`s-${i}`)));
    assert.deepEqual(statuses, Array(8).fill(200), "B served all eight");
    assert.equal(reads.filter((id) => id === "a").length, 1, "one read of A's sign-in for the burst");
    assert.deepEqual(missing, ["a"], "reported once, so one renewal is asked for");
    assert.ok(server.stats.recent().every((entry) => entry.accountId === "b"));
  } finally {
    await server.stop();
    await new Promise<void>((resolve) => {
      upstream.closeAllConnections();
      upstream.close(() => resolve());
    });
  }
});
