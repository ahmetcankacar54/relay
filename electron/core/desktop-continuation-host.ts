import { execFile } from "node:child_process";
import type {
  ContinuationCheckpoint,
  ContinuationDelivery,
  ContinuationHost,
  ContinuationIdentity,
  ContinuationSession,
  ContinuationState,
} from "./continuation";

export type DesktopAutomationIssue =
  | "accessibility-permission-required"
  | "claude-not-running"
  | "desktop-ui-unsupported"
  | "exact-session-not-observed"
  | "composer-not-empty"
  | "permission-mode-mismatch"
  | "context-changed"
  | "desktop-work-active"
  | "delivery-ambiguous"
  | "desktop-observation-incomplete"
  /**
   * `write-draft`, or `open-session` asked to check, refused before acting: Claude is not
   * in front, or the user had input in the last 3 s.
   */
  | "user-active";

export class DesktopAutomationError extends Error {
  constructor(
    readonly issue: DesktopAutomationIssue,
    /** True when the failure happened before anything in Claude was changed. */
    readonly unchanged = false,
  ) {
    super(issue);
  }
}

/** AX proves only the selected conversation, never all workers or their children. */
export interface DesktopAutomationSnapshot {
  observedAt: number;
  pid: number;
  localSessionId?: string;
  /**
   * Code's new-session screen is on screen: it has no `localSessionId`. Inside the
   * fingerprint; older helpers omit it.
   */
  newSession?: boolean;
  accountLabel?: string;
  permissionMode?: string;
  status: "stopped" | "running" | "waiting" | "unknown";
  quotaStopped: boolean;
  /** False when no composer was found, which also reads as not empty. Older helpers omit it. */
  composerPresent?: boolean;
  composerEmpty: boolean;
  /**
   * How an empty composer read as empty: "empty", "no-value", "blank" (only line breaks or
   * spaces), "editor-empty" (tiptap's empty-editor class) or "placeholder". Outside the
   * fingerprint, for the diagnosis log; older helpers omit it.
   */
  composerEmptyAs?: string;
  sendEnabled: boolean;
  quotaAutoResume?: boolean;
  visibleActiveTasks?: number;
  visibleWaitingTasks?: number;
  visibleScheduledTasks?: number;
  contextFingerprint: string;
  coverage: "active-conversation-only";
  /** Claude is the app in front. Outside the fingerprint; older helpers omit it. */
  frontmost?: boolean;
  /** Milliseconds since the user's last input of any kind. Outside the fingerprint; older helpers omit it. */
  idleMs?: number;
  /**
   * Milliseconds since the user last pressed a key, a modifier included; mouse input does not
   * count. Outside the fingerprint; older helpers omit it.
   */
  keyIdleMs?: number;
}

export interface DesktopAutomationGuard {
  pid: number;
  localSessionId: string;
  accountLabel: string;
  permissionMode: string;
  contextFingerprint: string;
}

/**
 * Code's new-session screen, for `writeDraft` only: the helper refuses it for any other
 * command. That screen may show no single permission selector, so the mode is kept only
 * when one was read.
 */
export interface DesktopNewSessionGuard {
  pid: number;
  newSession: true;
  accountLabel: string;
  permissionMode?: string;
  contextFingerprint: string;
}

/** The screens a draft can be typed into: a conversation, or Code's new-session screen. */
export type DesktopDraftGuard = DesktopAutomationGuard | DesktopNewSessionGuard;

