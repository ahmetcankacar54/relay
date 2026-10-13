import { createHash } from "node:crypto";
import { allowedHistoryPair } from "../../shared/history-policy";
import { quotaWindows } from "../../shared/usage";
import type { Account, AccountUsage, RelaySettings } from "../../shared/types";

/** Stopped-session orchestration with durable at-most-one submission. */
export interface ContinuationIdentity {
  profileId: string;
  accountUuid: string;
  orgId: string;
}
export interface ContinuationSession {
  id: string;
  projectKey: string;
  transcriptRevision: string;
  permissionMode: string;
  status: "stopped" | "running" | "waiting" | "unknown";
  lastRequestId?: string;
  lastTurnId?: string;
}
export interface ContinuationState {
  contextRevision: number;
  observedAt: number;
  identity: ContinuationIdentity;
  session: ContinuationSession;
  quiescence: {
    coverage: "isolated-all" | "verified-all" | "guarded-local" | "unknown";
    busyWorkers: number;
    subagents: number;
    pendingTasks: number;
    waiting: number;
    queuedPrompts: number;
    scheduledWakeups: number;
    unknownWork: number;
  };
}
export interface ContinuationCheckpoint {
  id: string;
  session: ContinuationSession;
}
export interface ContinuationReceipt {
  requestId: string;
  identity: ContinuationIdentity;
  sessionId: string;
  projectKey: string;
  permissionMode: string;
  beforeRevision: string;
  afterRevision: string;
  turnId: string;
}
export interface ContinuationDelivery {
  status: "absent" | "unknown" | "accepted" | "started" | "rejected";
  receipt?: ContinuationReceipt;
}
export interface ContinuationHost {
  capabilities: {
    kind: "simulated" | "verified-contract" | "guarded-native";
    contractId: string;
    exactSession: boolean;
    conditionalActions: boolean;
    idempotentDelivery: boolean;
    deliveryLookup: boolean;
    checkpoint: boolean;
    accountSwitch: boolean;
    sessionReopen: boolean;
    targetedSend: boolean;
    deliveryReceipt: boolean;
    atomicContextGuard: boolean;
  };
  readState(): Promise<ContinuationState>;
  checkpoint(input: {
    requestId: string;
    session: ContinuationSession;
    expectedContextRevision: number;
  }): Promise<ContinuationCheckpoint>;
  switchAccount(input: {
    requestId: string;
    target: ContinuationIdentity;
    expectedContextRevision: number;
  }): Promise<void>;
  reopenSession(input: {
    requestId: string;
    checkpoint: ContinuationCheckpoint;
    target: ContinuationIdentity;
    expectedContextRevision: number;
  }): Promise<void>;
  sendContinuation(input: {
    requestId: string;
    target: ContinuationIdentity;
    session: ContinuationSession;
    expectedContextRevision: number;
    text: string;
  }): Promise<ContinuationDelivery>;
  lookupDelivery(requestId: string): Promise<ContinuationDelivery>;
}
export interface ContinuationRequest {
  id: string;
  source: Account;
  target: Account;
  settings: RelaySettings;
  usage: Record<string, AccountUsage>;
  sessionId: string;
  projectKey: string;
  transcriptRevision: string;
  permissionMode: string;
  expectedContextRevision: number;
  authorized: boolean;
  /** Explicit opt-in to an OS UI transport without an atomic receiver contract. */
  executionPolicy?: "guarded-native-at-most-once";
}
export interface ContinuationJournalRecord {
  version: 1;
  id: string;
  fingerprint: string;
  /** Canonical opaque request metadata, used to validate other host intents. */
  boundRequest: string;
  stage:
    | "prepared"
    | "checkpointed"
    | "switch-intent"
    | "account-verified"
    | "open-intent"
    | "session-verified"
    | "send-intent"
    | "delivery-accepted"
    | "delivery-confirmed"
    | "reconciliation-required"
    | "blocked";
  updatedAt: number;
  checkpoint?: ContinuationCheckpoint;
  receipt?: ContinuationReceipt;
  sendRecorded: boolean;
  reason?: string;
}
/** Writes must be durable before resolving; the lock covers this entire host. */
export interface ContinuationJournal {
  withLock<T>(requestId: string, action: () => Promise<T>): Promise<T>;
  read(requestId: string): Promise<ContinuationJournalRecord | undefined>;
  /** All unfinished host intents, including unreadable entries; never drop one. */
  listPending(): Promise<ContinuationJournalRecord[]>;
  write(record: ContinuationJournalRecord): Promise<void>;
}
export interface ContinuationResult {
  status: "blocked" | "continued" | "reconciliation-required";
  /** It never transfers a still-running worker or its child processes. */
  continuationKind: "stopped-session-new-turn";
  reason: string;
  record?: ContinuationJournalRecord;
  receipt?: ContinuationReceipt;
}

