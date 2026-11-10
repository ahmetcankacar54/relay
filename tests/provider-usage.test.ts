import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  parseAntigravityQuota,
  parseCodexUsage,
  readAntigravityUsage,
  readCodexUsage,
} from "../electron/core/provider-usage";
import { authStatus, claudePlan, readProfileIdentity } from "../electron/core/profile-identity";
import { Store } from "../electron/core/store";
import { UsageManager } from "../electron/core/usage";
import { UsageError } from "../electron/core/usage-credentials";

const NOW = Date.parse("2026-11-09T12:00:00Z");

test("Codex usage: the primary window is the five-hour one, the secondary the weekly one", () => {
  const result = parseCodexUsage(
    {
      plan_type: "Plus",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: 1_794_272_497 },
        secondary_window: { used_percent: 76, limit_window_seconds: 604_800, reset_after_seconds: 3_600 },
      },
    },
    NOW,
  );
  assert.equal(result.plan, "plus");
  assert.deepEqual(result.limits.fiveHour, { usedPercent: 12, resetsAt: new Date(1_794_272_497_000).toISOString() });
  assert.deepEqual(result.limits.sevenDay, { usedPercent: 76, resetsAt: new Date(NOW + 3_600_000).toISOString() });
  assert.equal(result.limits.otherLimitReached, undefined);
});

test("Codex usage: windows are placed by their length, and an answer without any is refused", () => {
  const weeklyOnly = parseCodexUsage({ rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 604_800 } } }, NOW);
  assert.equal(weeklyOnly.limits.fiveHour, undefined);
  assert.equal(weeklyOnly.limits.sevenDay?.usedPercent, 40);
  assert.throws(() => parseCodexUsage({ rate_limit: {} }, NOW), (e: any) => e instanceof UsageError && e.issue === "unsupported");
});

test("Codex usage: an API key is never sent, and a refused token is an expired sign-in", async () => {
  await assert.rejects(
    readCodexUsage({ kind: "api-key", accessToken: "sk-x" }, { fetch: async () => assert.fail("no request") }),
    (e: any) => e.issue === "unsupported",
  );
  let headers: Record<string, string> = {};
  await assert.rejects(
    readCodexUsage(
      { kind: "chatgpt", accessToken: "tok", accountId: "acct-1" },
      {
        fetch: (async (_url: string, init: RequestInit) => {
          headers = init.headers as Record<string, string>;
          return new Response("{}", { status: 401 });
        }) as typeof fetch,
      },
    ),
    (e: any) => e.issue === "expired",
  );
  assert.equal(headers.Authorization, "Bearer tok");
  assert.equal(headers["ChatGPT-Account-Id"], "acct-1");
});

test("Antigravity quota: model shares, the roomiest model as the headline, variants folded", () => {
  const soon = new Date(Date.now() + 3 * 3_600_000).toISOString();
  const nextWeek = new Date(Date.now() + 6 * 86_400_000).toISOString();
  const result = parseAntigravityQuota({
    models: {
      "gemini-3-flash": { displayName: "Gemini 3 Flash", quotaInfo: { remainingFraction: 0.8, resetTime: soon } },
      "claude-opus-high": { displayName: "Claude Opus", quotaInfo: { resetTime: nextWeek } },
      "claude-opus-low": { displayName: "Claude Opus", quotaInfo: { remainingFraction: 0.5, resetTime: nextWeek } },
      "tab_flash_lite": { quotaInfo: { remainingFraction: 1 } },
      "no-quota": { displayName: "No quota" },
    },
  });
  assert.deepEqual(
    result.limits.modelWindows?.map((w) => [w.label, w.usedPercent]),
    [["Claude Opus", 100], ["Gemini 3 Flash", 20]],
  );
  assert.equal(result.limits.fiveHour?.usedPercent, 20);
  assert.equal(result.limits.sevenDay, undefined);
  // One exhausted model leaves the account usable.
  assert.equal(result.limits.otherLimitReached, undefined);
});

test("Antigravity quota: an outage tries the second host, a refusal does not", async () => {
  const body = JSON.stringify({ models: { m: { displayName: "M", quotaInfo: { remainingFraction: 1 } } } });
  const asked: string[] = [];
  const ok = await readAntigravityUsage(async ({ url, body: sent }) => {
    asked.push(url);
    assert.deepEqual(JSON.parse(sent), { project: "proj-1" });
    return asked.length === 1 ? { status: 503, retryAfter: null, body: "" } : { status: 200, retryAfter: null, body };
  }, "proj-1");
  assert.equal(asked.length, 2);
  assert.equal(ok.limits.fiveHour?.usedPercent, 0);
  let calls = 0;
  await assert.rejects(
    readAntigravityUsage(async () => (calls++, { status: 401, retryAfter: null, body: "" }), undefined),
    (e: any) => e.issue === "expired",
  );
  assert.equal(calls, 1);
});

