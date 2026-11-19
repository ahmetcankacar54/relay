import test from "node:test";
import assert from "node:assert/strict";
import { blockedTool, toolRows } from "../src/lib/tools";
import type { Account, AccountUsage, ProxyStatus } from "../shared/types";

const NOW = Date.parse("2026-11-19T15:00:00Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const account = (id: string, provider: Account["provider"]): Account => ({
  id, name: id, kind: "personal", group: "personal", color: "olive", createdAt: at(-9999), provider, auth: { loggedIn: true, checkedAt: "2026-11-19T00:00:00Z" },
});
const read = (id: string, extra: Partial<AccountUsage>): AccountUsage => ({
  accountId: id, status: "ready", stale: false, checkedAt: at(-1), ...extra,
});
const models = (carbon: number, opus: number) => ({
  fiveHour: { usedPercent: Math.min(carbon, opus), resetsAt: at(299) },
  modelWindows: [
    { key: "antigravity_gemini_4_carbon_high", label: "Gemini 4 Carbon (High)", usedPercent: carbon, resetsAt: at(25) },
    { key: "antigravity_claude_opus_5_5", label: "Claude Opus 5.5", usedPercent: opus, resetsAt: at(190) },
  ],
});
const proxy = (over: Partial<ProxyStatus>): ProxyStatus => ({
  running: true, port: 1, host: "127.0.0.1", stats: { totalRequests: 0, activeRequests: 0, promptCacheHits: 0, cacheHitRate: 0 }, accounts: [], ...over,
});

const claude1 = account("c1", "claude");
const claude2 = account("c2", "claude");
const codex = account("x1", "codex");
const g1 = account("g1", "antigravity");
const g2 = account("g2", "antigravity");
const g3 = account("g3", "antigravity");
const usage: Record<string, AccountUsage> = {
  c1: read("c1", { fiveHour: { usedPercent: 4, resetsAt: at(280) }, sevenDay: { usedPercent: 68, resetsAt: at(2000) } }),
  c2: read("c2", { fiveHour: { usedPercent: 31, resetsAt: at(130) }, sevenDay: { usedPercent: 58, resetsAt: at(3000) } }),
  x1: read("x1", { fiveHour: { usedPercent: 0, resetsAt: at(300) }, sevenDay: { usedPercent: 100, resetsAt: at(5000) } }),
  g1: read("g1", models(100, 62)),
  g2: read("g2", models(6, 0)),
  g3: read("g3", models(95, 0)),
};

test("Antigravity's row is the account the app signed in with, and its way out is the account with the most room on the spent model", () => {
  const rows = toolRows({
    accounts: [claude1, codex, g1, g2, g3],
    usage,
    antigravity: { installed: true, canOpen: true, accountId: "g1" },
    now: NOW,
  });
  const google = rows.find((r) => r.id === "antigravity")!;
  assert.equal(google.accountId, "g1");
  assert.equal(google.via, "own");
  assert.equal(google.state, "blocked");
  assert.equal(google.headline?.label, "Gemini 4 Carbon (High)");
  // g3 has the most room overall (Opus 0 %) but Carbon is at 95 % there: g2 is the way out.
  assert.equal(google.alternative?.accountId, "g2");
  assert.equal(google.alternative?.headline?.usedPercent, 6);
  assert.equal(blockedTool(rows)?.id, "antigravity");
});

test("an Antigravity app on a Google account Relay does not have, or none installed, says so", () => {
  const foreign = toolRows({ accounts: [g1], usage, antigravity: { installed: true, canOpen: true, otherSignIn: true }, now: NOW });
  assert.deepEqual(foreign.map((r) => [r.id, r.state, r.foreign]), [["antigravity", "unknown", true]]);
  assert.deepEqual(toolRows({ accounts: [g1], usage, antigravity: { installed: false, canOpen: false }, now: NOW }), []);
});

test("Claude Code and Codex on the gateway run on the account of their latest request, and say when the gateway is off", () => {
  const status = proxy({
    clients: [
      { id: "claude-code", installed: true, bound: true, stale: false, file: "" },
      { id: "codex", installed: true, bound: true, stale: false, file: "" },
    ],
    recent: [
      { at: NOW - 5000, accountId: "c2", provider: "claude", status: 200 },
      { at: NOW - 9000, accountId: "x1", provider: "codex", status: 200 },
    ],
  });
  const rows = toolRows({ accounts: [claude1, claude2, codex], usage, active: claude1, suggestion: claude2, proxy: status, now: NOW });
  assert.deepEqual(rows.map((r) => [r.id, r.via, r.accountId, r.state]), [
    ["claude-app", "app", "c1", "ok"],
    ["claude-code", "gateway", "c2", "ok"],
    ["codex", "gateway", "x1", "blocked"],
  ]);
  // The Claude app's way out is the switch rules' suggestion; a lone Codex account has none.
  assert.equal(rows[0].alternative?.accountId, "c2");
  assert.equal(rows[2].alternative, undefined);
  assert.equal(blockedTool(rows), undefined);
  const off = toolRows({ accounts: [claude1, codex], usage, proxy: { ...status, running: false }, now: NOW });
  assert.deepEqual(off.map((r) => [r.id, r.state]), [["claude-code", "off"], ["codex", "off"]]);
});

test("a Codex CLI on its own sign-in runs on the one Codex account, and Claude Code off the gateway has no row", () => {
  const rows = toolRows({ accounts: [claude1, codex], usage, proxy: proxy({ clients: [] }), now: NOW });
  assert.deepEqual(rows.map((r) => [r.id, r.via, r.accountId]), [["codex", "own", "x1"]]);
});