// A continuation is a new turn after a stopped checkpoint, not a transfer of
// running shells/subagents. Preserve permissions and reconcile interrupted work.
export const CONTINUATION_TEXT =
  "Continue this same conversation from the saved checkpoint. First inspect " +
  "the existing transcript and verify whether interrupted actions already took " +
  "effect. Do not replay the last prompt or duplicate completed work. Preserve " +
  "the existing permission mode, ask for any outstanding user decision, and do " +
  "not claim that stopped subagents or shell processes are still running.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const token = (s: unknown): s is string =>
  typeof s === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(s);
const textKey = (s: unknown): s is string =>
  typeof s === "string" &&
  s.length > 0 &&
  s.length <= 4096 &&
  !s.includes("\0");
const clock = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const identity = (account: Account): ContinuationIdentity => ({
  profileId: account.id,
  accountUuid: account.desktop!.accountUuid.toLowerCase(),
  orgId: account.desktop!.orgId.toLowerCase(),
});
function sameIdentity(a: ContinuationIdentity, b: ContinuationIdentity) {
  return (
    a?.profileId === b.profileId &&
    typeof a.accountUuid === "string" &&
    typeof a.orgId === "string" &&
    a.accountUuid.toLowerCase() === b.accountUuid &&
    a.orgId.toLowerCase() === b.orgId
  );
}
function enrolled(account: Account) {
  return (
    token(account?.id) &&
    UUID.test(account.desktop?.accountUuid ?? "") &&
    UUID.test(account.desktop?.orgId ?? "") &&
    account.auth?.loggedIn === true &&
    account.auth.accountUuid?.toLowerCase() ===
      account.desktop!.accountUuid.toLowerCase() &&
    account.auth.orgId?.toLowerCase() === account.desktop!.orgId.toLowerCase()
  );
}
function serializedBinding(request: ContinuationRequest) {
  return JSON.stringify({
    id: request.id,
    source: identity(request.source),
    target: identity(request.target),
    sessionId: request.sessionId.toLowerCase(),
    projectKey: request.projectKey,
    transcriptRevision: request.transcriptRevision,
    permissionMode: request.permissionMode,
    expectedContextRevision: request.expectedContextRevision,
    continuationText: CONTINUATION_TEXT,
    executionPolicy: request.executionPolicy,
  });
}
function binding(request: ContinuationRequest) {
  return createHash("sha256").update(serializedBinding(request)).digest("hex");
}
function freshQuota(
  usage: AccountUsage | undefined,
  accountId: string,
  now: number,
) {
  const at = Date.parse(usage?.checkedAt ?? "");
  return (
    usage?.accountId === accountId &&
    usage.status === "ready" &&
    usage.stale === false &&
    !usage.issue &&
    Number.isFinite(at) &&
    at <= now &&
    now - at <= 300_000
  );
}
function validWindow(window: AccountUsage["fiveHour"], now: number) {
  return (
    !!window &&
    Number.isFinite(window.usedPercent) &&
    window.usedPercent >= 0 &&
    window.usedPercent <= 100 &&
    ((window.usedPercent === 0 && window.resetsAt === undefined) ||
      (Number.isFinite(Date.parse(window.resetsAt ?? "")) &&
        Date.parse(window.resetsAt!) > now))
  );
}
export function continuationPolicyReason(
  request: ContinuationRequest,
  now: number,
  /** False once Claude has switched: the quota decision was already made. */
  checkQuota = true,
) {
  if (!request.authorized) return "not-authorized";
  if (!enrolled(request.source) || !enrolled(request.target))
    return "identity-not-enrolled";
  if (
    !request.settings ||
    !["off", "same-group", "selected"].includes(
      request.settings.desktopHistoryTransfer,
    ) ||
    !Array.isArray(request.settings.desktopHistoryAccounts) ||
    !request.settings.desktopHistoryAccounts.every(token)
  )
    return "invalid-history-policy";
  if (
    request.settings.desktopHistoryTransfer === "off" ||
    !allowedHistoryPair(request.source, request.target, request.settings)
  )
    return "history-boundary";
  if (!checkQuota) return undefined;
  const source = request.usage[request.source.id];
  const target = request.usage[request.target.id];
  if (
    !freshQuota(target, request.target.id, now) ||
    !quotaWindows(target)?.every((w) => validWindow(w, now))
  )
    return "quota-not-fresh";
  if (
    !freshQuota(source, request.source.id, now) ||
    ![source?.fiveHour, source?.sevenDay].some(
      (window) => window !== undefined,
    ) ||
    [source?.fiveHour, source?.sevenDay].some(
      (w) => w !== undefined && !validWindow(w, now),
    )
  )
    return "quota-not-fresh";
  // A model-specific weekly limit (e.g. Opus) also stops the conversation.
  if (
    !source.otherLimitReached &&
    ![source.fiveHour, source.sevenDay].some(
      (w) => validWindow(w, now) && w!.usedPercent === 100,
    )
  )
    return "source-quota-available";
  if (quotaWindows(target)!.some((w) => w.usedPercent >= 90))
    return "target-quota-unavailable";
  const cooldown = request.target.cooldownUntil;
  if (
    cooldown &&
    (!Number.isFinite(Date.parse(cooldown)) || Date.parse(cooldown) > now)
  )
    return "target-cooldown";
  return undefined;
}
function sameSession(a: ContinuationSession, b: ContinuationSession) {
  return (
    typeof a?.id === "string" &&
    a.id.toLowerCase() === b.id.toLowerCase() &&
    a.projectKey === b.projectKey &&
    a.transcriptRevision === b.transcriptRevision &&
    a.permissionMode === b.permissionMode
  );
}
function requestSession(request: ContinuationRequest): ContinuationSession {
  return {
    id: request.sessionId.toLowerCase(),
    projectKey: request.projectKey,
    transcriptRevision: request.transcriptRevision,
    permissionMode: request.permissionMode,
    status: "stopped",
  };
}
function receiptMatches(
  request: ContinuationRequest,
  receipt: ContinuationReceipt | undefined,
) {
  return (
    !!receipt &&
    receipt.requestId === request.id &&
    sameIdentity(receipt.identity, identity(request.target)) &&
    typeof receipt.sessionId === "string" &&
    receipt.sessionId.toLowerCase() === request.sessionId.toLowerCase() &&
    receipt.projectKey === request.projectKey &&
    receipt.permissionMode === request.permissionMode &&
    receipt.beforeRevision === request.transcriptRevision &&
    textKey(receipt.afterRevision) &&
    receipt.afterRevision !== receipt.beforeRevision &&
    token(receipt.turnId)
  );
}
function validRecord(
  request: ContinuationRequest,
  record: ContinuationJournalRecord,
  now: number,
) {
  const stages = [
    "prepared",
    "checkpointed",
    "switch-intent",
    "account-verified",
    "open-intent",
    "session-verified",
    "send-intent",
    "delivery-accepted",
    "delivery-confirmed",
    "reconciliation-required",
    "blocked",
  ];
  if (
    !stages.includes(record.stage) ||
    !clock(record.updatedAt) ||
    record.updatedAt > now ||
    typeof record.sendRecorded !== "boolean" ||
    record.boundRequest !== serializedBinding(request)
  )
    return false;
  if (
    record.checkpoint &&
    (!textKey(record.checkpoint.id) ||
      !sameSession(record.checkpoint.session, requestSession(request)) ||
      record.checkpoint.session.status !== "stopped")
  )
    return false;
  if (record.receipt && !receiptMatches(request, record.receipt)) return false;
  if (
    record.receipt &&
    (!record.sendRecorded ||
      !["delivery-confirmed", "reconciliation-required"].includes(record.stage))
  )
    return false;
  if (record.stage === "prepared" && record.checkpoint) return false;
  if (
    [
      "checkpointed",
      "switch-intent",
      "account-verified",
      "open-intent",
      "session-verified",
      "send-intent",
      "delivery-accepted",
      "delivery-confirmed",
    ].includes(record.stage) &&
    !record.checkpoint
  )
    return false;
  if (record.sendRecorded && !record.checkpoint) return false;
  if (
    ["send-intent", "delivery-accepted", "delivery-confirmed"].includes(
      record.stage,
    ) &&
    !record.sendRecorded
  )
    return false;
  if (
    [
      "prepared",
      "checkpointed",
      "switch-intent",
      "account-verified",
      "open-intent",
      "session-verified",
    ].includes(record.stage) &&
    record.sendRecorded
  )
    return false;
  if (record.stage === "delivery-confirmed" && !record.receipt) return false;
  if (record.stage === "blocked" && (record.sendRecorded || record.receipt))
    return false;
  return true;
}

