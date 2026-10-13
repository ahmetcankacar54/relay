/**
 * Offline diagnostics for the documented `claude agents --json --all` roster.
 * This module has no process, filesystem, credential or application transport.
 * A roster is scoped to one configuration directory and does not certify that
 * every Desktop, cloud, SSH, child or scheduled task is represented.
 */
export const LIVE_OBSERVATION_MAX_AGE = 15_000;

type RosterKind = "interactive" | "background";
type ProcessStatus = "busy" | "waiting" | "idle";
type JobState = "working" | "blocked" | "done" | "failed" | "stopped";
type WaitingFor =
  | "permission prompt"
  | "input needed"
  | "sandbox request"
  | "worker request"
  | "dialog open";
export type ObservedActivity =
  | "working"
  | "needs-input"
  | "quiet"
  | "done"
  | "failed"
  | "stopped"
  | "unknown";

export interface LiveRosterSnapshot {
  /** An opaque adapter scope ID, not a credential or configuration path. */
  scopeId: string;
  collectedAt: number;
  includeCompleted: boolean;
  rows: unknown;
}

export interface ExpectedLiveSession {
  scopeId: string;
  sessionId: string;
}

/**
 * A future adapter may normalize parent-session task evidence into this shape.
 * This is not a Claude hook schema. Even a complete parent snapshot cannot
 * establish global Desktop coverage or prevent a new task from starting.
 */
export interface LiveChildSnapshot extends ExpectedLiveSession {
  collectedAt: number;
  complete: boolean;
  tasks: unknown;
}

export interface LiveObservationInput {
  rosters: LiveRosterSnapshot[];
  expectedScopeIds: string[];
  expectedSessions?: ExpectedLiveSession[];
  children?: LiveChildSnapshot[];
}

export interface LiveObservationIssue {
  code:
    | "invalid-input"
    | "invalid-clock"
    | "invalid-scope"
    | "scope-not-declared"
    | "scope-missing"
    | "duplicate-scope"
    | "stale-snapshot"
    | "future-snapshot"
    | "completed-rows-not-requested"
    | "invalid-roster"
    | "invalid-row"
    | "conflicting-state"
    | "duplicate-session"
    | "invalid-expected-session"
    | "expected-session-missing"
    | "invalid-child-snapshot"
    | "child-parent-missing"
    | "duplicate-child-snapshot"
    | "child-evidence-incomplete"
    | "invalid-child-task";
  scopeId?: string;
  sessionKey?: string;
}

export interface ObservedLiveSession {
  key: string;
  scopeId: string;
  kind: RosterKind | "unknown";
  sessionId?: string;
  jobId?: string;
  pid?: number;
  startedAt?: number;
  status?: ProcessStatus;
  state?: JobState;
  waitingFor?: WaitingFor;
  activity: ObservedActivity;
}

export interface ObservedChildTask {
  scopeId: string;
  sessionId: string;
  id: string;
  kind: "shell" | "subagent" | "workflow" | "monitor" | "schedule" | "unknown";
  activity: ObservedActivity;
}

export interface LiveSessionObservation {
  observedAt: number;
  /** Positive busy/waiting evidence survives incomplete roster coverage. */
  rosterActivity: "working" | "needs-input" | "quiet" | "unknown";
  sessions: ObservedLiveSession[];
  tasks: ObservedChildTask[];
  counts: Record<ObservedActivity, number>;
  taskCounts: Record<ObservedActivity, number>;
  issues: LiveObservationIssue[];
  coverage: {
    declaredScopes: "complete" | "incomplete" | "not-declared";
    expectedSessions: "present" | "missing" | "not-declared";
    parentTaskDetails: "complete" | "incomplete" | "not-provided";
    desktop: "unverified";
    remoteWork: "unverified";
  };
  capabilities: {
    rosterDiagnostics: "available" | "partial" | "unavailable";
    liveAccountSwitch: "unsupported";
    crossAccountContinuation: "unsupported";
  };
  /** Diagnostics are never authorization for Desktop writes or a message. */
  canSwitchLive: false;
  canContinueAutomatically: false;
}

