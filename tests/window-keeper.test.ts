import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  KEEPER_COOLDOWN_MS,
  KEEPER_DAILY_LIMIT,
  WindowKeeper,
  type KeeperDeps,
} from "../electron/core/window-keeper";
import { wallTime } from "../shared/planning";
import {
  DEFAULT_PLANNING,
  type Account,
  type AccountUsage,
  type PlanningSettings,
} from "../shared/types";

const ZONE = "Europe/Istanbul";
const at = (clock: string, date = "2026-10-13") => wallTime(date, clock, ZONE)!;
function account(name: string): Account {
  const id = randomUUID();
  return {
    id,
    name,
    kind: "personal",
    group: "personal",
    color: "olive",
    createdAt: new Date(at("00:00")).toISOString(),
    auth: {
      loggedIn: true,
      accountUuid: randomUUID(),
      orgId: randomUUID(),
      checkedAt: new Date(at("00:00")).toISOString(),
    },
  };
}
function setup(accounts = [account("A")]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-keeper-"));
  const clock = { now: at("10:00") };
  const usage: Record<string, AccountUsage> = {};
  const fresh = (a: Account, resetsAt?: number): AccountUsage => ({
    accountId: a.id,
    status: "ready",
    stale: false,
    checkedAt: new Date(clock.now - 60_000).toISOString(),
    fiveHour: {
      usedPercent: resetsAt ? 10 : 0,
      ...(resetsAt ? { resetsAt: new Date(resetsAt).toISOString() } : {}),
    },
  });
  for (const a of accounts) usage[a.id] = fresh(a);
  const settings: PlanningSettings = {
    ...DEFAULT_PLANNING,
    autoStart: true,
    timeZone: ZONE,
    weekday: { enabled: true, start: "09:00", end: "21:00" },
    weekend: { enabled: true, start: "09:00", end: "21:00" },
    accounts: accounts.map((a) => ({ id: a.id })),
  };
  const calls = {
    starts: [] as string[],
    refreshes: [] as string[],
    notes: [] as string[],
    fail: undefined as Error | undefined,
    refreshFails: false,
    blocked: false,
    busy: [] as string[],
  };
  const deps: KeeperDeps = {
    directory,
    now: () => clock.now,
    state: () => ({
      settings,
      accounts,
      usage,
      blocked: calls.blocked,
      busyAccountIds: calls.busy,
    }),
    refresh: async (id) => {
      calls.refreshes.push(id);
      if (calls.refreshFails) throw new Error("offline");
      const a = accounts.find((x) => x.id === id)!;
      usage[id] = fresh(
        a,
        Date.parse(usage[id]?.fiveHour?.resetsAt ?? "") || undefined,
      );
      return usage[id];
    },
    refreshAfterStart: async (id) => {
      const a = accounts.find((x) => x.id === id)!;
      usage[id] = fresh(a, clock.now + 5 * 3_600_000);
      return usage[id];
    },
    start: async (a) => {
      calls.starts.push(a.id);
      if (calls.fail) throw calls.fail;
    },
    notify: (a, reason) => calls.notes.push(`${a.name}:${reason}`),
    changed: () => {},
  };
  return { directory, clock, usage, settings, calls, deps, accounts, fresh };
}

test("off and outside work hours never start", async () => {
  const f = setup();
  f.settings.autoStart = false;
  const keeper = new WindowKeeper(f.deps);
  await keeper.tick();
  assert.equal(keeper.snapshot().accounts[0].state, "off");
  f.settings.autoStart = true;
  f.clock.now = at("05:00");
  await keeper.tick();
  const status = keeper.snapshot().accounts[0];
  assert.equal(status.state, "outside");
  assert.equal(status.nextStartAt, new Date(at("06:30")).toISOString());
  assert.deepEqual(f.calls.starts, []);
});

test("a due account is started once and verified; an active window is left alone", async () => {
  const f = setup();
  const keeper = new WindowKeeper(f.deps);
  await keeper.tick();
  assert.deepEqual(f.calls.starts, [f.accounts[0].id]);
  const snapshot = keeper.snapshot();
  assert.equal(snapshot.attempts[0].status, "verified");
  assert.equal(snapshot.accounts[0].state, "active");
  await keeper.tick();
  assert.equal(f.calls.starts.length, 1);
});

test("stale usage is refreshed before deciding; a failing refresh waits without starting", async () => {
  const f = setup();
  const a = f.accounts[0];
  f.usage[a.id] = {
    ...f.usage[a.id],
    checkedAt: new Date(f.clock.now - 10 * 60_000).toISOString(),
  };
  f.calls.refreshFails = true;
  const keeper = new WindowKeeper(f.deps);
  await keeper.tick();
  assert.deepEqual(f.calls.refreshes, [a.id]);
  assert.deepEqual(f.calls.starts, []);
  assert.equal(keeper.snapshot().accounts[0].reason, "usage-stale");
  f.calls.refreshFails = false;
  await keeper.tick();
  assert.deepEqual(f.calls.starts, [a.id]);
});

