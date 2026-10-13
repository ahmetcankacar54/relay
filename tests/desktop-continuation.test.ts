import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DesktopContinuationManager,
  FileDesktopContinuationPersistence,
  type DesktopContinuationObservation,
  type DesktopContinuationPersistentState,
} from "../electron/core/desktop-continuation";
import type {
  ContinuationHost,
  ContinuationRequest,
  ContinuationResult,
} from "../electron/core/continuation";
import { ContinuationEngine } from "../electron/core/continuation";
import { FileContinuationJournal } from "../electron/core/continuation-journal";
import {
  DEFAULT_SETTINGS,
  type Account,
  type AccountUsage,
} from "../shared/types";

const NOW = Date.parse("2026-10-13T14:00:00Z");
function account(): Account {
  const id = randomUUID(),
    accountUuid = randomUUID(),
    orgId = randomUUID();
  return {
    id,
    name: "Synthetic",
    kind: "personal",
    group: "synthetic",
    color: "olive",
    createdAt: new Date(NOW).toISOString(),
    desktop: { accountUuid, orgId, savedAt: new Date(NOW).toISOString() },
    auth: {
      loggedIn: true,
      accountUuid,
      orgId,
      checkedAt: new Date(NOW).toISOString(),
    },
  };
}
function setup() {
  const source = account(),
    target = account(),
    sessionId = randomUUID();
  let persisted: DesktopContinuationPersistentState = {
    version: 1,
    completed: [],
  };
  const capabilities: ContinuationHost["capabilities"] = {
    kind: "simulated",
    contractId: "synthetic-all",
    exactSession: true,
    conditionalActions: true,
    idempotentDelivery: true,
    deliveryLookup: true,
    checkpoint: true,
    accountSwitch: true,
    sessionReopen: true,
    targetedSend: true,
    deliveryReceipt: true,
    atomicContextGuard: true,
  };
  const observation: DesktopContinuationObservation = {
    state: {
      contextRevision: 3,
      observedAt: NOW,
      identity: {
        profileId: source.id,
        accountUuid: source.desktop!.accountUuid,
        orgId: source.desktop!.orgId,
      },
      session: {
        id: sessionId,
        projectKey: "synthetic-project",
        transcriptRevision: "checkpoint-3",
        permissionMode: "Auto",
        status: "stopped",
        lastTurnId: "ended-turn-3",
      },
      quiescence: {
        coverage: "isolated-all",
        busyWorkers: 0,
        subagents: 0,
        pendingTasks: 0,
        waiting: 0,
        queuedPrompts: 0,
        scheduledWakeups: 0,
        unknownWork: 0,
      },
    },
    quotaStop: {
      reason: "rate-limit",
      sessionId,
      turnId: "ended-turn-3",
      observedAt: NOW,
    },
  };
  const requests: ContinuationRequest[] = [];
  let result: ContinuationResult = {
    status: "continued",
    continuationKind: "stopped-session-new-turn",
    reason: "new-turn-verified",
  };
  let desktopLocked = false,
    locks = 0,
    observations = 0;
  const deps = {
    capabilities,
    observe: async () => {
      observations++;
      return structuredClone(observation);
    },
    engine: {
      execute: async (request: ContinuationRequest) => {
        assert.equal(
          desktopLocked,
          true,
          "execute must hold the shared Desktop lock",
        );
        requests.push(structuredClone(request));
        return structuredClone(result);
      },
    },
    snapshot: () => ({
      accounts: [source, target],
      settings: structuredClone(DEFAULT_SETTINGS),
      usage: {},
    }),
    persistence: {
      load: () => structuredClone(persisted),
      save: (value: DesktopContinuationPersistentState) => {
        persisted = structuredClone(value);
      },
    },
    withDesktopLock: async <T>(action: () => Promise<T>) => {
      assert.equal(desktopLocked, false);
      locks++;
      desktopLocked = true;
      try {
        return await action();
      } finally {
        desktopLocked = false;
      }
    },
    now: () => NOW,
  };
  const manager = new DesktopContinuationManager(deps);
  return {
    manager,
    deps,
    source,
    target,
    observation,
    requests,
    capabilities,
    persisted: () => structuredClone(persisted),
    result: (next: ContinuationResult) => {
      result = next;
    },
    counts: () => ({ locks, observations }),
  };
}

test("new manager defaults off; read-only inspection never invokes the engine", async () => {
  const f = setup();
  assert.equal(f.manager.snapshot().status, "off");
  await f.manager.tick();
  assert.deepEqual(f.counts(), { observations: 0, locks: 0 });
  const view = await f.manager.inspect();
  assert.equal(view.canArm, true);
  assert.equal(view.permissionMode, "Auto");
  assert.equal(view.sessionId, f.observation.state.session.id);
  assert.equal(f.requests.length, 0);
  assert.equal(f.persisted().arm, undefined);
});

test("inspection preserves actionable OS permission errors without leaking arbitrary diagnostic text", async () => {
  const f = setup();
  f.deps.observe = async () => {
    throw new Error("accessibility-permission-required");
  };
  assert.equal(
    (await f.manager.inspect()).observationReason,
    "accessibility-permission-required",
  );
  f.deps.observe = async () => {
    throw new Error("private-profile-path-and-token");
  };
  const value = await f.manager.inspect();
  assert.equal(value.observationReason, "desktop-observation-unavailable");
  assert.equal(
    JSON.stringify(value).includes("private-profile-path-and-token"),
    false,
  );
});

test("explicit selected target produces one persisted same-session handoff with unchanged permissions", async () => {
  const f = setup();
  const armed = await f.manager.arm({ targetAccountId: f.target.id });
  assert.equal(armed.enabled, true);
  assert.equal(f.persisted().arm!.target.profileId, f.target.id);
  const result = await f.manager.tick();
  assert.equal(result.status, "continued");
  assert.equal(result.enabled, false);
  assert.equal(f.requests[0].sessionId, armed.sessionId);
  assert.equal(f.requests[0].permissionMode, "Auto");
  assert.equal(f.requests[0].target.id, f.target.id);
  assert.equal(f.persisted().completed.length, 1);
  await f.manager.tick();
  assert.equal(
    f.requests.length,
    1,
    "successful one-shot does not oscillate accounts",
  );
});

