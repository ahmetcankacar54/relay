import test from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_OBSERVATION_MAX_AGE,
  observeLiveSessions,
  type LiveObservationInput,
} from "../shared/live-session-observation";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const SESSION = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-0000-0000-000000000002";
const interactive = (extra: Record<string, unknown> = {}) => ({
  cwd: "/fixture/project",
  kind: "interactive",
  startedAt: NOW - 60_000,
  pid: 101,
  status: "idle",
  sessionId: SESSION,
  ...extra,
});
const background = (extra: Record<string, unknown> = {}) => ({
  cwd: "/fixture/project",
  kind: "background",
  startedAt: NOW - 60_000,
  id: "job-1",
  state: "done",
  sessionId: SESSION,
  ...extra,
});
function fixture(rows: unknown = [interactive()]): LiveObservationInput {
  return {
    expectedScopeIds: ["desktop-config"],
    rosters: [
      {
        scopeId: "desktop-config",
        collectedAt: NOW,
        includeCompleted: true,
        rows,
      },
    ],
  };
}
const observe = (input: unknown) => observeLiveSessions(input, NOW);
const codes = (input: unknown) =>
  observe(input).issues.map((issue) => issue.code);
const children = (tasks: unknown, complete = true) => [
  {
    scopeId: "desktop-config",
    sessionId: SESSION,
    collectedAt: NOW,
    complete,
    tasks,
  },
];

test("an empty declared roster is not proof that Desktop or remote tasks are idle", () => {
  const result = observe(fixture([]));
  assert.equal(result.rosterActivity, "quiet");
  assert.equal(result.coverage.declaredScopes, "complete");
  assert.equal(result.coverage.desktop, "unverified");
  assert.equal(result.coverage.remoteWork, "unverified");
  assert.equal(result.coverage.parentTaskDetails, "not-provided");
  assert.equal(result.canSwitchLive, false);
  assert.equal(result.canContinueAutomatically, false);
  assert.equal(result.capabilities.liveAccountSwitch, "unsupported");
  assert.equal(result.capabilities.crossAccountContinuation, "unsupported");
});

test("observed process idleness and ended background outcomes remain distinct", () => {
  const result = observe(
    fixture([
      interactive(),
      background({ id: "complete", sessionId: OTHER }),
      background({ id: "failed", state: "failed", sessionId: undefined }),
      background({ id: "stopped", state: "stopped", sessionId: undefined }),
    ]),
  );
  assert.equal(result.capabilities.rosterDiagnostics, "available");
  assert.deepEqual(
    result.sessions.map((session) => session.activity),
    ["quiet", "done", "failed", "stopped"],
  );
  assert.equal(result.counts.quiet, 1);
  assert.equal(result.counts.done, 1);
  assert.equal(result.counts.failed, 1);
  assert.equal(result.counts.stopped, 1);
  assert.equal(result.rosterActivity, "quiet");
});

test("background work between autonomous steps remains working even with an idle process", () => {
  for (const process of [{ pid: 102, status: "idle" }, {}]) {
    const result = observe(
      fixture([background({ state: "working", ...process })]),
    );
    assert.equal(result.sessions[0].activity, "working");
    assert.equal(result.rosterActivity, "working");
    assert.equal(result.canSwitchLive, false);
  }
});

test("busy foreground and separately blocked background sessions keep actionable observations", () => {
  const result = observe(
    fixture([
      interactive({ status: "busy" }),
      background({ state: "blocked", sessionId: OTHER }),
    ]),
  );
  assert.equal(result.counts.working, 1);
  assert.equal(result.counts["needs-input"], 1);
  assert.equal(result.rosterActivity, "working");
});

