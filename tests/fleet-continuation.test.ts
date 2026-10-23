import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  FleetContinuation,
  sourceExhausted as fleetSourceExhausted,
  type FleetDeps,
  type FleetResult,
} from "../electron/core/fleet-continuation";
import type { QuotaStop } from "../electron/core/desktop-continuation-evidence";
import { DesktopSwitchRefused } from "../electron/core/desktop";
import {
  DEFAULT_SETTINGS,
  type Account,
  type AccountUsage,
  type DesktopState,
} from "../shared/types";
import { SOURCE_FRESH_MS, sourceExhausted } from "../shared/usage";

const NOW = Date.parse("2026-10-13T20:00:00.000Z");
function account(name: string, plan: "max5" | "pro" = "max5"): Account {
  const id = randomUUID();
  return {
    id,
    name,
    kind: "personal",
    group: "personal",
    color: "blue",
    createdAt: new Date(NOW).toISOString(),
    planning: { plan, capacityWeight: 1 },
    desktop: {
      accountUuid: randomUUID(),
      orgId: randomUUID(),
      savedAt: new Date(NOW).toISOString(),
    },
    auth: { loggedIn: true, checkedAt: new Date(NOW).toISOString() },
  };
}
function enroll(a: Account) {
  a.auth = {
    ...a.auth!,
    accountUuid: a.desktop!.accountUuid,
    orgId: a.desktop!.orgId,
  };
  return a;
}
function usage(a: Account, five: number): AccountUsage {
  return {
    accountId: a.id,
    status: "ready",
    stale: false,
    checkedAt: new Date(NOW - 60_000).toISOString(),
    fiveHour: {
      usedPercent: five,
      resetsAt: new Date(NOW + 3_600_000).toISOString(),
    },
  };
}
function stop(index: number): QuotaStop {
  const id = randomUUID();
  return {
    localSessionId: `local_${randomUUID()}`,
    cliSessionId: id,
    projectKey: "/project",
    permissionMode: "Auto",
    turnId: randomUUID(),
    stoppedAt: NOW - index * 1000,
    transcriptRelative: `projects/p/${id}.jsonl`,
    transcriptBytes: 10,
    transcriptSha256: "a".repeat(64),
  };
}

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fleet-"));
  const a = enroll(account("A")),
    b = enroll(account("B"));
  const state = {
    active: a.id,
    stops: new Map<string, QuotaStop[]>([
      [a.id, [stop(0), stop(1)]],
      [b.id, []],
    ]),
    usage: { [a.id]: usage(a, 100), [b.id]: usage(b, 10) } as Record<
      string,
      AccountUsage
    >,
    busy: undefined as string | undefined,
    automation: undefined as string | undefined,
    switchError: undefined as Error | undefined,
    switches: [] as string[],
    sent: [] as string[],
    result: "started" as FleetResult,
    crashBeforeResult: false,
  };
  const deps: FleetDeps = {
    directory,
    now: () => NOW,
    snapshot: () => ({
      accounts: [a, b],
      settings: structuredClone(DEFAULT_SETTINGS),
      usage: state.usage,
    }),
    desktop: async () =>
      ({
        available: true,
        running: true,
        organizations: [],
        busy: false,
        recoveryRequired: false,
        errorRevision: 0,
        activeProfileId: state.active,
      }) satisfies DesktopState,
    busy: () => false,
    stops: async (account) => state.stops.get(account.id) ?? [],
    quiet: async () => state.busy,
    quietSync: () => state.busy,
    unchanged: () => true,
    automationReady: async () => state.automation,
    switchTo: async (targetId, guards) => {
      // As DesktopManager.restart: every guard runs before Claude is asked to quit.
      const refused = () =>
        new DesktopSwitchRefused(
          "Automatic Desktop switch was cancelled before restart.",
        );
      if (!guards.canProceed()) throw refused();
      await guards.beforeQuit();
      if (!guards.canProceed()) throw refused();
      if (state.switchError) throw state.switchError;
      state.switches.push(targetId);
      // History merge carries the stopped conversations to the target.
      state.active = targetId;
    },
    continueOne: async (s, target, requestId, beforeSend) => {
      assert.equal(target.id, state.active);
      beforeSend();
      if (state.crashBeforeResult) throw new Error("relay stopped");
      state.sent.push(`${s.localSessionId}:${requestId}`);
      // A continued conversation no longer ends with the quota error.
      return state.result;
    },
    withDesktopLock: (action) => action(),
    changed: () => {},
  };
  return { a, b, state, deps, directory };
}