const MAX_ROWS = 5_000;
const MAX_SCOPES = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const uuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const timestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const member = <T extends string>(
  value: unknown,
  values: readonly T[],
): value is T => typeof value === "string" && values.includes(value as T);
const states = ["working", "blocked", "done", "failed", "stopped"] as const;
const statuses = ["busy", "waiting", "idle"] as const;
const waits = [
  "permission prompt",
  "input needed",
  "sandbox request",
  "worker request",
  "dialog open",
] as const;
const activities = [
  "working",
  "needs-input",
  "quiet",
  "done",
  "failed",
  "stopped",
  "unknown",
] as const;
const emptyCounts = (): Record<ObservedActivity, number> =>
  Object.fromEntries(activities.map((state) => [state, 0])) as Record<
    ObservedActivity,
    number
  >;
const sessionKey = (scopeId: string, sessionId: string) =>
  `${scopeId}:session:${sessionId.toLowerCase()}`;

/** Parse supplied snapshots only. Incomplete/novel schemas fail closed. */
export function observeLiveSessions(
  input: unknown,
  now: number,
): LiveSessionObservation {
  const result: LiveSessionObservation = {
    observedAt: timestamp(now) ? now : 0,
    rosterActivity: "unknown",
    sessions: [],
    tasks: [],
    counts: emptyCounts(),
    taskCounts: emptyCounts(),
    issues: [],
    coverage: {
      declaredScopes: "not-declared",
      expectedSessions: "not-declared",
      parentTaskDetails: "not-provided",
      desktop: "unverified",
      remoteWork: "unverified",
    },
    capabilities: {
      rosterDiagnostics: "unavailable",
      liveAccountSwitch: "unsupported",
      crossAccountContinuation: "unsupported",
    },
    canSwitchLive: false,
    canContinueAutomatically: false,
  };
  const issue = (
    code: LiveObservationIssue["code"],
    scopeId?: string,
    key?: string,
  ) => result.issues.push({ code, scopeId, sessionKey: key });
  if (!timestamp(now)) {
    issue("invalid-clock");
    return result;
  }
  if (
    !object(input) ||
    !Array.isArray(input.rosters) ||
    input.rosters.length > MAX_SCOPES ||
    !Array.isArray(input.expectedScopeIds) ||
    input.expectedScopeIds.length > MAX_SCOPES
  ) {
    issue("invalid-input");
    return result;
  }
  const expectedScopes = new Set<string>();
  for (const scopeId of input.expectedScopeIds) {
    if (!identifier(scopeId) || expectedScopes.has(scopeId))
      issue("invalid-scope");
    else expectedScopes.add(scopeId);
  }
  const fresh = (collectedAt: unknown, scopeId: string, key?: string) => {
    if (!timestamp(collectedAt)) {
      issue("stale-snapshot", scopeId, key);
      return false;
    }
    if (collectedAt > now) {
      issue("future-snapshot", scopeId, key);
      return false;
    }
    if (now - collectedAt > LIVE_OBSERVATION_MAX_AGE) {
      issue("stale-snapshot", scopeId, key);
      return false;
    }
    return true;
  };
  let workingSignal = false,
    waitingSignal = false;
  const seenScopes = new Set<string>();
  const seenKeys = new Set<string>();
  const seenJobs = new Set<string>();
  const seenPids = new Set<string>();
  const normalizedSessionKeys = new Set<string>();
  const sessionStarts = new Map<string, number>();
  for (const snapshot of input.rosters) {
    if (!object(snapshot) || !identifier(snapshot.scopeId)) {
      issue("invalid-scope");
      continue;
    }
    const { scopeId } = snapshot;
    const scopeIssueStart = result.issues.length;
    if (seenScopes.has(scopeId)) issue("duplicate-scope", scopeId);
    seenScopes.add(scopeId);
    if (!expectedScopes.has(scopeId)) issue("scope-not-declared", scopeId);
    const snapshotFresh = fresh(snapshot.collectedAt, scopeId);
    if (snapshot.includeCompleted !== true)
      issue("completed-rows-not-requested", scopeId);
    if (!Array.isArray(snapshot.rows) || snapshot.rows.length > MAX_ROWS) {
      issue("invalid-roster", scopeId);
      continue;
    }
    const scopeValid = result.issues.length === scopeIssueStart;
    for (const [index, row] of snapshot.rows.entries()) {
      const rowIssueStart = result.issues.length;
      const knownRow = object(row);
      const kind =
        knownRow && member(row.kind, ["interactive", "background"])
          ? row.kind
          : "unknown";
      const sessionId =
        knownRow && uuid(row.sessionId)
          ? row.sessionId.toLowerCase()
          : undefined;
      const jobId = knownRow && identifier(row.id) ? row.id : undefined;
      const pid =
        knownRow &&
        typeof row.pid === "number" &&
        Number.isSafeInteger(row.pid) &&
        row.pid > 0
          ? row.pid
          : undefined;
      const status =
        knownRow && member(row.status, statuses) ? row.status : undefined;
      const state =
        knownRow && member(row.state, states) ? row.state : undefined;
      const waitingFor =
        knownRow && member(row.waitingFor, waits) ? row.waitingFor : undefined;
      const startedAt =
        knownRow && timestamp(row.startedAt) ? row.startedAt : undefined;
      const key = sessionId
        ? sessionKey(scopeId, sessionId)
        : jobId
          ? `${scopeId}:job:${jobId}`
          : pid && startedAt !== undefined
            ? `${scopeId}:pid:${pid}:${startedAt}`
            : `${scopeId}:unknown:${index}`;
      if (snapshotFresh) {
        workingSignal ||=
          status === "busy" || (state === "working" && status !== "waiting");
        waitingSignal ||= status === "waiting" || state === "blocked";
      }
      if (
        !knownRow ||
        kind === "unknown" ||
        startedAt === undefined ||
        startedAt > (snapshot.collectedAt as number) ||
        typeof row.cwd !== "string" ||
        !row.cwd.trim() ||
        row.cwd.length > 4_096 ||
        row.cwd.includes("\0") ||
        (row.sessionId !== undefined && !sessionId) ||
        (row.id !== undefined && !jobId) ||
        (row.state !== undefined && !state) ||
        (row.pid !== undefined && !pid) ||
        (row.status !== undefined && !status) ||
        (row.waitingFor !== undefined && !waitingFor) ||
        !!pid !== !!status ||
        (kind === "interactive" && (!pid || !status)) ||
        (kind === "interactive" && row.state !== undefined) ||
        (kind === "background" && (!jobId || !state)) ||
        (status === "waiting" && !waitingFor) ||
        (waitingFor !== undefined && status !== "waiting")
      )
        issue("invalid-row", scopeId, key);
      if (
        (state &&
          ["done", "failed", "stopped"].includes(state) &&
          (status === "busy" || status === "waiting")) ||
        (state === "blocked" && status === "busy")
      )
        issue("conflicting-state", scopeId, key);
      if (
        seenKeys.has(key) ||
        (jobId && seenJobs.has(`${scopeId}:${jobId}`)) ||
        (pid && seenPids.has(`${scopeId}:${pid}`))
      )
        issue("duplicate-session", scopeId, key);
      seenKeys.add(key);
      if (jobId) seenJobs.add(`${scopeId}:${jobId}`);
      if (pid) seenPids.add(`${scopeId}:${pid}`);
      const rowValid = scopeValid && result.issues.length === rowIssueStart;
      const activity: ObservedActivity = !rowValid
        ? "unknown"
        : state === "blocked" || status === "waiting"
          ? "needs-input"
          : state === "working" || status === "busy"
            ? "working"
            : state && ["done", "failed", "stopped"].includes(state)
              ? (state as "done" | "failed" | "stopped")
              : status === "idle"
                ? "quiet"
                : "unknown";
      result.sessions.push({
        key,
        scopeId,
        kind,
        sessionId,
        jobId,
        pid,
        startedAt,
        status,
        state,
        waitingFor,
        activity,
      });
      if (sessionId && rowValid && startedAt !== undefined) {
        normalizedSessionKeys.add(sessionKey(scopeId, sessionId));
        sessionStarts.set(key, startedAt);
      }
    }
  }
  for (const scopeId of expectedScopes)
    if (!seenScopes.has(scopeId)) issue("scope-missing", scopeId);
  result.coverage.declaredScopes =
    expectedScopes.size === 0
      ? "not-declared"
      : result.issues.length === 0
        ? "complete"
        : "incomplete";

  if (input.expectedSessions !== undefined) {
    if (
      !Array.isArray(input.expectedSessions) ||
      input.expectedSessions.length > MAX_ROWS
    ) {
      issue("invalid-expected-session");
      result.coverage.expectedSessions = "missing";
    } else if (input.expectedSessions.length) {
      result.coverage.expectedSessions = "present";
      const seenExpected = new Set<string>();
      for (const expected of input.expectedSessions) {
        if (
          !object(expected) ||
          !identifier(expected.scopeId) ||
          !uuid(expected.sessionId) ||
          !expectedScopes.has(expected.scopeId)
        ) {
          issue("invalid-expected-session");
          result.coverage.expectedSessions = "missing";
          continue;
        }
        const key = sessionKey(expected.scopeId, expected.sessionId);
        if (seenExpected.has(key)) {
          issue("invalid-expected-session", expected.scopeId, key);
          result.coverage.expectedSessions = "missing";
        }
        seenExpected.add(key);
        if (!normalizedSessionKeys.has(key)) {
          issue("expected-session-missing", expected.scopeId, key);
          result.coverage.expectedSessions = "missing";
        }
      }
    }
  }

  if (input.children !== undefined) {
    if (!Array.isArray(input.children) || input.children.length > MAX_ROWS) {
      issue("invalid-child-snapshot");
      result.coverage.parentTaskDetails = "incomplete";
    } else if (input.children.length) {
      const childIssueStart = result.issues.length;
      const seenParents = new Set<string>();
      for (const snapshot of input.children) {
        if (
          !object(snapshot) ||
          !identifier(snapshot.scopeId) ||
          !uuid(snapshot.sessionId)
        ) {
          issue("invalid-child-snapshot");
          continue;
        }
        const { scopeId } = snapshot;
        const sessionId = snapshot.sessionId.toLowerCase();
        const key = sessionKey(scopeId, sessionId);
        const snapshotFresh = fresh(snapshot.collectedAt, scopeId, key);
        if (!normalizedSessionKeys.has(key))
          issue("child-parent-missing", scopeId, key);
        const parentStartedAt = sessionStarts.get(key);
        if (
          parentStartedAt !== undefined &&
          timestamp(snapshot.collectedAt) &&
          snapshot.collectedAt < parentStartedAt
        )
          issue("invalid-child-snapshot", scopeId, key);
        if (seenParents.has(key))
          issue("duplicate-child-snapshot", scopeId, key);
        seenParents.add(key);
        if (snapshot.complete !== true)
          issue("child-evidence-incomplete", scopeId, key);
        if (
          !Array.isArray(snapshot.tasks) ||
          snapshot.tasks.length > MAX_ROWS
        ) {
          issue("invalid-child-snapshot", scopeId, key);
          continue;
        }
        const seenTasks = new Set<string>();
        for (const [index, task] of snapshot.tasks.entries()) {
          const validTask =
            object(task) &&
            identifier(task.id) &&
            member(task.kind, [
              "shell",
              "subagent",
              "workflow",
              "monitor",
              "schedule",
            ]) &&
            member(task.state, states) &&
            !seenTasks.has(task.id);
          const kind =
            object(task) &&
            member(task.kind, [
              "shell",
              "subagent",
              "workflow",
              "monitor",
              "schedule",
            ])
              ? task.kind
              : "unknown";
          const state =
            object(task) && member(task.state, states) ? task.state : undefined;
          const id =
            object(task) && identifier(task.id) ? task.id : `unknown-${index}`;
          seenTasks.add(id);
          if (!validTask) issue("invalid-child-task", scopeId, key);
          if (snapshotFresh) {
            workingSignal ||= state === "working";
            waitingSignal ||= state === "blocked";
          }
          const activity: ObservedActivity =
            !validTask || !snapshotFresh
              ? "unknown"
              : state === "blocked"
                ? "needs-input"
                : state!;
          result.tasks.push({ scopeId, sessionId, id, kind, activity });
        }
      }
      for (const session of result.sessions) {
        if (
          !session.sessionId ||
          !normalizedSessionKeys.has(session.key) ||
          !seenParents.has(session.key)
        )
          issue("child-evidence-incomplete", session.scopeId, session.key);
      }
      result.coverage.parentTaskDetails =
        result.issues.length === childIssueStart &&
        normalizedSessionKeys.size > 0 &&
        [...normalizedSessionKeys].every((key) => seenParents.has(key))
          ? "complete"
          : "incomplete";
    }
  }
  for (const session of result.sessions) result.counts[session.activity]++;
  for (const task of result.tasks) result.taskCounts[task.activity]++;
  result.capabilities.rosterDiagnostics =
    result.sessions.length || seenScopes.size
      ? result.issues.length
        ? "partial"
        : "available"
      : "unavailable";
  result.rosterActivity = workingSignal
    ? "working"
    : waitingSignal
      ? "needs-input"
      : result.issues.length || result.coverage.declaredScopes !== "complete"
        ? "unknown"
        : "quiet";
  return result;
}