/** A damaged terminal journal entry remains a host-wide unresolved barrier. */
export function isTerminalContinuationRecord(
  value: unknown,
  now?: number,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as ContinuationJournalRecord;
  if (
    record.version !== 1 ||
    !token(record.id) ||
    !clock(record.updatedAt) ||
    (now !== undefined && (!clock(now) || record.updatedAt > now)) ||
    typeof record.boundRequest !== "string" ||
    typeof record.fingerprint !== "string" ||
    createHash("sha256").update(record.boundRequest).digest("hex") !==
      record.fingerprint
  )
    return false;
  try {
    const b = JSON.parse(record.boundRequest);
    const knownIdentity = (v: ContinuationIdentity) =>
      v && token(v.profileId) && UUID.test(v.accountUuid) && UUID.test(v.orgId);
    if (
      b.id !== record.id ||
      !knownIdentity(b.source) ||
      !knownIdentity(b.target) ||
      !UUID.test(b.sessionId) ||
      !textKey(b.projectKey) ||
      !textKey(b.transcriptRevision) ||
      !textKey(b.permissionMode) ||
      !clock(b.expectedContextRevision) ||
      b.continuationText !== CONTINUATION_TEXT ||
      (b.executionPolicy !== undefined &&
        b.executionPolicy !== "guarded-native-at-most-once")
    )
      return false;
    const checkpoint = record.checkpoint;
    if (
      checkpoint &&
      (!textKey(checkpoint.id) ||
        checkpoint.session?.status !== "stopped" ||
        !sameSession(checkpoint.session, {
          id: b.sessionId,
          projectKey: b.projectKey,
          transcriptRevision: b.transcriptRevision,
          permissionMode: b.permissionMode,
          status: "stopped",
        }))
    )
      return false;
    if (record.stage === "blocked")
      return record.sendRecorded === false && record.receipt === undefined;
    const receipt = record.receipt;
    return (
      record.stage === "delivery-confirmed" &&
      record.sendRecorded === true &&
      !!checkpoint &&
      !!receipt &&
      receipt.requestId === b.id &&
      sameIdentity(receipt.identity, b.target) &&
      receipt.sessionId?.toLowerCase() === b.sessionId.toLowerCase() &&
      receipt.projectKey === b.projectKey &&
      receipt.permissionMode === b.permissionMode &&
      receipt.beforeRevision === b.transcriptRevision &&
      textKey(receipt.afterRevision) &&
      receipt.afterRevision !== receipt.beforeRevision &&
      token(receipt.turnId)
    );
  } catch {
    return false;
  }
}

