import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  CONTINUATION_TEXT,
  ContinuationEngine,
  isTerminalContinuationRecord,
  type ContinuationCheckpoint,
  type ContinuationDelivery,
  type ContinuationHost,
  type ContinuationIdentity,
  type ContinuationJournal,
  type ContinuationJournalRecord,
  type ContinuationRequest,
  type ContinuationState,
} from "../electron/core/continuation";
import {
  DEFAULT_SETTINGS,
  type Account,
  type AccountUsage,
} from "../shared/types";

const NOW = Date.parse("2026-10-13T14:00:00Z");
function account(name: string): Account {
  const accountUuid = randomUUID(),
    orgId = randomUUID();
  return {
    id: randomUUID(),
    name,
    kind: "personal",
    group: "fixture-only",
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
const profileIdentity = (account: Account): ContinuationIdentity => ({
  profileId: account.id,
  accountUuid: account.desktop!.accountUuid,
  orgId: account.desktop!.orgId,
});
function usage(account: Account, used: number): AccountUsage {
  return {
    accountId: account.id,
    status: "ready",
    stale: false,
    checkedAt: new Date(NOW).toISOString(),
    fiveHour: {
      usedPercent: used,
      resetsAt: new Date(NOW + 3600000).toISOString(),
    },
    sevenDay: {
      usedPercent: 25,
      resetsAt: new Date(NOW + 86400000).toISOString(),
    },
  };
}
class MemoryJournal implements ContinuationJournal {
  records = new Map<string, ContinuationJournalRecord>();
  writes: string[] = [];
  failStage?: string;
  private tail = Promise.resolve();
  async withLock<T>(_id: string, action: () => Promise<T>) {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
  async read(id: string) {
    return structuredClone(this.records.get(id));
  }
  async listPending() {
    return structuredClone(
      [...this.records.values()].filter(
        (record) => !isTerminalContinuationRecord(record, NOW),
      ),
    );
  }
  async write(record: ContinuationJournalRecord) {
    if (record.stage === this.failStage) {
      this.failStage = undefined;
      throw new Error("fixture-journal-fsync-failed");
    }
    this.records.set(record.id, structuredClone(record));
    this.writes.push(record.stage);
  }
}
class FixtureHost implements ContinuationHost {
  capabilities = {
    kind: "simulated" as const,
    contractId: "fixture-v1",
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
  actions: string[] = [];
  deliveries = new Map<string, ContinuationDelivery>();
  messages: { requestId: string; text: string; accountId: string }[] = [];
  faults = new Set<string>();
  checkpoints = new Map<string, ContinuationCheckpoint>();
  constructor(public state: ContinuationState) {}
  async readState() {
    const state = structuredClone(this.state);
    if (this.faults.has("user-race") && this.actions.includes("reopen"))
      this.state.contextRevision++;
    return state;
  }
  private guard(revision: number) {
    if (revision !== this.state.contextRevision)
      throw new Error("atomic-context-guard-rejected");
    if (this.state.session.status !== "stopped")
      throw new Error("fixture-session-busy");
  }
  async checkpoint(input: Parameters<ContinuationHost["checkpoint"]>[0]) {
    this.guard(input.expectedContextRevision);
    this.actions.push("checkpoint");
    const checkpoint = {
      id: `checkpoint-${input.requestId}`,
      session: structuredClone(this.state.session),
    };
    if (this.faults.has("bad-checkpoint")) checkpoint.session.id = randomUUID();
    this.checkpoints.set(checkpoint.id, structuredClone(checkpoint));
    this.state.contextRevision++;
    return checkpoint;
  }
  async switchAccount(input: Parameters<ContinuationHost["switchAccount"]>[0]) {
    this.guard(input.expectedContextRevision);
    this.actions.push("switch");
    this.state.identity = structuredClone(input.target);
    this.state.contextRevision++;
    if (this.faults.has("wrong-account"))
      this.state.identity.accountUuid = randomUUID();
    if (this.faults.has("busy-after-switch"))
      this.state.quiescence.subagents = 1;
    if (this.faults.has("crash-after-switch"))
      throw new Error("fixture-crash-after-switch");
  }
  async reopenSession(input: Parameters<ContinuationHost["reopenSession"]>[0]) {
    this.guard(input.expectedContextRevision);
    this.actions.push("reopen");
    this.state.session = structuredClone(
      this.checkpoints.get(input.checkpoint.id)!.session,
    );
    this.state.contextRevision++;
    if (this.faults.has("wrong-session")) this.state.session.id = randomUUID();
    if (this.faults.has("wrong-project"))
      this.state.session.projectKey = "fixture-other-project";
    if (this.faults.has("changed-transcript"))
      this.state.session.transcriptRevision = "user-added-turn";
    if (this.faults.has("changed-permissions"))
      this.state.session.permissionMode = "bypassPermissions";
  }
  async sendContinuation(
    input: Parameters<ContinuationHost["sendContinuation"]>[0],
  ): Promise<ContinuationDelivery> {
    this.guard(input.expectedContextRevision);
    const existing = this.deliveries.get(input.requestId);
    if (existing) return structuredClone(existing);
    this.actions.push("send");
    if (this.faults.has("refused")) return { status: "rejected" as const };
    this.messages.push({
      requestId: input.requestId,
      text: input.text,
      accountId: this.state.identity.profileId,
    });
    const beforeRevision = this.state.session.transcriptRevision;
    const afterRevision = `${beforeRevision}:continued`,
      turnId = randomUUID();
    this.state.session = {
      ...this.state.session,
      transcriptRevision: afterRevision,
      lastRequestId: input.requestId,
      lastTurnId: turnId,
      status: "running",
    };
    this.state.contextRevision++;
    const delivery: ContinuationDelivery = {
      status: "started",
      receipt: {
        requestId: input.requestId,
        identity: structuredClone(this.state.identity),
        sessionId: this.state.session.id,
        projectKey: this.state.session.projectKey,
        permissionMode: this.state.session.permissionMode,
        beforeRevision,
        afterRevision,
        turnId,
      },
    };
    this.deliveries.set(input.requestId, structuredClone(delivery));
    if (this.faults.has("crash-after-send"))
      throw new Error("fixture-crash-after-send");
    if (this.faults.has("accepted-only"))
      return { ...delivery, status: "accepted" };
    if (this.faults.has("receipt-wrong-account"))
      delivery.receipt!.identity.accountUuid = randomUUID();
    if (this.faults.has("receipt-not-observed"))
      this.state.session.lastTurnId = randomUUID();
    return delivery;
  }
  async lookupDelivery(id: string) {
    this.actions.push("lookup");
    if (this.faults.has("ambiguous-lookup"))
      return { status: "unknown" as const };
    if (this.faults.has("absent-lookup")) return { status: "absent" as const };
    return structuredClone(
      this.deliveries.get(id) ?? { status: "absent" as const },
    );
  }
}
function fixture() {
  const source = account("Fixture A"),
    target = account("Fixture B");
  const request: ContinuationRequest = {
    id: randomUUID(),
    source,
    target,
    authorized: true,
    settings: structuredClone(DEFAULT_SETTINGS),
    usage: { [source.id]: usage(source, 100), [target.id]: usage(target, 20) },
    sessionId: randomUUID(),
    projectKey: "fixture-project",
    transcriptRevision: "revision-0",
    permissionMode: "default",
    expectedContextRevision: 7,
  };
  const host = new FixtureHost({
    contextRevision: 7,
    observedAt: NOW,
    identity: profileIdentity(source),
    session: {
      id: request.sessionId,
      projectKey: request.projectKey,
      transcriptRevision: request.transcriptRevision,
      permissionMode: request.permissionMode,
      status: "stopped",
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
  });
  const journal = new MemoryJournal();
  return {
    source,
    target,
    request,
    host,
    journal,
    engine: new ContinuationEngine(host, journal, () => NOW),
  };
}

test("guarded native transport requires explicit at-most-once consent and verified worker coverage", async () => {
  const f = fixture();
  Object.assign(f.host.capabilities, {
    kind: "guarded-native",
    idempotentDelivery: false,
    atomicContextGuard: false,
  });
  f.host.state.quiescence.coverage = "guarded-local";
  assert.equal(
    (await f.engine.execute(f.request)).reason,
    "adapter-contract-unverified",
  );
  assert.deepEqual(f.host.actions, []);
  f.request.executionPolicy = "guarded-native-at-most-once";
  f.host.state.quiescence.coverage = "unknown";
  assert.equal(
    (await f.engine.execute(f.request)).reason,
    "coverage-unverified",
  );
  assert.deepEqual(f.host.actions, []);
  f.host.state.quiescence.coverage = "guarded-local";
  const result = await f.engine.execute(f.request);
  assert.equal(result.status, "continued");
  assert.equal(isTerminalContinuationRecord(result.record, NOW), true);
  assert.equal(f.host.messages.length, 1);
  assert.equal(
    JSON.parse(result.record!.boundRequest).executionPolicy,
    "guarded-native-at-most-once",
  );
  const changed = { ...f.request, executionPolicy: undefined };
  Object.assign(f.host.capabilities, {
    kind: "verified-contract",
    idempotentDelivery: true,
    atomicContextGuard: true,
  });
  assert.equal(
    (await f.engine.execute(changed)).reason,
    "journal-binding-mismatch",
  );
  assert.equal(f.host.messages.length, 1);
});

test("native opt-in cannot weaken a transport advertising a verified atomic contract", async () => {
  const f = fixture();
  Object.assign(f.host.capabilities, {
    kind: "verified-contract",
    atomicContextGuard: false,
  });
  f.request.executionPolicy = "guarded-native-at-most-once";
  assert.equal(
    (await f.engine.execute(f.request)).reason,
    "adapter-contract-unverified",
  );
  assert.deepEqual(f.host.actions, []);
});

test("quota-ended A→B→A resumes the same UUID/project/history and starts one target-account turn each way", async () => {
  const f = fixture();
  const first = await f.engine.execute(f.request);
  assert.equal(first.status, "continued");
  assert.equal(first.continuationKind, "stopped-session-new-turn");
  assert.deepEqual(f.host.actions, ["checkpoint", "switch", "reopen", "send"]);
  assert.equal(f.host.messages[0].accountId, f.target.id);
  assert.equal(f.host.messages[0].text, CONTINUATION_TEXT);
  assert.ok(
    f.journal.writes.indexOf("send-intent") <
      f.journal.writes.indexOf("delivery-confirmed"),
  );
  f.host.state.session.status = "stopped";
  const back: ContinuationRequest = {
    ...f.request,
    id: randomUUID(),
    source: f.target,
    target: f.source,
    usage: {
      [f.target.id]: usage(f.target, 100),
      [f.source.id]: usage(f.source, 20),
    },
    transcriptRevision: first.receipt!.afterRevision,
    expectedContextRevision: f.host.state.contextRevision,
  };
  const second = await f.engine.execute(back);
  assert.equal(second.status, "continued");
  assert.equal(second.receipt!.sessionId, first.receipt!.sessionId);
  assert.equal(second.receipt!.projectKey, first.receipt!.projectKey);
  assert.equal(second.receipt!.beforeRevision, first.receipt!.afterRevision);
  assert.equal(f.host.messages.length, 2);
  assert.equal(f.host.messages[1].accountId, f.source.id);
});
test("every busy/child/wait/queue/schedule/unknown signal blocks before any host mutation", async () => {
  for (const key of [
    "busyWorkers",
    "subagents",
    "pendingTasks",
    "waiting",
    "queuedPrompts",
    "scheduledWakeups",
    "unknownWork",
  ] as const) {
    for (const value of [1, NaN, -1]) {
      const f = fixture();
      f.host.state.quiescence[key] = value;
      assert.equal((await f.engine.execute(f.request)).status, "blocked", key);
      assert.deepEqual(f.host.actions, []);
    }
  }
});
test("a source worker must be stopped, with fresh complete observed coverage and the captured context revision", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.host.state.session.status = "running";
    },
    (f: ReturnType<typeof fixture>) => {
      f.host.state.session.status = "waiting";
    },
    (f: ReturnType<typeof fixture>) => {
      f.host.state.quiescence.coverage = "unknown";
    },
    (f: ReturnType<typeof fixture>) => {
      f.host.state.observedAt = NOW - 15001;
    },
    (f: ReturnType<typeof fixture>) => {
      f.host.state.observedAt = NOW + 1;
    },
    (f: ReturnType<typeof fixture>) => {
      f.host.state.contextRevision++;
    },
  ]) {
    const f = fixture();
    change(f);
    assert.equal((await f.engine.execute(f.request)).status, "blocked");
    assert.deepEqual(f.host.actions, []);
  }
});
test("authorization and every executable capability are mandatory", async () => {
  for (const key of [
    "exactSession",
    "conditionalActions",
    "idempotentDelivery",
    "deliveryLookup",
    "checkpoint",
    "accountSwitch",
    "sessionReopen",
    "targetedSend",
    "deliveryReceipt",
    "atomicContextGuard",
  ] as const) {
    const f = fixture();
    f.host.capabilities[key] = false;
    assert.equal(
      (await f.engine.execute(f.request)).reason,
      "adapter-contract-unverified",
    );
    assert.deepEqual(f.host.actions, []);
  }
  const f = fixture();
  f.request.authorized = false;
  assert.equal((await f.engine.execute(f.request)).reason, "not-authorized");
});
test("account enrollment, duplicate identities, source identity and exact source history are verified", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.source.auth!.loggedIn = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.target.auth!.orgId = randomUUID();
    },
    (f: ReturnType<typeof fixture>) => {
      f.target.desktop = structuredClone(f.source.desktop);
      f.target.auth = structuredClone(f.source.auth);
    },
    (f: ReturnType<typeof fixture>) => {
      f.host.state.identity.accountUuid = randomUUID();
    },
    (f: ReturnType<typeof fixture>) => {
      f.host.state.session.id = randomUUID();
    },
    (f: ReturnType<typeof fixture>) => {
      f.host.state.session.transcriptRevision = "other-revision";
    },
    (f: ReturnType<typeof fixture>) => {
      f.host.state.session.permissionMode = "other-mode";
    },
  ]) {
    const f = fixture();
    change(f);
    assert.equal((await f.engine.execute(f.request)).status, "blocked");
    assert.deepEqual(f.host.actions, []);
  }
});
test("cross-company history needs both selected endpoints and off never grants same-group access", async () => {
  const f = fixture();
  f.target.kind = "work";
  f.target.group = "fixture-work";
  assert.equal((await f.engine.execute(f.request)).reason, "history-boundary");
  f.request.settings.desktopHistoryTransfer = "selected";
  f.request.settings.desktopHistoryAccounts = [f.target.id];
  assert.equal((await f.engine.execute(f.request)).reason, "history-boundary");
  f.request.settings.desktopHistoryAccounts.push(f.source.id);
  assert.equal((await f.engine.execute(f.request)).status, "continued");
  const off = fixture();
  off.request.settings.desktopHistoryTransfer = "off";
  assert.equal(
    (await off.engine.execute(off.request)).reason,
    "history-boundary",
  );
});
test("source and target require known fresh quota; source recovered quota and target 90% block", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.request.usage[f.target.id].fiveHour = undefined;
    },
    (f: ReturnType<typeof fixture>) => {
      f.request.usage[f.target.id].stale = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.request.usage[f.target.id].issue = "rate-limited";
    },
    (f: ReturnType<typeof fixture>) => {
      f.request.usage[f.target.id].checkedAt = new Date(NOW + 1).toISOString();
    },
    (f: ReturnType<typeof fixture>) => {
      f.request.usage[f.source.id].checkedAt = new Date(
        NOW - 300001,
      ).toISOString();
    },
    (f: ReturnType<typeof fixture>) => {
      f.request.usage[f.source.id].fiveHour!.usedPercent = 99;
    },
    (f: ReturnType<typeof fixture>) => {
      f.request.usage[f.target.id].sevenDay!.usedPercent = 90;
    },
    (f: ReturnType<typeof fixture>) => {
      f.request.usage[f.target.id].fiveHour!.resetsAt = new Date(
        NOW,
      ).toISOString();
    },
    (f: ReturnType<typeof fixture>) => {
      f.target.cooldownUntil = new Date(NOW + 1).toISOString();
    },
  ]) {
    const f = fixture();
    change(f);
    assert.equal((await f.engine.execute(f.request)).status, "blocked");
    assert.deepEqual(f.host.actions, []);
  }
});
test("checkpoint mismatch, switch identity mismatch and newly busy child tasks stop before reopening or sending", async () => {
  for (const [fault, actions] of [
    ["bad-checkpoint", ["checkpoint"]],
    ["wrong-account", ["checkpoint", "switch"]],
    ["busy-after-switch", ["checkpoint", "switch"]],
  ] as const) {
    const f = fixture();
    f.host.faults.add(fault);
    assert.equal(
      (await f.engine.execute(f.request)).status,
      "reconciliation-required",
    );
    assert.deepEqual(f.host.actions, actions);
    assert.equal(f.host.messages.length, 0);
  }
});
test("reopened UUID, project, transcript and permission mode must all match before the continuation send", async () => {
  for (const fault of [
    "wrong-session",
    "wrong-project",
    "changed-transcript",
    "changed-permissions",
  ]) {
    const f = fixture();
    f.host.faults.add(fault);
    assert.equal(
      (await f.engine.execute(f.request)).reason,
      "session-mismatch",
    );
    assert.equal(f.host.messages.length, 0);
  }
});
test("atomic context guard rejects a user turn racing the final send", async () => {
  const f = fixture();
  f.host.faults.add("user-race");
  assert.equal(
    (await f.engine.execute(f.request)).reason,
    "atomic-context-guard-rejected",
  );
  assert.equal(f.host.messages.length, 0);
});
test("accepted-only delivery is distinct from observed new-turn start", async () => {
  const f = fixture();
  f.host.faults.add("accepted-only");
  assert.equal((await f.engine.execute(f.request)).reason, "delivery-accepted");
  assert.equal(
    (await f.journal.read(f.request.id))!.stage,
    "delivery-accepted",
  );
  assert.equal(f.host.messages.length, 1);
  assert.equal(
    (
      await new ContinuationEngine(f.host, f.journal, () => NOW).execute(
        f.request,
      )
    ).status,
    "continued",
  );
  assert.equal(f.host.messages.length, 1);
});
test("receipt identity and the observed new turn independently gate confirmation", async () => {
  for (const [fault, reason] of [
    ["receipt-wrong-account", "receipt-mismatch"],
    ["receipt-not-observed", "new-turn-not-observed"],
  ]) {
    const f = fixture();
    f.host.faults.add(fault);
    assert.equal((await f.engine.execute(f.request)).reason, reason);
    assert.notEqual(
      (await f.journal.read(f.request.id))!.stage,
      "delivery-confirmed",
    );
  }
});
test("crash after submission reconciles persisted receipt without resending after engine restart", async () => {
  const f = fixture();
  f.host.faults.add("crash-after-send");
  assert.equal(
    (await f.engine.execute(f.request)).status,
    "reconciliation-required",
  );
  assert.equal(f.host.messages.length, 1);
  const restarted = new ContinuationEngine(f.host, f.journal, () => NOW);
  assert.equal((await restarted.execute(f.request)).status, "continued");
  assert.equal(f.host.messages.length, 1);
  assert.equal(f.host.actions.filter((a) => a === "send").length, 1);
});
test("absent or ambiguous receipt after a recorded send intent never causes a retry", async () => {
  for (const fault of ["absent-lookup", "ambiguous-lookup"]) {
    const f = fixture();
    f.host.faults.add("crash-after-send");
    await f.engine.execute(f.request);
    f.host.faults.add(fault);
    const result = await new ContinuationEngine(
      f.host,
      f.journal,
      () => NOW,
    ).execute(f.request);
    assert.equal(result.status, "reconciliation-required");
    assert.equal(f.host.messages.length, 1);
    assert.equal(f.host.actions.filter((a) => a === "send").length, 1);
  }
});
test("crash before submission leaves an absent receipt for explicit recovery, not automatic execution", async () => {
  const f = fixture();
  f.host.faults.add("user-race");
  await f.engine.execute(f.request);
  f.host.faults.clear();
  const result = await new ContinuationEngine(
    f.host,
    f.journal,
    () => NOW,
  ).execute(f.request);
  assert.equal(result.reason, "delivery-absent");
  assert.equal(f.host.messages.length, 0);
});
test("durable journal writes precede side effects and a failed send-intent write prevents sending", async () => {
  const prepared = fixture();
  prepared.journal.failStage = "prepared";
  await assert.rejects(
    prepared.engine.execute(prepared.request),
    /fsync-failed/,
  );
  assert.deepEqual(prepared.host.actions, []);
  const sending = fixture();
  sending.journal.failStage = "send-intent";
  assert.equal(
    (await sending.engine.execute(sending.request)).status,
    "reconciliation-required",
  );
  assert.equal(sending.host.messages.length, 0);
});
test("crash after switching resumes a durable unsent checkpoint without replaying the account switch", async () => {
  const f = fixture();
  f.host.faults.add("crash-after-switch");
  await f.engine.execute(f.request);
  assert.equal(
    (
      await new ContinuationEngine(f.host, f.journal, () => NOW).execute(
        f.request,
      )
    ).status,
    "continued",
  );
  assert.equal(
    f.host.actions.filter((action) => action === "switch").length,
    1,
  );
  assert.equal(f.host.messages.length, 1);
  assert.equal(f.host.state.session.id, f.request.sessionId);
});
test("a completed request is durable, idempotent and bound to account/session/permission/history", async () => {
  const f = fixture();
  await f.engine.execute(f.request);
  const actions = [...f.host.actions];
  assert.equal(
    (await f.engine.execute(f.request)).reason,
    "durable-delivery-confirmed",
  );
  assert.deepEqual(f.host.actions, actions);
  for (const update of [
    { target: account("Other") },
    { sessionId: randomUUID() },
    { transcriptRevision: "changed" },
    { permissionMode: "bypassPermissions" },
  ]) {
    assert.equal(
      (await f.engine.execute({ ...f.request, ...update })).reason,
      "journal-binding-mismatch",
    );
    assert.deepEqual(f.host.actions, actions);
  }
});
test("the host-wide journal lock prevents concurrent duplicate execution", async () => {
  const f = fixture();
  const results = await Promise.all([
    f.engine.execute(f.request),
    new ContinuationEngine(f.host, f.journal, () => NOW).execute(f.request),
  ]);
  assert.ok(results.every((result) => result.status === "continued"));
  assert.equal(f.host.messages.length, 1);
});