test("checking a new unarmed conversation does not attach a previous completion badge or target", async () => {
  const f = setup();
  await f.manager.arm({ targetAccountId: f.target.id });
  await f.manager.tick();
  f.observation.state.identity = {
    profileId: f.target.id,
    accountUuid: f.target.desktop!.accountUuid,
    orgId: f.target.desktop!.orgId,
  };
  f.observation.state.session.id = randomUUID();
  const checked = await f.manager.inspect();
  assert.equal(checked.status, "off");
  assert.equal(checked.sourceId, f.target.id);
  assert.equal(checked.targetId, undefined);
  assert.equal(checked.sessionId, f.observation.state.session.id);
  assert.equal(checked.canArm, true);
});

test("watch can be armed while the selected session runs, but its tasks are never interrupted", async () => {
  const f = setup();
  f.observation.state.session.status = "running";
  f.observation.state.quiescence.subagents = 1;
  await f.manager.arm({ targetAccountId: f.target.id });
  assert.equal((await f.manager.tick()).reason, "session-not-stopped");
  assert.equal(f.requests.length, 0);
  f.observation.state.session.status = "stopped";
  assert.equal((await f.manager.tick()).reason, "not-quiescent:subagents");
  assert.equal(f.requests.length, 0);
});

for (const work of [
  "busyWorkers",
  "pendingTasks",
  "waiting",
  "queuedPrompts",
  "scheduledWakeups",
  "unknownWork",
] as const) {
  test(`nonzero ${work} keeps the application waiting without switching`, async () => {
    const f = setup();
    await f.manager.arm({ targetAccountId: f.target.id });
    f.observation.state.quiescence[work] = 1;
    assert.equal((await f.manager.tick()).reason, `not-quiescent:${work}`);
    assert.equal(f.requests.length, 0);
  });
}

test("quota metric without a fresh matched ended-turn signal does not trigger continuation", async () => {
  const f = setup();
  await f.manager.arm({ targetAccountId: f.target.id });
  f.observation.quotaStop = undefined;
  assert.equal((await f.manager.tick()).reason, "awaiting-quota-stop");
  f.observation.quotaStop = {
    reason: "rate-limit",
    sessionId: f.observation.state.session.id,
    turnId: "other-turn",
    observedAt: NOW,
  };
  assert.equal((await f.manager.tick()).reason, "quota-stop-unverified");
  f.observation.quotaStop.turnId = "ended-turn-3";
  f.observation.quotaStop.observedAt = NOW - 15_001;
  assert.equal((await f.manager.tick()).reason, "quota-stop-unverified");
  assert.equal(f.requests.length, 0);
});

test("permission, session, source and enrolled target identity changes all refuse an armed handoff", async () => {
  const edits: Array<[string, (f: ReturnType<typeof setup>) => void]> = [
    [
      "permission-mode-changed",
      (f) => {
        f.observation.state.session.permissionMode = "Manual";
      },
    ],
    [
      "selected-session-changed",
      (f) => {
        f.observation.state.session.id = randomUUID();
      },
    ],
    [
      "source-account-changed",
      (f) => {
        f.observation.state.identity = {
          profileId: f.target.id,
          accountUuid: f.target.desktop!.accountUuid,
          orgId: f.target.desktop!.orgId,
        };
      },
    ],
    [
      "target-identity-changed",
      (f) => {
        const other = randomUUID();
        f.target.desktop!.orgId = other;
        f.target.auth!.orgId = other;
      },
    ],
  ];
  for (const [reason, edit] of edits) {
    const f = setup();
    await f.manager.arm({ targetAccountId: f.target.id });
    edit(f);
    assert.equal((await f.manager.tick()).reason, reason);
    assert.equal(f.requests.length, 0);
  }
});

test("unknown task coverage and stale observation never count as quiescent", async () => {
  const f = setup();
  await f.manager.arm({ targetAccountId: f.target.id });
  f.observation.state.quiescence.coverage = "unknown";
  assert.equal((await f.manager.tick()).reason, "coverage-unverified");
  f.observation.state.observedAt = NOW - 15_001;
  assert.equal((await f.manager.tick()).reason, "observation-not-fresh");
  assert.equal(f.requests.length, 0);
});

test("unavailable shared Desktop lock blocks monitoring without throwing or calling the engine", async () => {
  const f = setup();
  await f.manager.arm({ targetAccountId: f.target.id });
  f.deps.withDesktopLock = async () => {
    throw new Error("synthetic-owner-busy");
  };
  const outcome = await f.manager.tick();
  assert.equal(outcome.status, "blocked");
  assert.equal(outcome.reason, "desktop-lock-unavailable");
  assert.equal(f.requests.length, 0);
  assert.equal(f.persisted().pending, undefined);
});

test("unsupported adapter may save monitoring intent, clearly reports nonexecutable, and never executes", async () => {
  const f = setup();
  f.capabilities.atomicContextGuard = false;
  const inspection = await f.manager.inspect();
  assert.equal(inspection.canArm, true);
  assert.equal(inspection.executable, false);
  assert.equal(inspection.observationReason, "adapter-contract-unverified");
  const arm = await f.manager.arm({ targetAccountId: f.target.id });
  assert.equal(arm.status, "blocked");
  assert.equal(arm.enabled, true);
  assert.equal((await f.manager.tick()).reason, "adapter-contract-unverified");
  assert.equal(f.requests.length, 0);
  assert.equal((await f.manager.disarm()).enabled, false);
});

test("guarded native path requires explicit persisted at-most-once consent before execution", async () => {
  const f = setup();
  f.capabilities.kind = "guarded-native";
  f.capabilities.atomicContextGuard = false;
  f.capabilities.idempotentDelivery = false;
  assert.equal((await f.manager.inspect()).executable, true);
  await assert.rejects(
    f.manager.arm({ targetAccountId: f.target.id }),
    /guarded-native-policy-required/,
  );
  assert.equal(f.persisted().arm, undefined);
  await f.manager.arm({
    targetAccountId: f.target.id,
    executionPolicy: "guarded-native-at-most-once",
  });
  f.observation.state.quiescence.coverage = "guarded-local";
  const result = await f.manager.tick();
  assert.equal(result.status, "continued");
  assert.equal(f.requests[0].executionPolicy, "guarded-native-at-most-once");
  assert.equal(f.requests[0].permissionMode, "Auto");
});

