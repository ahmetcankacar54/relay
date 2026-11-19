import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../electron/core/store";
import { UsageManager } from "../electron/core/usage";
import { UsageError } from "../electron/core/usage-credentials";
import {
  RENEW_BEFORE_MS,
  RENEW_RETRY_MS,
  SignInRenewal,
  renewalDue,
  type RenewalResult,
} from "../electron/core/sign-in-renewal";
import { approvalStep } from "../electron/core/quiet-approval";
import { SIGN_IN_ENDED } from "../electron/core/usage-refresh";
import { cliNeedsReconnect } from "../shared/account-state";
import type { Account, AccountUsage, UsageIssue } from "../shared/types";

const START = Date.parse("2026-11-19T05:30:00Z");
const DAY = 86_400_000;
const UUID = "aaaaaaaa-1111-4111-8111-111111111111";
const ORG = "bbbbbbbb-2222-4222-8222-222222222222";

function directory(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-renewal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function account(over: Partial<Account> = {}): Account {
  return {
    id: "acc-1",
    name: "Vertex",
    kind: "work",
    color: "#000",
    createdAt: new Date(START).toISOString(),
    auth: { loggedIn: true, email: "a@example.test", accountUuid: UUID, orgId: ORG, checkedAt: new Date(START).toISOString() },
    desktop: { accountUuid: UUID, orgId: ORG, savedAt: new Date(START).toISOString() },
    ...over,
  } as Account;
}

function usageFixture(t: any, cli: () => Promise<unknown>, app?: (account: Account, allowPrompt: boolean) => Promise<unknown>) {
  const store = new Store(directory(t));
  const created = store.create({ name: "Vertex", kind: "work" });
  store.update((s) => {
    s.accounts[0].auth = { loggedIn: true, email: "a@example.test", accountUuid: UUID, orgId: ORG, checkedAt: new Date(START).toISOString() };
    s.accounts[0].desktop = { accountUuid: UUID, orgId: ORG, savedAt: new Date(START).toISOString() };
  });
  const issues: [UsageIssue, string | undefined][] = [];
  const limits = { five_hour: { utilization: 42, resets_at: new Date(START + 3_600_000).toISOString() } };
  const manager = new UsageManager(
    store,
    cli as never,
    async (endpoint) =>
      endpoint === "profile" ? { account: { uuid: UUID, email: "a@example.test" }, organization: { uuid: ORG } } : limits,
    () => START,
    undefined,
    undefined,
    undefined,
    (_a, issue, detail) => issues.push([issue, detail]),
    app ? { usable: () => true, read: app } : undefined,
  );
  return { id: created.id, manager, issues, store, limits };
}

test("a read through the Claude Code sign-in says when that sign-in ends", async (t) => {
  const end = START + 20 * DAY;
  const f = usageFixture(t, async () => ({
    accessToken: "x",
    expiresAt: START + 8 * 3_600_000,
    refreshToken: "r",
    refreshTokenExpiresAt: end,
    scopes: ["user:profile", "user:inference"],
  }));
  const usage = await f.manager.refresh(f.id);
  assert.equal(usage.status, "ready");
  assert.equal(usage.source, "cli");
  assert.equal(usage.cliSignInEndsAt, new Date(end).toISOString());
  assert.equal(usage.cliSignInEnded, undefined);
});

test("an ended Claude Code sign-in reads the limits through the Claude app and still asks for a sign-in", async (t) => {
  const f = usageFixture(
    t,
    async () => {
      throw new UsageError("expired", undefined, SIGN_IN_ENDED);
    },
    async () => ({ five_hour: { utilization: 17, resets_at: new Date(START + 3_600_000).toISOString() } }),
  );
  const usage = await f.manager.refresh(f.id);
  assert.equal(usage.status, "ready");
  assert.equal(usage.issue, undefined);
  assert.equal(usage.source, "desktop");
  assert.equal(usage.cliSignInEnded, true);
  assert.equal(usage.fiveHour?.usedPercent, 17);
  // Logged once, with the reason, so the diagnosis log tells it from a network failure.
  assert.deepEqual(f.issues, [["expired", "refresh: sign-in reached its end date; limits read through the Claude app"]]);
  // The account keeps asking for a new Claude Code sign-in.
  assert.equal(cliNeedsReconnect(f.store.account(f.id), usage), true);
});

test("when the Claude app cannot answer either, the ended sign-in is what the read reports, and it says the end came", async (t) => {
  const f = usageFixture(
    t,
    async () => {
      throw new UsageError("expired", undefined, SIGN_IN_ENDED);
    },
    async () => {
      throw new UsageError("keychain-locked");
    },
  );
  const usage = await f.manager.refresh(f.id);
  assert.equal(usage.status, "error");
  assert.equal(usage.issue, "expired");
  assert.equal(usage.cliSignInEnded, true);
});

test("an expired sign-in for any other reason is not taken for the 30-day end: no read through the app, no end said", async (t) => {
  let appReads = 0;
  const f = usageFixture(
    t,
    async () => {
      throw new UsageError("expired", undefined, "refresh: saved sign-in cannot be renewed");
    },
    async () => {
      appReads++;
      return {};
    },
  );
  const usage = await f.manager.refresh(f.id);
  assert.equal(usage.issue, "expired");
  assert.equal(usage.cliSignInEnded, undefined);
  assert.equal(appReads, 0);
  assert.equal(renewalDue(f.store.account(f.id), usage, START), undefined);
});

test("a read failing for another reason never falls back to the Claude app", async (t) => {
  let appReads = 0;
  const f = usageFixture(
    t,
    async () => {
      throw new UsageError("unavailable");
    },
    async () => {
      appReads++;
      return {};
    },
  );
  assert.equal((await f.manager.refresh(f.id)).issue, "unavailable");
  assert.equal(appReads, 0);
});

test("renewal is due three days before the end, at the end, and never for an account without the Claude app", () => {
  const ends = (ms: number): AccountUsage => ({
    accountId: "acc-1",
    status: "ready",
    stale: false,
    cliSignInEndsAt: new Date(START + ms).toISOString(),
  });
  assert.equal(renewalDue(account(), ends(RENEW_BEFORE_MS + DAY), START), undefined);
  assert.deepEqual(renewalDue(account(), ends(RENEW_BEFORE_MS - 1), START), { endsAt: new Date(START + RENEW_BEFORE_MS - 1).toISOString() });
  assert.deepEqual(renewalDue(account(), { accountId: "acc-1", status: "ready", stale: false, cliSignInEnded: true }, START), {});
  // An "expired" read alone is not the end: only the end said by the read is.
  assert.equal(renewalDue(account(), { accountId: "acc-1", status: "error", stale: false, issue: "expired" }, START), undefined);
  // A Claude Code sign-in of another workspace than the Claude app's is never renewed from it.
  assert.equal(
    renewalDue(account({ desktop: { accountUuid: UUID, orgId: "cccccccc-3333-4333-8333-333333333333", savedAt: new Date(START).toISOString() } }), ends(DAY), START),
    undefined,
  );
  assert.equal(renewalDue(account({ desktop: undefined }), ends(DAY), START), undefined);
  assert.equal(renewalDue(account({ provider: "codex" } as Partial<Account>), ends(DAY), START), undefined);
  assert.equal(renewalDue(account({ auth: undefined }), ends(DAY), START), undefined);
});

function renewalFixture(t: any, outcomes: RenewalResult[], usage: AccountUsage) {
  let now = START;
  const renewed: string[] = [];
  const told: (string | undefined)[] = [];
  const file = path.join(directory(t), "sign-in-renewal.json");
  const renewal = new SignInRenewal({
    file,
    accounts: () => [account()],
    usage: () => usage,
    renew: async (a) => {
      renewed.push(a.id);
      return outcomes.shift() ?? { result: "failed", detail: "no more" };
    },
    notify: (_a, endsAt) => told.push(endsAt),
    now: () => now,
  });
  return { renewal, renewed, told, file, advance: (ms: number) => (now += ms) };
}

test("a failed renewal is said once per end date and retried after six hours", async (t) => {
  const endsAt = new Date(START + 2 * DAY).toISOString();
  const f = renewalFixture(
    t,
    [
      { result: "failed", detail: "no-approval: no approve button" },
      { result: "unavailable", detail: "no claude.ai session" },
    ],
    { accountId: "acc-1", status: "ready", stale: false, cliSignInEndsAt: endsAt },
  );
  await f.renewal.tick();
  assert.deepEqual(f.renewed, ["acc-1"]);
  assert.deepEqual(f.told, [endsAt]);
  // Within the retry delay nothing runs.
  f.advance(RENEW_RETRY_MS - 1);
  await f.renewal.tick();
  assert.equal(f.renewed.length, 1);
  // After it, one more try; the same end date is not said again.
  f.advance(1);
  await f.renewal.tick();
  assert.equal(f.renewed.length, 2);
  assert.deepEqual(f.told, [endsAt]);
  const saved = JSON.parse(fs.readFileSync(f.file, "utf8"));
  assert.equal(saved.accounts["acc-1"].result, "unavailable");
  assert.equal(saved.accounts["acc-1"].detail, "no claude.ai session");
});

test("a renewal that connects tells no one", async (t) => {
  const f = renewalFixture(t, [{ result: "connected" }], {
    accountId: "acc-1",
    status: "ready",
    stale: false,
    cliSignInEndsAt: new Date(START + DAY).toISOString(),
  });
  await f.renewal.tick();
  assert.deepEqual(f.renewed, ["acc-1"]);
  assert.deepEqual(f.told, []);
});

test("the hidden window approves only on claude.ai, only a whole approve label, and stops at a sign-in form", () => {
  const page = (buttons: string[], over: Partial<Parameters<typeof approvalStep>[0]> = {}) => ({
    host: "claude.ai",
    path: "/oauth/authorize",
    loginForm: false,
    buttons: buttons.map((text) => ({ text, disabled: false })),
    ...over,
  });
  assert.deepEqual(approvalStep(page(["Cancel", "Authorize"])), { step: "click", index: 1 });
  assert.deepEqual(approvalStep(page(["İptal", "Yetkilendir"])), { step: "click", index: 1 });
  assert.deepEqual(approvalStep(page(["Continue with Google"])), { step: "wait" });
  assert.deepEqual(approvalStep(page(["Authorize"], { host: "evil.example" })), { step: "wait" });
  assert.deepEqual(approvalStep(page(["Continue with email"], { loginForm: true })), { step: "signed-out" });
  assert.deepEqual(approvalStep(page([], { path: "/login" })), { step: "signed-out" });
  assert.deepEqual(
    approvalStep({ ...page([]), buttons: [{ text: "Authorize", disabled: true }] }),
    { step: "wait" },
  );
});

test("asked by the user, an ended sign-in reads through the Claude app inside the failure backoff, allowed to ask the Keychain", async (t) => {
  const prompts: boolean[] = [];
  let appWorks = false;
  const f = usageFixture(
    t,
    async () => {
      throw new UsageError("expired", undefined, SIGN_IN_ENDED);
    },
    async (_a: unknown, allowPrompt: boolean) => {
      prompts.push(allowPrompt);
      if (!appWorks) throw new UsageError("keychain-locked");
      return { five_hour: { utilization: 5 } };
    },
  );
  assert.equal((await f.manager.refresh(f.id)).issue, "expired");
  appWorks = true;
  // A background poll waits out the backoff.
  assert.equal((await f.manager.refresh(f.id)).issue, "expired");
  const asked = await f.manager.refresh(f.id, true);
  assert.equal(asked.cliSignInEnded, true);
  assert.deepEqual(prompts, [false, true]);
});

test("asked by the user, a renewal runs at once whether due or not and tells no one; an allowed Keychain lets a waiting one run again", async (t) => {
  const f = renewalFixture(
    t,
    [{ result: "unavailable", detail: "claude.ai session not readable: keychain-locked" }, { result: "connected" }, { result: "connected" }],
    { accountId: "acc-1", status: "ready", stale: false, cliSignInEndsAt: new Date(START + DAY).toISOString() },
  );
  await f.renewal.tick();
  assert.equal(f.renewed.length, 1);
  assert.equal(f.told.length, 1);
  // Inside the retry delay, an allowed Keychain runs it again at once.
  await f.renewal.retryUnavailable();
  assert.equal(f.renewed.length, 2);
  // Not due at all: the user's own request still runs, and says nothing.
  const now = await f.renewal.renewNow(account());
  assert.deepEqual(now, { result: "connected" });
  assert.equal(f.renewed.length, 3);
  assert.equal(f.told.length, 1);
});

test("an account waiting for a fresh claude.ai sign-in is said once, looked at again on every pass, and does not hold up the next account", async (t) => {
  let now = START;
  const tried: string[] = [];
  const told: string[] = [];
  const outcomes: Record<string, RenewalResult[]> = {
    first: [{ result: "waiting", detail: "claude.ai sign-in is 120 h old" }, { result: "connected" }],
    second: [{ result: "connected" }],
  };
  const accounts = [account({ id: "first" }), account({ id: "second" })];
  const ends = (days: number): AccountUsage => ({
    accountId: "x",
    status: "ready",
    stale: false,
    cliSignInEndsAt: new Date(START + days * DAY).toISOString(),
  });
  const renewal = new SignInRenewal({
    file: path.join(directory(t), "sign-in-renewal.json"),
    accounts: () => accounts,
    usage: (id) => (id === "first" ? ends(1) : ends(2)),
    renew: async (a) => {
      tried.push(a.id);
      return outcomes[a.id]!.shift()!;
    },
    notify: (a) => told.push(a.id),
    now: () => now,
  });
  await renewal.tick();
  // The first only waits, so the second is renewed in the same pass.
  assert.deepEqual(tried, ["first", "second"]);
  assert.deepEqual(told, ["first"]);
  // Fifteen minutes later, not six hours: the fresh sign-in is used.
  now += 15 * 60_000;
  await renewal.tick();
  assert.deepEqual(tried, ["first", "second", "first"]);
  assert.deepEqual(told, ["first"]);
});

test("a renewal that could not start for a passing reason tells no one and leaves the schedule alone", async (t) => {
  const f = renewalFixture(t, [{ result: "busy", detail: "Claude app busy" }, { result: "connected" }], {
    accountId: "acc-1",
    status: "ready",
    stale: false,
    cliSignInEndsAt: new Date(START + DAY).toISOString(),
  });
  await f.renewal.tick();
  assert.deepEqual(f.told, []);
  // The next pass, minutes later, tries for real.
  f.advance(15 * 60_000);
  await f.renewal.tick();
  assert.equal(f.renewed.length, 2);
  assert.deepEqual(f.told, []);
  const saved = JSON.parse(fs.readFileSync(f.file, "utf8"));
  assert.equal(saved.accounts["acc-1"].result, "connected");
});
