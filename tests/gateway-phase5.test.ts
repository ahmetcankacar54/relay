import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import path from "node:path";
import { ProxyServer } from "../electron/core/proxy/proxy-server";
import { Store } from "../electron/core/store";
import type { Account, AccountUsage } from "../shared/types";
import { cliFixture } from "./cli-fixture";

const HOUR = 3_600_000;
const macOnly = { skip: process.platform === "win32" && "macOS only: the relay CLI refuses other systems" };

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

/** A Codex and an Antigravity account signed in through the app, with a Codex ChatGPT sign-in saved. */
async function providerAccounts(t: any) {
  const f = await cliFixture(t);
  const store = new Store(f.home);
  const codex = store.create({ name: "Codex", kind: "personal", provider: "codex" });
  store.create({ name: "Google", kind: "personal", provider: "antigravity" });
  store.update((state) => {
    for (const account of state.accounts)
      account.auth = { loggedIn: true, checkedAt: new Date().toISOString(), subscription: "plus" } as Account["auth"];
  });
  const profile = path.join(f.home, "profiles", codex.id);
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(
    path.join(profile, "provider-credential.json"),
    JSON.stringify({ kind: "chatgpt", accessToken: "codex-test-token", expiresAt: Date.now() + HOUR }),
    { mode: 0o600 },
  );
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    asked.push(`${String(url)} ${(init?.headers as Record<string, string>)?.Authorization ?? ""}`);
    return new Response(
      JSON.stringify({
        plan_type: "pro",
        rate_limit: {
          primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_after_seconds: 3_600 },
          secondary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_after_seconds: 86_400 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  return { f, codex, asked };
}

test("relay usage reads a Codex account's limits as the app does, and sends Antigravity to the app", macOnly, async (t) => {
  const { f, codex, asked } = await providerAccounts(t);
  assert.equal(await f.run("usage", "--json"), 0);
  const rows = JSON.parse(f.out());
  const codexRow = rows.find((row: { name: string }) => row.name === "Codex");
  assert.equal(codexRow.status, "ready");
  assert.equal(codexRow.fiveHour.usedPercent, 12);
  assert.equal(codexRow.sevenDay.usedPercent, 40);
  assert.equal(rows.find((row: { name: string }) => row.name === "Google").issue, "unsupported");
  assert.deepEqual(asked, ["https://chatgpt.com/backend-api/wham/usage Bearer codex-test-token"]);
  // The plan the answer names is the app's to save: relay only reads.
  assert.equal(f.store().account(codex.id).auth?.subscription, "plus");

  f.clear();
  assert.equal(await f.run("usage", "--lang", "en"), 0);
  assert.match(f.out(), /Codex\s+12% used/);
  assert.match(f.out(), /Google\s+Antigravity limits are read in the Relay app only/);
  assert.doesNotMatch(f.out(), /relay connect/, "relay connect signs in Claude accounts only");
  assert.ok(!(f.out() + f.err()).includes("codex-test-token"));
});

test("a Codex or Antigravity account without a sign-in is sent to the app, not to relay connect", macOnly, async (t) => {
  const { f } = await providerAccounts(t);
  f.store().update((state) => {
    for (const account of state.accounts) delete account.auth;
  });
  assert.equal(await f.run("usage", "--lang", "en"), 0);
  assert.match(f.out(), /Codex\s+not signed in: sign in again in the Relay app/);
  assert.doesNotMatch(f.out(), /relay connect/);
});
