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
  keeperDecision,
  type KeeperDeps,
} from "../electron/core/window-keeper";
import { wallTime } from "../shared/planning";
import { dayPlan, planContext } from "../shared/day-plan";
import { presetTempo, type Tempo } from "../shared/tempo";
import { usageIdentity, type UsageSample } from "../shared/usage-statistics";
import {
  DEFAULT_PLANNING,
  type Account,
  type AccountUsage,
  type PlanningSettings,
} from "../shared/types";
import { planningAccount } from "./planning-fixtures";

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
  const tempo: { value: Tempo } = { value: presetTempo("medium", "default") };
  const calls = {
    starts: [] as string[],
    refreshes: [] as string[],
    notes: [] as string[],
    fail: undefined as Error | undefined,
    refreshFails: false,
    blocked: false,
    busy: [] as string[],
    samples: [] as UsageSample[],
    activeId: undefined as string | undefined,
    adapted: [] as Parameters<NonNullable<KeeperDeps["adapted"]>>[0][],
  };
  const deps: KeeperDeps = {
    directory,
    now: () => clock.now,
    state: () => ({
      settings,
      accounts,
      usage,
      tempo: tempo.value,
      blocked: calls.blocked,
      busyAccountIds: calls.busy,
      recentSamples: calls.samples,
      activeId: calls.activeId,
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
    adapted: (notice) => calls.adapted.push(notice),
    changed: () => {},
  };
  return {
    directory,
    clock,
    usage,
    settings,
    calls,
    deps,
    accounts,
    fresh,
    tempo,
  };
}
/** Today's plan as the keeper sees it, with the state's tempo. */
const keeperPlan = (f: ReturnType<typeof setup>) =>
  dayPlan("2026-10-13", f.settings, planContext(f.accounts, f.tempo.value));

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
  const first = keeperPlan(f).accounts[0].firstStart;
  assert.ok(first > f.clock.now);
  assert.equal(status.nextStartAt, new Date(first).toISOString());
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
  // At the planned pace with nothing moved there is no adaptation to show.
  assert.equal("adaptation" in snapshot, false);
  assert.deepEqual(f.calls.adapted, []);
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
  const snapshot = keeper.snapshot();
  const status = snapshot.accounts[0];
  assert.equal(status.state, "outside");
  // Planned as if the deleted account were not listed at all.
  f.settings.accounts.pop();
  const [only] = keeperPlan(f).accounts;
  assert.ok(only.firstStart > f.clock.now);
  assert.equal(status.nextStartAt, new Date(only.firstStart).toISOString());
  assert.equal(snapshot.plannedToday, only.windows.length);
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

test("an expired usage connection is reported, still refreshed, and never starts", async () => {
  const f = setup();
  const a = f.accounts[0];
  f.usage[a.id] = {
    accountId: a.id,
    status: "error",
    stale: true,
    issue: "expired",
  };
  f.calls.refreshFails = true;
  const keeper = new WindowKeeper(f.deps);
  await keeper.tick();
  assert.deepEqual(f.calls.starts, []);
  assert.deepEqual(f.calls.refreshes, [a.id]);
  const status = keeper.snapshot().accounts[0];
  assert.equal(status.state, "blocked");
  assert.equal(status.reason, "usage-connection");
});

test("while Relay is busy a stale account waits for Relay, not for usage", async () => {
  const f = setup();
  const a = f.accounts[0];
  f.usage[a.id] = {
    ...f.usage[a.id],
    checkedAt: new Date(f.clock.now - 10 * 60_000).toISOString(),
  };
  f.calls.blocked = true;
  const keeper = new WindowKeeper(f.deps);
  await keeper.tick();
  assert.equal(keeper.snapshot().accounts[0].reason, "relay-busy");
});

test("the snapshot carries the state's tempo", () => {
  const f = setup();
  f.tempo.value = presetTempo("heavy");
  const keeper = new WindowKeeper(f.deps);
  assert.equal(keeper.snapshot().tempo, f.tempo.value);
  f.tempo.value = presetTempo("light");
  assert.equal(keeper.snapshot().tempo, f.tempo.value);
});

test("today's count and the next start follow the capacity-aware plan", async () => {
  const max = {
    ...account("Max"),
    planning: { plan: "max5" as const, capacityWeight: 5 },
  };
  const pro = {
    ...account("Pro"),
    planning: { plan: "pro" as const, capacityWeight: 1 },
  };
  const f = setup([max, pro]);
  f.clock.now = at("05:00");
  const keeper = new WindowKeeper(f.deps);
  await keeper.tick();
  const expected = keeperPlan(f);
  const windows = expected.accounts.reduce((n, a) => n + a.windows.length, 0);
  assert.ok(windows >= 2);
  assert.equal(keeper.snapshot().plannedToday, windows);
  keeper.snapshot().accounts.forEach((status, i) => {
    assert.equal(status.state, "outside");
    assert.equal(
      status.nextStartAt,
      new Date(expected.accounts[i].firstStart).toISOString(),
    );
  });
});

test("the keeper plans with the state's tempo as soon as it changes", async () => {
  const f = setup();
  f.clock.now = at("04:00");
  const keeper = new WindowKeeper(f.deps);
  await keeper.tick();
  const medium = keeperPlan(f).accounts[0];
  assert.equal(keeper.snapshot().plannedToday, medium.windows.length);
  f.tempo.value = presetTempo("heavy");
  await keeper.tick();
  const heavy = keeperPlan(f).accounts[0];
  // A heavy day needs another window and an earlier warm-up.
  assert.ok(heavy.windows.length > medium.windows.length);
  assert.ok(heavy.firstStart < medium.firstStart);
  assert.equal(keeper.snapshot().plannedToday, heavy.windows.length);
  assert.equal(
    keeper.snapshot().accounts[0].nextStartAt,
    new Date(heavy.firstStart).toISOString(),
  );
});

/** Every hour at `rate` Pro units. */
const flatTempo = (rate: number): Tempo => ({
  source: "learned",
  weekday: Array.from({ length: 24 }, () => rate),
  weekend: Array.from({ length: 24 }, () => rate),
  rate: { weekday: rate, weekend: rate },
  days: { weekday: 15, weekend: 2 },
});
const iso = (time: number) => new Date(time).toISOString();

test("a closed window waits for its adapted start and is due at that time", () => {
  const f = setup();
  const [a] = f.accounts;
  const context = planContext(f.accounts, f.tempo.value);
  const scheduled = f.clock.now + 30 * 60_000;
  const decide = (now: number, usage = f.fresh(a)) =>
    keeperDecision(
      a,
      { ...usage, checkedAt: iso(now) },
      f.settings,
      context,
      [],
      now,
      false,
      undefined,
      scheduled,
    );
  assert.deepEqual(decide(f.clock.now), {
    accountId: a.id,
    state: "waiting",
    reason: "adapted",
    nextStartAt: iso(scheduled),
  });
  assert.deepEqual(decide(scheduled), { accountId: a.id, state: "due" });
  // A full week still blocks: the keeper could not start it then either.
  assert.deepEqual(
    decide(f.clock.now, { ...f.fresh(a), sevenDay: { usedPercent: 100 } }),
    { accountId: a.id, state: "blocked", reason: "weekly-limit" },
  );
});

const WEDNESDAY = "2026-10-14";
/**
 * The Mac wakes at 08:50 on a 09:00–18:00 Wednesday planned at 120 Pro units
 * an hour: every warm-up (08:00, 08:45, 08:45) was missed, every window is
 * closed and the usage was last read `readAgo` before (the evening before).
 */
function wake({
  adaptive,
  readAgo = 10 * 3_600_000,
}: { adaptive?: boolean; readAgo?: number } = {}) {
  const team = planningAccount("vertex", "team");
  team.planning!.capacityWeight = 2;
  const f = setup([
    planningAccount("max", "max5"),
    team,
    planningAccount("pro", "pro"),
  ]);
  f.settings.weekday = { enabled: true, start: "09:00", end: "18:00" };
  if (adaptive !== undefined) f.settings.adaptive = adaptive;
  f.tempo.value = flatTempo(120);
  f.clock.now = at("08:50", WEDNESDAY);
  for (const a of f.accounts)
    f.usage[a.id] = {
      ...f.fresh(a),
      checkedAt: iso(f.clock.now - readAgo),
    };
  const order: string[] = [];
  const keeper = new WindowKeeper({
    ...f.deps,
    refresh: (id) => {
      order.push(`refresh ${id}`);
      return f.deps.refresh(id);
    },
    start: (a) => {
      order.push(`start ${a.id}`);
      return f.deps.start(a);
    },
    adapted: (notice) => {
      order.push(`adapted ${notice.kind}`);
      f.deps.adapted!(notice);
    },
  });
  return { ...f, keeper, order };
}

test("a Mac waking with every window closed refreshes, re-plans, then starts only what is not deferred", async () => {
  const f = wake();
  await f.keeper.tick();
  // Started now, all three would switch twice; held to 09:00, max and pro
  // switch once (the adaptive schedule's own wake-up case).
  assert.deepEqual(f.order, [
    "refresh max",
    "refresh vertex",
    "refresh pro",
    "adapted updated",
    "start vertex",
  ]);
  const nine = iso(at("09:00", WEDNESDAY));
  const schedule = [
    { accountId: "max", startAt: nine },
    { accountId: "pro", startAt: nine },
  ];
  assert.deepEqual(f.calls.adapted, [{ kind: "updated", schedule }]);
  const snapshot = f.keeper.snapshot();
  assert.deepEqual(snapshot.adaptation, {
    factor: 1,
    schedule,
    since: iso(at("08:50", WEDNESDAY)),
  });
  assert.deepEqual(
    snapshot.accounts.map((s) => [s.accountId, s.state, s.reason]),
    [
      ["max", "waiting", "adapted"],
      ["vertex", "active", undefined],
      ["pro", "waiting", "adapted"],
    ],
  );
  assert.equal(snapshot.accounts[0].nextStartAt, nine);
  assert.deepEqual(snapshot.next, { accountId: "max", at: nine });
  // Nothing else starts before 09:00, and nothing more is announced.
  for (const clock of ["08:51", "08:55", "08:59"]) {
    f.clock.now = at(clock, WEDNESDAY);
    await f.keeper.tick();
  }
  assert.deepEqual(f.calls.starts, ["vertex"]);
  // At 09:00 the deferred accounts start, one a tick, quietly.
  for (const clock of ["09:00", "09:01"]) {
    f.clock.now = at(clock, WEDNESDAY);
    await f.keeper.tick();
  }
  assert.deepEqual(f.calls.starts, ["vertex", "max", "pro"]);
  assert.equal(f.calls.adapted.length, 1);
  assert.equal("adaptation" in f.keeper.snapshot(), false);
});

test("with adaptation off the waking Mac starts the first planned account", async () => {
  const f = wake({ adaptive: false });
  await f.keeper.tick();
  assert.deepEqual(f.order, [
    "refresh max",
    "refresh vertex",
    "refresh pro",
    "start max",
  ]);
  assert.equal("adaptation" in f.keeper.snapshot(), false);
});

test("today's faster pace shows in the snapshot without a schedule or a notice", async () => {
  const f = setup();
  const [a] = f.accounts;
  // Planned at 60 an hour; the last hour used 90% of a Pro window.
  f.tempo.value = flatTempo(60);
  const used = (time: number) => ((time - at("09:00")) / 3_600_000) * 90;
  const resetsAt = iso(at("12:00"));
  for (let time = at("09:00"); time <= f.clock.now; time += 5 * 60_000)
    f.calls.samples.push({
      accountId: a.id,
      identity: usageIdentity(a)!,
      checkedAt: iso(time),
      fiveHour: { usedPercent: used(time), resetsAt },
    });
  f.usage[a.id] = {
    ...f.fresh(a, at("12:00")),
    fiveHour: { usedPercent: 90, resetsAt },
  };
  const keeper = new WindowKeeper(f.deps);
  await keeper.tick();
  assert.deepEqual(keeper.snapshot().adaptation, {
    factor: 1.5,
    observedRate: 90,
    schedule: [],
  });
  assert.deepEqual(f.calls.adapted, []);
  assert.deepEqual(f.calls.starts, []);
});

test("while Relay is busy nothing is searched or adopted; the next free tick refreshes, adapts, then starts", async () => {
  // Read 10 minutes ago: fresh enough for a forecast, stale for the keeper.
  const f = wake({ readAgo: 10 * 60_000 });
  f.calls.blocked = true;
  await f.keeper.tick();
  assert.deepEqual(f.order, []);
  assert.deepEqual(f.calls.adapted, []);
  assert.equal("adaptation" in f.keeper.snapshot(), false);
  // No review was spent: the first free tick searches at once.
  f.calls.blocked = false;
  f.clock.now = at("08:51", WEDNESDAY);
  await f.keeper.tick();
  assert.deepEqual(f.order, [
    "refresh max",
    "refresh vertex",
    "refresh pro",
    "adapted updated",
    "start vertex",
  ]);
});

/**
 * The adaptive schedule's hold scenario at 09:30 on Wednesday: `a` serves at
 * 100 Pro units an hour on its last 250 (until its 12:00 reset) while `b`'s
 * idle window resets at 10:00; holding b's restart to 11:00 removes an hour
 * without quota.
 */
function holding() {
  const a = planningAccount("a", "team");
  a.planning!.capacityWeight = 3;
  const f = setup([a, planningAccount("b", "pro")]);
  f.settings.weekday = { enabled: true, start: "09:00", end: "18:00" };
  f.tempo.value = flatTempo(100);
  f.clock.now = at("09:30", WEDNESDAY);
  f.calls.activeId = "a";
  const open = (id: string, usedPercent: number, clock: string) => ({
    ...f.fresh(f.accounts.find((x) => x.id === id)!),
    fiveHour: { usedPercent, resetsAt: iso(at(clock, WEDNESDAY)) },
  });
  f.usage.a = open("a", 100 / 6, "12:00");
  f.usage.b = open("b", 0, "10:00");
  return { ...f, keeper: new WindowKeeper(f.deps) };
}

test("a held restart is the next start; adaptation turned off says the plan is normal again", async () => {
  const f = holding();
  await f.keeper.tick();
  const eleven = iso(at("11:00", WEDNESDAY));
  assert.deepEqual(f.calls.adapted, [
    { kind: "updated", schedule: [{ accountId: "b", startAt: eleven }] },
  ]);
  const snapshot = f.keeper.snapshot();
  // b's window still resets at 10:00, but the keeper restarts it at 11:00.
  assert.deepEqual(
    snapshot.accounts.map((s) => [s.accountId, s.state, s.resetsAt]),
    [
      ["a", "active", iso(at("12:00", WEDNESDAY))],
      ["b", "active", iso(at("10:00", WEDNESDAY))],
    ],
  );
  assert.deepEqual(snapshot.next, { accountId: "b", at: eleven });
  // Turned off half an hour later, while Relay is busy: dropped at once, and
  // the user hears the plan is back to normal.
  f.clock.now = at("10:00", WEDNESDAY);
  f.settings.adaptive = false;
  f.calls.blocked = true;
  await f.keeper.tick();
  assert.deepEqual(f.calls.adapted[1], { kind: "normal", schedule: [] });
  assert.equal(f.calls.adapted.length, 2);
  assert.equal("adaptation" in f.keeper.snapshot(), false);
  assert.deepEqual(f.calls.starts, []);
  // Free again: b's window, closed since 10:00, starts at once.
  f.calls.blocked = false;
  await f.keeper.tick();
  assert.deepEqual(f.calls.starts, ["b"]);
});

test("a failing re-plan or notification never stops the keep-alive", async () => {
  // The schedule cannot be computed: the plan's own starts, quietly.
  const broken = wake();
  broken.calls.samples = null as unknown as UsageSample[];
  await broken.keeper.tick();
  assert.deepEqual(broken.order, [
    "refresh max",
    "refresh vertex",
    "refresh pro",
    "start max",
  ]);
  assert.deepEqual(broken.calls.adapted, []);
  // The notification fails: the adopted schedule still holds.
  const silent = wake();
  silent.deps.adapted = () => {
    throw new Error("notifications unavailable");
  };
  await silent.keeper.tick();
  assert.deepEqual(silent.order, [
    "refresh max",
    "refresh vertex",
    "refresh pro",
    "adapted updated",
    "start vertex",
  ]);
});
