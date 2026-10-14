import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageHistory } from "../electron/core/usage-history";
import { foldSamples, hourKey } from "../shared/usage-rollups";
import {
  USAGE_HISTORY_DAYS,
  MAX_USAGE_SAMPLES,
  usageIdentity,
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
const identity = usageIdentity(account)!;
function usage(at: number, usedPercent: number): AccountUsage {
  return {
    accountId: account.id,
    status: "ready",
    stale: false,
    checkedAt: new Date(at).toISOString(),
    fiveHour: {
      usedPercent,
      resetsAt: new Date(
        at - ((at - start) % (5 * 60 * minute)) + 5 * 60 * minute,
      ).toISOString(),
    },
    sevenDay: {
      usedPercent: 15,
      resetsAt: new Date(at + 3 * day).toISOString(),
    },
  };
}
function directory(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-usage-rollups-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const rollupsFile = (root: string) => path.join(root, "usage-rollups.json");

test("raw retention is 14 days and at most 50,000 samples", () => {
  assert.equal(USAGE_HISTORY_DAYS, 14);
  assert.equal(MAX_USAGE_SAMPLES, 50_000);
});

test("recording folds samples into a persisted rollups file", (t) => {
  const root = directory(t);
  let now = start;
  const history = new UsageHistory(root, () => now);
  history.record(account, usage(start, 10));
  now += 5 * minute;
  history.record(account, usage(now, 17.5));
  assert.equal(history.rollupsAvailable, true);
  assert.ok(fs.existsSync(rollupsFile(root)));
  assert.deepEqual(history.rollups()!.hours[identity][hourKey(start)], {
    points: 7.5,
    windows: 1,
    coveredMinutes: 5,
  });
  const persisted = JSON.parse(fs.readFileSync(rollupsFile(root), "utf8"));
  assert.deepEqual(persisted, history.rollups());
  if (process.platform !== "win32")
    assert.equal(fs.statSync(rollupsFile(root)).mode & 0o777, 0o600);
  // A fresh instance reads the persisted rollups.
  assert.deepEqual(new UsageHistory(root, () => now).rollups(), persisted);
});

test("an existing raw ledger without rollups is backfilled on open", (t) => {
  const root = directory(t);
  const now = start + 60 * minute;
  const samples: UsageSample[] = [0, 5, 10, 15].map((m, index) =>
    usageSample(account, usage(start + m * minute, 10 + index * 3))!,
  );
  fs.writeFileSync(
    path.join(root, "usage-history.json"),
    JSON.stringify({ version: 1, samples }),
  );
  const history = new UsageHistory(root, () => now);
  assert.equal(history.rollupsAvailable, true);
  assert.deepEqual(history.rollups(), foldSamples(samples, now));
  assert.equal(history.rollups()!.hours[identity][hourKey(start)].points, 9);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(rollupsFile(root), "utf8")),
    foldSamples(samples, now),
  );
});

test("raw samples older than 14 days are pruned while rollup hours remain", (t) => {
  const root = directory(t);
  let now = start;
  const history = new UsageHistory(root, () => now);
  history.record(account, usage(now, 10));
  now += 5 * minute;
  history.record(account, usage(now, 20));
  now = start + 20 * day;
  history.record(account, usage(now, 30));
  const raw = JSON.parse(
    fs.readFileSync(path.join(root, "usage-history.json"), "utf8"),
  ).samples;
  assert.equal(raw.length, 1);
  assert.equal(raw[0].checkedAt, new Date(now).toISOString());
  const hours = history.rollups()!.hours[identity];
  assert.equal(hours[hourKey(start)].points, 10);
  assert.ok(hours[hourKey(now)]);
  assert.equal(
    new UsageHistory(root, () => now).rollups()!.hours[identity][hourKey(start)]
      .points,
    10,
  );
});

