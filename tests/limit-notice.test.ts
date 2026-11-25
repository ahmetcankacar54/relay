import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LimitNotices, READY_FRESH_MS, type LimitWindowKind } from "../electron/core/limit-notice";
import type { Account, AccountUsage, NotificationSettings } from "../shared/types";

const FIVE_RESET = "2026-11-23T14:00:00.000Z";
const WEEK_RESET = "2026-11-27T09:00:00.000Z";
const account = (id: string): Account => ({ id, name: id, kind: "personal", group: "personal", color: "olive", createdAt: "2026-11-23T00:00:00Z" });
/** `fiveReset` null: a 5-hour window with no reset time, as an unused window after its reset reads. */
const reading = (id: string, five?: number, week?: number, fiveReset: string | null = FIVE_RESET): AccountUsage => ({
  accountId: id,
  status: "ready",
  stale: false,
  ...(five === undefined ? {} : { fiveHour: { usedPercent: five, resetsAt: fiveReset ?? undefined } }),
  ...(week === undefined ? {} : { sevenDay: { usedPercent: week, resetsAt: WEEK_RESET } }),
});

function setup(
  o: {
    warnings?: boolean;
    threshold?: 80 | 90 | 95;
    inUse?: string;
    notifications?: NotificationSettings;
    file?: string;
    now?: number;
  } = {},
) {
  const told: string[] = [];
  const ready: string[] = [];
  let inUse = o.inUse ?? "a";
  let now = o.now ?? Date.parse("2026-11-23T12:00:00Z");
  const notices = new LimitNotices({
    settings: () => ({ usageWarnings: o.warnings ?? true, usageWarningPercent: o.threshold ?? 90, notifications: o.notifications }),
    inUse: () => inUse,
    notify: (acc: Account, kind: LimitWindowKind, window) => told.push(`${acc.id}:${kind}:${window.usedPercent}`),
    ready: (acc: Account, kind: LimitWindowKind) => ready.push(`${acc.id}:${kind}`),
    file: o.file ? () => o.file! : undefined,
    now: () => now,
  });
  return { notices, told, ready, use: (id: string) => (inUse = id), at: (iso: string) => (now = Date.parse(iso)) };
}

/** A private folder for the saved reset memory, removed after the test. */
function memoryFile(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-limit-notice-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "limit-notices.json");
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

test("a window that reached the threshold says ready again once when it resets", () => {
  const { notices, ready, at } = setup();
  notices.observe(account("a"), reading("a", 95, 40));
  at("2026-11-23T13:00:00Z");
  notices.observe(account("a"), reading("a", 96, 40));
  // After the reset the 5-hour window has no reset time until it is used again.
  at("2026-11-23T14:02:00Z");
  notices.observe(account("a"), reading("a", 0, 41, null));
  assert.deepEqual(ready, ["a:five_hour"]);
  at("2026-11-23T14:07:00Z");
  notices.observe(account("a"), reading("a", 1, 41, "2026-11-23T19:07:00Z"));
  // An older poll still showing the full window does not wait for that reset again.
  notices.observe(account("a"), reading("a", 97, 41));
  at("2026-11-23T14:12:00Z");
  notices.observe(account("a"), reading("a", 2, 41, "2026-11-23T19:07:00Z"));
  assert.deepEqual(ready, ["a:five_hour"]);
});

test("the weekly window and an early reset say ready again too", () => {
  const weekly = setup();
  weekly.notices.observe(account("a"), reading("a", undefined, 92));
  weekly.at("2026-11-27T09:05:00Z");
  weekly.notices.observe(account("a"), { accountId: "a", status: "ready", stale: false, sevenDay: { usedPercent: 0 } });
  assert.deepEqual(weekly.ready, ["a:seven_day"]);

  // A later window began before the awaited reset time: the limit was reset early.
  const early = setup();
  early.notices.observe(account("a"), reading("a", 95));
  early.at("2026-11-23T12:30:00Z");
  early.notices.observe(account("a"), reading("a", 5, undefined, "2026-11-23T17:30:00Z"));
  assert.deepEqual(early.ready, ["a:five_hour"]);

  // Under the threshold before the reset time with the same window: no reset.
  const drop = setup();
  drop.notices.observe(account("a"), reading("a", 95));
  drop.notices.observe(account("a"), reading("a", 3));
  assert.deepEqual(drop.ready, []);
});