export interface DesktopAutomation {
  /** Explicit user action only. Ordinary inspection never triggers an OS prompt. */
  requestAccessibility?(): Promise<boolean>;
  inspect(): Promise<DesktopAutomationSnapshot>;
  /**
   * Opens an exact saved conversation. Success still requires inspection. With
   * `requireIdle`, the helper first checks, right before it opens, that Claude is in
   * front and the user has had no input for 3 s, and otherwise opens nothing:
   * `user-active`.
   */
  openSession(
    localSessionId: string,
    options?: { requireIdle?: boolean },
  ): Promise<void>;
  /**
   * Shows Code's new-session screen through Desktop's own `claude://code/new`, which starts
   * no session. Success still requires inspection. `requireIdle` as for `openSession`.
   */
  openNewSession(options?: { requireIdle?: boolean }): Promise<void>;
  /** Chooses the prior explicit permission mode; it never approves a tool dialog. */
  setPermission(
    guard: DesktopAutomationGuard,
    mode: string,
  ): Promise<DesktopAutomationSnapshot>;
  cancelQuotaResume?(
    guard: DesktopAutomationGuard,
  ): Promise<DesktopAutomationSnapshot>;
  /** At-most-one UI send attempt. A visible marker is not a durable receipt. */
  send(
    guard: DesktopAutomationGuard,
    requestId: string,
    text: string,
  ): Promise<{ acceptedVisible: boolean }>;
  hasRequestMarker(requestId: string): Promise<boolean>;
  /**
   * Types `text` into the empty composer of the open conversation, or of Code's
   * new-session screen, and never presses Send. One guarded attempt: a non-empty
   * composer is `composer-not-empty`, a moved context is `context-changed`, an
   * unverifiable result is `delivery-ambiguous`. Claude not in front, or input from
   * the user in the last 3 s, is `user-active`, before anything is typed; with
   * `keysIdleMs` (500 to 3000), a key pressed in that time instead of any input.
   * Resolves with the snapshot taken after the write.
   */
  writeDraft(
    guard: DesktopDraftGuard,
    text: string,
    options?: { keysIdleMs?: number },
  ): Promise<DesktopAutomationSnapshot>;
}

export interface DesktopContinuationObservation extends ContinuationState {
  ownQuotaWakeup?: boolean;
  /** Read-only evidence must bind this Desktop alias to session.id. */
  localSessionId: string;
  quotaStop?: {
    sessionId: string;
    turnId: string;
    observedAt: number;
    reason: "rate-limit";
  };
}

/**
 * Identity, transcript, complete worker coverage and durable acknowledgement are
 * independent of AX. Do not infer them from an empty composer or a quota banner.
 */
export interface DesktopContinuationEvidence {
  read(
    snapshot: DesktopAutomationSnapshot,
  ): Promise<DesktopContinuationObservation>;
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
  localSessionId(checkpoint: ContinuationCheckpoint): Promise<string>;
  lookupDelivery(requestId: string): Promise<ContinuationDelivery>;
}

const LOCAL =
  /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Whether `id` is an exact Desktop conversation id, the only kind `openSession` opens. */
export const isLocalSessionId = (id: string) => LOCAL.test(id);
const REQUEST = /^[A-Za-z0-9._:-]{1,128}$/;
/** Longest unsent draft Relay re-types; longer ones are left for Copy. */
const MAX_DRAFT_LENGTH = 16_384;
const MODES = new Set(["Manual", "Auto", "Plan", "Accept edits"]);
const knownIssues = new Set<DesktopAutomationIssue>([
  "accessibility-permission-required",
  "claude-not-running",
  "desktop-ui-unsupported",
  "exact-session-not-observed",
  "composer-not-empty",
  "permission-mode-mismatch",
  "context-changed",
  "desktop-work-active",
  "delivery-ambiguous",
  "desktop-observation-incomplete",
  "user-active",
]);

type NativeReply = {
  ok: boolean;
  issue?: DesktopAutomationIssue;
  snapshot?: DesktopAutomationSnapshot;
  acceptedVisible?: boolean;
  markerPresent?: boolean;
  accessibilityGranted?: boolean;
};
export type DesktopNativeExecutor = (request: unknown) => Promise<unknown>;