test("guarded native consent does not override incomplete coverage or running child work", async () => {
  const f = setup();
  f.capabilities.kind = "guarded-native";
  f.capabilities.atomicContextGuard = false;
  f.capabilities.idempotentDelivery = false;
  await f.manager.arm({
    targetAccountId: f.target.id,
    executionPolicy: "guarded-native-at-most-once",
  });
  assert.equal((await f.manager.tick()).reason, "coverage-unverified");
  f.observation.state.quiescence.coverage = "guarded-local";
  f.observation.state.quiescence.subagents = 1;
  assert.equal((await f.manager.tick()).reason, "not-quiescent:subagents");
  assert.equal(f.requests.length, 0);
});

test("persisted strict-mode arm cannot silently opt into guarded native after an upgrade", async () => {
  const f = setup();
  await f.manager.arm({ targetAccountId: f.target.id });
  f.capabilities.kind = "guarded-native";
  f.capabilities.atomicContextGuard = false;
  f.capabilities.idempotentDelivery = false;
  const upgraded = new DesktopContinuationManager(f.deps);
  assert.equal(
    (await upgraded.tick()).reason,
    "guarded-native-policy-required",
  );
  assert.equal(f.requests.length, 0);
});

function wakeupSetup() {
  const f = setup();
  f.capabilities.kind = "guarded-native";
  f.capabilities.atomicContextGuard = false;
  f.capabilities.idempotentDelivery = false;
  f.observation.state.quiescence.coverage = "guarded-local";
  f.observation.state.quiescence.scheduledWakeups = 1;
  f.observation.ownQuotaWakeup = true;
  const usage = (id: string, used: number) => ({
    accountId: id,
    status: "ready" as const,
    stale: false,
    checkedAt: new Date(NOW).toISOString(),
    fiveHour: {
      usedPercent: used,
      resetsAt: new Date(NOW + 3_600_000).toISOString(),
    },
    sevenDay: {
      usedPercent: 20,
      resetsAt: new Date(NOW + 86_400_000).toISOString(),
    },
  });
  const sourceUsage = usage(f.source.id, 100),
    targetUsage = usage(f.target.id, 10);
  const snapshot = () => ({
    accounts: [f.source, f.target],
    settings: structuredClone(DEFAULT_SETTINGS),
    usage: {
      [f.source.id]: sourceUsage,
      [f.target.id]: targetUsage,
    },
  });
  let preparations = 0;
  const prepareQuotaStop = async (
    observation: DesktopContinuationObservation,
    request: ContinuationRequest,
  ) => {
    preparations++;
    const pending = f.persisted().pending;
    assert.equal(pending?.id, request.id);
    assert.equal(pending?.ownQuotaWakeup, "cancellation-intent");
    assert.equal(f.persisted().arm, undefined);
    assert.equal(observation.ownQuotaWakeup, true);
    assert.equal(request.executionPolicy, "guarded-native-at-most-once");
    assert.equal(request.expectedContextRevision, 3);
    f.observation.state.quiescence.scheduledWakeups = 0;
    f.observation.state.contextRevision++;
    f.observation.ownQuotaWakeup = false;
    return structuredClone(f.observation);
  };
  const deps = { ...f.deps, snapshot, prepareQuotaStop };
  return {
    ...f,
    deps,
    sourceUsage,
    targetUsage,
    preparations: () => preparations,
    manager: new DesktopContinuationManager(deps),
  };
}

function automaticSetup() {
  const f = wakeupSetup();
  const alternate = account();
  const accounts = [f.source, f.target, alternate];
  const usage: Record<string, AccountUsage> = {
    ...f.deps.snapshot().usage,
    [alternate.id]: {
      ...structuredClone(f.targetUsage),
      accountId: alternate.id,
    },
  };
  const settings = structuredClone(DEFAULT_SETTINGS);
  f.observation.state.quiescence.scheduledWakeups = 0;
  f.observation.ownQuotaWakeup = false;
  const deps = {
    ...f.deps,
    snapshot: () => ({ accounts, usage, settings }),
  };
  return {
    ...f,
    deps,
    accounts,
    usage,
    settings,
    alternate,
    manager: new DesktopContinuationManager(deps),
  };
}

const automaticArm = {
  targetAccountId: "automatic",
  executionPolicy: "guarded-native-at-most-once" as const,
};

test("automatic enrollment freezes distinct identities without requiring fresh quota or displaying a placeholder target", async () => {
  const f = automaticSetup();
  const duplicate = {
    ...structuredClone(f.target),
    id: randomUUID(),
  };
  f.accounts.push(duplicate);
  delete f.usage[f.target.id];
  delete f.usage[f.alternate.id];
  const armed = await f.manager.arm(automaticArm);
  assert.equal(armed.targetSelection, "automatic");
  assert.equal(armed.targetId, undefined);
  assert.equal(armed.allowedTargetCount, 2);
  const enrolled = f.persisted().arm!;
  assert.equal(enrolled.targetSelection, "automatic");
  assert.equal(enrolled.allowedTargets!.length, 2);
  assert.equal(
    enrolled.allowedTargets!.some((a) => a.profileId === f.source.id),
    false,
  );
  assert.equal((await f.manager.tick()).reason, "automatic-target-unavailable");
  assert.equal(f.requests.length, 0);
});

test("automatic arm needs a distinct enrolled identity, excluding CLI-only and duplicate source profiles", async () => {
  const f = automaticSetup();
  f.accounts.splice(1);
  f.accounts.push({ ...account(), desktop: undefined });
  f.accounts.push({ ...structuredClone(f.source), id: randomUUID() });
  await assert.rejects(
    f.manager.arm(automaticArm),
    /automatic-target-enrollment-unavailable/,
  );
  assert.equal(f.persisted().arm, undefined);
});

test("automatic selection starts only at the exact ended quota turn and uses capacity-adjusted bottleneck remaining", async () => {
  const f = automaticSetup();
  f.target.planning = { plan: "pro", capacityWeight: 1 };
  f.alternate.planning = { plan: "max5", capacityWeight: 5 };
  f.usage[f.target.id].fiveHour!.usedPercent = 5;
  f.usage[f.target.id].sevenDay!.usedPercent = 5;
  f.usage[f.alternate.id].fiveHour!.usedPercent = 70;
  f.usage[f.alternate.id].sevenDay!.usedPercent = 40;
  const stop = f.observation.quotaStop;
  f.observation.quotaStop = undefined;
  await f.manager.arm(automaticArm);
  assert.equal((await f.manager.tick()).reason, "awaiting-quota-stop");
  assert.equal(f.requests.length, 0);
  f.observation.quotaStop = stop;
  const result = await f.manager.tick();
  assert.equal(result.status, "continued");
  assert.equal(f.requests[0].target.id, f.alternate.id);
  assert.equal(result.targetId, f.alternate.id);
  assert.equal(result.targetSelection, "automatic");
  assert.equal(f.requests[0].sessionId, f.observation.state.session.id);
  assert.equal(f.requests[0].permissionMode, "Auto");
});