test("a corrupt rollups file is unavailable and never overwritten", (t) => {
  const root = directory(t);
  const content = "{ broken rollups";
  fs.writeFileSync(rollupsFile(root), content);
  const now = start + 10 * minute;
  const history = new UsageHistory(root, () => now);
  assert.equal(history.rollupsAvailable, false);
  assert.equal(history.rollups(), undefined);
  history.record(account, usage(start, 10));
  history.record(account, usage(start + 5 * minute, 20));
  const raw = JSON.parse(
    fs.readFileSync(path.join(root, "usage-history.json"), "utf8"),
  ).samples;
  assert.equal(raw.length, 2);
  assert.equal(history.historyAvailable, true);
  assert.equal(fs.readFileSync(rollupsFile(root), "utf8"), content);
  // Valid JSON with an invalid shape is also rejected.
  const wrongShape = JSON.stringify({ version: 2, hours: {} });
  fs.writeFileSync(rollupsFile(root), wrongShape);
  const reopened = new UsageHistory(root, () => now);
  reopened.record(account, usage(start + 10 * minute, 30));
  assert.equal(reopened.rollupsAvailable, false);
  assert.equal(fs.readFileSync(rollupsFile(root), "utf8"), wrongShape);
});

test("a symlinked rollups file is unavailable and not followed", (t) => {
  const root = directory(t);
  const foreign = path.join(root, "foreign.json");
  const foreignContent = JSON.stringify({
    version: 2,
    hours: {},
    windows: {},
    hits: [],
    last: {},
  });
  fs.writeFileSync(foreign, foreignContent);
  fs.symlinkSync(foreign, rollupsFile(root));
  const history = new UsageHistory(root, () => start + 10 * minute);
  assert.equal(history.rollupsAvailable, false);
  assert.equal(history.rollups(), undefined);
  history.record(account, usage(start, 10));
  assert.equal(fs.readFileSync(foreign, "utf8"), foreignContent);
  assert.ok(fs.lstatSync(rollupsFile(root)).isSymbolicLink());

  // A symlink substituted after opening is refused at write time.
  fs.unlinkSync(rollupsFile(root));
  const substituted = new UsageHistory(root, () => start + 10 * minute);
  assert.equal(substituted.rollupsAvailable, true);
  fs.unlinkSync(rollupsFile(root));
  fs.symlinkSync(foreign, rollupsFile(root));
  substituted.record(account, usage(start + 5 * minute, 20));
  assert.equal(substituted.rollupsAvailable, false);
  assert.equal(fs.readFileSync(foreign, "utf8"), foreignContent);
  assert.equal(substituted.historyAvailable, true);
});

test("a stale rollups file is caught up with newer raw samples on load", (t) => {
  const root = directory(t);
  const now = start + 60 * minute;
  const samples: UsageSample[] = [0, 5, 10, 15].map((m, index) =>
    usageSample(account, usage(start + m * minute, 10 + index * 3))!,
  );
  fs.writeFileSync(
    path.join(root, "usage-history.json"),
    JSON.stringify({ version: 1, samples }),
  );
  fs.writeFileSync(
    rollupsFile(root),
    JSON.stringify(foldSamples(samples.slice(0, 2), now)),
  );
  const history = new UsageHistory(root, () => now);
  assert.equal(history.rollupsAvailable, true);
  assert.deepEqual(history.rollups(), foldSamples(samples, now));
  assert.deepEqual(
    JSON.parse(fs.readFileSync(rollupsFile(root), "utf8")),
    foldSamples(samples, now),
  );
});

test("a version 1 rollups file is rebuilt from the raw ledger", (t) => {
  const root = directory(t);
  const now = start + 60 * minute;
  const samples: UsageSample[] = [0, 5, 10, 15].map((m, index) =>
    usageSample(account, usage(start + m * minute, 10 + index * 3))!,
  );
  fs.writeFileSync(
    path.join(root, "usage-history.json"),
    JSON.stringify({ version: 1, samples }),
  );
  // Version 1 credited coverage only inside windows and to the later hour.
  const v1 = {
    ...foldSamples(samples.slice(0, 2), now),
    version: 1,
    hours: {
      [identity]: {
        [hourKey(start - day)]: { points: 99, windows: 1, coveredMinutes: 5 },
      },
    },
  };
  fs.writeFileSync(rollupsFile(root), JSON.stringify(v1));
  const history = new UsageHistory(root, () => now);
  assert.equal(history.rollupsAvailable, true);
  assert.deepEqual(history.rollups(), foldSamples(samples, now));
  assert.equal(history.rollups()!.version, 2);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(rollupsFile(root), "utf8")),
    foldSamples(samples, now),
  );
});

