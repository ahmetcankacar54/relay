import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  DesktopAutomationError,
  DesktopContinuationHost,
  isLocalSessionId,
  nativeDesktopAutomation,
  newSessionGuard,
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
    openSession: async (alias, options) => {
      // Continuation never asks the helper to check the user: it opens as before.
      calls.push(
        options === undefined
          ? `open:${alias}`
          : `open:${alias}:${JSON.stringify(options)}`,
      );
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
    openNewSession: async () => {
      throw new Error("openNewSession must not be called here");
    },
    writeDraft: async () => {
      throw new Error("writeDraft must not be called here");
    },
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
test("a snapshot's composerPresent is optional, and a boolean when given", async () => {
  const reply = (extra: Record<string, unknown>) =>
    nativeDesktopAutomation("/unused", async () => ({
      ok: true,
      snapshot: { ...snapshot(), ...extra },
    }));
  assert.equal(
    (await reply({ composerPresent: true }).inspect()).composerPresent,
    true,
  );
  assert.equal(
    (await reply({ composerPresent: false }).inspect()).composerPresent,
    false,
  );
  // An older helper does not report it.
  assert.equal((await reply({}).inspect()).composerPresent, undefined);
  await assert.rejects(
    reply({ composerPresent: "yes" }).inspect(),
    blocked("desktop-ui-unsupported"),
  );
});
test("a snapshot keeps frontmost and idleMs, which are optional and well-formed when given", async () => {
  const reply = (extra: Record<string, unknown>) =>
    nativeDesktopAutomation("/unused", async () => ({
      ok: true,
      snapshot: { ...snapshot(), ...extra },
    }));
  const kept = await reply({ frontmost: true, idleMs: 4_250 }).inspect();
  assert.equal(kept.frontmost, true);
  assert.equal(kept.idleMs, 4_250);
  const behind = await reply({ frontmost: false, idleMs: 0 }).inspect();
  assert.equal(behind.frontmost, false);
  assert.equal(behind.idleMs, 0);
  // An older helper reports neither.
  const older = await reply({}).inspect();
  assert.equal(older.frontmost, undefined);
  assert.equal(older.idleMs, undefined);
  for (const bad of [
    { frontmost: "yes" },
    { frontmost: 1 },
    { idleMs: -1 },
    { idleMs: 1.5 },
    { idleMs: "60000" },
    { idleMs: Number.POSITIVE_INFINITY },
  ])
    await assert.rejects(
      reply(bad).inspect(),
      blocked("desktop-ui-unsupported"),
      JSON.stringify(bad),
    );
  // writeDraft's snapshot is read the same way.
  const written = await nativeDesktopAutomation("/unused", async () => ({
    ok: true,
    snapshot: { ...snapshot(), frontmost: true, idleMs: 9_000 },
  })).writeDraft(draftGuard(), "draft");
  assert.equal(written.frontmost, true);
  assert.equal(written.idleMs, 9_000);
});
test("a snapshot keeps keyIdleMs, which is optional and a whole number of ms when given", async () => {
  const reply = (extra: Record<string, unknown>) =>
    nativeDesktopAutomation("/unused", async () => ({
      ok: true,
      snapshot: { ...snapshot(), ...extra },
    }));
  assert.equal((await reply({ keyIdleMs: 1_250 }).inspect()).keyIdleMs, 1_250);
  assert.equal((await reply({ keyIdleMs: 0 }).inspect()).keyIdleMs, 0);
  assert.equal((await reply({}).inspect()).keyIdleMs, undefined);
  for (const bad of [-1, 1.5, "1000", Number.POSITIVE_INFINITY, true])
    await assert.rejects(
      reply({ keyIdleMs: bad }).inspect(),
      blocked("desktop-ui-unsupported"),
      String(bad),
    );
});
test("only an exact local session id passes isLocalSessionId", () => {
  assert.equal(isLocalSessionId(localId), true);
  // The id is matched whatever the case of its hex digits.
  const upper = `local_${id.toUpperCase()}`;
  assert.equal(isLocalSessionId(upper), true);
  for (const bad of [id, `local_${id}x`, `local_../${id}`, "local_", ""])
    assert.equal(isLocalSessionId(bad), false, bad);
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
test("send passes on how the text went in, the screen after Send and the step a failure came from", async () => {
  const guard = {
    pid: 1,
    localSessionId: localId,
    accountLabel: "test",
    permissionMode: "Auto",
    contextFingerprint: "a".repeat(64),
  };
  const after = {
    status: "stopped",
    composerPresent: true,
    composerEmpty: false,
    composerHoldsText: true,
    composerChars: 47,
    markerVisible: false,
    sendPresent: true,
  };
  const sent = nativeDesktopAutomation("/unused", async () => ({
    ok: true,
    acceptedVisible: false,
    written: "paste",
    submitted: "return",
    after: { ...after, waitedMs: 600 },
  }));
  assert.deepEqual(await sent.send(guard, "request", "Try again"), {
    acceptedVisible: false,
    written: "paste",
    submitted: "return",
    after: { ...after, waitedMs: 600 },
  });
  // An older helper, or one with a malformed report, still sends: only the extras drop.
  const older = nativeDesktopAutomation("/unused", async () => ({
    ok: true,
    acceptedVisible: true,
    written: "typed",
    after: { ...after, status: 3 },
  }));
  assert.deepEqual(await older.send(guard, "request", "Try again"), {
    acceptedVisible: true,
  });
  const failed = (step: unknown) =>
    nativeDesktopAutomation("/unused", async () => ({
      ok: false,
      issue: "desktop-ui-unsupported",
      step,
    })).send(guard, "request", "Try again");
  await assert.rejects(
    failed("press"),
    (error: unknown) =>
      error instanceof DesktopAutomationError &&
      error.issue === "desktop-ui-unsupported" &&
      error.step === "press",
  );
  await assert.rejects(
    failed("secret text"),
    (error: unknown) =>
      error instanceof DesktopAutomationError && error.step === undefined,
  );
});
test("a helper that times out, exits or prints no JSON says which", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-helper-"));
  const script = (name: string, body: string) => {
    const file = path.join(directory, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    return file;
  };
  try {
    const step = async (helper: string) => {
      try {
        await nativeDesktopAutomation(helper).inspect();
      } catch (error) {
        return error instanceof DesktopAutomationError ? error.step : "other";
      }
      return "resolved";
    };
    assert.equal(await step(script("exit.sh", "exit 3")), "helper-exit");
    assert.equal(
      await step(script("text.sh", "echo not-json")),
      "helper-output",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("openSession asks the helper to check the user only when asked", async () => {
  const commands: unknown[] = [];
  const adapter = nativeDesktopAutomation("/unused", async (input) => {
    commands.push(input);
    return { ok: true };
  });
  await adapter.openSession(localId);
  await adapter.openSession(localId, { requireIdle: true });
  await adapter.openSession(localId, { requireIdle: false });
  await adapter.openSession(localId, {});
  assert.deepEqual(commands, [
    { command: "open-session", localSessionId: localId },
    { command: "open-session", localSessionId: localId, requireIdle: true },
    { command: "open-session", localSessionId: localId },
    { command: "open-session", localSessionId: localId },
  ]);
  // The helper's refusal comes through as itself.
  const refused = nativeDesktopAutomation("/unused", async () => ({
    ok: false,
    issue: "user-active",
  }));
  await assert.rejects(
    refused.openSession(localId, { requireIdle: true }),
    blocked("user-active"),
  );
});

const draftGuard = () => ({
  pid: 456,
  localSessionId: localId,
  accountLabel: "Test User Company",
  permissionMode: "Auto",
  contextFingerprint: "a".repeat(64),
});
test("writeDraft sends the write-draft command with the guard and text", async () => {
  const commands: unknown[] = [];
  const written = { ...snapshot(), composerEmpty: false };
  const adapter = nativeDesktopAutomation("/unused", async (input) => {
    commands.push(input);
    return { ok: true, snapshot: written };
  });
  const result = await adapter.writeDraft(draftGuard(), "Merhaba\nDünya");
  assert.deepEqual(commands, [
    { command: "write-draft", guard: draftGuard(), text: "Merhaba\nDünya" },
  ]);
  assert.deepEqual(result, written);
  // The 16 384 character limit is inclusive.
  await adapter.writeDraft(draftGuard(), "a".repeat(16_384));
  assert.equal(commands.length, 2);
});
test("writeDraft passes keysIdleMs only when given, and refuses one out of 500 to 3000 without calling the helper", async () => {
  const commands: unknown[] = [];
  const adapter = nativeDesktopAutomation("/unused", async (input) => {
    commands.push(input);
    return { ok: true, snapshot: snapshot() };
  });
  await adapter.writeDraft(draftGuard(), "draft", { keysIdleMs: 1_000 });
  await adapter.writeDraft(draftGuard(), "draft", {});
  await adapter.writeDraft(draftGuard(), "draft", { keysIdleMs: 500 });
  await adapter.writeDraft(draftGuard(), "draft", { keysIdleMs: 3_000 });
  assert.deepEqual(commands, [
    {
      command: "write-draft",
      guard: draftGuard(),
      text: "draft",
      keysIdleMs: 1_000,
    },
    { command: "write-draft", guard: draftGuard(), text: "draft" },
    {
      command: "write-draft",
      guard: draftGuard(),
      text: "draft",
      keysIdleMs: 500,
    },
    {
      command: "write-draft",
      guard: draftGuard(),
      text: "draft",
      keysIdleMs: 3_000,
    },
  ]);
  for (const keysIdleMs of [499, 3_001, 1.5, Number.NaN, -1])
    await assert.rejects(
      adapter.writeDraft(draftGuard(), "draft", { keysIdleMs }),
      blocked("desktop-ui-unsupported"),
      String(keysIdleMs),
    );
  assert.equal(commands.length, 4);
});
test("writeDraft refuses empty, NUL and over-long text without calling the helper", async () => {
  const commands: unknown[] = [];
  const adapter = nativeDesktopAutomation("/unused", async (input) => {
    commands.push(input);
    return { ok: true, snapshot: snapshot() };
  });
  for (const text of ["", "a\0b", "a".repeat(16_385)])
    await assert.rejects(
      adapter.writeDraft(draftGuard(), text),
      blocked("desktop-ui-unsupported"),
    );
  assert.deepEqual(commands, []);
});
test("writeDraft maps composer-not-empty and context-changed", async () => {
  for (const issue of [
    "composer-not-empty",
    "context-changed",
    "delivery-ambiguous",
    "accessibility-permission-required",
    // The helper refused before typing: the user is active or Claude is not in front.
    "user-active",
  ] as const) {
    const adapter = nativeDesktopAutomation("/unused", async () => ({
      ok: false,
      issue,
    }));
    await assert.rejects(
      adapter.writeDraft(draftGuard(), "draft"),
      blocked(issue),
    );
  }
  const unknown = nativeDesktopAutomation("/unused", async () => ({
    ok: false,
    issue: "draft text echoed back",
  }));
  await assert.rejects(
    unknown.writeDraft(draftGuard(), "draft"),
    blocked("desktop-ui-unsupported"),
  );
  // A reply without a valid snapshot cannot prove what is in the composer.
  const noSnapshot = nativeDesktopAutomation("/unused", async () => ({
    ok: true,
  }));
  await assert.rejects(
    noSnapshot.writeDraft(draftGuard(), "draft"),
    blocked("desktop-ui-unsupported"),
  );
});
test("a snapshot's newSession is optional, a boolean, and never comes with a conversation id", async () => {
  const reply = (extra: Record<string, unknown>) =>
    nativeDesktopAutomation("/unused", async () => ({
      ok: true,
      snapshot: { ...snapshot(), ...extra },
    }));
  const { localSessionId: _, ...screen } = snapshot();
  assert.equal(
    (
      await reply({
        ...screen,
        localSessionId: undefined,
        newSession: true,
      }).inspect()
    ).newSession,
    true,
  );
  assert.equal(
    (await reply({ newSession: false }).inspect()).newSession,
    false,
  );
  // An older helper does not report it.
  assert.equal((await reply({}).inspect()).newSession, undefined);
  for (const bad of [
    { newSession: "yes" },
    { newSession: 1 },
    // A conversation is not the new-session screen.
    { newSession: true },
  ])
    await assert.rejects(
      reply(bad).inspect(),
      blocked("desktop-ui-unsupported"),
      JSON.stringify(bad),
    );
});
const newSessionView = (
  over: Partial<DesktopAutomationSnapshot> = {},
): DesktopAutomationSnapshot => {
  const { localSessionId: _, ...rest } = snapshot();
  return { ...rest, newSession: true, ...over };
};
test("newSessionGuard names the new-session screen, with its mode only when one was read", () => {
  assert.deepEqual(newSessionGuard(newSessionView()), {
    pid: 456,
    newSession: true,
    accountLabel: "Test User Company",
    permissionMode: "Auto",
    contextFingerprint: "a".repeat(64),
  });
  const modeless = newSessionGuard(
    newSessionView({ permissionMode: undefined }),
  );
  assert.equal("permissionMode" in modeless, false);
  // A conversation, or a screen that is neither, is not the new-session screen.
  for (const view of [
    snapshot(),
    { ...snapshot(), localSessionId: undefined },
    newSessionView({ newSession: false }),
    newSessionView({ localSessionId: localId }),
  ])
    assert.throws(
      () => newSessionGuard(view),
      blocked("exact-session-not-observed"),
    );
  // Without its account the screen cannot be told apart from another account's.
  assert.throws(
    () => newSessionGuard(newSessionView({ accountLabel: undefined })),
    blocked("desktop-ui-unsupported"),
  );
});
test("openNewSession sends open-new-session, asking the helper to check the user only when asked", async () => {
  const commands: unknown[] = [];
  const adapter = nativeDesktopAutomation("/unused", async (input) => {
    commands.push(input);
    return { ok: true };
  });
  await adapter.openNewSession();
  await adapter.openNewSession({ requireIdle: true });
  await adapter.openNewSession({ requireIdle: false });
  assert.deepEqual(commands, [
    { command: "open-new-session" },
    { command: "open-new-session", requireIdle: true },
    { command: "open-new-session" },
  ]);
  const refused = nativeDesktopAutomation("/unused", async () => ({
    ok: false,
    issue: "user-active",
  }));
  await assert.rejects(
    refused.openNewSession({ requireIdle: true }),
    blocked("user-active"),
  );
});
test("writeDraft passes a new-session guard to the helper as it is", async () => {
  const commands: unknown[] = [];
  const adapter = nativeDesktopAutomation("/unused", async (input) => {
    commands.push(input);
    return { ok: true, snapshot: newSessionView({ composerEmpty: false }) };
  });
  const guard = newSessionGuard(newSessionView({ permissionMode: undefined }));
  const result = await adapter.writeDraft(guard, "draft");
  assert.deepEqual(commands, [
    { command: "write-draft", guard, text: "draft" },
  ]);
  assert.equal(result.newSession, true);
});
test("writeDraft never sends: the request has no requestId", async () => {
  const commands: Record<string, unknown>[] = [];
  const adapter = nativeDesktopAutomation("/unused", async (input) => {
    commands.push(input as Record<string, unknown>);
    return { ok: true, snapshot: snapshot() };
  });
  await adapter.writeDraft(draftGuard(), "draft");
  assert.equal(commands.length, 1);
  assert.deepEqual(Object.keys(commands[0]).sort(), [
    "command",
    "guard",
    "text",
  ]);
  assert.equal(commands[0].command, "write-draft");
  assert.equal("requestId" in commands[0], false);
});

// The helper cannot be run in tests (it drives the real Claude UI), so these
// scan its source for the properties that matter most. Comments are stripped:
// only code counts.
const swiftSource = readFileSync(
  path.join(import.meta.dirname, "../electron/native/desktop-automation.swift"),
  "utf8",
);
/** The `{ ... }` block that follows `header`, with `//` comments removed. */
function swiftBlock(header: string): string {
  const start = swiftSource.indexOf(header);
  assert.notEqual(start, -1, `${header} not found`);
  const open = swiftSource.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < swiftSource.length; i++) {
    if (swiftSource[i] === "{") depth++;
    else if (swiftSource[i] === "}" && --depth === 0)
      return swiftSource.slice(open, i + 1).replace(/\/\/.*$/gm, "");
  }
  throw new Error(`${header} is not closed`);
}
test("the Swift write-draft branch and writeComposer never press, send or add a marker", () => {
  const branch = swiftBlock('if command == "write-draft" {');
  const composer = swiftBlock("func writeComposer(");
  assert.match(branch, /writeComposer\(/);
  assert.doesNotMatch(branch, /marker/i);
  assert.doesNotMatch(branch, /requestId/i);
  // writeComposer is shared with send: it must only type, never press a button or Return.
  for (const [name, block] of [
    ["write-draft", branch],
    ["writeComposer", composer],
  ]) {
    for (const forbidden of [
      "press(",
      "AXUIElementPerformAction",
      "kAXPressAction",
      "virtualKey: 36",
      "virtualKey: 76",
    ])
      assert.equal(block.includes(forbidden), false, `${name}: ${forbidden}`);
    // Return (36) and keypad Enter (76) send, however the call is spaced.
    assert.doesNotMatch(block, /virtualKey:\s*(?:36|76)\b/, name);
  }
  // Its only key is V (9), for the paste.
  const keys = [...composer.matchAll(/virtualKey:\s*([^,)\s]+)/g)].map(
    (m) => m[1],
  );
  assert.ok(keys.length > 0);
  assert.deepEqual([...new Set(keys)], ["9"]);
  // send submits outside both blocks: with Return, since Send pressed through AX did nothing.
  const send = swiftBlock('if command == "send" {');
  assert.match(send, /try submitComposer\(current\)/);
  assert.doesNotMatch(send, /press\(send\)/);
});
test("the Swift write-draft branch checks the user, then re-reads the composer and conversation, right before writing", () => {
  const branch = swiftBlock('if command == "write-draft" {');
  const at = (text: string) => branch.indexOf(text);
  const guarded = at("let composer = current.composer");
  const active = at('fail("user-active")');
  const write = at("writeComposer(");
  assert.ok(guarded !== -1 && active !== -1 && write !== -1);
  // First the text and composer guard, then whether the user is active, then the re-reads.
  assert.ok(guarded < active);
  for (const before of [
    "composerReadsEmpty(composer.element)",
    'fail("composer-not-empty")',
    "liveScreen(",
    'fail("context-changed")',
  ]) {
    const i = at(before);
    assert.ok(i > active, `${before} must follow the user check`);
    assert.ok(i < write, `${before} must precede writeComposer`);
  }
  // Read fresh, never from the observation: Claude in front and 3 s without input, or, when
  // the caller names keysIdleMs (500 to 3000), no key for that long.
  const check = branch.slice(guarded, at("composerReadsEmpty("));
  assert.match(
    check,
    /if let keys = request\["keysIdleMs"\] \{\s*guard let ms = keys as\? Int, \(500\.\.\.3000\)\.contains\(ms\) else \{ try fail\("desktop-ui-unsupported"\) \}\s*quiet = keyIdleMilliseconds\(\) >= ms\s*\} else \{\s*quiet = idleMilliseconds\(\) >= 3000\s*\}/,
  );
  assert.match(
    check,
    /guard claudeFrontmost\(current\.app\), quiet else \{ try fail\("user-active"\) \}/,
  );
  assert.doesNotMatch(check, /current\.fields/);
});
test("the Swift open-session checks the user right before opening, and only when asked", () => {
  const block = swiftBlock(
    'if command == "open-session" || command == "open-new-session" {',
  );
  const at = (text: string) => block.indexOf(text);
  const observed = at("let observation = try observe()");
  const flag = at('if request["requireIdle"] as? Bool == true {');
  const check = at(
    'guard claudeFrontmost(observation.app), idleMilliseconds() >= 3000 else { try fail("user-active") }',
  );
  const open = at("NSWorkspace.shared.open(url)");
  for (const [name, i] of Object.entries({ observed, flag, check, open }))
    assert.notEqual(i, -1, name);
  // After its observe() and right before the open, read fresh, never from the observation.
  assert.ok(observed < flag && flag < check && check < open);
  assert.doesNotMatch(block, /observation\.fields/);
  // The check sits inside the flag's branch: without the flag nothing new runs.
  assert.match(
    block,
    /if request\["requireIdle"\] as\? Bool == true \{\s*guard claudeFrontmost\(observation\.app\), idleMilliseconds\(\) >= 3000 else \{ try fail\("user-active"\) \}\s*\}/,
  );
  // Nothing else opens a URL in that block.
  assert.equal(block.split("NSWorkspace.shared.open(").length - 1, 1);
  // Its only links: an exact conversation, and Desktop's own new-session link with nothing
  // after it, so no text ever travels in a URL (its ?q= would prefill the composer). Read
  // from the source as it is: stripping `//` comments would cut the links too.
  const raw = swiftSource.slice(
    swiftSource.indexOf('if command == "open-session" ||'),
    swiftSource.indexOf('if command == "lookup" {'),
  );
  const links = [...raw.matchAll(/"(claude:\/\/[^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(links, [
    "claude://code/continue?session=\\(id)",
    "claude://code/new",
  ]);
});
test("the Swift helper accepts a new-session guard for write-draft only", () => {
  // validateGuard takes a guard without a conversation id only when allowed to.
  const check = swiftBlock("func validateGuard(");
  assert.match(check, /if named \{\s*guard allowNewSession,/);
  const handler = swiftBlock("func handle(");
  assert.match(handler, /let draft = command == "write-draft"/);
  assert.match(
    handler,
    /try validateGuard\(current, expected, allowNewSession: draft\)/,
  );
  // No other command's branch allows it.
  for (const command of ["cancel-quota-resume", "set-permission", "send"])
    assert.doesNotMatch(
      swiftBlock(`if command == "${command}" {`),
      /allowNewSession/,
      command,
    );
  // write-draft re-reads the screen right before writing: still the new-session screen.
  assert.match(
    swiftBlock('if command == "write-draft" {'),
    /if expected\["newSession"\] as\? Bool == true \{\s*guard live\.newSession else \{ try fail\("context-changed"\) \}/,
  );
});
test("the Swift snapshot names the new-session screen inside the fingerprint", () => {
  const body = swiftBlock("func observe()");
  const stable = body.indexOf("var stable: [String: Any] = [");
  const flag = body.indexOf(
    'if screen.newSession { stable["newSession"] = true }',
  );
  const serialized = body.indexOf("let serialized");
  assert.ok(stable !== -1 && flag > stable && flag < serialized);
  // The same pure classifier names the conversation, so the two cannot disagree.
  assert.match(
    body,
    /let screen = screenOf\(webAreas\.flatMap \{ \$0\.strings \}\)/,
  );
  assert.match(body, /let localID = screen\.localSessionId/);
});
test("the Swift snapshot reports frontmost and idleMs outside the fingerprint", () => {
  const body = swiftBlock("func observe()");
  const stable = body.slice(
    body.indexOf("var stable: [String: Any] = ["),
    body.indexOf("let serialized"),
  );
  assert.ok(stable.length > 0);
  assert.doesNotMatch(stable, /frontmost|idleMs/);
  const fingerprint = body.indexOf('fields["contextFingerprint"]');
  for (const field of [
    'fields["frontmost"] = claudeFrontmost(app)',
    'fields["idleMs"] = idleMilliseconds()',
  ]) {
    const i = body.indexOf(field);
    assert.ok(i !== -1 && i > fingerprint, field);
  }
  assert.match(
    swiftBlock("func claudeFrontmost("),
    /NSWorkspace\.shared\.frontmostApplication\?\.processIdentifier == app\.processIdentifier/,
  );
  assert.match(
    swiftBlock("func idleMilliseconds("),
    /CGEventSource\.secondsSinceLastEventType\(\.combinedSessionState, eventType: CGEventType\(rawValue: ~0\)!\)/,
  );
  // keyIdleMs too: keys and modifiers only, read after the fingerprint.
  const keys = body.indexOf('fields["keyIdleMs"] = keyIdleMilliseconds()');
  assert.ok(keys > fingerprint);
  assert.doesNotMatch(stable, /keyIdleMs/);
  assert.match(
    swiftBlock("func keyIdleMilliseconds("),
    /\[CGEventType\.keyDown, \.flagsChanged\]\.map \{\s*CGEventSource\.secondsSinceLastEventType\(\.combinedSessionState, eventType: \$0\)\s*\}\.min\(\)/,
  );
});
test("the Swift watch only reads: it opens, types, presses and observes nothing, and ends on its own", () => {
  const body = swiftBlock("func watch(");
  for (const forbidden of [
    /writeComposer\(/,
    /press\(/,
    /NSWorkspace\.shared\.open/,
    /AXUIElementSetAttributeValue/,
    /AXUIElementPerformAction/,
    /CGEvent\(/,
    /observe\(\)/,
    /NSPasteboard/,
    /requestAccessibility|AXIsProcessTrustedWithOptions/,
  ])
    assert.doesNotMatch(body, forbidden, String(forbidden));
  // Ends with stdin, with Claude, and after 10 minutes; never asks for accessibility.
  assert.match(
    body,
    /FileHandle\.standardInput\.readDataToEndOfFile\(\)\s*exit\(0\)/,
  );
  assert.match(body, /guard AXIsProcessTrusted\(\) else/);
  assert.match(body, /Date\(\)\.addingTimeInterval\(600\)/);
  assert.match(body, /emit\(\["gone": true\]\)/);
  // Its times are bounded, and it reads the web areas only while Claude is in front.
  assert.match(
    body,
    /\(250\.\.\.10000\)\.contains\(quietMs\), \(250\.\.\.10000\)\.contains\(idleMs\)/,
  );
  assert.match(body, /if front \{\s*if areas\.isEmpty/);
  assert.match(body, /front \? 0\.25 : 1/);
  // The cheap walk never enters a web area or the menu bar, and stops at 300 elements.
  const walk = swiftBlock("func webAreas(");
  assert.match(walk, /seen < 300/);
  assert.match(
    walk,
    /if role == "AXWebArea" \{ found\.append\(element\); continue \}/,
  );
  assert.match(walk, /role == "AXMenuBar"/);
  // The dispatcher runs it from its argument, before reading any request.
  const dispatch = swiftSource.slice(swiftSource.lastIndexOf("#else"));
  assert.ok(
    dispatch.indexOf('CommandLine.arguments[1] == "watch"') <
      dispatch.indexOf("readDataToEndOfFile"),
  );
});
test("the Swift composer reads as empty only from a readable value, the same way before a write", () => {
  // observe() and the re-read right before a write decide alike, from AX directly.
  assert.match(
    swiftBlock("func observe()"),
    /let composerEmpty = composer\.flatMap \{ composerEmptiness\(\$0\.element\) \}/,
  );
  assert.match(swiftBlock("func observe()"), /"composerEmpty": composerEmpty != nil/);
  // A missing composer reads as not empty, so the snapshot says whether there is one.
  assert.match(
    swiftBlock("func observe()"),
    /"composerPresent": composer != nil/,
  );
  const branch = swiftBlock('if command == "write-draft" {');
  assert.match(
    branch,
    /guard composerReadsEmpty\(composer\.element\) else \{ try fail\("composer-not-empty"\) \}/,
  );
  assert.doesNotMatch(branch, /valueText\(/);
  assert.doesNotMatch(branch, /kAXValueAttribute/);
  assert.match(
    swiftBlock("func composerReadsEmpty("),
    /composerEmptiness\(element\) != nil/,
  );
  // An AX error, or a value that is not text, may hide the user's text: never empty.
  const read = swiftBlock("func composerEmptiness(");
  assert.match(
    read,
    /AXUIElementCopyAttributeValue\(element, kAXValueAttribute as CFString, &value\)/,
  );
  assert.match(read, /case \.noValue: return "no-value"/);
  assert.match(read, /default: return nil/);
  assert.match(read, /guard let text = value as\? String else \{ return nil \}/);
});
test("the Swift submitComposer posts Return only into Claude in front with its composer focused", () => {
  const body = swiftBlock("func submitComposer(");
  const keys = [...body.matchAll(/virtualKey:\s*([^,)\s]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(keys)], ["36"]);
  // No modifier: Shift+Return is a new line, Cmd+Return something else.
  assert.doesNotMatch(body, /flags/);
  const focus = body.indexOf("kAXFocusedAttribute");
  const front = body.indexOf("frontmostApplication");
  const post = body.indexOf("down.post(");
  assert.ok(focus !== -1 && front !== -1 && post !== -1);
  assert.ok(focus < post && front < post);
  assert.match(body, /fail\("context-changed"\)/);
});
test("the Swift writeComposer only pastes: Claude's editor ignores a value set through AX", () => {
  const body = swiftBlock("func writeComposer(");
  // Setting the value shows the text but leaves the editor's own state empty, so Send took nothing.
  assert.doesNotMatch(body, /kAXValueAttribute/);
  assert.doesNotMatch(body, /"ax-value"/);
  assert.match(body, /return "paste"/);
  assert.match(body, /down\.post\(tap: \.cghidEventTap\)/);
});
test("the Swift writeComposer marks its clipboard text transient and concealed before it is owned", () => {
  const body = swiftBlock("func writeComposer(");
  const at = (text: string) => body.indexOf(text);
  const string = at("board.setString(body, forType: .string)");
  const marks = [
    'board.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType"))',
    'board.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))',
  ].map(at);
  const owned = at("let owned = board.changeCount");
  const paste = at("down.post(");
  assert.ok(string !== -1 && owned !== -1 && paste !== -1);
  for (const mark of marks) assert.ok(mark > string && mark < owned);
  assert.ok(owned < paste);
});
test("the Swift writeComposer re-checks focus after its re-observe and before the clipboard write", () => {
  const body = swiftBlock("func writeComposer(");
  const observed = body.indexOf("try observe()");
  const board = body.indexOf("board.clearContents()");
  const checks = [...body.matchAll(/focusHeld\(\)/g)].map((m) => m.index ?? -1);
  assert.ok(observed !== -1 && board !== -1);
  assert.ok(
    checks.some((at) => at > observed && at < board),
    "focus must be checked between the re-observe and the clipboard write",
  );
});