test("off does nothing; without a quota stop or confirmation it waits", async () => {
  const f = setup();
  let clock = NOW;
  const fleet = new FleetContinuation({ ...f.deps, now: () => clock });
  assert.equal((await fleet.tick()).status, "off");
  assert.deepEqual(f.state.switches, []);
  fleet.setEnabled(true);
  // Full, but read too long ago to confirm it.
  f.state.usage[f.a.id] = {
    ...usage(f.a, 100),
    checkedAt: new Date(NOW - SOURCE_FRESH_MS - 1).toISOString(),
  };
  const unconfirmed = await fleet.tick();
  assert.equal(unconfirmed.reason, "source-quota-unconfirmed");
  assert.equal(unconfirmed.stopped, 2);
  f.state.stops.set(f.a.id, []);
  // The next scan is a minute after the last one.
  clock += 60_000;
  assert.equal((await fleet.tick()).reason, "awaiting-quota-stop");
  assert.deepEqual(f.state.switches, []);
});

test("a full account with no stopped conversation names a target without switching", async () => {
  const f = setup();
  const fleet = new FleetContinuation(f.deps);
  fleet.setEnabled(true);
  f.state.stops.set(f.a.id, []);
  f.state.usage[f.a.id] = usage(f.a, 100);
  const full = await fleet.tick();
  assert.equal(full.reason, "awaiting-quota-stop");
  assert.equal(full.targetId, f.b.id);
  assert.equal(full.stopped, 0);
  assert.deepEqual(f.state.switches, []);
  f.state.usage[f.a.id] = usage(f.a, 70);
  const room = await fleet.tick();
  assert.equal(room.reason, "awaiting-quota-stop");
  assert.equal(room.targetId, undefined);
  assert.deepEqual(f.state.switches, []);
});

test("the source is confirmed full only by a reading under 15 minutes old", () => {
  // The renderer reads the same rule from shared/usage.
  assert.equal(fleetSourceExhausted, sourceExhausted);
  assert.equal(SOURCE_FRESH_MS, 15 * 60_000);
  const a = account("A");
  const read = (ageMs: number): AccountUsage => ({
    ...usage(a, 100),
    checkedAt: new Date(NOW - ageMs).toISOString(),
  });
  assert.equal(sourceExhausted(read(5 * 60_000), NOW), true);
  assert.equal(sourceExhausted(read(SOURCE_FRESH_MS), NOW), true);
  assert.equal(sourceExhausted(read(SOURCE_FRESH_MS + 1), NOW), false);
  assert.equal(sourceExhausted(read(20 * 60_000), NOW), false);
  assert.equal(sourceExhausted(usage(a, 70), NOW), false);
});

test("other running work, a missing target or missing automation keep Claude untouched", async () => {
  const f = setup();
  const fleet = new FleetContinuation(f.deps);
  fleet.setEnabled(true);
  f.state.busy = "not-quiescent:busyWorkers";
  assert.equal((await fleet.tick()).reason, "not-quiescent:busyWorkers");
  f.state.busy = undefined;
  f.state.usage[f.b.id] = usage(f.b, 95);
  assert.equal((await fleet.tick()).reason, "no-target");
  f.state.usage[f.b.id] = usage(f.b, 10);
  f.state.automation = "accessibility-permission-required";
  const blocked = await fleet.tick();
  assert.equal(blocked.status, "attention");
  assert.equal(blocked.reason, "accessibility-permission-required");
  assert.deepEqual(f.state.switches, []);
});

test("one switch continues every stopped conversation once and stays on", async () => {
  const f = setup();
  const fleet = new FleetContinuation(f.deps);
  fleet.setEnabled(true);
  const done = await fleet.tick();
  assert.deepEqual(f.state.switches, [f.b.id]);
  assert.equal(f.state.sent.length, 2);
  assert.equal(done.status, "watching");
  assert.equal(done.reason, "continued");
  assert.equal(done.last?.conversations, 2);
  assert.equal(done.last?.started, 2);
  assert.equal(fleet.enabled, true);
  // The same stops are never handled again, even if still reported.
  f.state.active = f.a.id;
  await fleet.tick();
  assert.deepEqual(f.state.switches, [f.b.id]);
  assert.equal(f.state.sent.length, 2);
});