test("automatic selection uses the weekly bottleneck even when another account has more five-hour quota", async () => {
  const f = automaticSetup();
  f.usage[f.target.id].fiveHour!.usedPercent = 1;
  f.usage[f.target.id].sevenDay!.usedPercent = 85;
  f.usage[f.alternate.id].fiveHour!.usedPercent = 50;
  f.usage[f.alternate.id].sevenDay!.usedPercent = 50;
  await f.manager.arm(automaticArm);
  await f.manager.tick();
  assert.equal(f.requests[0].target.id, f.alternate.id);
});

test("automatic choice is recomputed from fresh quota inside the shared Desktop lock immediately before handoff", async () => {
  const f = automaticSetup();
  f.target.planning = { plan: "max20", capacityWeight: 20 };
  await f.manager.arm(automaticArm);
  const lock = f.deps.withDesktopLock;
  f.deps.withDesktopLock = async (action) => {
    f.usage[f.target.id].fiveHour!.usedPercent = 100;
    return lock(action);
  };
  await f.manager.tick();
  assert.equal(f.requests[0].target.id, f.alternate.id);
});

test("automatic mode rejects unusable live quota, cooldown and changed identities before cancelling the original wakeup", async () => {
  const scenarios: ((f: ReturnType<typeof automaticSetup>) => void)[] = [
    (f) => {
      f.usage[f.target.id].stale = true;
    },
    (f) => {
      f.usage[f.target.id].checkedAt = new Date(NOW - 300_001).toISOString();
    },
    (f) => {
      f.usage[f.target.id].checkedAt = new Date(NOW + 1).toISOString();
    },
    (f) => {
      f.usage[f.target.id].accountId = f.source.id;
    },
    (f) => {
      f.usage[f.target.id].sevenDay = undefined;
    },
    (f) => {
      f.usage[f.target.id].fiveHour = undefined;
      f.usage[f.target.id].sevenDay = undefined;
      f.usage[f.target.id].lastKnownResets = {
        fiveHour: {
          resetsAt: new Date(NOW + 3_600_000).toISOString(),
          checkedAt: new Date(NOW).toISOString(),
        },
        sevenDay: {
          resetsAt: new Date(NOW + 86_400_000).toISOString(),
          checkedAt: new Date(NOW).toISOString(),
        },
      };
    },
    (f) => {
      f.usage[f.target.id].sevenDay!.resetsAt = new Date(NOW - 1).toISOString();
    },
    (f) => {
      f.usage[f.target.id].fiveHour!.usedPercent = 90;
    },
    (f) => {
      f.usage[f.target.id].sevenDay!.usedPercent = 90;
    },
    (f) => {
      f.target.cooldownUntil = new Date(NOW + 60_000).toISOString();
    },
    (f) => {
      f.target.cooldownUntil = "invalid";
    },
    (f) => {
      f.target.auth!.accountUuid = randomUUID();
    },
    (f) => {
      f.target.auth!.accountUuid = randomUUID();
      f.target.desktop!.accountUuid = f.target.auth!.accountUuid!;
    },
  ];
  for (const change of scenarios) {
    const f = automaticSetup();
    f.usage[f.alternate.id].fiveHour!.usedPercent = 100;
    f.observation.ownQuotaWakeup = true;
    f.observation.state.quiescence.scheduledWakeups = 1;
    await f.manager.arm(automaticArm);
    change(f);
    const result = await f.manager.tick();
    assert.equal(result.status, "waiting");
    assert.equal(result.reason, "automatic-target-unavailable");
    assert.equal(f.preparations(), 0);
    assert.equal(f.requests.length, 0);
    assert.equal(f.persisted().pending, undefined);
    assert.equal(f.observation.state.quiescence.scheduledWakeups, 1);
  }
});

test("automatic continuation applies current history scope and never admits accounts added after enrollment", async () => {
  const f = automaticSetup();
  await f.manager.arm(automaticArm);
  f.settings.desktopHistoryTransfer = "selected";
  f.settings.desktopHistoryAccounts = [f.source.id, f.alternate.id];
  f.target.planning = { plan: "max20", capacityWeight: 20 };
  const added = account();
  added.planning = { plan: "max20", capacityWeight: 20 };
  f.accounts.push(added);
  f.usage[added.id] = {
    ...structuredClone(f.targetUsage),
    accountId: added.id,
  };
  await f.manager.tick();
  assert.equal(f.requests[0].target.id, f.alternate.id);
  assert.equal(f.requests[0].settings.desktopHistoryTransfer, "selected");
  assert.equal(
    f.requests[0].settings.desktopHistoryAccounts.includes(f.alternate.id),
    true,
  );
});

test("automatic target absence caused by history restrictions waits without any restart, timer mutation or pending attempt", async () => {
  const f = automaticSetup();
  f.observation.ownQuotaWakeup = true;
  f.observation.state.quiescence.scheduledWakeups = 1;
  await f.manager.arm(automaticArm);
  f.settings.desktopHistoryTransfer = "off";
  assert.equal((await f.manager.tick()).reason, "automatic-target-unavailable");
  assert.equal(f.preparations(), 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.persisted().pending, undefined);
  assert.equal(f.observation.state.quiescence.scheduledWakeups, 1);
});

test("automatic quota wakeup takeover binds the dynamically selected account durably before UI cancellation", async () => {
  const f = automaticSetup();
  f.target.planning = { plan: "pro", capacityWeight: 1 };
  f.alternate.planning = { plan: "max20", capacityWeight: 20 };
  f.observation.ownQuotaWakeup = true;
  f.observation.state.quiescence.scheduledWakeups = 1;
  const prepare = f.deps.prepareQuotaStop;
  f.deps.prepareQuotaStop = async (observation, request) => {
    assert.equal(request.target.id, f.alternate.id);
    assert.equal(f.persisted().pending?.arm.target.profileId, f.alternate.id);
    return prepare(observation, request);
  };
  await f.manager.arm(automaticArm);
  await f.manager.tick();
  assert.equal(f.preparations(), 1);
  assert.equal(f.requests[0].target.id, f.alternate.id);
  assert.equal(f.requests[0].expectedContextRevision, 4);
});

