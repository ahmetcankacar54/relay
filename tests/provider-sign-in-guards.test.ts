import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { reconnectIssues } from "../src/app/Banners";
import type { Account, AccountUsage } from "../shared/types";

const NOW = Date.parse("2026-11-09T12:00:00Z");

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

test("the window never starts the Claude Code sign-in for a Codex or Antigravity account", () => {
  const relay = fs.readFileSync(new URL("../src/data/useRelay.ts", import.meta.url), "utf8");
  assert.match(relay, /const startCli = [\s\S]{0,300}provider \?\? "claude"\) !== "claude"\) return;/);
});