test("later limits rotate back only to an account with quota again", async () => {
  const f = setup();
  const fleet = new FleetContinuation(f.deps);
  fleet.setEnabled(true);
  await fleet.tick();
  assert.equal(f.state.active, f.b.id);
  // B runs out while A is still exhausted: wait instead of switching back.
  f.state.stops.set(f.b.id, [stop(0)]);
  f.state.usage[f.b.id] = usage(f.b, 100);
  assert.equal((await fleet.tick()).reason, "no-target");
  // A's window reset: rotate back.
  f.state.usage[f.a.id] = usage(f.a, 5);
  await fleet.tick();
  assert.deepEqual(f.state.switches, [f.b.id, f.a.id]);
  assert.equal(f.state.sent.length, 3);
});

test("a failed switch is reported and never retried automatically", async () => {
  const f = setup();
  const fleet = new FleetContinuation(f.deps);
  fleet.setEnabled(true);
  f.state.switchError = new Error("Claude did not close");
  const failed = await fleet.tick();
  assert.equal(failed.status, "attention");
  assert.match(failed.reason ?? "", /^switch-failed:/);
  f.state.switchError = undefined;
  await fleet.tick();
  assert.deepEqual(f.state.switches, []);
  assert.equal(f.state.sent.length, 0);
});

function handledStops(directory: string): string[] {
  return JSON.parse(
    fs.readFileSync(path.join(directory, "fleet-state.json"), "utf8"),
  ).handled;
}

test("a task notification that calls the switch off before Claude quits leaves the stops for the next tick", async () => {
  const f = setup();
  let scans = 0;
  let attempts = 0;
  // A background-task notification lands in a stopped transcript between the
  // scan under the lock and the quit; it keeps the stop's turn.
  let landed = false;
  const fleet = new FleetContinuation({
    ...f.deps,
    stops: async (account) => {
      scans++;
      return f.state.stops.get(account.id) ?? [];
    },
    quiet: async () => (landed ? "not-quiescent:busyWorkers" : undefined),
    switchTo: (targetId, guards) => {
      if (!attempts++) landed = true;
      return f.deps.switchTo(targetId, guards);
    },
  });
  fleet.setEnabled(true);
  const refused = await fleet.tick();
  assert.equal(refused.status, "waiting");
  assert.equal(refused.reason, "context-changed");
  assert.equal(refused.stopped, 2);
  assert.deepEqual(f.state.switches, []);
  assert.deepEqual(handledStops(f.directory), []);
  assert.equal(scans, 2);
  // The notification settled: the next tick scans afresh and continues both.
  landed = false;
  const done = await fleet.tick();
  assert.equal(scans, 4);
  assert.deepEqual(f.state.switches, [f.b.id]);
  assert.equal(f.state.sent.length, 2);
  assert.equal(done.reason, "continued");
  assert.equal(handledStops(f.directory).length, 2);
});

test("a transcript that changes right before the quit is refused by the guard and tried again", async () => {
  const f = setup();
  let attempts = 0;
  let changed = false;
  const fleet = new FleetContinuation({
    ...f.deps,
    unchanged: () => !changed,
    switchTo: (targetId, guards) => {
      if (!attempts++) changed = true;
      return f.deps.switchTo(targetId, guards);
    },
  });
  fleet.setEnabled(true);
  assert.equal((await fleet.tick()).reason, "context-changed");
  assert.deepEqual(handledStops(f.directory), []);
  changed = false;
  assert.equal((await fleet.tick()).reason, "continued");
  assert.deepEqual(f.state.switches, [f.b.id]);
  assert.equal(f.state.sent.length, 2);
});

test("a switch that fails after Claude was asked to quit marks its stops handled", async () => {
  const f = setup();
  let attempts = 0;
  const fleet = new FleetContinuation({
    ...f.deps,
    switchTo: async (targetId, guards) => {
      attempts++;
      assert.equal(guards.canProceed(), true);
      await guards.beforeQuit();
      // Claude quit; the write guard then saw the conditions change. Claude
      // relaunches on the source account.
      throw new Error(
        "Automatic Desktop switch was cancelled because its conditions changed.",
      );
    },
  });
  fleet.setEnabled(true);
  const failed = await fleet.tick();
  assert.equal(failed.status, "attention");
  assert.match(failed.reason ?? "", /^switch-failed:.*conditions changed/);
  assert.equal(handledStops(f.directory).length, 2);
  // Never restarted again for the same limit.
  assert.equal((await fleet.tick()).reason, "awaiting-quota-stop");
  assert.equal(attempts, 1);
  assert.equal(f.state.sent.length, 0);
});