test("automatic mode retains exact source session and permission guards while waiting", async () => {
  for (const changed of ["session", "permission", "source"] as const) {
    const f = automaticSetup();
    await f.manager.arm(automaticArm);
    if (changed === "session") f.observation.state.session.id = randomUUID();
    if (changed === "permission")
      f.observation.state.session.permissionMode = "Manual";
    if (changed === "source")
      f.observation.state.identity = {
        profileId: f.target.id,
        accountUuid: f.target.desktop!.accountUuid,
        orgId: f.target.desktop!.orgId,
      };
    const result = await f.manager.tick();
    assert.equal(result.status, "blocked");
    assert.equal(
      result.reason,
      changed === "session"
        ? "selected-session-changed"
        : changed === "permission"
          ? "permission-mode-changed"
          : "source-account-changed",
    );
    assert.equal(f.requests.length, 0);
    assert.equal(f.preparations(), 0);
  }
});

test("automatic mode never selects or starts a handoff while other work or extra wakeups exist", async () => {
  for (const work of [
    "subagents",
    "busyWorkers",
    "waiting",
    "unknownWork",
    "scheduledWakeups",
  ] as const) {
    const f = automaticSetup();
    f.observation.ownQuotaWakeup = true;
    f.observation.state.quiescence.scheduledWakeups = 1;
    f.observation.state.quiescence[work] = work === "scheduledWakeups" ? 2 : 1;
    await f.manager.arm(automaticArm);
    assert.equal((await f.manager.tick()).status, "waiting");
    assert.equal(f.preparations(), 0);
    assert.equal(f.requests.length, 0);
    assert.equal(f.persisted().pending, undefined);
  }
});

test("uncertain automatic handoff freezes its chosen target through quota changes, new accounts and restart", async () => {
  const f = automaticSetup();
  f.alternate.planning = { plan: "max20", capacityWeight: 20 };
  f.result({
    status: "reconciliation-required",
    continuationKind: "stopped-session-new-turn",
    reason: "delivery-unknown",
  });
  await f.manager.arm(automaticArm);
  await f.manager.tick();
  const pending = f.persisted().pending!;
  assert.equal(pending.arm.target.profileId, f.alternate.id);
  f.usage[f.alternate.id].fiveHour!.usedPercent = 100;
  f.target.planning = { plan: "max20", capacityWeight: 20 };
  const added = account();
  f.accounts.push(added);
  f.usage[added.id] = {
    ...structuredClone(f.targetUsage),
    accountId: added.id,
  };
  const restarted = new DesktopContinuationManager(f.deps);
  await restarted.tick();
  assert.equal(f.requests.length, 1);
  await restarted.resumePending();
  assert.equal(f.requests[1].id, pending.id);
  assert.equal(f.requests[1].target.id, f.alternate.id);
  assert.equal(restarted.snapshot().targetId, f.alternate.id);
});