export class ContinuationEngine {
  constructor(
    private host: ContinuationHost,
    private journal: ContinuationJournal,
    private now: () => number = Date.now,
  ) {}

  /** Each adapter checks revision again; native UI checks are observational. */
  private stateReason(
    state: ContinuationState,
    expectedIdentity: ContinuationIdentity,
    expectedSession?: ContinuationSession,
  ) {
    const now = this.now();
    if (
      !clock(now) ||
      !clock(state?.observedAt) ||
      state.observedAt > now ||
      now - state.observedAt > 15_000
    )
      return "observation-not-fresh";
    if (!clock(state.contextRevision)) return "invalid-context-revision";
    if (!sameIdentity(state.identity, expectedIdentity))
      return "identity-mismatch";
    const q = state.quiescence;
    const expectedCoverage =
      this.host.capabilities.kind === "simulated"
        ? "isolated-all"
        : this.host.capabilities.kind === "guarded-native"
          ? "guarded-local"
          : "verified-all";
    if (!q || q.coverage !== expectedCoverage) return "coverage-unverified";
    for (const name of [
      "busyWorkers",
      "subagents",
      "pendingTasks",
      "waiting",
      "queuedPrompts",
      "scheduledWakeups",
      "unknownWork",
    ] as const) {
      if (!clock(q[name]) || q[name] !== 0) return `not-quiescent:${name}`;
    }
    if (!state.session || state.session.status !== "stopped")
      return "session-not-stopped";
    if (expectedSession && !sameSession(state.session, expectedSession))
      return "session-mismatch";
    return undefined;
  }