test("a send interrupted by a crash is never repeated after Relay restarts", async () => {
  const f = setup();
  f.state.crashBeforeResult = true;
  const fleet = new FleetContinuation(f.deps);
  fleet.setEnabled(true);
  const result = await fleet.tick();
  assert.equal(result.status, "attention");
  assert.equal(result.reason, "delivery-uncertain");
  assert.equal(result.last?.uncertain, 2);
  // A new instance reading the same state sends nothing.
  f.state.crashBeforeResult = false;
  const restarted = new FleetContinuation(f.deps);
  await restarted.tick();
  assert.equal(f.state.sent.length, 0);
  assert.deepEqual(f.state.switches, [f.b.id]);
});

test("a switch that was interrupted mid-way resumes continuing on the target", async () => {
  const f = setup();
  const fleet = new FleetContinuation(f.deps);
  fleet.setEnabled(true);
  // Simulate Relay stopping right after Claude switched.
  const state = JSON.parse(
    fs.readFileSync(path.join(f.directory, "fleet-state.json"), "utf8"),
  );
  state.pending = {
    id: randomUUID(),
    key: "k",
    sourceId: f.a.id,
    targetId: f.b.id,
    stops: f.state.stops.get(f.a.id),
    stage: "switching",
    results: {},
    startedAt: NOW,
  };
  fs.writeFileSync(
    path.join(f.directory, "fleet-state.json"),
    JSON.stringify(state),
  );
  f.state.active = f.b.id;
  const resumed = new FleetContinuation(f.deps);
  await resumed.tick();
  assert.equal(f.state.sent.length, 2);
  assert.deepEqual(f.state.switches, []);
});

test("the target is the soonest reset that holds half an hour at the snapshot's tempo", async () => {
  const f = setup();
  const c = enroll(account("C", "pro"));
  // C (Pro, 50 Pro units) resets in 30 minutes; B (Max 5×, 450) in an hour.
  const usageOf = {
    ...f.state.usage,
    [c.id]: {
      ...usage(c, 50),
      fiveHour: {
        usedPercent: 50,
        resetsAt: new Date(NOW + 30 * 60_000).toISOString(),
      },
    },
  };
  let tempoRate: number | undefined;
  const fleet = new FleetContinuation({
    ...f.deps,
    snapshot: () => ({
      accounts: [f.a, f.b, c],
      settings: structuredClone(DEFAULT_SETTINGS),
      usage: usageOf,
      tempoRate,
    }),
  });
  fleet.setEnabled(true);
  // Missing automation stops the tick after the target is chosen.
  f.state.automation = "accessibility-permission-required";
  assert.equal((await fleet.tick()).targetId, c.id);
  // 200 Pro units/h needs 100 left: C falls short.
  tempoRate = 200;
  assert.equal((await fleet.tick()).targetId, f.b.id);
  assert.deepEqual(f.state.switches, []);
});

test("the windows are told only when the fleet state changed, not for a new check time", async () => {
  const f = setup();
  let told = 0;
  let clock = NOW;
  const fleet = new FleetContinuation({
    ...f.deps,
    now: () => clock,
    changed: () => void told++,
  });
  fleet.setEnabled(true);
  f.state.stops.set(f.a.id, []);
  f.state.usage[f.a.id] = usage(f.a, 70);
  told = 0;
  await fleet.tick();
  assert.equal(told, 1);
  clock += 10_000;
  const again = await fleet.tick();
  assert.equal(again.checkedAt, new Date(clock).toISOString());
  assert.equal(told, 1);
  // A full source names a target: that is a change.
  f.state.usage[f.a.id] = usage(f.a, 100);
  clock += 10_000;
  assert.equal((await fleet.tick()).targetId, f.b.id);
  assert.equal(told, 2);
  // Off stays off without telling anyone again.
  fleet.setEnabled(false);
  assert.equal(told, 3);
  await fleet.tick();
  await fleet.tick();
  assert.equal(told, 3);
});

