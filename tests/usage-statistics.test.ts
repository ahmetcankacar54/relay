import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageHistory } from "../electron/core/usage-history";
import { UsageManager } from "../electron/core/usage";
import { UsageError } from "../electron/core/usage-credentials";
import { Store } from "../electron/core/store";
import {
  MAX_USAGE_GAP_MS,
  MAX_USAGE_SAMPLES,
  USAGE_HISTORY_DAYS,
  usageIdentity,
  usageSample,
  type UsageSample,
} from "../shared/usage-statistics";
import type { Account, AccountUsage } from "../shared/types";
import { foldSamples, type UsageRollups } from "../shared/usage-rollups";

const start = Date.parse("2026-10-13T08:00:00.000Z");
const reset = "2026-10-13T13:00:00.000Z";
const week = "2026-10-19T13:00:00.000Z";
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
function usage(
  at: number,
  usedPercent: number,
  resetsAt: string | undefined = reset,
): AccountUsage {
  return {
    accountId: account.id,
    status: "ready",
    stale: false,
    checkedAt: new Date(at).toISOString(),
    fiveHour: { usedPercent, resetsAt },
    sevenDay: { usedPercent: 15, resetsAt: week },
  };
}
function sample(
  at: number,
  usedPercent: number,
  resetsAt: string | undefined = reset,
): UsageSample {
  return usageSample(account, usage(at, usedPercent, resetsAt))!;
}
// The points rule now lives in the rollups; these totals sum one identity.
function totals(r: UsageRollups, identity = usageIdentity(account)!) {
  const hours = Object.values(r.hours[identity] ?? {});
  return {
    observedFiveHourPoints:
      Math.round(hours.reduce((sum, h) => sum + h.points, 0) * 100) / 100,
    windowsObserved: r.windows[identity]?.length ?? 0,
    coveredMinutes: Math.round(
      hours.reduce((sum, h) => sum + h.coveredMinutes, 0),
    ),
  };
}
function stats(samples: UsageSample[], now = start + 60 * minute) {
  return totals(foldSamples(samples, now));
}
function directory(t: any) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-usage-statistics-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("statistics count observed increases with an explicit baseline and covered minutes", () => {
  const result = stats([
    sample(start, 20),
    sample(start + 5 * minute, 25.2),
    sample(start + 10 * minute, 31.3),
  ]);
  assert.equal(result.observedFiveHourPoints, 11.3);
  assert.equal(result.windowsObserved, 1);
  assert.equal(result.coveredMinutes, 10);
  assert.equal(stats([sample(start, 80)]).observedFiveHourPoints, 0);
});
test("corrections never lower the running baseline and inflate later increases", () => {
  const result = stats([
    sample(start, 20),
    sample(start + 5 * minute, 10),
    sample(start + 10 * minute, 15),
    sample(start + 15 * minute, 25),
    sample(start + 20 * minute, 25),
  ]);
  assert.equal(result.observedFiveHourPoints, 5);
});
test("a reset is a new baseline even if its starting utilization is higher", () => {
  const result = stats([
    sample(start, 20),
    sample(start + 5 * minute, 25),
    sample(start + 10 * minute, 50, "2026-10-13T13:10:00.000Z"),
    sample(start + 15 * minute, 53, "2026-10-13T13:10:00.000Z"),
  ]);
  assert.equal(result.observedFiveHourPoints, 8);
  assert.equal(result.windowsObserved, 2);
  assert.equal(result.coveredMinutes, 10);
});
test("gaps longer than 35 minutes do not invent unobserved usage", () => {
  assert.equal(
    stats([sample(start, 10), sample(start + MAX_USAGE_GAP_MS, 15)])
      .observedFiveHourPoints,
    5,
  );
  assert.equal(
    stats([sample(start, 10), sample(start + MAX_USAGE_GAP_MS + 1, 15)])
      .observedFiveHourPoints,
    0,
  );
  assert.equal(
    stats([
      sample(start, 10),
      sample(start + 40 * minute, 50),
      sample(start + 45 * minute, 53),
    ]).observedFiveHourPoints,
    3,
  );
});
test("missing, expired, and implausible reset timestamps cannot form usage deltas", () => {
  for (const resetsAt of [
    undefined,
    new Date(start).toISOString(),
    new Date(start + 6 * 60 * minute).toISOString(),
  ]) {
    const a = sample(start, 10);
    const b = sample(start + 5 * minute, 50);
    a.fiveHour!.resetsAt = resetsAt;
    b.fiveHour!.resetsAt = resetsAt;
    const result = stats([a, b]);
    assert.equal(result.observedFiveHourPoints, 0);
    assert.equal(result.coveredMinutes, 0);
    assert.equal(result.windowsObserved, 0);
  }
});
test("a long gap does not count a rebound twice", () => {
  assert.equal(
    stats([
      sample(start, 20),
      sample(start + 5 * minute, 50),
      sample(start + 45 * minute, 10),
      sample(start + 50 * minute, 20),
    ]).observedFiveHourPoints,
    30,
  );
});
test("duplicate timestamps and temporarily missing windows never inflate totals", () => {
  const duplicate = sample(start, 5);
  duplicate.checkedAt = duplicate.checkedAt.replace(".000Z", "Z");
  const missing = sample(start + 10 * minute, 50);
  delete missing.fiveHour;
  const result = stats([
    sample(start, 20),
    duplicate,
    sample(start + 5 * minute, 50),
    missing,
    sample(start + 15 * minute, 10),
    sample(start + 20 * minute, 20),
  ]);
  assert.equal(result.observedFiveHourPoints, 30);
  assert.equal(result.coveredMinutes, 10);
});
test("stable identity isolates organizations/accounts while UUID survives email changes", () => {
  const values = [sample(start, 10), sample(start + 5 * minute, 20)];
  const rollups = foldSamples(values, start + 10 * minute);
  const alteredEmail = {
    ...account,
    auth: { ...account.auth!, email: "new@example.test" },
  };
  assert.equal(
    totals(rollups, usageIdentity(alteredEmail)).observedFiveHourPoints,
    10,
  );
  for (const change of [
    { accountUuid: "other-account" },
    { orgId: "other-org" },
    { orgId: undefined },
    { loggedIn: false },
  ]) {
    const changed = { ...account, auth: { ...account.auth!, ...change } };
    const identity = usageIdentity(changed);
    assert.notEqual(identity, usageIdentity(account));
    if (identity) assert.equal(rollups.hours[identity], undefined);
  }
  const legacy = {
    ...account,
    auth: {
      ...account.auth!,
      accountUuid: undefined,
      email: " A@EXAMPLE.TEST ",
    },
  };
  assert.equal(
    usageIdentity(legacy),
    usageIdentity({
      ...legacy,
      auth: { ...legacy.auth, email: "a@example.test" },
    }),
  );
});
test("only fresh ready verified usage produces normalized metadata samples", () => {
  for (const change of [
    { status: "error" as const },
    { status: "loading" as const },
    { stale: true },
    { issue: "identity-mismatch" as const },
    { accountId: "other-slot" },
    { checkedAt: "invalid" },
  ])
    assert.equal(
      usageSample(account, { ...usage(start, 10), ...change }),
      undefined,
    );
  assert.equal(
    usageSample({ ...account, auth: undefined }, usage(start, 10)),
    undefined,
  );
  assert.equal(
    usageSample(
      { ...account, auth: { ...account.auth!, orgId: undefined } },
      usage(start, 10),
    ),
    undefined,
  );
  const equivalent = usageSample(
    account,
    usage(start, 10, "2026-10-13T16:00:00+03:00"),
  )!;
  assert.equal(equivalent.fiveHour?.resetsAt, reset);
  assert.equal(
    usageSample(account, {
      ...usage(start, 10),
      fiveHour: { usedPercent: NaN },
      sevenDay: undefined,
    }),
    undefined,
  );
});
test("history persists privately, reloads, and rejects duplicate/out-of-order/future samples", (t) => {
  const root = directory(t);
  const now = start + 60 * minute;
  const history = new UsageHistory(root, () => now);
  history.record(account, usage(start, 10));
  history.record(account, usage(start + 5 * minute, 20));
  history.record(account, usage(start + 5 * minute, 90));
  history.record(account, usage(start - minute, 0));
  history.record(account, usage(now + minute, 100));
  const restored = new UsageHistory(root, () => now);
  assert.equal(restored.historyAvailable, true);
  assert.equal(
    JSON.parse(fs.readFileSync(restored.file, "utf8")).samples.length,
    2,
  );
  assert.equal(totals(restored.rollups()!).observedFiveHourPoints, 10);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(history.file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  }
  const raw = fs.readFileSync(history.file, "utf8");
  assert.doesNotMatch(raw, /token|message|credential|name|subscription/);
  assert.deepEqual(fs.readdirSync(root).sort(), [
    "usage-history.json",
    "usage-rollups.json",
  ]);
  assert.doesNotMatch(
    fs.readFileSync(path.join(root, "usage-rollups.json"), "utf8"),
    /token|message|credential|name|subscription/,
  );
});
test("14-day retention and maximum sample count are bounded on load and next write", (t) => {
  const root = directory(t);
  let now = start;
  const oldest = now - USAGE_HISTORY_DAYS * day;
  // 50,000 samples 20 seconds apart fit inside the retention window.
  const step = 20_000;
  const fiveHours = 5 * 60 * minute;
  const values = Array.from({ length: MAX_USAGE_SAMPLES }, (_, index) => {
    const at = oldest + 5 * minute + index * step;
    return sample(
      at,
      10,
      new Date(at - ((at - oldest) % fiveHours) + fiveHours).toISOString(),
    );
  });
  values[0].checkedAt = new Date(oldest - 1).toISOString();
  const file = path.join(root, "usage-history.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, samples: values }));
  const history = new UsageHistory(root, () => now);
  history.record(account, usage(now, 20));
  const persisted = JSON.parse(fs.readFileSync(file, "utf8")).samples;
  assert.equal(persisted.length, MAX_USAGE_SAMPLES);
  assert.ok(
    persisted.every((s: UsageSample) => Date.parse(s.checkedAt) >= oldest),
  );
  now += minute;
  history.record(account, usage(now, 50));
  assert.equal(
    JSON.parse(fs.readFileSync(file, "utf8")).samples.length,
    MAX_USAGE_SAMPLES,
  );
  assert.equal(new UsageHistory(root, () => now).historyAvailable, true);
});
test("corrupt or oversized history fails safely without overwriting the evidence", (t) => {
  const root = directory(t);
  const file = path.join(root, "usage-history.json");
  for (const content of [
    "broken JSON",
    JSON.stringify({ version: 2, samples: [] }),
    JSON.stringify({
      version: 1,
      samples: [{ ...sample(start, 10), accessToken: "not-allowed" }],
    }),
    "x".repeat(32 * 1024 * 1024 + 1),
  ]) {
    fs.writeFileSync(file, content);
    const history = new UsageHistory(root, () => start + minute);
    history.record(account, usage(start, 20));
    assert.equal(history.historyAvailable, false);
    assert.equal(fs.readFileSync(file, "utf8"), content);
  }
});
test("symlink files and roots fail closed; write never follows a substituted symlink", (t) => {
  const root = directory(t);
  const foreign = path.join(root, "foreign.json");
  const foreignContent = JSON.stringify({ version: 1, samples: [] });
  fs.writeFileSync(foreign, foreignContent);
  const file = path.join(root, "usage-history.json");
  fs.symlinkSync(foreign, file);
  const linked = new UsageHistory(root, () => start + minute);
  linked.record(account, usage(start, 10));
  assert.equal(linked.historyAvailable, false);
  assert.equal(fs.readFileSync(foreign, "utf8"), foreignContent);
  fs.unlinkSync(file);
  const substituted = new UsageHistory(root, () => start + minute);
  fs.symlinkSync(foreign, file);
  substituted.record(account, usage(start, 10));
  assert.equal(substituted.historyAvailable, false);
  assert.equal(fs.readFileSync(foreign, "utf8"), foreignContent);
  const linkedRoot = path.join(root, "linked-root");
  fs.symlinkSync(root, linkedRoot);
  assert.equal(
    new UsageHistory(linkedRoot, () => start).historyAvailable,
    false,
  );
});
test("identity replacement does not inherit the earlier login's statistics", (t) => {
  const history = new UsageHistory(directory(t), () => start + 10 * minute);
  history.record(account, usage(start, 10));
  history.record(account, usage(start + 5 * minute, 20));
  const different = {
    ...account,
    auth: { ...account.auth!, accountUuid: "new-account" },
  };
  history.record(different, usage(start + 10 * minute, 90));
  const rollups = history.rollups()!;
  assert.equal(
    totals(rollups, usageIdentity(different)).observedFiveHourPoints,
    0,
  );
  assert.equal(totals(rollups).observedFiveHourPoints, 10);
});
test("UsageManager emits only successfully identity-verified fresh polls and tolerates recorder failures", async (t) => {
  const store = new Store(directory(t));
  const a = store.create({ name: "A", kind: "personal" });
  store.update((s) => {
    s.accounts[0].auth = {
      loggedIn: true,
      email: "a@example.test",
      checkedAt: new Date(start).toISOString(),
    };
  });
  let now = start;
  let mismatch = false;
  const received: AccountUsage[] = [];
  const manager = new UsageManager(
    store,
    async () => ({ accessToken: "fixture-only", scopes: ["user:profile"] }),
    async (endpoint) =>
      endpoint === "profile"
        ? {
            account: {
              email: mismatch ? "wrong@example.test" : "a@example.test",
            },
          }
        : { five_hour: { utilization: 10, resets_at: reset } },
    () => now,
    (_account, value) => {
      received.push(value);
      throw new Error("fixture disk failure");
    },
  );
  assert.equal((await manager.refresh(a.id)).status, "ready");
  assert.equal(received.length, 1);
  now += minute;
  mismatch = true;
  assert.equal((await manager.refresh(a.id)).issue, "identity-mismatch");
  assert.equal(received.length, 1);
});
test("post-request quota verification bypasses only a successful client cooldown, never 429 or failure backoff", async (t) => {
  const store = new Store(directory(t));
  const a = store.create({ name: "A", kind: "personal" });
  store.update((s) => {
    s.accounts[0].auth = {
      loggedIn: true,
      email: "a@example.test",
      checkedAt: new Date(start).toISOString(),
    };
  });
  let now = start;
  let calls = 0;
  let issue: "rate-limited" | "unavailable" | undefined;
  const prompts: boolean[] = [];
  const manager = new UsageManager(
    store,
    async (_profile, allowPrompt) => {
      prompts.push(allowPrompt);
      return { accessToken: "fixture-only", scopes: ["user:profile"] };
    },
    async (endpoint) => {
      if (endpoint === "profile")
        return { account: { email: "a@example.test" } };
      calls++;
      if (issue)
        throw new UsageError(
          issue,
          issue === "rate-limited" ? now + 10 * minute : undefined,
        );
      return {
        five_hour: {
          utilization: calls === 1 ? 0 : 1,
          resets_at: calls === 1 ? null : reset,
        },
      };
    },
    () => now,
  );
  assert.equal((await manager.refresh(a.id)).fiveHour?.resetsAt, undefined);
  now += 1_000;
  assert.equal((await manager.refresh(a.id)).fiveHour?.resetsAt, undefined);
  assert.equal(calls, 1);
  const after = await manager.refreshAfterRequest(a.id);
  assert.equal(after.fiveHour?.resetsAt, reset);
  assert.equal(after.checkedAt, new Date(now).toISOString());
  assert.equal(calls, 2);
  issue = "rate-limited";
  const throttled = await manager.refreshAfterRequest(a.id);
  assert.equal(throttled.issue, "rate-limited");
  assert.equal(calls, 3);
  assert.equal(
    (await manager.refreshAfterRequest(a.id)).retryAt,
    throttled.retryAt,
  );
  assert.equal(calls, 3);
  manager.invalidate(a.id);
  await manager.refreshAfterRequest(a.id);
  assert.equal(calls, 3);
  now += 11 * minute;
  issue = "unavailable";
  const failed = await manager.refreshAfterRequest(a.id);
  assert.equal(failed.issue, "unavailable");
  assert.equal(calls, 4);
  assert.equal(
    (await manager.refreshAfterRequest(a.id)).retryAt,
    failed.retryAt,
  );
  assert.equal(calls, 4);
  assert.ok(prompts.every((allowPrompt) => allowPrompt === false));
});
test("post-request refresh joins an in-flight verified read without issuing another poll", async (t) => {
  const store = new Store(directory(t));
  const a = store.create({ name: "A", kind: "personal" });
  store.update((s) => {
    s.accounts[0].auth = {
      loggedIn: true,
      email: "a@example.test",
      checkedAt: new Date(start).toISOString(),
    };
  });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const manager = new UsageManager(
    store,
    async () => ({ accessToken: "fixture-only", scopes: ["user:profile"] }),
    async (endpoint) => {
      if (endpoint === "profile")
        return { account: { email: "a@example.test" } };
      calls++;
      await hold;
      return { five_hour: { utilization: 1, resets_at: reset } };
    },
    () => start,
  );
  const first = manager.refresh(a.id);
  const second = manager.refreshAfterRequest(a.id);
  assert.equal(first, second);
  release();
  await first;
  assert.equal(calls, 1);
});