test("a Team source with unknown weekly quota can hand off a known exhausted 5h window", async () => {
  const f = fixture();
  f.source.kind = "work";
  f.source.planning = { plan: "team", capacityWeight: 1 };
  f.request.usage[f.source.id].sevenDay = undefined;
  assert.equal((await f.engine.execute(f.request)).status, "continued");
  const unknown = fixture();
  unknown.request.usage[unknown.source.id].fiveHour = undefined;
  unknown.request.usage[unknown.source.id].sevenDay = undefined;
  assert.equal(
    (await unknown.engine.execute(unknown.request)).reason,
    "quota-not-fresh",
  );
});
test("a fresh target with zero used and no start/reset timestamp is eligible; nonzero missing reset is blocked", async () => {
  const f = fixture();
  f.request.usage[f.target.id].fiveHour = { usedPercent: 0 };
  assert.equal((await f.engine.execute(f.request)).status, "continued");
  const nonzero = fixture();
  nonzero.request.usage[nonzero.target.id].fiveHour = { usedPercent: 1 };
  assert.equal(
    (await nonzero.engine.execute(nonzero.request)).reason,
    "quota-not-fresh",
  );
});
test("a new request ID cannot bypass an unresolved send, even for a different session", async () => {
  const f = fixture();
  f.host.faults.add("crash-after-send");
  await f.engine.execute(f.request);
  f.host.state.session.status = "stopped";
  f.host.faults.clear();
  for (const sessionId of [f.request.sessionId, randomUUID()]) {
    const result = await f.engine.execute({
      ...f.request,
      id: randomUUID(),
      source: f.target,
      target: f.source,
      usage: {
        [f.target.id]: usage(f.target, 100),
        [f.source.id]: usage(f.source, 0),
      },
      sessionId,
      transcriptRevision: f.host.state.session.transcriptRevision,
      expectedContextRevision: f.host.state.contextRevision,
    });
    assert.equal(result.reason, "unresolved-host-intent");
    assert.equal(f.host.messages.length, 1);
  }
});
test("corrupt persisted terminal records neither claim success nor exempt the host-wide barrier", async () => {
  for (const corrupt of [
    (r: ContinuationJournalRecord) => {
      r.receipt!.identity.accountUuid = randomUUID();
    },
    (r: ContinuationJournalRecord) => {
      r.receipt!.sessionId = randomUUID();
    },
    (r: ContinuationJournalRecord) => {
      r.sendRecorded = false;
    },
    (r: ContinuationJournalRecord) => {
      r.stage = "blocked";
      r.sendRecorded = true;
    },
    (r: ContinuationJournalRecord) => {
      r.updatedAt = NaN;
    },
    (r: ContinuationJournalRecord) => {
      r.updatedAt = NOW + 1;
    },
    (r: ContinuationJournalRecord) => {
      r.stage = "session-verified";
      r.sendRecorded = false;
    },
  ]) {
    const f = fixture();
    await f.engine.execute(f.request);
    const record = f.journal.records.get(f.request.id)!;
    corrupt(record);
    assert.equal(isTerminalContinuationRecord(record, NOW), false);
    assert.equal(
      (await f.engine.execute(f.request)).reason,
      "journal-record-invalid",
    );
    const actions = [...f.host.actions];
    assert.equal(
      (await f.engine.execute({ ...f.request, id: randomUUID() })).reason,
      "unresolved-host-intent",
    );
    assert.deepEqual(f.host.actions, actions);
  }
});
test("existing unsent recovery also blocks while another host intent is unresolved", async () => {
  const f = fixture();
  f.host.faults.add("crash-after-switch");
  await f.engine.execute(f.request);
  const other = structuredClone(f.journal.records.get(f.request.id)!);
  other.id = randomUUID();
  other.stage = "send-intent";
  other.sendRecorded = true;
  f.journal.records.set(other.id, other);
  const actions = [...f.host.actions];
  assert.equal(
    (await f.engine.execute(f.request)).reason,
    "unresolved-host-intent",
  );
  assert.deepEqual(f.host.actions, actions);
});

test("unsent recovery never overwrites a user-updated copy of the same conversation", async () => {
  const f = fixture();
  f.host.faults.add("crash-after-switch");
  await f.engine.execute(f.request);
  f.host.state.session.transcriptRevision = "user-turn-after-crash";
  f.host.faults.clear();
  const actions = [...f.host.actions];
  assert.equal((await f.engine.execute(f.request)).reason, "session-mismatch");
  assert.deepEqual(f.host.actions, actions);
  assert.equal(f.host.messages.length, 0);
});