test("scans at most once a minute, and at once when the source's quota state changes", async () => {
  const f = setup();
  let clock = NOW;
  let scans = 0;
  const fleet = new FleetContinuation({
    ...f.deps,
    now: () => clock,
    stops: async (account) => {
      scans++;
      return f.state.stops.get(account.id) ?? [];
    },
  });
  fleet.setEnabled(true);
  f.state.stops.set(f.a.id, []);
  f.state.usage[f.a.id] = usage(f.a, 70);
  for (let i = 0; i < 3; i++, clock += 10_000)
    assert.equal((await fleet.tick()).reason, "awaiting-quota-stop");
  assert.equal(scans, 1);
  // Out of quota: scanned at once, nothing stopped yet.
  f.state.usage[f.a.id] = usage(f.a, 100);
  assert.equal((await fleet.tick()).reason, "awaiting-quota-stop");
  assert.equal(scans, 2);
  // A conversation stops: seen at the next scan, a minute after the last.
  f.state.stops.set(f.a.id, [stop(0)]);
  f.state.automation = "accessibility-permission-required";
  clock += 50_000;
  assert.equal((await fleet.tick()).stopped, 0);
  assert.equal(scans, 2);
  clock += 10_000;
  assert.equal((await fleet.tick()).stopped, 1);
  assert.equal(scans, 3);
  // A change of quota state scans again at once.
  f.state.usage[f.a.id] = {
    ...usage(f.a, 100),
    checkedAt: new Date(NOW - SOURCE_FRESH_MS - 1).toISOString(),
  };
  clock += 10_000;
  assert.equal((await fleet.tick()).reason, "source-quota-unconfirmed");
  assert.equal(scans, 4);
  assert.deepEqual(f.state.switches, []);
});

test("a stop after a reading that still shows room reads the source again and switches at once", async () => {
  const f = setup();
  const reads: string[] = [];
  // The last reading was a minute before the conversations stopped: 99 %.
  f.state.usage[f.a.id] = usage(f.a, 99);
  f.state.stops.set(f.a.id, [
    { ...stop(0), stoppedAt: NOW - 10_000 },
    { ...stop(1), stoppedAt: NOW - 11_000 },
  ]);
  const fleet = new FleetContinuation({
    ...f.deps,
    refreshUsage: async (id) => {
      reads.push(id);
      f.state.usage[id] = { ...usage(f.a, 100), checkedAt: new Date(NOW).toISOString() };
    },
  });
  fleet.setEnabled(true);
  await fleet.tick();
  assert.deepEqual(reads, [f.a.id]);
  assert.deepEqual(f.state.switches, [f.b.id]);
  assert.equal(f.state.sent.length, 2);
});

test("a source read again that still has room keeps waiting, and is read at most once a minute", async () => {
  const f = setup();
  let clock = NOW;
  const reads: string[] = [];
  f.state.usage[f.a.id] = usage(f.a, 99);
  f.state.stops.set(f.a.id, [{ ...stop(0), stoppedAt: NOW - 10_000 }]);
  const fleet = new FleetContinuation({
    ...f.deps,
    now: () => clock,
    // The server says room still (a model limit, or the window reset meanwhile).
    refreshUsage: async (id) => void reads.push(id),
  });
  fleet.setEnabled(true);
  assert.equal((await fleet.tick()).reason, "awaiting-quota-stop");
  clock += 10_000;
  assert.equal((await fleet.tick()).reason, "awaiting-quota-stop");
  assert.equal(reads.length, 1);
  clock += 50_000;
  await fleet.tick();
  assert.equal(reads.length, 2);
  // A stop older than the reading asks for nothing: the reading came after it.
  f.state.usage[f.a.id] = { ...usage(f.a, 99), checkedAt: new Date(clock).toISOString() };
  clock += 70_000;
  await fleet.tick();
  assert.equal(reads.length, 2);
  // A read that fails changes nothing and is asked again only a minute later.
  f.state.usage[f.a.id] = usage(f.a, 99);
  const failing = new FleetContinuation({
    ...f.deps,
    now: () => clock,
    refreshUsage: async () => {
      reads.push("failed");
      throw new Error("offline");
    },
  });
  assert.equal((await failing.tick()).reason, "awaiting-quota-stop");
  assert.equal(reads.at(-1), "failed");
  assert.deepEqual(f.state.switches, []);
});

test("the switch acts on the conversations as scanned under the lock, not on an earlier scan", async () => {
  const f = setup();
  let clock = NOW;
  const first = stop(0);
  // A meta row appended after the stop: the same turn, a longer transcript.
  const grown = { ...first, transcriptBytes: 20, transcriptSha256: "b".repeat(64) };
  f.state.stops.set(f.a.id, [first]);
  f.state.automation = "accessibility-permission-required";
  const fleet = new FleetContinuation({
    ...f.deps,
    now: () => clock,
    unchanged: (s) => s.transcriptBytes === 20,
  });
  fleet.setEnabled(true);
  await fleet.tick();
  f.state.stops.set(f.a.id, [grown]);
  f.state.automation = undefined;
  clock += 10_000;
  const done = await fleet.tick();
  assert.deepEqual(f.state.switches, [f.b.id]);
  assert.equal(done.reason, "continued");
});
