import test from "node:test";
import assert from "node:assert/strict";
import { LimitNotices, type LimitWindowKind } from "../electron/core/limit-notice";
import type { Account, AccountUsage } from "../shared/types";

const account = (id: string): Account => ({ id, name: id, kind: "personal", group: "personal", color: "olive", createdAt: "2026-11-23T00:00:00Z" });
const reading = (id: string, five?: number, week?: number): AccountUsage => ({
  accountId: id,
  status: "ready",
  stale: false,
  ...(five === undefined ? {} : { fiveHour: { usedPercent: five, resetsAt: "2026-11-23T14:00:00Z" } }),
  ...(week === undefined ? {} : { sevenDay: { usedPercent: week, resetsAt: "2026-11-27T09:00:00Z" } }),
});

function setup(o: { warnings?: boolean; threshold?: 80 | 90 | 95; inUse?: string } = {}) {
  const told: string[] = [];
  let inUse = o.inUse ?? "a";
  const notices = new LimitNotices({
    settings: () => ({ usageWarnings: o.warnings ?? true, usageWarningPercent: o.threshold ?? 90 }),
    inUse: () => inUse,
    notify: (acc: Account, kind: LimitWindowKind, window) => told.push(`${acc.id}:${kind}:${window.usedPercent}`),
  });
  return { notices, told, use: (id: string) => (inUse = id) };
}

test("the account in use tells once when a window crosses the threshold", () => {
  const { notices, told } = setup();
  notices.observe(account("a"), reading("a", 70, 40));
  notices.observe(account("a"), reading("a", 91, 40));
  notices.observe(account("a"), reading("a", 95, 40));
  assert.deepEqual(told, ["a:five_hour:91"]);
  // The weekly window crosses on its own.
  notices.observe(account("a"), reading("a", 96, 92));
  assert.deepEqual(told, ["a:five_hour:91", "a:seven_day:92"]);
});

test("a first reading already past the threshold says nothing, so a restart or a switch never repeats it", () => {
  const { notices, told, use } = setup();
  notices.observe(account("a"), reading("a", 95));
  notices.observe(account("a"), reading("a", 97));
  // Switched to b, which is already past it: nothing either.
  use("b");
  notices.observe(account("b"), reading("b", 93));
  assert.deepEqual(told, []);
});

test("a reset brings the window under the threshold and arms it again", () => {
  const { notices, told } = setup();
  notices.observe(account("a"), reading("a", 85));
  notices.observe(account("a"), reading("a", 92));
  notices.observe(account("a"), reading("a", 3));
  notices.observe(account("a"), reading("a", 90));
  assert.deepEqual(told, ["a:five_hour:92", "a:five_hour:90"]);
});

test("a gateway fraction and an older poll around the threshold tell once, not twice", () => {
  const { notices, told } = setup();
  notices.observe(account("a"), reading("a", 85));
  notices.observe(account("a"), reading("a", 90.2));
  notices.observe(account("a"), reading("a", 89));
  notices.observe(account("a"), reading("a", 91));
  assert.deepEqual(told, ["a:five_hour:90.2"]);
});

test("accounts not in use, the switch turned off, and the chosen threshold", () => {
  const other = setup({ inUse: "b" });
  other.notices.observe(account("a"), reading("a", 50));
  other.notices.observe(account("a"), reading("a", 99));
  assert.deepEqual(other.told, []);

  const off = setup({ warnings: false });
  off.notices.observe(account("a"), reading("a", 50));
  off.notices.observe(account("a"), reading("a", 99));
  assert.deepEqual(off.told, []);

  const eighty = setup({ threshold: 80 });
  eighty.notices.observe(account("a"), reading("a", 79));
  eighty.notices.observe(account("a"), reading("a", 80));
  assert.deepEqual(eighty.told, ["a:five_hour:80"]);
});