test("a restart neither repeats ready again nor forgets a window that filled before it", (t) => {
  const file = memoryFile(t);
  const before = setup({ file });
  before.notices.observe(account("a"), reading("a", 95));
  assert.ok(fs.existsSync(file));
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // Relay restarted around the reset: the first reading after it tells once.
  const after = setup({ file, now: Date.parse("2026-11-23T14:05:00Z") });
  after.notices.observe(account("a"), reading("a", 0, undefined, null));
  assert.deepEqual(after.ready, ["a:five_hour"]);

  // Another restart: the same reset, and an older poll of the full window, say nothing.
  const again = setup({ file, now: Date.parse("2026-11-23T14:10:00Z") });
  again.notices.observe(account("a"), reading("a", 97));
  again.notices.observe(account("a"), reading("a", 0, undefined, null));
  assert.deepEqual(again.ready, []);
});

test("a reset found long after it happened is old news and not told", (t) => {
  const file = memoryFile(t);
  setup({ file }).notices.observe(account("a"), reading("a", 95));
  const late = setup({ file, now: Date.parse(FIVE_RESET) + READY_FRESH_MS + 60_000 });
  late.notices.observe(account("a"), reading("a", 0, undefined, null));
  assert.deepEqual(late.ready, []);
  // Passed, not pending: a later reading says nothing either.
  const later = setup({ file, now: Date.parse(FIVE_RESET) + READY_FRESH_MS + 120_000 });
  later.notices.observe(account("a"), reading("a", 0, undefined, null));
  assert.deepEqual(later.ready, []);
});

test("the window switches, the ready-again choice and the account it is for", () => {
  // The 5-hour window off: neither its warning nor its ready again; the weekly one still warns.
  const five = setup({ notifications: { limitFiveHour: false } });
  five.notices.observe(account("a"), reading("a", 70, 70));
  five.notices.observe(account("a"), reading("a", 95, 95));
  five.at("2026-11-23T14:05:00Z");
  five.notices.observe(account("a"), reading("a", 0, 95, null));
  assert.deepEqual(five.told, ["a:seven_day:95"]);
  assert.deepEqual(five.ready, []);

  // Ready again off: the warning stays.
  const off = setup({ notifications: { limitReset: "off" } });
  off.notices.observe(account("a"), reading("a", 70));
  off.notices.observe(account("a"), reading("a", 95));
  off.at("2026-11-23T14:05:00Z");
  off.notices.observe(account("a"), reading("a", 0, undefined, null));
  assert.deepEqual(off.told, ["a:five_hour:95"]);
  assert.deepEqual(off.ready, []);

  // The default is the account in use; "all" tells for an account that is not.
  for (const [limitReset, expected] of [[undefined, []], ["all", ["a:five_hour"]]] as const) {
    const other = setup({ inUse: "b", notifications: limitReset ? { limitReset } : undefined });
    other.notices.observe(account("a"), reading("a", 95));
    other.at("2026-11-23T14:05:00Z");
    other.notices.observe(account("a"), reading("a", 0, undefined, null));
    assert.deepEqual(other.ready, expected);
  }

  // Ready again does not need the marks: it fires with "Mark accounts near their limit" off.
  const unmarked = setup({ warnings: false });
  unmarked.notices.observe(account("a"), reading("a", 95));
  unmarked.at("2026-11-23T14:05:00Z");
  unmarked.notices.observe(account("a"), reading("a", 0, undefined, null));
  assert.deepEqual(unmarked.ready, ["a:five_hour"]);
});