test("a working background job waiting for a permission is reported as needing input", () => {
  const waiting = background({
    state: "working",
    pid: 102,
    status: "waiting",
    waitingFor: "permission prompt",
  });
  const result = observe(fixture([waiting]));
  assert.equal(result.sessions[0].activity, "needs-input");
  assert.equal(result.counts["needs-input"], 1);
  assert.equal(result.counts.working, 0);
  assert.equal(result.rosterActivity, "needs-input");
  const mixed = observe(
    fixture([waiting, interactive({ status: "busy", sessionId: OTHER })]),
  );
  assert.equal(mixed.rosterActivity, "working");
  assert.equal(mixed.counts["needs-input"], 1);
});

test("permission, input, sandbox, worker and dialog waits block rather than count as quiet", () => {
  for (const waitingFor of [
    "permission prompt",
    "input needed",
    "sandbox request",
    "worker request",
    "dialog open",
  ]) {
    const result = observe(
      fixture([interactive({ status: "waiting", waitingFor })]),
    );
    assert.equal(result.sessions[0].activity, "needs-input");
    assert.equal(result.sessions[0].waitingFor, waitingFor);
    assert.equal(result.rosterActivity, "needs-input");
  }
});

test("unknown required fields and new status, state or wait values prevent a quiet roster", () => {
  const invalid = [
    interactive({ kind: "desktop" }),
    interactive({ cwd: "" }),
    interactive({ startedAt: undefined }),
    interactive({ startedAt: NOW + 1 }),
    interactive({ pid: 0 }),
    interactive({ pid: 1.5 }),
    interactive({ pid: undefined }),
    interactive({ status: undefined }),
    interactive({ status: "sleeping" }),
    interactive({ state: "done" }),
    interactive({ sessionId: "not-a-uuid" }),
    interactive({ waitingFor: "input needed" }),
    background({ id: undefined }),
    background({ state: undefined }),
    background({ state: "scheduled" }),
    null,
  ];
  for (const row of invalid) {
    const result = observe(fixture([row]));
    assert.equal(result.sessions[0].activity, "unknown");
    assert.equal(result.rosterActivity, "unknown");
    assert.ok(result.issues.some((issue) => issue.code === "invalid-row"));
  }
  for (const waitingFor of [undefined, "unrecognized wait"]) {
    const result = observe(
      fixture([interactive({ status: "waiting", waitingFor })]),
    );
    assert.equal(result.sessions[0].activity, "unknown");
    assert.equal(result.rosterActivity, "needs-input");
    assert.ok(result.issues.some((issue) => issue.code === "invalid-row"));
  }
});

test("terminal states conflicting with live activity fail closed while preserving busy signals", () => {
  for (const state of ["done", "failed", "stopped", "blocked"]) {
    const result = observe(
      fixture([background({ state, pid: 102, status: "busy" })]),
    );
    assert.equal(result.sessions[0].activity, "unknown");
    assert.equal(result.rosterActivity, "working");
    assert.ok(
      result.issues.some((issue) => issue.code === "conflicting-state"),
    );
  }
});

test("old or future snapshots cannot produce current busy, blocked or quiet assertions", () => {
  for (const collectedAt of [
    NOW - LIVE_OBSERVATION_MAX_AGE - 1,
    NOW + 1,
    NaN,
    "2026-10-13T12:00:00Z",
  ]) {
    const f = fixture([interactive({ status: "busy" })]);
    (f.rosters[0] as any).collectedAt = collectedAt;
    const result = observe(f);
    assert.equal(result.rosterActivity, "unknown");
    assert.equal(result.sessions[0].activity, "unknown");
    assert.equal(result.coverage.declaredScopes, "incomplete");
  }
  const f = fixture();
  f.rosters[0].collectedAt = NOW - LIVE_OBSERVATION_MAX_AGE;
  assert.equal(observe(f).rosterActivity, "quiet");
});