  async execute(request: ContinuationRequest): Promise<ContinuationResult> {
    const fail = (reason: string): ContinuationResult => ({
      status: "blocked",
      continuationKind: "stopped-session-new-turn",
      reason,
    });
    if (!request || request.authorized !== true) return fail("not-authorized");
    const caps = this.host.capabilities;
    if (
      !caps ||
      !["simulated", "verified-contract", "guarded-native"].includes(
        caps.kind,
      ) ||
      !textKey(caps.contractId) ||
      caps.exactSession !== true ||
      caps.conditionalActions !== true ||
      caps.deliveryLookup !== true ||
      caps.checkpoint !== true ||
      caps.accountSwitch !== true ||
      caps.sessionReopen !== true ||
      caps.targetedSend !== true ||
      caps.deliveryReceipt !== true ||
      (caps.kind === "guarded-native"
        ? request.executionPolicy !== "guarded-native-at-most-once"
        : caps.idempotentDelivery !== true || caps.atomicContextGuard !== true)
    )
      return fail("adapter-contract-unverified");
    if (
      !token(request.id) ||
      !UUID.test(request.sessionId) ||
      !textKey(request.projectKey) ||
      !textKey(request.transcriptRevision) ||
      !textKey(request.permissionMode) ||
      !clock(request.expectedContextRevision) ||
      !clock(this.now())
    )
      return fail("invalid-request");
    if (!enrolled(request.source) || !enrolled(request.target))
      return fail("identity-not-enrolled");
    const source = identity(request.source),
      target = identity(request.target);
    if (
      source.profileId === target.profileId ||
      (source.accountUuid === target.accountUuid &&
        source.orgId === target.orgId)
    )
      return fail("duplicate-identity");
    return this.journal.withLock(request.id, async () => {
      const fingerprint = binding(request);
      let record = await this.journal.read(request.id);
      if (record) {
        if (
          record.version !== 1 ||
          record.id !== request.id ||
          record.fingerprint !== fingerprint
        )
          return fail("journal-binding-mismatch");
        if (!validRecord(request, record, this.now()))
          return fail("journal-record-invalid");
        if (record.stage === "delivery-confirmed" && record.receipt)
          return {
            status: "continued",
            continuationKind: "stopped-session-new-turn",
            reason: "durable-delivery-confirmed",
            record,
            receipt: record.receipt,
          };
        if (record.sendRecorded) return this.reconcile(request, record);
        if (record.checkpoint && record.stage !== "blocked") {
          if (await this.hasOtherIntent(request.id))
            return fail("unresolved-host-intent");
          return this.run(request, record);
        }
        return {
          status:
            record.stage === "blocked" ? "blocked" : "reconciliation-required",
          continuationKind: "stopped-session-new-turn",
          reason: record.reason ?? "interrupted-before-send",
          record,
        };
      }
      if (await this.hasOtherIntent(request.id))
        return fail("unresolved-host-intent");
      const session = requestSession(request);
      const before = await this.host.readState();
      const reason =
        continuationPolicyReason(request, this.now()) ??
        this.stateReason(before, source, session) ??
        (before.contextRevision !== request.expectedContextRevision
          ? "context-revision-changed"
          : undefined);
      if (reason) return fail(reason);
      record = {
        version: 1,
        id: request.id,
        fingerprint,
        boundRequest: serializedBinding(request),
        stage: "prepared",
        updatedAt: this.now(),
        sendRecorded: false,
      };
      await this.journal.write(record);
      return this.run(request, record, before);
    });
  }