test("a version 1 rollups file without a readable raw ledger stays unavailable", (t) => {
  const root = directory(t);
  fs.writeFileSync(path.join(root, "usage-history.json"), "broken");
  const content = JSON.stringify({
    version: 1,
    hours: {},
    windows: {},
    hits: [],
    last: {},
  });
  fs.writeFileSync(rollupsFile(root), content);
  const history = new UsageHistory(root, () => start);
  assert.equal(history.rollupsAvailable, false);
  assert.equal(fs.readFileSync(rollupsFile(root), "utf8"), content);
});

test("a transient rollups write failure is retried on the next record", (t) => {
  const root = directory(t);
  let now = start;
  const history = new UsageHistory(root, () => now);
  const rename = fs.renameSync;
  let failures = 1;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === rollupsFile(root) && failures-- > 0)
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return rename(from, to);
  });
  history.record(account, usage(now, 10));
  assert.equal(history.rollupsAvailable, true);
  now += 5 * minute;
  history.record(account, usage(now, 17));
  assert.equal(history.rollupsAvailable, true);
  const persisted = JSON.parse(fs.readFileSync(rollupsFile(root), "utf8"));
  assert.equal(persisted.last[identity].checkedAt, new Date(now).toISOString());
  assert.deepEqual(persisted.hours[identity][hourKey(start)], {
    points: 7,
    windows: 1,
    coveredMinutes: 5,
  });
  assert.deepEqual(persisted, history.rollups());
});

test("an unreadable raw ledger still folds new samples into the rollups", (t) => {
  const root = directory(t);
  const rawFile = path.join(root, "usage-history.json");
  let now = start;
  new UsageHistory(root, () => now).record(account, usage(now, 10));
  const corrupt = "{ broken history";
  fs.writeFileSync(rawFile, corrupt);
  now += 5 * minute;
  const history = new UsageHistory(root, () => now);
  assert.equal(history.historyAvailable, false);
  assert.equal(history.rollupsAvailable, true);
  history.record(account, usage(now, 17.5));
  assert.equal(history.rollupsAvailable, true);
  assert.deepEqual(history.rollups()!.hours[identity][hourKey(start)], {
    points: 7.5,
    windows: 1,
    coveredMinutes: 5,
  });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(rollupsFile(root), "utf8")),
    history.rollups(),
  );
  // A repeated sample is still ignored, and the raw ledger is never replaced.
  history.record(account, usage(now, 40));
  assert.equal(history.rollups()!.hours[identity][hourKey(start)].points, 7.5);
  assert.equal(fs.readFileSync(rawFile, "utf8"), corrupt);
  assert.equal(history.lastKnownResets(account), undefined);
});

test("a failed raw write keeps folding samples into the rollups", (t) => {
  const root = directory(t);
  const rawFile = path.join(root, "usage-history.json");
  let now = start;
  const history = new UsageHistory(root, () => now);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === rawFile)
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return rename(from, to);
  });
  history.record(account, usage(now, 10));
  assert.equal(history.historyAvailable, false);
  now += 5 * minute;
  history.record(account, usage(now, 17));
  assert.equal(history.rollupsAvailable, true);
  assert.equal(history.rollups()!.hours[identity][hourKey(start)].points, 7);
  assert.equal(
    JSON.parse(fs.readFileSync(rollupsFile(root), "utf8")).last[identity]
      .checkedAt,
    new Date(now).toISOString(),
  );
  assert.equal(fs.existsSync(rawFile), false);
});

test("rollups stamped ahead of the clock accept new samples after a restart", (t) => {
  const root = directory(t);
  const rawFile = path.join(root, "usage-history.json");
  let now = start + 60 * minute;
  new UsageHistory(root, () => now).record(account, usage(now, 50));
  // The clock moves back an hour; the raw ledger is unreadable too.
  fs.writeFileSync(rawFile, "broken");
  now = start + 5 * minute;
  const history = new UsageHistory(root, () => now);
  assert.equal(history.rollups()!.last[identity], undefined);
  assert.equal(
    JSON.parse(fs.readFileSync(rollupsFile(root), "utf8")).last[identity],
    undefined,
  );
  history.record(account, usage(now, 10));
  assert.equal(
    history.rollups()!.last[identity].checkedAt,
    new Date(now).toISOString(),
  );
});