test("declared configuration directories, unfiltered completed rows and session targets are checked", () => {
  const f = fixture();
  f.expectedScopeIds.push("other-config");
  assert.ok(codes(f).includes("scope-missing"));
  assert.equal(observe(f).rosterActivity, "unknown");
  f.rosters.push({ ...f.rosters[0], scopeId: "other-config", rows: [] });
  assert.equal(observe(f).coverage.declaredScopes, "complete");
  f.rosters[1].includeCompleted = false;
  assert.ok(codes(f).includes("completed-rows-not-requested"));
  f.rosters[1].includeCompleted = true;
  f.expectedSessions = [{ scopeId: "other-config", sessionId: OTHER }];
  assert.equal(observe(f).coverage.expectedSessions, "missing");
  assert.equal(observe(f).rosterActivity, "unknown");
  f.rosters[1].rows = [interactive({ sessionId: OTHER })];
  assert.equal(observe(f).coverage.expectedSessions, "present");
  assert.equal(observe(f).coverage.desktop, "unverified");
});

test("undeclared or duplicate scopes, absent scope declarations and duplicate sessions stay unknown", () => {
  const undeclared = fixture();
  undeclared.expectedScopeIds = [];
  assert.ok(codes(undeclared).includes("scope-not-declared"));
  assert.equal(observe(undeclared).coverage.declaredScopes, "not-declared");
  assert.equal(observe(undeclared).rosterActivity, "unknown");
  const duplicateScope = fixture();
  duplicateScope.rosters.push(structuredClone(duplicateScope.rosters[0]));
  assert.ok(codes(duplicateScope).includes("duplicate-scope"));
  assert.equal(observe(duplicateScope).rosterActivity, "unknown");
  const duplicateSession = fixture([interactive(), background()]);
  assert.ok(codes(duplicateSession).includes("duplicate-session"));
  assert.equal(observe(duplicateSession).rosterActivity, "unknown");
  for (const rows of [
    [interactive(), interactive({ sessionId: OTHER })],
    [background(), background({ sessionId: OTHER })],
  ]) {
    assert.ok(codes(fixture(rows)).includes("duplicate-session"));
  }
});

test("malformed or oversized arrays and unsupported input envelopes cannot signal readiness", () => {
  for (const input of [
    null,
    {},
    [],
    { rosters: [] },
    fixture({ sessions: [] }),
    fixture(new Array(5_001).fill(interactive())),
  ]) {
    assert.equal(observe(input).rosterActivity, "unknown");
    assert.equal(observe(input).canSwitchLive, false);
  }
  assert.equal(
    observeLiveSessions(fixture(), NaN).issues[0].code,
    "invalid-clock",
  );
});

test("positive busy evidence stays visible when another configuration scope is missing", () => {
  const f = fixture([interactive({ status: "busy" })]);
  f.expectedScopeIds.push("unobserved-config");
  const result = observe(f);
  assert.equal(result.rosterActivity, "working");
  assert.equal(result.coverage.declaredScopes, "incomplete");
  assert.equal(result.canSwitchLive, false);
});

test("a running subagent, monitor or sleeping schedule defeats parent process idleness", () => {
  for (const kind of ["subagent", "shell", "workflow", "monitor", "schedule"]) {
    const f = fixture();
    f.children = children([{ id: "task-1", kind, state: "working" }]);
    const result = observe(f);
    assert.equal(result.counts.quiet, 1);
    assert.equal(result.taskCounts.working, 1);
    assert.equal(result.rosterActivity, "working");
    assert.equal(result.coverage.parentTaskDetails, "complete");
    assert.equal(result.canContinueAutomatically, false);
  }
});

test("child completed, failed and stopped outcomes remain separate; blocked child needs input", () => {
  const f = fixture();
  f.children = children([
    { id: "done", kind: "subagent", state: "done" },
    { id: "failed", kind: "shell", state: "failed" },
    { id: "stopped", kind: "workflow", state: "stopped" },
    { id: "permission", kind: "subagent", state: "blocked" },
  ]);
  const result = observe(f);
  assert.equal(result.taskCounts.done, 1);
  assert.equal(result.taskCounts.failed, 1);
  assert.equal(result.taskCounts.stopped, 1);
  assert.equal(result.taskCounts["needs-input"], 1);
  assert.equal(result.rosterActivity, "needs-input");
});