  /** User cancellation never probes Desktop or clears a possible send. */
  async abandonUnsent(requestId: string) {
    if (!token(requestId) || !clock(this.now()))
      throw new Error("invalid-request");
    return this.journal.withLock(requestId, async () => {
      const record = await this.journal.read(requestId);
      if (!record) {
        if (await this.hasOtherIntent(requestId))
          throw new Error("unresolved-host-intent");
        // execute writes prepared durably before any host operation. Absence
        // therefore proves that this request never entered the host pipeline.
        return {
          status: "abandoned" as const,
          reason: "user-cancelled-unsent",
        };
      }
      if (
        record.id !== requestId ||
        record.sendRecorded !== false ||
        record.receipt !== undefined
      )
        throw new Error("cannot-cancel-possible-send");
      const unsent = [
        "prepared",
        "checkpointed",
        "switch-intent",
        "account-verified",
        "open-intent",
        "session-verified",
        "reconciliation-required",
        "blocked",
      ];
      if (
        !unsent.includes(record.stage) ||
        !clock(record.updatedAt) ||
        record.updatedAt > this.now() ||
        (record.stage === "prepared" && record.checkpoint !== undefined) ||
        ([
          "checkpointed",
          "switch-intent",
          "account-verified",
          "open-intent",
          "session-verified",
        ].includes(record.stage) &&
          !record.checkpoint)
      )
        throw new Error("journal-record-invalid");
      const terminal: ContinuationJournalRecord = {
        ...record,
        stage: "blocked",
        reason: "user-cancelled-unsent",
      };
      // Validate original binding/hash/checkpoint before changing its timestamp.
      if (!isTerminalContinuationRecord(terminal, this.now()))
        throw new Error("journal-record-invalid");
      terminal.updatedAt = this.now();
      await this.journal.write(terminal);
      return {
        status: "abandoned" as const,
        reason: "user-cancelled-unsent",
        record: terminal,
      };
    });
  }

  private async hasOtherIntent(requestId: string) {
    const pending = await this.journal.listPending();
    return (
      !Array.isArray(pending) ||
      pending.some(
        (entry) =>
          !entry ||
          (entry.id !== requestId &&
            !isTerminalContinuationRecord(entry, this.now())),
      )
    );
  }

  /** Resume only an unambiguous, durable, unsent checkpoint under the same lock. */
  private async run(
    request: ContinuationRequest,
    record: ContinuationJournalRecord,
    initial?: ContinuationState,
  ): Promise<ContinuationResult> {
    const source = identity(request.source),
      target = identity(request.target),
      session = requestSession(request);
    const persist = async (stage: ContinuationJournalRecord["stage"]) => {
      record.stage = stage;
      record.updatedAt = this.now();
      await this.journal.write(record);
    };
    try {
      let state = initial ?? (await this.host.readState());
      if (!record.checkpoint) {
        this.assertReady(request, state, source, session);
        record.checkpoint = await this.host.checkpoint({
          requestId: request.id,
          session,
          expectedContextRevision: state.contextRevision,
        });
        if (
          !textKey(record.checkpoint.id) ||
          !sameSession(record.checkpoint.session, session) ||
          record.checkpoint.session.status !== "stopped"
        )
          throw new Error("checkpoint-mismatch");
        await persist("checkpointed");
        state = await this.host.readState();
      }
      if (sameIdentity(state.identity, source)) {
        this.assertReady(request, state, source, session);
        await persist("switch-intent");
        await this.host.switchAccount({
          requestId: request.id,
          target,
          expectedContextRevision: state.contextRevision,
        });
        state = await this.host.readState();
      }
      // A resumed journal never guesses the active identity, task coverage or
      // history. The exact checkpoint is reopened; a conditional adapter must
      // refuse to overwrite a conversation whose transcript changed meanwhile.
      this.assertReady(request, state, target, undefined, false);
      if (
        typeof state.session.id === "string" &&
        state.session.id.toLowerCase() === session.id &&
        !sameSession(state.session, session) &&
        !(
          this.host.capabilities.kind === "guarded-native" &&
          state.session.projectKey === session.projectKey &&
          state.session.transcriptRevision === session.transcriptRevision
        )
      )
        throw new Error("session-mismatch");
      await persist("account-verified");
      await persist("open-intent");
      await this.host.reopenSession({
        requestId: request.id,
        checkpoint: record.checkpoint,
        target,
        expectedContextRevision: state.contextRevision,
      });
      state = await this.host.readState();
      this.assertReady(request, state, target, session, false);
      await persist("session-verified");
      // Persist before submission. Any restart with this bit queries receipts;
      // an absent/ambiguous acknowledgement must NEVER cause a blind resend.
      record.sendRecorded = true;
      await persist("send-intent");
      state = await this.host.readState();
      this.assertReady(request, state, target, session, false);
      const delivery = await this.host.sendContinuation({
        requestId: request.id,
        target,
        session,
        expectedContextRevision: state.contextRevision,
        text: CONTINUATION_TEXT,
      });
      return await this.confirm(request, record, delivery);
    } catch (error) {
      record.reason =
        error instanceof Error ? error.message : "host-operation-failed";
      await persist("reconciliation-required");
      return {
        status: "reconciliation-required",
        continuationKind: "stopped-session-new-turn",
        reason: record.reason,
        record,
      };
    }
  }

