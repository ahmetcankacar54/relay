import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../electron/core/store";
import { UsageManager } from "../electron/core/usage";
import { UsageError } from "../electron/core/usage-credentials";
import {
  USAGE_ISSUE_LOG_LIMIT,
  appendUsageIssue,
} from "../electron/core/usage-issue-log";
import type { Account, UsageIssue } from "../shared/types";

const START = Date.parse("2026-10-17T09:00:00Z");
const MINUTE = 60_000;
const SECRET = "fixture-usage-issue-secret";

function directory(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-usage-issues-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const readLog = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

test("the log keeps a version and the entries it was given, with the time of each", (t) => {
  const file = path.join(directory(t), "usage-issues.json");
  appendUsageIssue(file, { accountId: "a", issue: "expired" }, START);
  appendUsageIssue(file, { accountId: "b", issue: "scope" }, START + MINUTE);
  assert.deepEqual(readLog(file), {
    version: 1,
    entries: [
      { accountId: "a", issue: "expired", at: new Date(START).toISOString() },
      {
        accountId: "b",
        issue: "scope",
        at: new Date(START + MINUTE).toISOString(),
      },
    ],
  });
  // Private to the owner, like the other Relay journals.
  if (process.platform !== "win32")
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("the log keeps only the newest 200 entries", (t) => {
  assert.equal(USAGE_ISSUE_LOG_LIMIT, 200);
  const file = path.join(directory(t), "usage-issues.json");
  for (let i = 0; i < USAGE_ISSUE_LOG_LIMIT + 25; i++)
    appendUsageIssue(
      file,
      { accountId: `account-${i}`, issue: "unavailable" },
      START + i * MINUTE,
    );
  const { entries } = readLog(file);
  assert.equal(entries.length, USAGE_ISSUE_LOG_LIMIT);
  assert.equal(entries[0].accountId, "account-25");
  assert.equal(
    entries.at(-1).accountId,
    `account-${USAGE_ISSUE_LOG_LIMIT + 24}`,
  );
});

test("a missing, corrupt or wrongly shaped log starts over and a write failure is swallowed", (t) => {
  const root = directory(t);
  const missing = path.join(root, "missing", "usage-issues.json");
  // The directory does not exist: the write fails and nothing is thrown.
  assert.doesNotThrow(() =>
    appendUsageIssue(missing, { accountId: "a", issue: "expired" }, START),
  );
  assert.equal(fs.existsSync(missing), false);
  for (const content of [
    "{not json",
    "",
    "[]",
    JSON.stringify({ version: 2, entries: [] }),
    JSON.stringify({ version: 1, entries: "nope" }),
  ]) {
    const file = path.join(root, "usage-issues.json");
    fs.writeFileSync(file, content);
    appendUsageIssue(file, { accountId: "a", issue: "expired" }, START);
    assert.deepEqual(readLog(file).entries, [
      { accountId: "a", issue: "expired", at: new Date(START).toISOString() },
    ]);
  }
  // Entries that are not well formed are dropped, the rest are kept.
  const file = path.join(root, "partial.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      entries: [
        { accountId: "keep", issue: "scope", at: "2026-10-16T00:00:00.000Z" },
        { accountId: 7, issue: "scope", at: "x" },
        null,
      ],
    }),
  );
  appendUsageIssue(file, { accountId: "a", issue: "expired" }, START);
  assert.deepEqual(
    readLog(file).entries.map((entry: any) => entry.accountId),
    ["keep", "a"],
  );
});

test("the log holds only the account, the issue and the time, never a credential", (t) => {
  const file = path.join(directory(t), "usage-issues.json");
  const hostile = {
    accountId: "a",
    issue: "expired",
    accessToken: SECRET,
    refreshToken: SECRET,
  } as { accountId: string; issue: UsageIssue };
  appendUsageIssue(file, hostile, START);
  assert.equal(fs.readFileSync(file, "utf8").includes(SECRET), false);
  assert.deepEqual(Object.keys(readLog(file).entries[0]).sort(), [
    "accountId",
    "at",
    "issue",
  ]);
});