function validSnapshot(value: unknown): value is DesktopAutomationSnapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as DesktopAutomationSnapshot;
  return (
    Number.isSafeInteger(v.observedAt) &&
    v.observedAt > 0 &&
    Number.isSafeInteger(v.pid) &&
    v.pid > 0 &&
    (v.localSessionId === undefined || LOCAL.test(v.localSessionId)) &&
    (v.newSession === undefined || typeof v.newSession === "boolean") &&
    // The new-session screen has no conversation id.
    !(v.newSession === true && v.localSessionId !== undefined) &&
    (v.accountLabel === undefined ||
      (typeof v.accountLabel === "string" && v.accountLabel.length <= 512)) &&
    (v.permissionMode === undefined || MODES.has(v.permissionMode)) &&
    ["stopped", "running", "waiting", "unknown"].includes(v.status) &&
    typeof v.quotaStopped === "boolean" &&
    (v.composerPresent === undefined ||
      typeof v.composerPresent === "boolean") &&
    typeof v.composerEmpty === "boolean" &&
    (v.composerEmptyAs === undefined ||
      (typeof v.composerEmptyAs === "string" && /^[a-z-]{1,16}$/.test(v.composerEmptyAs))) &&
    typeof v.sendEnabled === "boolean" &&
    (v.quotaAutoResume === undefined ||
      typeof v.quotaAutoResume === "boolean") &&
    [
      v.visibleActiveTasks,
      v.visibleWaitingTasks,
      v.visibleScheduledTasks,
    ].every(
      (count) =>
        count === undefined || (Number.isSafeInteger(count) && count >= 0),
    ) &&
    /^[0-9a-f]{64}$/.test(v.contextFingerprint) &&
    v.coverage === "active-conversation-only" &&
    (v.frontmost === undefined || typeof v.frontmost === "boolean") &&
    (v.idleMs === undefined || (Number.isSafeInteger(v.idleMs) && v.idleMs >= 0)) &&
    (v.keyIdleMs === undefined ||
      (Number.isSafeInteger(v.keyIdleMs) && v.keyIdleMs >= 0))
  );
}

function guard(snapshot: DesktopAutomationSnapshot): DesktopAutomationGuard {
  if (!snapshot.localSessionId)
    throw new DesktopAutomationError("exact-session-not-observed");
  if (!snapshot.accountLabel || !snapshot.permissionMode)
    throw new DesktopAutomationError("desktop-ui-unsupported");
  return {
    pid: snapshot.pid,
    localSessionId: snapshot.localSessionId,
    accountLabel: snapshot.accountLabel,
    permissionMode: snapshot.permissionMode,
    contextFingerprint: snapshot.contextFingerprint,
  };
}

export const automationGuard = guard;

/** A guard for Code's new-session screen, from a snapshot that shows it. */
export function newSessionGuard(
  snapshot: DesktopAutomationSnapshot,
): DesktopNewSessionGuard {
  if (snapshot.newSession !== true || snapshot.localSessionId !== undefined)
    throw new DesktopAutomationError("exact-session-not-observed");
  if (!snapshot.accountLabel)
    throw new DesktopAutomationError("desktop-ui-unsupported");
  return {
    pid: snapshot.pid,
    newSession: true,
    accountLabel: snapshot.accountLabel,
    ...(snapshot.permissionMode !== undefined
      ? { permissionMode: snapshot.permissionMode }
      : {}),
    contextFingerprint: snapshot.contextFingerprint,
  };
}