test("the Claude plan comes from the sign-in's rate-limit tier, the seat's before the organization's", () => {
  assert.equal(claudePlan({ organizationType: "claude_team", organizationRateLimitTier: "default_raven", userRateLimitTier: "default_claude_max_5x" }), "max5");
  assert.equal(claudePlan({ organizationType: "claude_max", organizationRateLimitTier: "default_claude_max_20x" }), "max20");
  assert.equal(claudePlan({ organizationType: "claude_pro", organizationRateLimitTier: "default_claude_ai" }), "pro");
  assert.equal(claudePlan({ organizationType: "claude_team", organizationRateLimitTier: "default_raven" }), "team");
  assert.equal(claudePlan({ organizationType: "claude_free" }), undefined);
});

test("the detected plan is kept only for the sign-in its metadata matches", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "relay-plan-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const identity = {
    accountUuid: randomUUID(),
    organizationUuid: randomUUID(),
    emailAddress: "person@example.test",
    organizationType: "claude_team",
    organizationRateLimitTier: "default_raven",
    userRateLimitTier: "default_claude_max_5x",
  };
  await fsp.writeFile(path.join(root, ".claude.json"), JSON.stringify({ oauthAccount: identity }));
  const metadata = await readProfileIdentity(root);
  assert.equal(metadata?.plan, "max5");
  const status = { loggedIn: true, authMethod: "claude.ai", email: identity.emailAddress, orgId: identity.organizationUuid, subscriptionType: "team" };
  assert.equal(authStatus(status, undefined, metadata, "now").plan, "max5");
  assert.equal(authStatus({ ...status, orgId: randomUUID() }, undefined, metadata, "now").plan, undefined);
});

test("a Codex account's limits are read through its provider, and its plan follows the answer", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-provider-usage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const s = new Store(root);
  const codex = s.create({ name: "Codex", kind: "personal", provider: "codex" });
  s.update((state) => {
    state.accounts[0].auth = { loggedIn: true, email: "dev@example.com", subscription: "free", checkedAt: new Date(NOW).toISOString() };
  });
  const manager = new UsageManager(
    s,
    async () => assert.fail("no Claude credential for a Codex account"),
    async () => assert.fail("no Claude request for a Codex account"),
    () => NOW,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (account) => {
      assert.equal(account.id, codex.id);
      return { limits: { fiveHour: { usedPercent: 10 }, sevenDay: { usedPercent: 76 } }, plan: "plus" };
    },
  );
  const usage = await manager.refresh(codex.id);
  assert.equal(usage.status, "ready");
  assert.equal(usage.sevenDay?.usedPercent, 76);
  assert.equal(s.account(codex.id).auth?.subscription, "plus");
});

test("on macOS the plan is read at startup from the profile file, without the Claude CLI", async (t) => {
  const { Service } = await import("../electron/core/service");
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "relay-plan-sync-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const service = new Service(path.join(root, "Relay"), () => {}, path.join(root, "imported"));
  service.store.update((s) => {
    s.executable = path.join(root, "no-such-claude");
  });
  const orgId = randomUUID();
  const matching = service.store.create({ name: "Seat", kind: "personal" });
  const other = service.store.create({ name: "Other", kind: "personal" });
  service.store.update((s) => {
    for (const a of s.accounts)
      a.auth = { loggedIn: true, email: a.id === matching.id ? "seat@example.test" : "other@example.test", orgId, checkedAt: "x" };
    s.accounts.find((a) => a.id === matching.id)!.planning = { plan: "pro", capacityWeight: 3 };
  });
  for (const id of [matching.id, other.id]) {
    const profile = service.store.profile(id);
    await fsp.mkdir(profile, { recursive: true });
    await fsp.writeFile(
      path.join(profile, ".claude.json"),
      JSON.stringify({
        oauthAccount: {
          accountUuid: randomUUID(),
          organizationUuid: orgId,
          // The other profile's file names someone else: its plan is not taken.
          emailAddress: "seat@example.test",
          organizationType: "claude_team",
          userRateLimitTier: "default_claude_max_5x",
        },
      }),
    );
  }
  await service.reconcileAuth("darwin");
  assert.equal(service.store.account(matching.id).auth?.plan, "max5");
  assert.deepEqual(service.store.account(matching.id).planning, { plan: "max5", capacityWeight: 3 });
  assert.equal(service.store.account(other.id).auth?.plan, undefined);
  assert.equal(service.store.account(other.id).planning, undefined);
});
