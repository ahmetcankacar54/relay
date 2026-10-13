import assert from "node:assert/strict";
import test from "node:test";
import {
  DesktopAutomationError,
  DesktopContinuationHost,
  nativeDesktopAutomation,
  type DesktopAutomation,
  type DesktopAutomationSnapshot,
  type DesktopContinuationEvidence,
  type DesktopContinuationObservation,
} from "../electron/core/desktop-continuation-host";
import type {
  ContinuationCheckpoint,
  ContinuationDelivery,
} from "../electron/core/continuation";

const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const localId = `local_${id}`;
const source = {
  profileId: "source",
  accountUuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  orgId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
};
const target = {
  ...source,
  profileId: "target",
  accountUuid: "dddddddd-dddd-dddd-dddd-dddddddddddd",
};
const snapshot = (): DesktopAutomationSnapshot => ({
  observedAt: 100,
  pid: 456,
  localSessionId: localId,
  accountLabel: "Test User Company",
  permissionMode: "Auto",
  status: "stopped",
  quotaStopped: true,
  composerEmpty: true,
  sendEnabled: true,
  contextFingerprint: "a".repeat(64),
  coverage: "active-conversation-only",
});
const state = (): DesktopContinuationObservation => ({
  observedAt: 100,
  contextRevision: 1,
  localSessionId: localId,
  identity: source,
  session: {
    id,
    projectKey: "project-key",
    transcriptRevision: "rev-1",
    permissionMode: "Auto",
    status: "stopped",
  },
  quiescence: {
    coverage: "guarded-local",
    busyWorkers: 0,
    subagents: 0,
    pendingTasks: 0,
    waiting: 0,
    queuedPrompts: 0,
    scheduledWakeups: 0,
    unknownWork: 0,
  },
});
function fixture() {
  let ui = snapshot();
  let observed = state();
  let delivery: ContinuationDelivery = { status: "absent" };
  const calls: string[] = [];
  const automation: DesktopAutomation = {
    inspect: async () => ({ ...ui }),
    openSession: async (alias) => {
      calls.push(`open:${alias}`);
    },
    setPermission: async (_guard, mode) => {
      calls.push(`mode:${mode}`);
      ui.permissionMode = mode;
      observed.session.permissionMode = mode;
      return { ...ui };
    },
    send: async (_guard, requestId) => {
      calls.push(`send:${requestId}`);
      return { acceptedVisible: true };
    },
    hasRequestMarker: async () => false,
  };
  const evidence: DesktopContinuationEvidence = {
    read: async () => structuredClone(observed),
    checkpoint: async (input) => {
      calls.push("checkpoint");
      return { id: "checkpoint", session: input.session };
    },
    switchAccount: async () => {
      calls.push("switch");
    },
    localSessionId: async () => localId,
    lookupDelivery: async () => delivery,
  };
  return {
    host: new DesktopContinuationHost(automation, evidence, async () => {}),
    ui,
    observed,
    calls,
    setDelivery: (value: ContinuationDelivery) => {
      delivery = value;
    },
  };
}
const blocked = (issue: string) => (error: unknown) =>
  error instanceof DesktopAutomationError && error.issue === issue;