/** The helper never starts Claude, reads credentials or invokes a CLI. */
export function nativeDesktopAutomation(
  helper: string,
  executor?: DesktopNativeExecutor,
): DesktopAutomation {
  const invoke =
    executor ??
    ((request: unknown) =>
      new Promise<unknown>((resolve, reject) => {
        const child = execFile(
          helper,
          [],
          { timeout: 45_000, maxBuffer: 65_536, windowsHide: true },
          (error, stdout) => {
            if (error)
              return reject(
                new DesktopAutomationError("desktop-ui-unsupported"),
              );
            try {
              resolve(JSON.parse(stdout));
            } catch {
              reject(new DesktopAutomationError("desktop-ui-unsupported"));
            }
          },
        );
        child.stdin?.on("error", () => {});
        child.stdin?.end(JSON.stringify(request));
      }));
  const call = async (request: unknown) => {
    const raw = await invoke(request);
    if (!raw || typeof raw !== "object")
      throw new DesktopAutomationError("desktop-ui-unsupported");
    const reply = raw as NativeReply;
    if (reply.ok !== true)
      throw new DesktopAutomationError(
        reply.issue && knownIssues.has(reply.issue)
          ? reply.issue
          : "desktop-ui-unsupported",
      );
    return reply;
  };
  const snapshot = (reply: NativeReply) => {
    if (!validSnapshot(reply.snapshot))
      throw new DesktopAutomationError("desktop-ui-unsupported");
    return reply.snapshot;
  };
  return {
    requestAccessibility: async () =>
      (await call({ command: "request-accessibility" }))
        .accessibilityGranted === true,
    inspect: async () => snapshot(await call({ command: "inspect" })),
    openSession: async (localSessionId, options) => {
      if (!LOCAL.test(localSessionId))
        throw new DesktopAutomationError("exact-session-not-observed");
      await call({
        command: "open-session",
        localSessionId,
        ...(options?.requireIdle === true ? { requireIdle: true } : {}),
      });
    },
    openNewSession: async (options) => {
      await call({
        command: "open-new-session",
        ...(options?.requireIdle === true ? { requireIdle: true } : {}),
      });
    },
    setPermission: async (expected, mode) => {
      if (!MODES.has(mode))
        throw new DesktopAutomationError("permission-mode-mismatch");
      return snapshot(
        await call({ command: "set-permission", guard: expected, mode }),
      );
    },
    cancelQuotaResume: async (expected) =>
      snapshot(await call({ command: "cancel-quota-resume", guard: expected })),
    send: async (expected, requestId, text) => {
      if (
        !REQUEST.test(requestId) ||
        !text ||
        text.length > 8192 ||
        text.includes("\0")
      )
        throw new DesktopAutomationError("desktop-ui-unsupported");
      const r = await call({
        command: "send",
        guard: expected,
        requestId,
        text,
      });
      return { acceptedVisible: r.acceptedVisible === true };
    },
    writeDraft: async (expected, text, options) => {
      if (!text || text.length > MAX_DRAFT_LENGTH || text.includes("\0"))
        throw new DesktopAutomationError("desktop-ui-unsupported");
      const keys = options?.keysIdleMs;
      if (
        keys !== undefined &&
        !(Number.isSafeInteger(keys) && keys >= 500 && keys <= 3_000)
      )
        throw new DesktopAutomationError("desktop-ui-unsupported");
      return snapshot(
        await call({
          command: "write-draft",
          guard: expected,
          text,
          ...(keys !== undefined ? { keysIdleMs: keys } : {}),
        }),
      );
    },
    hasRequestMarker: async (requestId) => {
      if (!REQUEST.test(requestId))
        throw new DesktopAutomationError("desktop-ui-unsupported");
      return (
        (await call({ command: "lookup", requestId })).markerPresent === true
      );
    },
  };
}

/**
 * Production AX transport, with its actual limitations exposed. In particular,
 * it must not satisfy ContinuationEngine's atomic or exactly-once contract.
 */
