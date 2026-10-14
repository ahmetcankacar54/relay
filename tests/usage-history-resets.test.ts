import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageHistory } from "../electron/core/usage-history";
import type { Account, AccountUsage } from "../shared/types";

const at = Date.parse("2026-10-13T08:00:00.000Z");
const fiveHourReset = "2026-10-13T13:00:00.000Z";
const weeklyReset = "2026-10-19T08:00:00.000Z";
const minute = 60_000;
const account: Account = {
  id: "profile-a",
  name: "A",
  kind: "personal",
  group: "personal",
  color: "olive",
  createdAt: new Date(at).toISOString(),
  auth: {
    loggedIn: true,
    accountUuid: "verified-account-a",
    orgId: "verified-org-a",
    email: "a@example.test",
    checkedAt: new Date(at).toISOString(),
  },
};

function directory(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-last-resets-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function usage(checkedAt = at): AccountUsage {
  return {
    accountId: account.id,
    status: "ready",
    stale: false,
    checkedAt: new Date(checkedAt).toISOString(),
    fiveHour: { usedPercent: 100, resetsAt: fiveHourReset },
    sevenDay: { usedPercent: 40, resetsAt: weeklyReset },
  };
}

test("an exhausted account's reset dates survive cache invalidation and Relay restart without resurrecting quota", (t) => {
  const root = directory(t);
  const history = new UsageHistory(root, () => at + minute);
  const current = usage();
  history.record(account, current);
  const invalidated: AccountUsage = {
    accountId: account.id,
    status: "idle",
    stale: false,
  };
  const restored = new UsageHistory(root, () => at + minute);
  invalidated.lastKnownResets = restored.lastKnownResets(account);
  assert.deepEqual(invalidated.lastKnownResets, {
    fiveHour: { resetsAt: fiveHourReset, checkedAt: current.checkedAt },
    sevenDay: { resetsAt: weeklyReset, checkedAt: current.checkedAt },
  });
  assert.equal(invalidated.fiveHour, undefined);
  assert.equal(invalidated.sevenDay, undefined);
  assert.equal(invalidated.checkedAt, undefined);
  assert.equal(invalidated.status, "idle");
  assert.equal(invalidated.stale, false);
  assert.equal(
    restored.snapshot([account])[account.id].periods.sevenDay.samples,
    1,
  );
});

test("newer missing reset dates retain each window's own last verified reset", (t) => {
  const history = new UsageHistory(directory(t), () => at + 10 * minute);
  history.record(account, usage());
  const weeklyOnly = usage(at + minute);
  weeklyOnly.fiveHour = { usedPercent: 0 };
  weeklyOnly.sevenDay!.resetsAt = "2026-10-20T08:00:00.000Z";
  history.record(account, weeklyOnly);
  const missingResets = usage(at + 2 * minute);
  missingResets.fiveHour = { usedPercent: 0 };
  missingResets.sevenDay = { usedPercent: 0 };
  history.record(account, missingResets);
  assert.deepEqual(history.lastKnownResets(account), {
    fiveHour: {
      resetsAt: fiveHourReset,
      checkedAt: new Date(at).toISOString(),
    },
    sevenDay: {
      resetsAt: "2026-10-20T08:00:00.000Z",
      checkedAt: weeklyOnly.checkedAt,
    },
  });
});

test("another login or organization cannot inherit a slot's former reset dates", (t) => {
  const history = new UsageHistory(directory(t), () => at + minute);
  history.record(account, usage());
  for (const patch of [
    { accountUuid: "other-account" },
    { orgId: "other-organization" },
    { loggedIn: false },
    { accountUuid: undefined, orgId: undefined, email: undefined },
  ]) {
    const changed = { ...account, auth: { ...account.auth!, ...patch } };
    assert.equal(history.lastKnownResets(changed), undefined);
  }
  assert.equal(
    history.lastKnownResets({ ...account, id: "different-profile" }),
    undefined,
  );
  assert.deepEqual(
    history.lastKnownResets({
      ...account,
      auth: { ...account.auth!, email: "renamed@example.test" },
    }),
    history.lastKnownResets(account),
  );
});

test("stale and failed polls do not replace persisted verified reset dates", (t) => {
  const history = new UsageHistory(directory(t), () => at + 10 * minute);
  history.record(account, usage());
  for (const patch of [
    { stale: true },
    { status: "error" as const, issue: "identity-mismatch" as const },
    { accountId: "different-profile" },
  ]) {
    const unverified = { ...usage(at + minute), ...patch };
    unverified.fiveHour!.resetsAt = "2026-10-13T14:00:00.000Z";
    history.record(account, unverified);
  }
  assert.equal(
    history.lastKnownResets(account)?.fiveHour?.resetsAt,
    fiveHourReset,
  );
});

test("expired retention and unavailable ledgers cannot supply reset metadata", (t) => {
  const root = directory(t);
  let now = at;
  const history = new UsageHistory(root, () => now);
  history.record(account, usage());
  now += 14 * 86_400_000 + 1;
  assert.equal(history.lastKnownResets(account), undefined);
  assert.equal(
    new UsageHistory(root, () => now).lastKnownResets(account),
    undefined,
  );
  fs.writeFileSync(history.file, "broken history");
  assert.equal(
    new UsageHistory(root, () => at).lastKnownResets(account),
    undefined,
  );
});

test("past reset metadata stays available as history and returned objects cannot mutate the ledger", (t) => {
  const history = new UsageHistory(directory(t), () => at + 6 * 60 * minute);
  history.record(account, usage());
  const dates = history.lastKnownResets(account)!;
  assert.equal(dates.fiveHour?.resetsAt, fiveHourReset);
  dates.fiveHour!.resetsAt = "2099-01-01T00:00:00.000Z";
  assert.equal(
    history.lastKnownResets(account)?.fiveHour?.resetsAt,
    fiveHourReset,
  );
});
