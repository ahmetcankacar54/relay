import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  FleetContinuation,
  type FleetDeps,
  type FleetResult,
} from "../electron/core/fleet-continuation";
import type { QuotaStop } from "../electron/core/desktop-continuation-evidence";
import {
  DEFAULT_SETTINGS,
  type Account,
  type AccountUsage,
  type DesktopState,
} from "../shared/types";

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
      await guards.beforeQuit();
      assert.equal(guards.canProceed(), true);
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
  const fleet = new FleetContinuation(f.deps);
  assert.equal((await fleet.tick()).status, "off");
  assert.deepEqual(f.state.switches, []);
  fleet.setEnabled(true);
  f.state.usage[f.a.id] = usage(f.a, 70);
  const unconfirmed = await fleet.tick();
  assert.equal(unconfirmed.reason, "source-quota-unconfirmed");
  assert.equal(unconfirmed.stopped, 2);
  f.state.stops.set(f.a.id, []);
  assert.equal((await fleet.tick()).reason, "awaiting-quota-stop");
  assert.deepEqual(f.state.switches, []);
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