test("a failure is reported once an hour and retried only after the cooldown", async () => {
  const f = setup();
  f.calls.fail = new Error("routine-request-failed");
  const keeper = new WindowKeeper(f.deps);
  await keeper.tick();
  assert.equal(keeper.snapshot().attempts[0].status, "failed");
  assert.equal(keeper.snapshot().accounts[0].reason, "cooldown");
  f.clock.now += KEEPER_COOLDOWN_MS - 1000;
  await keeper.tick();
  assert.equal(f.calls.starts.length, 1);
  f.clock.now += 2000;
  await keeper.tick();
  assert.equal(f.calls.starts.length, 2);
  assert.equal(f.calls.notes.length, 1);
});

test("at most the daily limit of attempts per account", async () => {
  const f = setup();
  f.calls.fail = new Error("routine-request-failed");
  const keeper = new WindowKeeper(f.deps);
  for (let i = 0; i < KEEPER_DAILY_LIMIT + 3; i++) {
    await keeper.tick();
    f.clock.now += KEEPER_COOLDOWN_MS + 1000;
  }
  assert.equal(f.calls.starts.length, KEEPER_DAILY_LIMIT);
  assert.equal(keeper.snapshot().accounts[0].reason, "daily-limit");
});

test("one start per tick; blocked Relay, busy accounts and full weeks wait", async () => {
  const f = setup([account("A"), account("B")]);
  const [a, b] = f.accounts;
  const keeper = new WindowKeeper(f.deps);
  f.calls.blocked = true;
  await keeper.tick();
  assert.deepEqual(f.calls.starts, []);
  assert.equal(keeper.snapshot().accounts[0].reason, "relay-busy");
  f.calls.blocked = false;
  f.calls.busy = [a.id];
  f.usage[b.id] = { ...f.usage[b.id], sevenDay: { usedPercent: 100 } };
  await keeper.tick();
  assert.deepEqual(f.calls.starts, []);
  assert.equal(keeper.snapshot().accounts[0].reason, "in-use");
  assert.equal(keeper.snapshot().accounts[1].reason, "weekly-limit");
  f.calls.busy = [];
  f.usage[b.id] = f.fresh(b);
  await keeper.tick();
  assert.deepEqual(f.calls.starts, [a.id]);
  await keeper.tick();
  assert.deepEqual(f.calls.starts, [a.id, b.id]);
});

test("an interrupted attempt is never resent and counts toward the cooldown", async () => {
  const f = setup();
  const a = f.accounts[0];
  fs.mkdirSync(f.directory, { recursive: true });
  fs.writeFileSync(
    path.join(f.directory, "attempts.json"),
    JSON.stringify({
      version: 1,
      attempts: [
        {
          id: randomUUID(),
          accountId: a.id,
          identityKey: `${a.auth!.accountUuid}:${a.auth!.orgId}`,
          at: new Date(f.clock.now - 60_000).toISOString(),
          status: "started",
        },
      ],
    }),
  );
  const keeper = new WindowKeeper(f.deps);
  assert.equal(keeper.snapshot().attempts[0].status, "failed");
  assert.equal(keeper.snapshot().attempts[0].reason, "interrupted");
  await keeper.tick();
  assert.deepEqual(f.calls.starts, []);
});

test("a future attempt time does not block; deleted planned accounts are ignored", async () => {
  const f = setup();
  const a = f.accounts[0];
  f.settings.accounts.push({ id: randomUUID() });
  fs.writeFileSync(
    path.join(f.directory, "attempts.json"),
    JSON.stringify({
      version: 1,
      attempts: [
        {
          id: randomUUID(),
          accountId: a.id,
          identityKey: `${a.auth!.accountUuid}:${a.auth!.orgId}`,
          at: new Date(f.clock.now + 3 * 3_600_000).toISOString(),
          status: "failed",
          reason: "routine-request-failed",
        },
      ],
    }),
  );
  const keeper = new WindowKeeper(f.deps);
  await keeper.tick();
  assert.deepEqual(f.calls.starts, [a.id]);
  assert.equal(keeper.snapshot().accounts.length, 1);
});

test("a deleted planned account takes no slot in the staggering or today's count", async () => {
  const f = setup();
  f.settings.accounts.push({ id: randomUUID() });
  f.clock.now = at("05:30");
  const keeper = new WindowKeeper(f.deps);
  await keeper.tick();
  const status = keeper.snapshot().accounts[0];
  assert.equal(status.state, "outside");
  assert.equal(status.nextStartAt, new Date(at("06:30")).toISOString());
  assert.equal(keeper.snapshot().plannedToday, 3);
});

test("local administrator policy stops the account until the plan changes", async () => {
  const f = setup();
  f.calls.fail = new Error("routine-policy-unverified");
  const keeper = new WindowKeeper(f.deps);
  for (let i = 0; i < 5; i++) {
    await keeper.tick();
    f.clock.now += KEEPER_COOLDOWN_MS + 1000;
  }
  assert.equal(f.calls.starts.length, 1);
  assert.equal(f.calls.notes.length, 1);
  const status = keeper.snapshot().accounts[0];
  assert.equal(status.state, "blocked");
  assert.equal(status.reason, "routine-policy-unverified");
  // A restart keeps the stop; changing the plan lets it try again.
  const restarted = new WindowKeeper(f.deps);
  await restarted.tick();
  assert.equal(f.calls.starts.length, 1);
  f.calls.fail = undefined;
  restarted.resume();
  await restarted.tick();
  assert.equal(f.calls.starts.length, 2);
});