test("native adapter exposes absence of atomic and receiver-idempotent guarantees", () => {
  const { host } = fixture();
  assert.equal(host.capabilities.atomicContextGuard, false);
  assert.equal(host.capabilities.idempotentDelivery, false);
});
test("quota-stopped selected conversation does not prove full quiescence", async () => {
  const f = fixture();
  f.observed.quiescence.coverage = "unknown";
  await assert.rejects(
    f.host.switchAccount({
      requestId: "request",
      target,
      expectedContextRevision: 1,
    }),
    blocked("desktop-observation-incomplete"),
  );
  assert.deepEqual(f.calls, []);
});
test("native host requires its explicit guarded-local observation contract", async () => {
  for (const coverage of ["verified-all", "isolated-all"] as const) {
    const f = fixture();
    f.observed.quiescence.coverage = coverage;
    await assert.rejects(
      f.host.switchAccount({
        requestId: "request",
        target,
        expectedContextRevision: 1,
      }),
      blocked("desktop-observation-incomplete"),
    );
    assert.deepEqual(f.calls, []);
  }
});
test("any live sibling, pending task, queue, wakeup or unknown blocks mutation", async () => {
  for (const key of [
    "busyWorkers",
    "subagents",
    "pendingTasks",
    "waiting",
    "queuedPrompts",
    "scheduledWakeups",
    "unknownWork",
  ] as const) {
    const f = fixture();
    f.observed.quiescence[key] = 1;
    await assert.rejects(
      f.host.switchAccount({
        requestId: "request",
        target,
        expectedContextRevision: 1,
      }),
      blocked("desktop-work-active"),
    );
    assert.deepEqual(f.calls, []);
  }
});
test("changed generation or active UI turn blocks checkpoint", async () => {
  const f = fixture();
  f.ui.status = "running";
  await assert.rejects(
    f.host.checkpoint({
      requestId: "request",
      session: f.observed.session,
      expectedContextRevision: 1,
    }),
    blocked("desktop-work-active"),
  );
  f.ui.status = "stopped";
  await assert.rejects(
    f.host.checkpoint({
      requestId: "request",
      session: f.observed.session,
      expectedContextRevision: 2,
    }),
    blocked("context-changed"),
  );
  assert.deepEqual(f.calls, []);
});
test("a Desktop title/alias mismatch cannot checkpoint the same UUID", async () => {
  const f = fixture();
  f.ui.localSessionId = "local_eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
  await assert.rejects(
    f.host.checkpoint({
      requestId: "request",
      session: f.observed.session,
      expectedContextRevision: 1,
    }),
    blocked("exact-session-not-observed"),
  );
  assert.deepEqual(f.calls, []);
});
test("reopen restores and verifies the captured permission mode", async () => {
  const f = fixture();
  const checkpoint: ContinuationCheckpoint = {
    id: "checkpoint",
    session: structuredClone(f.observed.session),
  };
  f.observed.identity = target;
  f.ui.permissionMode = "Manual";
  f.observed.session.permissionMode = "Manual";
  await f.host.reopenSession({
    requestId: "request",
    checkpoint,
    target,
    expectedContextRevision: 1,
  });
  assert.deepEqual(f.calls, [`open:${localId}`, "mode:Auto"]);
});
test("reopen does not change permissions while another task is present", async () => {
  const f = fixture();
  const checkpoint = {
    id: "checkpoint",
    session: structuredClone(f.observed.session),
  };
  f.observed.identity = target;
  f.ui.permissionMode = "Manual";
  f.observed.session.permissionMode = "Manual";
  f.observed.quiescence.subagents = 1;
  await assert.rejects(
    f.host.reopenSession({
      requestId: "request",
      checkpoint,
      target,
      expectedContextRevision: 1,
    }),
    blocked("desktop-work-active"),
  );
  assert.deepEqual(f.calls, []);
});
test("a visible UI acceptance is not fabricated into a durable receipt", async () => {
  const f = fixture();
  const result = await f.host.sendContinuation({
    requestId: "request",
    target: source,
    session: f.observed.session,
    expectedContextRevision: 1,
    text: "Continue",
  });
  assert.deepEqual(result, { status: "unknown" });
  assert.deepEqual(f.calls, ["send:request"]);
});
test("existing ambiguous delivery is never sent a second time", async () => {
  const f = fixture();
  f.setDelivery({ status: "unknown" });
  assert.deepEqual(
    await f.host.sendContinuation({
      requestId: "request",
      target: source,
      session: f.observed.session,
      expectedContextRevision: 1,
      text: "Continue",
    }),
    { status: "unknown" },
  );
  assert.deepEqual(f.calls, []);
});
test("new user text or permission change prevents send", async () => {
  const f = fixture();
  f.ui.composerEmpty = false;
  const input = {
    requestId: "request",
    target: source,
    session: f.observed.session,
    expectedContextRevision: 1,
    text: "Continue",
  };
  await assert.rejects(
    f.host.sendContinuation(input),
    blocked("composer-not-empty"),
  );
  f.ui.composerEmpty = true;
  f.ui.permissionMode = "Manual";
  await assert.rejects(
    f.host.sendContinuation(input),
    blocked("permission-mode-mismatch"),
  );
  assert.deepEqual(f.calls, []);
});
test("native reply validation hides arbitrary helper output and requires selected-scope metadata", async () => {
  const adapter = nativeDesktopAutomation("/unused", async () => ({
    ok: true,
    snapshot: { ...snapshot(), coverage: "guarded-local" },
  }));
  await assert.rejects(adapter.inspect(), blocked("desktop-ui-unsupported"));
  const errorAdapter = nativeDesktopAutomation("/unused", async () => ({
    ok: false,
    issue: "credential secret",
  }));
  await assert.rejects(
    errorAdapter.inspect(),
    blocked("desktop-ui-unsupported"),
  );
});
test("native transport validates exact IDs and never uses last-session navigation", async () => {
  const commands: unknown[] = [];
  const adapter = nativeDesktopAutomation("/unused", async (input) => {
    commands.push(input);
    return { ok: true };
  });
  await assert.rejects(
    adapter.openSession("last"),
    blocked("exact-session-not-observed"),
  );
  await adapter.openSession(localId);
  assert.deepEqual(commands, [
    { command: "open-session", localSessionId: localId },
  ]);
  await assert.rejects(
    adapter.send(
      {
        pid: 1,
        localSessionId: localId,
        accountLabel: "test",
        permissionMode: "Auto",
        contextFingerprint: "a".repeat(64),
      },
      "request",
      "a\0b",
    ),
    blocked("desktop-ui-unsupported"),
  );
  assert.equal(commands.length, 1);
});
