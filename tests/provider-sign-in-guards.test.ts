import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../electron/core/store";
import { UsageManager } from "../electron/core/usage";
import { antigravityCallbackUrl } from "../electron/core/antigravity-bridge";
import { reconnectIssues } from "../src/app/Banners";
import type { Account, AccountUsage } from "../shared/types";

const NOW = Date.parse("2026-11-09T12:00:00Z");

function store(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-provider-guards-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new Store(root);
}

test("a Codex account's limits are never read through a Claude sign-in", async (t) => {
  const s = store(t);
  const codex = s.create({ name: "OpenAI · Codex", kind: "personal", provider: "codex" });
  s.update((state) => {
    state.accounts[0].auth = { loggedIn: true, email: "dev@example.com", checkedAt: new Date(NOW).toISOString() };
  });
  let credentialReads = 0;
  const manager = new UsageManager(
    s,
    async () => {
      credentialReads += 1;
      throw new Error("no Claude sign-in in a Codex profile");
    },
    async () => assert.fail("no request for a Codex account"),
    () => NOW,
  );
  const usage = await manager.refresh(codex.id);
  // Unsupported, not signed out: nothing offers a Claude sign-in for it.
  assert.equal(usage.issue, "unsupported");
  assert.equal(credentialReads, 0);
});

test("sign-in banners name Claude accounts only", () => {
  const base = { kind: "personal", group: "personal", color: "olive", createdAt: new Date(NOW).toISOString() } as const;
  const expired = (accountId: string): AccountUsage => ({ accountId, status: "error", stale: true, issue: "expired" });
  const accounts: Account[] = [
    { ...base, id: "cl", name: "Claude", auth: { loggedIn: true, email: "a@example.com", checkedAt: new Date(NOW).toISOString() } },
    { ...base, id: "cx", name: "Codex", provider: "codex", auth: { loggedIn: true, email: "b@example.com", checkedAt: new Date(NOW).toISOString() } },
    { ...base, id: "ag", name: "Antigravity", provider: "antigravity", auth: { loggedIn: true, email: "c@example.com", checkedAt: new Date(NOW).toISOString() } },
  ];
  const issues = reconnectIssues(accounts, { cl: expired("cl"), cx: expired("cx"), ag: expired("ag") }, new Set());
  assert.deepEqual(issues.map((i) => i.account.id), ["cl"]);
});

test("the Claude Code sign-in refuses a Codex or Antigravity account, in main and in the window", () => {
  const service = fs.readFileSync(new URL("../electron/core/service.ts", import.meta.url), "utf8");
  assert.match(service, /async login\(id: string\) \{[\s\S]{0,300}provider \?\? "claude"\) !== "claude"\)\s*throw/);
  const relay = fs.readFileSync(new URL("../src/data/useRelay.ts", import.meta.url), "utf8");
  assert.match(relay, /const startCli = [\s\S]{0,300}provider \?\? "claude"\) !== "claude"\) return;/);
});

test("Google sends the browser back to 51121: Relay asks CLIProxyAPI to listen there", () => {
  const bridge = fs.readFileSync(new URL("../electron/core/antigravity-bridge.ts", import.meta.url), "utf8");
  assert.match(bridge, /"\/oauth\/auth-url\?provider=antigravity&is_webui=true"/);
});

test("a pasted callback address goes on only when it is this sign-in's loopback callback", () => {
  const state = "da84eef2f0b8303bfbb0253824586afa";
  const ok = `http://localhost:51121/oauth-callback?state=${state}&code=4/abc&scope=email`;
  assert.equal(antigravityCallbackUrl(`  ${ok} `, state), ok);
  assert.equal(antigravityCallbackUrl(ok.replace("localhost", "127.0.0.1"), state), ok.replace("localhost", "127.0.0.1"));
  assert.throws(() => antigravityCallbackUrl(ok, "another-state-123"), /another sign-in/);
  assert.throws(() => antigravityCallbackUrl(ok.replace("localhost", "evil.example"), state), /Not the Antigravity/);
  assert.throws(() => antigravityCallbackUrl(ok.replace("/oauth-callback", "/other"), state), /Not the Antigravity/);
  assert.throws(() => antigravityCallbackUrl(ok.replace("http:", "https:"), state), /Not the Antigravity/);
  assert.throws(() => antigravityCallbackUrl(`http://localhost:51121/oauth-callback?state=${state}`, state), /no sign-in code/);
  assert.throws(() => antigravityCallbackUrl("not a url", state), /Not a sign-in address/);
});