test("child evidence captured before the current parent started cannot certify its task coverage", () => {
  const input = fixture([interactive({ startedAt: NOW - 1_000 })]);
  input.children = children([]);
  input.children[0].collectedAt = NOW - 2_000;
  const result = observe(input);
  assert.equal(result.coverage.parentTaskDetails, "incomplete");
  assert.equal(result.rosterActivity, "unknown");
  assert.ok(
    result.issues.some((issue) => issue.code === "invalid-child-snapshot"),
  );
  assert.equal(result.canSwitchLive, false);
  assert.equal(result.canContinueAutomatically, false);
});

test("a complete empty parent snapshot remains insufficient for Desktop-wide idle or continuation", () => {
  const f = fixture();
  f.children = children([]);
  const result = observe(f);
  assert.equal(result.coverage.parentTaskDetails, "complete");
  assert.equal(result.rosterActivity, "quiet");
  assert.equal(result.coverage.desktop, "unverified");
  assert.equal(result.canSwitchLive, false);
  assert.equal(result.canContinueAutomatically, false);
});

test("missing, stale, incomplete or uncorrelated parent task evidence is never assumed empty", () => {
  const cases = [
    children(undefined),
    children([], false),
    [{ ...children([])[0], sessionId: OTHER }],
    [{ ...children([])[0], collectedAt: NOW - LIVE_OBSERVATION_MAX_AGE - 1 }],
    [{ ...children([])[0], collectedAt: NOW + 1 }],
    [...children([]), ...children([])],
  ];
  for (const snapshots of cases) {
    const f = fixture();
    f.children = snapshots;
    const result = observe(f);
    assert.equal(result.coverage.parentTaskDetails, "incomplete");
    assert.equal(result.rosterActivity, "unknown");
  }
  const f = fixture([
    interactive(),
    interactive({ sessionId: OTHER, pid: 102 }),
  ]);
  f.children = children([]);
  assert.equal(observe(f).coverage.parentTaskDetails, "incomplete");
  assert.equal(observe(f).rosterActivity, "unknown");
});

test("invalid, duplicate and new task kinds or states fail closed without concealing known work", () => {
  for (const tasks of [
    [{ id: "task", kind: "new-kind", state: "done" }],
    [{ id: "task", kind: "subagent", state: "paused" }],
    [
      { id: "task", kind: "subagent", state: "done" },
      { id: "task", kind: "subagent", state: "done" },
    ],
  ]) {
    const f = fixture();
    f.children = children(tasks);
    assert.equal(observe(f).rosterActivity, "unknown");
    assert.ok(codes(f).includes("invalid-child-task"));
  }
  const f = fixture();
  f.children = children(
    [{ id: "task", kind: "new-kind", state: "working" }],
    false,
  );
  assert.equal(observe(f).rosterActivity, "working");
  assert.equal(observe(f).coverage.parentTaskDetails, "incomplete");
});

test("an imported roster never echoes prompt, title, configuration path or unrelated metadata", () => {
  const f = fixture([
    interactive({
      cwd: "/sensitive/private-project",
      name: "PRIVATE TITLE",
      prompt: "PRIVATE PROMPT",
      auth: "PRIVATE TOKEN",
      futureMetadata: { content: "PRIVATE CONTENT" },
    }),
  ]);
  const encoded = JSON.stringify(observe(f));
  for (const value of [
    "sensitive",
    "PRIVATE TITLE",
    "PRIVATE PROMPT",
    "PRIVATE TOKEN",
    "PRIVATE CONTENT",
  ])
    assert.ok(!encoded.includes(value));
  assert.equal(observe(f).rosterActivity, "quiet");
});

test("additional caller coverage or control flags cannot unlock unsupported live actions", () => {
  const f = {
    ...fixture(),
    desktopCoverage: "verified",
    safeToSwitch: true,
    canSwitchLive: true,
    canContinueAutomatically: true,
  };
  const result = observe(f);
  assert.equal(result.coverage.desktop, "unverified");
  assert.equal(result.canSwitchLive, false);
  assert.equal(result.canContinueAutomatically, false);
});