export class DesktopContinuationHost implements ContinuationHost {
  readonly capabilities = {
    kind: "guarded-native" as const,
    contractId: "macos-accessibility-guarded-new-turn-v1",
    exactSession: true,
    conditionalActions: true,
    idempotentDelivery: false,
    deliveryLookup: true,
    checkpoint: true,
    accountSwitch: true,
    sessionReopen: true,
    targetedSend: true,
    deliveryReceipt: true,
    atomicContextGuard: false,
  };
  constructor(
    private readonly automation: DesktopAutomation,
    private readonly evidence: DesktopContinuationEvidence,
    private readonly deliveryWait: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  private async observed(expectedRevision?: number) {
    const snapshot = await this.automation.inspect();
    const state = await this.evidence.read(snapshot);
    if (
      !LOCAL.test(state.localSessionId) ||
      snapshot.localSessionId !== state.localSessionId
    )
      throw new DesktopAutomationError("exact-session-not-observed");
    if (
      expectedRevision !== undefined &&
      state.contextRevision !== expectedRevision
    )
      throw new DesktopAutomationError("context-changed");
    if (snapshot.permissionMode !== state.session.permissionMode)
      throw new DesktopAutomationError("permission-mode-mismatch");
    if (snapshot.status !== "stopped" || state.session.status !== "stopped")
      throw new DesktopAutomationError("desktop-work-active");
    return { snapshot, state };
  }
  async readState() {
    const snapshot = await this.automation.inspect();
    return this.evidence.read(snapshot);
  }
  /** Call only after explicit opt-in and fresh target/history quota preflight. */
  async cancelQuotaResume(expectedContextRevision: number) {
    let observed: Awaited<ReturnType<typeof this.observed>>;
    try {
      observed = await this.observed(expectedContextRevision);
    } catch (error) {
      throw new DesktopAutomationError(
        error instanceof DesktopAutomationError
          ? error.issue
          : "desktop-observation-incomplete",
        true,
      );
    }
    const { snapshot, state } = observed;
    const q = state.quiescence;
    if (
      !state.quotaStop ||
      snapshot.quotaAutoResume !== true ||
      !this.automation.cancelQuotaResume ||
      q.coverage !== "guarded-local" ||
      q.scheduledWakeups !== 1 ||
      [
        q.busyWorkers,
        q.subagents,
        q.pendingTasks,
        q.waiting,
        q.queuedPrompts,
        q.unknownWork,
      ].some((value) => value !== 0)
    )
      throw new DesktopAutomationError("desktop-work-active", true);
    const changed = await this.automation.cancelQuotaResume(guard(snapshot));
    const fresh = await this.evidence.read(changed);
    if (
      changed.quotaAutoResume !== false ||
      fresh.session.id !== state.session.id ||
      fresh.session.transcriptRevision !== state.session.transcriptRevision ||
      fresh.session.permissionMode !== state.session.permissionMode ||
      fresh.identity.profileId !== state.identity.profileId
    )
      throw new DesktopAutomationError("context-changed");
    return fresh;
  }
  async checkpoint(input: Parameters<ContinuationHost["checkpoint"]>[0]) {
    const { state } = await this.observed(input.expectedContextRevision);
    this.requireQuiescence(state);
    this.requireSession(state.session, input.session);
    return this.evidence.checkpoint(input);
  }
  async switchAccount(input: Parameters<ContinuationHost["switchAccount"]>[0]) {
    const { state } = await this.observed(input.expectedContextRevision);
    this.requireQuiescence(state);
    await this.evidence.switchAccount(input);
  }
  async reopenSession(input: Parameters<ContinuationHost["reopenSession"]>[0]) {
    const before = await this.evidence.read(await this.automation.inspect());
    if (before.contextRevision !== input.expectedContextRevision)
      throw new DesktopAutomationError("context-changed");
    this.requireIdentity(before.identity, input.target);
    this.requireQuiescence(before);
    const localSessionId = await this.evidence.localSessionId(input.checkpoint);
    await this.automation.openSession(localSessionId);
    // A requested navigation is not a successful reopen. Observe the loaded ID.
    let snapshot = await this.automation.inspect();
    let state = await this.evidence.read(snapshot);
    this.requireIdentity(state.identity, input.target);
    this.requireQuiescence(state);
    if (
      snapshot.localSessionId !== localSessionId ||
      state.localSessionId !== localSessionId
    )
      throw new DesktopAutomationError("exact-session-not-observed");
    if (
      state.session.id !== input.checkpoint.session.id ||
      state.session.projectKey !== input.checkpoint.session.projectKey ||
      state.session.transcriptRevision !==
        input.checkpoint.session.transcriptRevision
    )
      throw new DesktopAutomationError("exact-session-not-observed");
    if (snapshot.status !== "stopped" || state.session.status !== "stopped")
      throw new DesktopAutomationError("desktop-work-active");
    if (snapshot.permissionMode !== input.checkpoint.session.permissionMode) {
      snapshot = await this.automation.setPermission(
        guard(snapshot),
        input.checkpoint.session.permissionMode,
      );
      state = await this.evidence.read(snapshot);
    }
    this.requireSession(state.session, input.checkpoint.session);
    if (snapshot.permissionMode !== input.checkpoint.session.permissionMode)
      throw new DesktopAutomationError("permission-mode-mismatch");
  }
  async sendContinuation(
    input: Parameters<ContinuationHost["sendContinuation"]>[0],
  ) {
    const previous = await this.evidence.lookupDelivery(input.requestId);
    if (previous.status !== "absent") return previous;
    const { snapshot, state } = await this.observed(
      input.expectedContextRevision,
    );
    this.requireIdentity(state.identity, input.target);
    this.requireSession(state.session, input.session);
    this.requireQuiescence(state);
    if (!snapshot.composerEmpty)
      throw new DesktopAutomationError("composer-not-empty");
    await this.automation.send(guard(snapshot), input.requestId, input.text);
    // Never fabricate a receipt from a button click or visible text. A durable
    // receiver transcript must establish the new user turn under this identity.
    let delivery = await this.evidence.lookupDelivery(input.requestId);
    // Read-only polling allows the receiver's first assistant row to arrive;
    // with high effort the first thinking block can take minutes. There is
    // never another send attempt, even after an ambiguous outcome.
    for (
      let attempt = 0;
      attempt < 110 && ["absent", "accepted"].includes(delivery.status);
      attempt++
    ) {
      await this.deliveryWait(attempt < 10 ? 500 : 2_000);
      delivery = await this.evidence.lookupDelivery(input.requestId);
    }
    return delivery.status === "absent"
      ? { status: "unknown" as const }
      : delivery;
  }
  lookupDelivery(requestId: string) {
    return this.evidence.lookupDelivery(requestId);
  }

  private requireQuiescence(state: ContinuationState) {
    const q = state.quiescence;
    if (q.coverage !== "guarded-local")
      throw new DesktopAutomationError("desktop-observation-incomplete");
    if (
      [
        q.busyWorkers,
        q.subagents,
        q.pendingTasks,
        q.waiting,
        q.queuedPrompts,
        q.scheduledWakeups,
        q.unknownWork,
      ].some((n) => !Number.isSafeInteger(n) || n !== 0)
    )
      throw new DesktopAutomationError("desktop-work-active");
  }
  private requireIdentity(a: ContinuationIdentity, b: ContinuationIdentity) {
    if (
      a.profileId !== b.profileId ||
      a.accountUuid.toLowerCase() !== b.accountUuid.toLowerCase() ||
      a.orgId.toLowerCase() !== b.orgId.toLowerCase()
    )
      throw new DesktopAutomationError("context-changed");
  }
  private requireSession(a: ContinuationSession, b: ContinuationSession) {
    if (
      a.id.toLowerCase() !== b.id.toLowerCase() ||
      a.projectKey !== b.projectKey ||
      a.transcriptRevision !== b.transcriptRevision
    )
      throw new DesktopAutomationError("exact-session-not-observed");
    if (a.permissionMode !== b.permissionMode)
      throw new DesktopAutomationError("permission-mode-mismatch");
  }
}
