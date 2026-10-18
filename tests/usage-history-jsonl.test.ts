import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  USAGE_COMPACTION_MS,
  UsageHistory,
} from "../electron/core/usage-history";
import {
  USAGE_HISTORY_DAYS,
  usageSample,
  type UsageSample,
} from "../shared/usage-statistics";
import type { Account, AccountUsage } from "../shared/types";

const start = Date.parse("2026-10-13T08:00:00.000Z");
const minute = 60_000;
const day = 86_400_000;
const account: Account = {
  id: "account-slot-a",
  name: "A",
  kind: "personal",
  group: "personal",
  color: "terra",
  createdAt: new Date(start).toISOString(),
  auth: {
    loggedIn: true,
    accountUuid: "verified-account-a",
    orgId: "verified-org-a",
    email: "a@example.test",
    checkedAt: new Date(start).toISOString(),
  },
};
function usage(at: number, usedPercent: number): AccountUsage {
  return {
    accountId: account.id,
    status: "ready",
    stale: false,
    checkedAt: new Date(at).toISOString(),
    fiveHour: {
      usedPercent,
      resetsAt: new Date(at + 60 * minute).toISOString(),
    },
  };
}
const sample = (at: number, usedPercent: number): UsageSample =>
  usageSample(account, usage(at, usedPercent))!;
function directory(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-usage-jsonl-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const lines = (file: string) =>
  fs.readFileSync(file, "utf8").split("\n").filter(Boolean);

test("each sample is appended as one line of usage-history.jsonl", (t) => {
  const root = directory(t);
  let now = start + minute;
  const history = new UsageHistory(root, () => now);
  assert.equal(history.file, path.join(root, "usage-history.jsonl"));
  history.record(account, usage(start, 10));
  assert.deepEqual(
    lines(history.file).map((line) => JSON.parse(line)),
    [sample(start, 10)],
  );
  const first = fs.readFileSync(history.file, "utf8");
  const inode = fs.statSync(history.file).ino;
  now += 5 * minute;
  history.record(account, usage(start + 5 * minute, 20));
  const after = fs.readFileSync(history.file, "utf8");
  // Appended in place: the first line is untouched and the file is the same.
  assert.ok(after.startsWith(first));
  assert.equal(fs.statSync(history.file).ino, inode);
  assert.equal(lines(history.file).length, 2);
  if (process.platform !== "win32")
    assert.equal(fs.statSync(history.file).mode & 0o777, 0o600);
});

test("a reload returns the same samples, in time order", (t) => {
  const root = directory(t);
  const now = start + 60 * minute;
  const history = new UsageHistory(root, () => now);
  const other = {
    ...account,
    id: "account-slot-b",
    auth: { ...account.auth!, accountUuid: "verified-account-b" },
  };
  history.record(account, usage(start, 10));
  history.record(other, {
    ...usage(start + 2 * minute, 30),
    accountId: other.id,
  });
  history.record(account, usage(start + 5 * minute, 20));
  const before = history.recentSamples(0);
  assert.equal(before.length, 3);
  assert.deepEqual(new UsageHistory(root, () => now).recentSamples(0), before);
});

test("compaction keeps the 14-day window, at startup and then at most once a day", (t) => {
  const root = directory(t);
  let now = start;
  const history = new UsageHistory(root, () => now);
  history.record(account, usage(now, 10));
  now += 5 * minute;
  history.record(account, usage(now, 20));
  // Less than a day: still appended.
  now += USAGE_COMPACTION_MS - 10 * minute;
  history.record(account, usage(now, 30));
  assert.equal(lines(history.file).length, 3);
  // Past the retention and a day after the last compaction: rewritten.
  now = start + (USAGE_HISTORY_DAYS + 1) * day;
  history.record(account, usage(now, 40));
  assert.deepEqual(
    lines(history.file).map((line) => JSON.parse(line)),
    [sample(now, 40)],
  );
  // A restart compacts too.
  fs.appendFileSync(history.file, JSON.stringify(sample(start, 50)) + "\n");
  const reopened = new UsageHistory(root, () => now);
  assert.equal(reopened.historyAvailable, true);
  assert.deepEqual(
    lines(reopened.file).map((line) => JSON.parse(line)),
    [sample(now, 40)],
  );
});

test("the ledger from before is migrated once and kept beside it, never losing a sample", (t) => {
  const root = directory(t);
  const now = start + 60 * minute;
  const legacy = path.join(root, "usage-history.json");
  const samples = [0, 5, 10].map((m) => sample(start + m * minute, 10 + m));
  const content = JSON.stringify({ version: 1, samples });
  fs.writeFileSync(legacy, content);
  const history = new UsageHistory(root, () => now);
  assert.equal(history.historyAvailable, true);
  assert.deepEqual(history.recentSamples(0), samples);
  assert.deepEqual(
    lines(history.file).map((line) => JSON.parse(line)),
    samples,
  );
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(fs.readFileSync(`${legacy}.migrated`, "utf8"), content);
  // A migration that stopped before the rename merges both, once each.
  fs.writeFileSync(legacy, content);
  history.record(account, usage(start + 15 * minute, 40));
  const merged = new UsageHistory(root, () => now);
  assert.deepEqual(merged.recentSamples(0), [
    ...samples,
    sample(start + 15 * minute, 40),
  ]);
  assert.equal(lines(merged.file).length, 4);
});

test("a line cut short by a crash or one that is not a sample is skipped", (t) => {
  const root = directory(t);
  const now = start + 60 * minute;
  const file = path.join(root, "usage-history.jsonl");
  const kept = [sample(start, 10), sample(start + 5 * minute, 20)];
  fs.writeFileSync(
    file,
    [
      JSON.stringify(kept[0]),
      "not json",
      JSON.stringify({ ...sample(start + 2 * minute, 15), token: "no" }),
      JSON.stringify(kept[1]),
      JSON.stringify(sample(start + 7 * minute, 30)).slice(0, 40),
    ].join("\n"),
  );
  const history = new UsageHistory(root, () => now);
  assert.equal(history.historyAvailable, true);
  assert.deepEqual(history.recentSamples(0), kept);
  // The next sample starts on a line of its own.
  history.record(account, usage(start + 10 * minute, 40));
  assert.deepEqual(new UsageHistory(root, () => now).recentSamples(0), [
    ...kept,
    sample(start + 10 * minute, 40),
  ]);
});

test("a ledger with lines but no sample, or too large, is unavailable and never overwritten", (t) => {
  const root = directory(t);
  const file = path.join(root, "usage-history.jsonl");
  for (const content of [
    "broken\nlines\n",
    JSON.stringify({ ...sample(start, 10), accessToken: "not-allowed" }) + "\n",
    "x".repeat(32 * 1024 * 1024 + 1),
  ]) {
    fs.writeFileSync(file, content);
    const history = new UsageHistory(root, () => start + minute);
    history.record(account, usage(start, 20));
    assert.equal(history.historyAvailable, false);
    assert.equal(fs.readFileSync(file, "utf8"), content);
  }
});