function pollingFixture(
  t: any,
  onIssue: (account: Account, issue: UsageIssue) => void,
) {
  const store = new Store(directory(t));
  const created = store.create({ name: "A", kind: "personal" });
  store.update((s) => {
    s.accounts[0].auth = {
      loggedIn: true,
      email: "a@example.test",
      checkedAt: new Date(START).toISOString(),
    };
  });
  let now = START;
  let failure: UsageIssue | undefined;
  const manager = new UsageManager(
    store,
    async () => {
      if (failure) throw new UsageError(failure);
      return { accessToken: SECRET, scopes: ["user:profile"] };
    },
    async (endpoint) =>
      endpoint === "profile"
        ? { account: { email: "a@example.test" } }
        : {
            five_hour: {
              utilization: 10,
              resets_at: new Date(START + 4 * 60 * MINUTE).toISOString(),
            },
          },
    () => now,
    undefined,
    undefined,
    undefined,
    onIssue,
  );
  return {
    id: created.id,
    manager,
    /** Wait out the failure backoff, then poll once. */
    poll: async (next: UsageIssue | undefined) => {
      now += 31 * MINUTE;
      failure = next;
      return manager.refresh(created.id);
    },
    pollWithinBackoff: () => {
      now += 1_000;
      return manager.refresh(created.id);
    },
  };
}

test("onIssue fires once per change of issue, not on every failed poll", async (t) => {
  const seen: [string, UsageIssue][] = [];
  const f = pollingFixture(t, (account, issue) =>
    seen.push([account.id, issue]),
  );
  assert.equal((await f.poll("expired")).issue, "expired");
  assert.deepEqual(seen, [[f.id, "expired"]]);
  // The same issue on later failed polls is not reported again.
  assert.equal((await f.poll("expired")).issue, "expired");
  assert.equal((await f.poll("expired")).issue, "expired");
  assert.equal(seen.length, 1);
  // A poll inside the backoff does not run, so it reports nothing either.
  await f.pollWithinBackoff();
  assert.equal(seen.length, 1);
  // A different issue is a change.
  assert.equal((await f.poll("scope")).issue, "scope");
  assert.deepEqual(seen.at(-1), [f.id, "scope"]);
  assert.equal(seen.length, 2);
  // A good poll reports nothing, and the same issue after it is a new change.
  assert.equal((await f.poll(undefined)).status, "ready");
  assert.equal(seen.length, 2);
  assert.equal((await f.poll("scope")).issue, "scope");
  assert.equal(seen.length, 3);
  assert.deepEqual(
    seen.map(([, issue]) => issue),
    ["expired", "scope", "scope"],
  );
});

test("onIssue sees the account and the issue, never a credential, and a throwing log does not break polling", async (t) => {
  const received: unknown[][] = [];
  const f = pollingFixture(t, (...args) => {
    received.push(args);
    throw new Error("fixture disk failure");
  });
  assert.equal(
    (await f.poll("credentials-missing")).issue,
    "credentials-missing",
  );
  assert.equal(received.length, 1);
  assert.equal(JSON.stringify(received).includes(SECRET), false);
  // The manager still answers and keeps polling after the failed write.
  assert.equal((await f.poll(undefined)).status, "ready");
});

test("main logs usage issues to usage-issues.json in the user data folder", () => {
  const main = fs.readFileSync(
    new URL("../electron/main.ts", import.meta.url),
    "utf8",
  );
  assert.match(main, /from "\.\/core\/usage-issue-log"/);
  assert.match(
    main,
    /path\.join\(app\.getPath\("userData"\), "usage-issues\.json"\)/,
  );
  assert.match(
    main,
    /appendUsageIssue\(\s*path\.join\(app\.getPath\("userData"\), "usage-issues\.json"\),\s*\{ accountId: account\.id, issue \},\s*Date\.now\(\),?\s*\)/,
  );
});