test("automatic enrollment survives durable reload and older explicit-target arms remain compatible", async () => {
  const f = automaticSetup();
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-automatic-enrollment-"),
  );
  try {
    const persistence = new FileDesktopContinuationPersistence(root);
    const deps = { ...f.deps, persistence };
    const manager = new DesktopContinuationManager(deps);
    await manager.arm(automaticArm);
    const restored = new DesktopContinuationManager({
      ...deps,
      persistence: new FileDesktopContinuationPersistence(root),
    });
    assert.equal(restored.snapshot().targetSelection, "automatic");
    assert.equal(restored.snapshot().targetId, undefined);
    assert.equal(restored.snapshot().allowedTargetCount, 2);
    await restored.tick();
    assert.equal(f.requests.length, 1);
    const explicit = new DesktopContinuationManager(f.deps);
    await explicit.arm({
      targetAccountId: f.target.id,
      executionPolicy: "guarded-native-at-most-once",
    });
    assert.equal(explicit.snapshot().targetSelection, undefined);
    assert.equal(explicit.snapshot().targetId, f.target.id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("guarded handoff may cancel only the selected stopped turn's own quota wakeup after complete policy validation", async () => {
  const f = wakeupSetup();
  const execute = f.deps.engine.execute;
  f.deps.engine.execute = async (request) => {
    assert.equal(f.persisted().pending?.id, request.id);
    assert.equal(f.persisted().pending?.ownQuotaWakeup, "cancelled-verified");
    assert.equal(f.persisted().pending?.expectedContextRevision, 4);
    return execute(request);
  };
  await f.manager.arm({
    targetAccountId: f.target.id,
    executionPolicy: "guarded-native-at-most-once",
  });
  assert.equal((await f.manager.tick()).status, "continued");
  assert.equal(f.preparations(), 1);
  assert.equal(
    f.requests[0].expectedContextRevision,
    4,
    "engine binds the fresh post-cancellation observation",
  );
  assert.equal(f.requests[0].permissionMode, "Auto");
});

test("unavailable target quota or nonexhausted source leaves the user's original wakeup intact", async () => {
  for (const sourceAvailable of [false, true]) {
    const f = wakeupSetup();
    if (sourceAvailable) f.sourceUsage.fiveHour.usedPercent = 20;
    else f.targetUsage.fiveHour.usedPercent = 98;
    await f.manager.arm({
      targetAccountId: f.target.id,
      executionPolicy: "guarded-native-at-most-once",
    });
    assert.equal(
      (await f.manager.tick()).reason,
      sourceAvailable ? "source-quota-available" : "target-quota-unavailable",
    );
    assert.equal(f.preparations(), 0);
    assert.equal(f.observation.state.quiescence.scheduledWakeups, 1);
    assert.equal(f.requests.length, 0);
  }
});

test("other work, multiple wakeups or unverified wakeup ownership never permits cancellation", async () => {
  const scenarios = [
    (f: ReturnType<typeof wakeupSetup>) => {
      f.observation.state.quiescence.unknownWork = 1;
    },
    (f: ReturnType<typeof wakeupSetup>) => {
      f.observation.state.quiescence.scheduledWakeups = 2;
    },
    (f: ReturnType<typeof wakeupSetup>) => {
      f.observation.ownQuotaWakeup = undefined;
    },
  ];
  for (const change of scenarios) {
    const f = wakeupSetup();
    change(f);
    await f.manager.arm({
      targetAccountId: f.target.id,
      executionPolicy: "guarded-native-at-most-once",
    });
    assert.notEqual((await f.manager.tick()).status, "continued");
    assert.equal(f.preparations(), 0);
    assert.equal(f.requests.length, 0);
  }
});

test("fresh reread after wake cancellation must preserve the exact permission and transcript checkpoint", async () => {
  for (const modeChanged of [false, true]) {
    const f = wakeupSetup();
    const original = f.deps.prepareQuotaStop;
    f.deps.prepareQuotaStop = async (observation, request) => {
      const after = await original(observation, request);
      if (modeChanged) after.state.session.permissionMode = "Manual";
      else after.state.session.transcriptRevision = "user-added-a-turn";
      return after;
    };
    await f.manager.arm({
      targetAccountId: f.target.id,
      executionPolicy: "guarded-native-at-most-once",
    });
    assert.equal(
      (await f.manager.tick()).observationReason,
      modeChanged ? "permission-mode-changed" : "quota-checkpoint-changed",
    );
    assert.equal(f.preparations(), 1);
    assert.equal(f.requests.length, 0);
    assert.equal(f.manager.snapshot().status, "reconciliation-required");
    assert.equal(f.manager.snapshot().reason, "own-quota-wakeup-uncertain");
    assert.equal(f.persisted().pending?.ownQuotaWakeup, "cancellation-intent");
    assert.equal(f.persisted().arm, undefined);
    await f.manager.tick();
    await f.manager.resumePending();
    assert.equal(f.preparations(), 1);
    assert.equal(f.requests.length, 0);
  }
});

test("wakeup cancellation failures retain durable intent and never retry, including after restart", async () => {
  for (const cancellationOccurred of [false, true]) {
    const f = wakeupSetup();
    let cancellations = 0;
    f.deps.prepareQuotaStop = async (observation, request) => {
      cancellations++;
      assert.equal(f.persisted().pending?.id, request.id);
      assert.equal(
        f.persisted().pending?.ownQuotaWakeup,
        "cancellation-intent",
      );
      if (cancellationOccurred) {
        f.observation.state.quiescence.scheduledWakeups = 0;
        f.observation.ownQuotaWakeup = false;
      }
      throw new Error("context-changed");
    };
    await f.manager.arm({
      targetAccountId: f.target.id,
      executionPolicy: "guarded-native-at-most-once",
    });
    const failed = await f.manager.tick();
    assert.equal(failed.status, "reconciliation-required");
    assert.equal(failed.reason, "own-quota-wakeup-uncertain");
    assert.equal(failed.observationReason, "context-changed");
    assert.equal(f.requests.length, 0);
    const pendingId = f.persisted().pending!.id;
    const restarted = new DesktopContinuationManager(f.deps);
    assert.equal(restarted.snapshot().reason, "own-quota-wakeup-uncertain");
    await restarted.tick();
    await restarted.resumePending();
    assert.equal(cancellations, 1);
    assert.equal(f.requests.length, 0);
    assert.equal(f.persisted().pending!.id, pendingId);
    assert.equal(
      f.observation.state.quiescence.scheduledWakeups,
      cancellationOccurred ? 0 : 1,
    );
  }
});

test("failed pre-cancellation persistence leaves the original Desktop wakeup untouched", async () => {
  const f = wakeupSetup();
  const save = f.deps.persistence.save;
  f.deps.persistence.save = (state) => {
    if (state.pending?.ownQuotaWakeup === "cancellation-intent")
      throw new Error("disk-full");
    save(state);
  };
  await f.manager.arm({
    targetAccountId: f.target.id,
    executionPolicy: "guarded-native-at-most-once",
  });
  assert.equal((await f.manager.tick()).status, "blocked");
  assert.equal(f.preparations(), 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.persisted().pending, undefined);
  assert.equal(f.observation.state.quiescence.scheduledWakeups, 1);
});

test("failed post-cancellation persistence preserves uncertain takeover instead of invoking the engine", async () => {
  const f = wakeupSetup();
  const save = f.deps.persistence.save;
  f.deps.persistence.save = (state) => {
    if (state.pending?.ownQuotaWakeup === "cancelled-verified")
      throw new Error("disk-full");
    save(state);
  };
  await f.manager.arm({
    targetAccountId: f.target.id,
    executionPolicy: "guarded-native-at-most-once",
  });
  assert.equal((await f.manager.tick()).reason, "own-quota-wakeup-uncertain");
  assert.equal(f.preparations(), 1);
  assert.equal(f.requests.length, 0);
  assert.equal(f.persisted().pending?.ownQuotaWakeup, "cancellation-intent");
  assert.equal(f.observation.state.quiescence.scheduledWakeups, 0);
  const restarted = new DesktopContinuationManager(f.deps);
  await restarted.tick();
  await restarted.resumePending();
  assert.equal(f.preparations(), 1);
  assert.equal(f.requests.length, 0);
});

test("engine rejection after verified wakeup cancellation retains reconciliation and exact durable binding", async () => {
  const f = wakeupSetup();
  f.result({
    status: "blocked",
    continuationKind: "stopped-session-new-turn",
    reason: "unresolved-host-intent",
  });
  await f.manager.arm({
    targetAccountId: f.target.id,
    executionPolicy: "guarded-native-at-most-once",
  });
  const failed = await f.manager.tick();
  assert.equal(failed.status, "reconciliation-required");
  assert.equal(failed.reason, "unresolved-host-intent");
  const pending = f.persisted().pending!;
  assert.equal(pending.ownQuotaWakeup, "cancelled-verified");
  assert.equal(pending.id, f.requests[0].id);
  assert.equal(pending.expectedContextRevision, 4);
  const restarted = new DesktopContinuationManager(f.deps);
  await restarted.tick();
  assert.equal(f.requests.length, 1);
  await restarted.resumePending();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].id, pending.id);
  assert.equal(f.preparations(), 1);
  assert.equal(f.persisted().pending?.id, pending.id);
});

test("durable uncertain wakeup survives file reload and explicit unsent cancellation never restores or replays UI", async () => {
  const f = wakeupSetup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-wakeup-takeover-"));
  try {
    const persistence = new FileDesktopContinuationPersistence(root);
    let nativeCancellations = 0;
    let abandonedId: string | undefined;
    const deps = {
      ...f.deps,
      persistence,
      prepareQuotaStop: async (
        _observation: DesktopContinuationObservation,
        request: ContinuationRequest,
      ) => {
        nativeCancellations++;
        const saved = persistence.load();
        assert.equal(saved.pending?.ownQuotaWakeup, "cancellation-intent");
        assert.equal(saved.pending?.id, request.id);
        f.observation.state.quiescence.scheduledWakeups = 0;
        throw new Error("context-changed");
      },
      engine: {
        ...f.deps.engine,
        abandonUnsent: async (id: string) => {
          abandonedId = id;
        },
      },
    };
    const manager = new DesktopContinuationManager(deps);
    await manager.arm({
      targetAccountId: f.target.id,
      executionPolicy: "guarded-native-at-most-once",
    });
    await manager.tick();
    const pending = persistence.load().pending!;
    assert.equal(pending.ownQuotaWakeup, "cancellation-intent");
    const restarted = new DesktopContinuationManager({
      ...deps,
      persistence: new FileDesktopContinuationPersistence(root),
    });
    await restarted.tick();
    await restarted.resumePending();
    assert.equal(nativeCancellations, 1);
    assert.equal(f.requests.length, 0);
    const cancelled = await restarted.abandonPending();
    assert.equal(cancelled.status, "off");
    assert.equal(abandonedId, pending.id);
    assert.equal(persistence.load().pending, undefined);
    assert.equal(f.observation.state.quiescence.scheduledWakeups, 0);
    assert.equal(nativeCancellations, 1);
    assert.equal(f.requests.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an ambiguous handoff never repeats quota wakeup preparation during explicit reconciliation", async () => {
  const f = wakeupSetup();
  f.result({
    status: "reconciliation-required",
    continuationKind: "stopped-session-new-turn",
    reason: "delivery-unknown",
  });
  await f.manager.arm({
    targetAccountId: f.target.id,
    executionPolicy: "guarded-native-at-most-once",
  });
  await f.manager.tick();
  assert.equal(f.preparations(), 1);
  f.result({
    status: "continued",
    continuationKind: "stopped-session-new-turn",
    reason: "durable-delivery-confirmed",
  });
  await f.manager.resumePending();
  assert.equal(f.preparations(), 1);
  assert.equal(
    f.requests[1].expectedContextRevision,
    f.requests[0].expectedContextRevision,
  );
});

test("explicit cancellation clears only an engine-confirmed unsent pending intent, even after account identity changes", async () => {
  const f = setup();
  f.result({
    status: "reconciliation-required",
    continuationKind: "stopped-session-new-turn",
    reason: "target-identity-changed",
  });
  let cancelledId: string | undefined;
  const manager = new DesktopContinuationManager({
    ...f.deps,
    engine: {
      ...f.deps.engine,
      abandonUnsent: async (id: string) => {
        cancelledId = id;
      },
    },
  });
  await manager.arm({ targetAccountId: f.target.id });
  await manager.tick();
  const pendingId = f.persisted().pending!.id;
  f.target.auth!.loggedIn = false;
  const outcome = await manager.abandonPending();
  assert.equal(cancelledId, pendingId);
  assert.equal(outcome.status, "off");
  assert.equal(outcome.reason, "user-cancelled-unsent");
  assert.equal(f.persisted().pending, undefined);
  assert.equal(f.persisted().arm, undefined);
  assert.equal(f.requests.length, 1);
});

test("a possible send cannot be cleared by the manager's explicit cancellation action", async () => {
  const f = setup();
  f.result({
    status: "reconciliation-required",
    continuationKind: "stopped-session-new-turn",
    reason: "delivery-unknown",
  });
  const manager = new DesktopContinuationManager({
    ...f.deps,
    engine: {
      ...f.deps.engine,
      abandonUnsent: async () => {
        throw new Error("cannot-cancel-possible-send");
      },
    },
  });
  await manager.arm({ targetAccountId: f.target.id });
  await manager.tick();
  const before = f.persisted();
  await assert.rejects(manager.abandonPending(), /cannot-cancel-possible-send/);
  assert.deepEqual(f.persisted(), before);
  assert.equal(f.requests.length, 1);
});

test("unreadable optional automation state keeps the account panel usable but cannot arm, reset or write", async () => {
  const f = setup();
  let writes = 0;
  const manager = new DesktopContinuationManager({
    ...f.deps,
    persistence: {
      load: () => {
        throw new Error("synthetic-corrupt-state");
      },
      save: () => {
        writes++;
      },
    },
  });
  assert.equal(manager.snapshot().reason, "continuation-state-unreadable");
  assert.equal(manager.snapshot().executable, false);
  await manager.inspect();
  await manager.tick();
  manager.start();
  manager.stop();
  await assert.rejects(
    manager.arm({ targetAccountId: f.target.id }),
    /continuation-state-unreadable/,
  );
  await assert.rejects(manager.disarm(), /continuation-state-unreadable/);
  await assert.rejects(
    manager.resumePending(),
    /continuation-state-unreadable/,
  );
  await assert.rejects(
    manager.abandonPending(),
    /continuation-state-unreadable/,
  );
  assert.equal(writes, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.counts().observations, 0);
});

test("ambiguous delivery disables automation, survives restart and never resends automatically", async () => {
  const f = setup();
  f.result({
    status: "reconciliation-required",
    continuationKind: "stopped-session-new-turn",
    reason: "delivery-unknown",
  });
  await f.manager.arm({ targetAccountId: f.target.id });
  assert.equal((await f.manager.tick()).status, "reconciliation-required");
  const pending = f.persisted().pending!;
  assert.equal(f.persisted().arm, undefined);
  const restarted = new DesktopContinuationManager(f.deps);
  assert.equal(restarted.snapshot().status, "reconciliation-required");
  await restarted.tick();
  assert.equal(f.requests.length, 1);
  await assert.rejects(
    restarted.arm({ targetAccountId: f.target.id }),
    /unfinished-attempt/,
  );
  f.result({
    status: "continued",
    continuationKind: "stopped-session-new-turn",
    reason: "durable-delivery-confirmed",
  });
  await restarted.resumePending();
  assert.equal(f.requests[1].id, pending.id);
  assert.equal(
    f.requests[1].expectedContextRevision,
    pending.expectedContextRevision,
  );
  assert.equal(f.persisted().pending, undefined);
});

test("a recovery preflight failure retains unfinished binding instead of clearing an unknown send", async () => {
  const f = setup();
  f.result({
    status: "reconciliation-required",
    continuationKind: "stopped-session-new-turn",
    reason: "delivery-unknown",
  });
  await f.manager.arm({ targetAccountId: f.target.id });
  await f.manager.tick();
  const requestId = f.persisted().pending!.id;
  f.result({
    status: "blocked",
    continuationKind: "stopped-session-new-turn",
    reason: "adapter-contract-unverified",
  });
  const result = await f.manager.resumePending();
  assert.equal(result.status, "reconciliation-required");
  assert.equal(f.persisted().pending!.id, requestId);
});

test("pre-intent rejection retries only from a new fresh binding and deduplicates consumed quota events", async () => {
  const f = setup();
  f.result({
    status: "blocked",
    continuationKind: "stopped-session-new-turn",
    reason: "quota-not-fresh",
  });
  await f.manager.arm({ targetAccountId: f.target.id });
  await f.manager.tick();
  assert.equal(f.persisted().pending, undefined);
  f.observation.state.contextRevision++;
  f.result({
    status: "continued",
    continuationKind: "stopped-session-new-turn",
    reason: "new-turn-verified",
  });
  await f.manager.tick();
  assert.notEqual(f.requests[0].id, f.requests[1].id);
  assert.equal(f.requests[1].expectedContextRevision, 4);
  await f.manager.arm({ targetAccountId: f.target.id });
  assert.equal(
    (await f.manager.tick()).reason,
    "quota-episode-already-continued",
  );
  assert.equal(f.requests.length, 2);
});

test("durable state is private, reloads the exact intent and refuses corrupt or symlinked files", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-continuation-manager-"),
  );
  try {
    const persistence = new FileDesktopContinuationPersistence(directory);
    assert.deepEqual(persistence.load(), { version: 1, completed: [] });
    persistence.save({
      version: 1,
      completed: [{ key: "a".repeat(64), at: NOW }],
    });
    assert.equal(
      new FileDesktopContinuationPersistence(directory).load().completed[0].at,
      NOW,
    );
    if (process.platform !== "win32")
      assert.equal(fs.statSync(persistence.file).mode & 0o777, 0o600);
    fs.writeFileSync(persistence.file, "{");
    assert.throws(() => persistence.load(), /continuation-state-unreadable/);
    fs.unlinkSync(persistence.file);
    fs.writeFileSync(path.join(directory, "elsewhere"), "{}");
    fs.symlinkSync(path.join(directory, "elsewhere"), persistence.file);
    assert.throws(() => persistence.load(), /continuation-state-unreadable/);
    assert.throws(
      () => persistence.save({ version: 1, completed: [] }),
      /continuation-file-invalid/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("application manager runs the real guarded engine and durable journal through one same-session handoff", async () => {
  const f = setup();
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-manager-engine-"),
  );
  try {
    f.capabilities.kind = "guarded-native";
    f.capabilities.atomicContextGuard = false;
    f.capabilities.idempotentDelivery = false;
    f.observation.state.quiescence.coverage = "guarded-local";
    const state = f.observation.state;
    const actions: string[] = [];
    const check = (revision: number) => {
      assert.equal(revision, state.contextRevision);
      assert.equal(state.session.status, "stopped");
    };
    const host: ContinuationHost = {
      capabilities: f.capabilities,
      readState: async () => structuredClone(state),
      checkpoint: async (input) => {
        check(input.expectedContextRevision);
        actions.push("checkpoint");
        state.contextRevision++;
        return {
          id: "synthetic-checkpoint",
          session: structuredClone(state.session),
        };
      },
      switchAccount: async (input) => {
        check(input.expectedContextRevision);
        actions.push("switch");
        state.identity = structuredClone(input.target);
        state.contextRevision++;
      },
      reopenSession: async (input) => {
        check(input.expectedContextRevision);
        actions.push("reopen");
        state.session = structuredClone(input.checkpoint.session);
        state.contextRevision++;
      },
      sendContinuation: async (input) => {
        check(input.expectedContextRevision);
        actions.push("send");
        const beforeRevision = state.session.transcriptRevision;
        state.session.transcriptRevision = "synthetic-next-turn";
        state.session.lastRequestId = input.requestId;
        state.session.lastTurnId = "synthetic-turn-4";
        state.session.status = "running";
        state.contextRevision++;
        return {
          status: "started",
          receipt: {
            requestId: input.requestId,
            identity: structuredClone(input.target),
            sessionId: state.session.id,
            projectKey: state.session.projectKey,
            permissionMode: state.session.permissionMode,
            beforeRevision,
            afterRevision: state.session.transcriptRevision,
            turnId: state.session.lastTurnId,
          },
        };
      },
      lookupDelivery: async () => ({ status: "unknown" }),
    };
    const journal = new FileContinuationJournal(
      path.join(directory, "journal"),
      () => NOW,
    );
    const engine = new ContinuationEngine(host, journal, () => NOW);
    const usage = (id: string, used: number) => ({
      accountId: id,
      status: "ready" as const,
      stale: false,
      checkedAt: new Date(NOW).toISOString(),
      fiveHour: {
        usedPercent: used,
        resetsAt: new Date(NOW + 3_600_000).toISOString(),
      },
      sevenDay: {
        usedPercent: 20,
        resetsAt: new Date(NOW + 86_400_000).toISOString(),
      },
    });
    const manager = new DesktopContinuationManager({
      ...f.deps,
      engine,
      persistence: new FileDesktopContinuationPersistence(
        path.join(directory, "manager"),
      ),
      snapshot: () => ({
        accounts: [f.source, f.target],
        settings: structuredClone(DEFAULT_SETTINGS),
        usage: {
          [f.source.id]: usage(f.source.id, 100),
          [f.target.id]: usage(f.target.id, 10),
        },
      }),
    });
    await manager.arm({
      targetAccountId: f.target.id,
      executionPolicy: "guarded-native-at-most-once",
    });
    const outcome = await manager.tick();
    assert.equal(outcome.status, "continued");
    assert.equal(outcome.enabled, false);
    assert.equal(state.session.permissionMode, "Auto");
    assert.equal(state.identity.profileId, f.target.id);
    assert.deepEqual(actions, ["checkpoint", "switch", "reopen", "send"]);
    assert.deepEqual(await journal.listPending(), []);
    const saved = new FileDesktopContinuationPersistence(
      path.join(directory, "manager"),
    ).load();
    assert.equal(saved.pending, undefined);
    assert.equal(saved.arm, undefined);
    assert.equal(saved.completed.length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