  private assertReady(
    request: ContinuationRequest,
    state: ContinuationState,
    expectedIdentity: ContinuationIdentity,
    session?: ContinuationSession,
    checkQuota = true,
  ) {
    const reason =
      continuationPolicyReason(request, this.now(), checkQuota) ??
      this.stateReason(state, expectedIdentity, session);
    if (reason) throw new Error(reason);
  }

  private async reconcile(
    request: ContinuationRequest,
    record: ContinuationJournalRecord,
  ): Promise<ContinuationResult> {
    try {
      return await this.confirm(
        request,
        record,
        await this.host.lookupDelivery(request.id),
      );
    } catch {
      record.stage = "reconciliation-required";
      record.reason = "delivery-lookup-unavailable";
      record.updatedAt = this.now();
      await this.journal.write(record);
      return {
        status: "reconciliation-required",
        continuationKind: "stopped-session-new-turn",
        reason: record.reason,
        record,
      };
    }
  }

  private async confirm(
    request: ContinuationRequest,
    record: ContinuationJournalRecord,
    delivery: ContinuationDelivery,
  ): Promise<ContinuationResult> {
    const receipt = delivery.receipt;
    let reason = `delivery-${delivery.status}`;
    if (delivery.status === "started" && receipt) {
      if (!receiptMatches(request, receipt)) {
        reason = "receipt-mismatch";
      } else {
        const state = await this.host.readState();
        const now = this.now();
        if (
          clock(state.observedAt) &&
          state.observedAt <= now &&
          now - state.observedAt <= 15_000 &&
          sameIdentity(state.identity, identity(request.target)) &&
          state.session.id.toLowerCase() === request.sessionId.toLowerCase() &&
          state.session.projectKey === request.projectKey &&
          state.session.permissionMode === request.permissionMode
          // The resumed turn keeps appending to the transcript, so its revision
          // and latest row move on; the receipt already bound them to the nonce.
        ) {
          record.stage = "delivery-confirmed";
          record.receipt = receipt;
          record.reason = undefined;
          record.updatedAt = now;
          await this.journal.write(record);
          return {
            status: "continued",
            continuationKind: "stopped-session-new-turn",
            reason: "new-turn-verified",
            record,
            receipt,
          };
        }
        reason = "new-turn-not-observed";
      }
    }
    record.stage =
      delivery.status === "accepted"
        ? "delivery-accepted"
        : "reconciliation-required";
    record.reason = reason;
    record.updatedAt = this.now();
    await this.journal.write(record);
    return {
      status: "reconciliation-required",
      continuationKind: "stopped-session-new-turn",
      reason,
      record,
    };
  }
}
