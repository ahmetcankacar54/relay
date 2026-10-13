import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Account, AccountUsage, RelaySettings } from "../../shared/types";
import { rankContinuationTargets } from "../../shared/continuation-target-ranking";
import {
  continuationPolicyReason,
  type ContinuationHost,
  type ContinuationIdentity,
  type ContinuationRequest,
  type ContinuationResult,
  type ContinuationState,
} from "./continuation";
import {
  privateJournalDirectory,
  readPrivateJson,
  writePrivateJson,
} from "./continuation-journal";

export interface DesktopQuotaStop {
  reason: "rate-limit";
  sessionId: string;
  /** The specific ended model turn; a quota percentage alone is insufficient. */
  turnId: string;
  observedAt: number;
}
export interface DesktopContinuationObservation {
  state: ContinuationState;
  quotaStop?: DesktopQuotaStop;
  blockedReason?: string;
  /** Exactly this ended turn's checked Desktop quota-reset wakeup, never other work. */
  ownQuotaWakeup?: boolean;
}
export interface DesktopContinuationSnapshot {
  status:
    | "off"
    | "armed"
    | "waiting"
    | "executing"
    | "continued"
    | "blocked"
    | "reconciliation-required";
  reason: string;
  canArm: boolean;
  enabled: boolean;
  executable: boolean;
  observationReason?: string;
  checkedAt?: string;
  sourceId?: string;
  targetId?: string;
  targetSelection?: "automatic";
  allowedTargetCount?: number;
  sessionId?: string;
  projectKey?: string;
  permissionMode?: string;
  requestId?: string;
}
export interface DesktopContinuationArm {
  id: string;
  armedAt: number;
  source: ContinuationIdentity;
  target: ContinuationIdentity;
  /** Automatic enrollment is frozen; later added or replaced identities need new consent. */
  targetSelection?: "automatic";
  allowedTargets?: ContinuationIdentity[];
  sessionId: string;
  projectKey: string;
  permissionMode: string;
  executionPolicy?: "guarded-native-at-most-once";
}
export interface DesktopContinuationAttempt {
  id: string;
  arm: DesktopContinuationArm;
  episodeKey: string;
  transcriptRevision: string;
  expectedContextRevision: number;
  turnId: string;
  /** Durable before taking over Desktop's timer; an uncertain cancel is never replayed. */
  ownQuotaWakeup?: "cancellation-intent" | "cancelled-verified";
}
export interface DesktopContinuationPersistentState {
  version: 1;
  arm?: DesktopContinuationArm;
  pending?: DesktopContinuationAttempt;
  completed: { key: string; at: number }[];
}
export interface DesktopContinuationPersistence {
  load(): DesktopContinuationPersistentState;
  save(state: DesktopContinuationPersistentState): void;
}
export interface DesktopContinuationDependencies {
  observe(): Promise<DesktopContinuationObservation>;
  capabilities: ContinuationHost["capabilities"];
  engine: {
    execute(request: ContinuationRequest): Promise<ContinuationResult>;
    abandonUnsent?(requestId: string): Promise<unknown>;
  };
  snapshot(): {
    accounts: Account[];
    settings: RelaySettings;
    usage: Record<string, AccountUsage>;
  };
  persistence: DesktopContinuationPersistence;
  /** The same lock used by manual switching, login, recovery and history writes. */
  withDesktopLock<T>(action: () => Promise<T>): Promise<T>;
  pendingAuth?(): boolean;
  changed?(): void;
  now?(): number;
  /** Explicit guarded-policy takeover of the selected stopped turn's own wakeup. */
  prepareQuotaStop?(
    observation: DesktopContinuationObservation,
    request: ContinuationRequest,
  ): Promise<DesktopContinuationObservation>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const actionableObservationIssues = new Set([
  "accessibility-permission-required",
  "claude-not-running",
  "desktop-ui-unsupported",
  "exact-session-not-observed",
  "composer-not-empty",
  "permission-mode-mismatch",
  "context-changed",
  "desktop-work-active",
  "desktop-observation-incomplete",
  "unsupported-platform",
]);
const observationErrorReason = (error: unknown) =>
  error instanceof Error && actionableObservationIssues.has(error.message)
    ? error.message
    : "desktop-observation-unavailable";
const validText = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 4096 &&
  !v.includes("\0");
const validClock = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
function sameIdentity(a: ContinuationIdentity, b: ContinuationIdentity) {
  return (
    a.profileId === b.profileId &&
    a.accountUuid.toLowerCase() === b.accountUuid.toLowerCase() &&
    a.orgId.toLowerCase() === b.orgId.toLowerCase()
  );
}
function enrolled(account: Account | undefined): account is Account & {
  desktop: NonNullable<Account["desktop"]>;
} {
  return (
    !!account &&
    UUID.test(account.id) &&
    UUID.test(account.desktop?.accountUuid ?? "") &&
    UUID.test(account.desktop?.orgId ?? "") &&
    account.auth?.loggedIn === true &&
    account.auth.accountUuid?.toLowerCase() ===
      account.desktop?.accountUuid.toLowerCase() &&
    account.auth.orgId?.toLowerCase() === account.desktop?.orgId.toLowerCase()
  );
}
const identity = (
  account: Account & { desktop: NonNullable<Account["desktop"]> },
) => ({
  profileId: account.id,
  accountUuid: account.desktop.accountUuid.toLowerCase(),
  orgId: account.desktop.orgId.toLowerCase(),
});
function validIdentity(value: unknown): value is ContinuationIdentity {
  if (!value || typeof value !== "object") return false;
  const v = value as ContinuationIdentity;
  return (
    UUID.test(v.profileId) && UUID.test(v.accountUuid) && UUID.test(v.orgId)
  );
}
function validArm(value: unknown): value is DesktopContinuationArm {
  if (!value || typeof value !== "object") return false;
  const a = value as DesktopContinuationArm;
  return (
    KEY.test(a.id) &&
    validClock(a.armedAt) &&
    validIdentity(a.source) &&
    validIdentity(a.target) &&
    a.source.profileId !== a.target.profileId &&
    !(
      a.source.accountUuid.toLowerCase() ===
        a.target.accountUuid.toLowerCase() &&
      a.source.orgId.toLowerCase() === a.target.orgId.toLowerCase()
    ) &&
    UUID.test(a.sessionId) &&
    validText(a.projectKey) &&
    validText(a.permissionMode) &&
    (a.executionPolicy === undefined ||
      a.executionPolicy === "guarded-native-at-most-once") &&
    (a.targetSelection === undefined ||
      (a.targetSelection === "automatic" &&
        Array.isArray(a.allowedTargets) &&
        a.allowedTargets.length > 0 &&
        a.allowedTargets.length <= 100 &&
        a.allowedTargets.every(
          (target) =>
            validIdentity(target) &&
            target.profileId !== a.source.profileId &&
            !(
              target.accountUuid.toLowerCase() ===
                a.source.accountUuid.toLowerCase() &&
              target.orgId.toLowerCase() === a.source.orgId.toLowerCase()
            ),
        ) &&
        new Set(a.allowedTargets.map((target) => target.profileId)).size ===
          a.allowedTargets.length &&
        new Set(
          a.allowedTargets.map(
            (target) =>
              `${target.accountUuid.toLowerCase()}:${target.orgId.toLowerCase()}`,
          ),
        ).size === a.allowedTargets.length &&
        a.allowedTargets.some((target) => sameIdentity(target, a.target))))
  );
}
function validPersistent(
  value: unknown,
): value is DesktopContinuationPersistentState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as DesktopContinuationPersistentState;
  if (
    v.version !== 1 ||
    (v.arm !== undefined && !validArm(v.arm)) ||
    !Array.isArray(v.completed) ||
    v.completed.length > 100 ||
    !v.completed.every(
      (entry) =>
        entry && /^[a-f0-9]{64}$/.test(entry.key) && validClock(entry.at),
    )
  )
    return false;
  if (v.pending) {
    const p = v.pending;
    if (
      !KEY.test(p.id) ||
      !validArm(p.arm) ||
      !/^[a-f0-9]{64}$/.test(p.episodeKey) ||
      !validText(p.transcriptRevision) ||
      !validClock(p.expectedContextRevision) ||
      !KEY.test(p.turnId) ||
      (p.ownQuotaWakeup !== undefined &&
        (p.arm.executionPolicy !== "guarded-native-at-most-once" ||
          (p.ownQuotaWakeup !== "cancellation-intent" &&
            p.ownQuotaWakeup !== "cancelled-verified")))
    )
      return false;
  }
  return true;
}

export class FileDesktopContinuationPersistence implements DesktopContinuationPersistence {
  readonly file: string;
  constructor(root: string) {
    privateJournalDirectory(root);
    this.file = path.join(root, "continuation-state.json");
  }
  load() {
    try {
      const value = readPrivateJson(this.file);
      if (!validPersistent(value))
        throw new Error("continuation-state-invalid");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1 as const, completed: [] };
      // Never silently reset an arm, unfinished send or deduplication history.
      throw new Error("continuation-state-unreadable");
    }
  }
  save(state: DesktopContinuationPersistentState) {
    if (!validPersistent(state)) throw new Error("continuation-state-invalid");
    writePrivateJson(this.file, state);
  }
}

/** One explicit, persisted handoff for the selected current conversation. */
export class DesktopContinuationManager {
  private saved: DesktopContinuationPersistentState;
  private view: DesktopContinuationSnapshot;
  private tail: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private now: () => number;
  private stopped = false;
  private persistenceFault = false;
  constructor(private deps: DesktopContinuationDependencies) {
    this.now = deps.now ?? Date.now;
    try {
      this.saved = deps.persistence.load();
      if (!validPersistent(this.saved))
        throw new Error("continuation-state-invalid");
    } catch {
      // Keep the account panel usable, but never reset or write the unreadable
      // optional automation state. Its possible unfinished intent remains blocked.
      this.persistenceFault = true;
      this.stopped = true;
      this.saved = { version: 1, completed: [] };
      this.view = {
        status: "blocked",
        reason: "continuation-state-unreadable",
        observationReason: "continuation-state-unreadable",
        canArm: false,
        enabled: false,
        executable: false,
      };
      return;
    }
    this.view = this.saved.pending
      ? this.fields(
          "reconciliation-required",
          this.saved.pending.ownQuotaWakeup === "cancellation-intent"
            ? "own-quota-wakeup-uncertain"
            : "unfinished-attempt",
          this.saved.pending.arm,
        )
      : this.saved.arm
        ? this.fields("armed", "awaiting-quota-stop", this.saved.arm)
        : {
            status: "off",
            reason: "disabled",
            canArm: false,
            enabled: false,
            executable: !this.contractReason(),
          };
  }
  snapshot() {
    return structuredClone(this.view);
  }
  private pendingAttempt(): DesktopContinuationAttempt | undefined {
    // Awaited host operations may have committed an intent since tick's first check.
    return this.saved.pending;
  }
  start() {
    if (this.persistenceFault) return;
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      this.poll();
    }, 10_000);
    this.timer.unref();
    this.poll();
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  private poll() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    void this.tick()
      .catch(() => {
        this.publish(
          this.fields("blocked", "continuation-monitor-failed", this.saved.arm),
        );
      })
      .finally(() => {
        this.polling = false;
      });
  }
  private async serial<T>(action: () => Promise<T>): Promise<T> {
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
  private fields(
    status: DesktopContinuationSnapshot["status"],
    reason: string,
    arm?: DesktopContinuationArm,
    selectedTarget = false,
  ): DesktopContinuationSnapshot {
    return {
      status,
      reason,
      canArm: false,
      enabled: !!this.saved?.arm,
      executable: !this.contractReason(),
      checkedAt: new Date(this.now()).toISOString(),
      sourceId: arm?.source.profileId,
      targetId:
        arm?.targetSelection === "automatic" &&
        !selectedTarget &&
        !this.saved?.pending
          ? undefined
          : arm?.target.profileId,
      targetSelection: arm?.targetSelection,
      allowedTargetCount: arm?.allowedTargets?.length,
      sessionId: arm?.sessionId,
      projectKey: arm?.projectKey,
      permissionMode: arm?.permissionMode,
      requestId: this.saved?.pending?.id,
    };
  }
  private publish(value: DesktopContinuationSnapshot) {
    const previous = { ...this.view, checkedAt: undefined };
    this.view = value;
    if (
      JSON.stringify(previous) !==
      JSON.stringify({ ...value, checkedAt: undefined })
    )
      this.deps.changed?.();
    return this.snapshot();
  }
  private commit(update: (state: DesktopContinuationPersistentState) => void) {
    const next = structuredClone(this.saved);
    update(next);
    this.deps.persistence.save(next);
    this.saved = next;
  }
  private contractReason(
    policy?: DesktopContinuationArm["executionPolicy"],
    requireConsent = false,
  ) {
    if (this.persistenceFault) return "continuation-state-unreadable";
    const c = this.deps.capabilities;
    if (
      !c ||
      !["simulated", "verified-contract", "guarded-native"].includes(c.kind) ||
      !validText(c.contractId) ||
      ![
        c.exactSession,
        c.conditionalActions,
        c.deliveryLookup,
        c.checkpoint,
        c.accountSwitch,
        c.sessionReopen,
        c.targetedSend,
        c.deliveryReceipt,
      ].every((capability) => capability === true)
    )
      return "adapter-contract-unverified";
    if (c.kind === "guarded-native") {
      if (requireConsent && policy !== "guarded-native-at-most-once")
        return "guarded-native-policy-required";
    } else if (c.idempotentDelivery !== true || c.atomicContextGuard !== true)
      return "adapter-contract-unverified";
    return undefined;
  }
  private observationReason(observation: DesktopContinuationObservation) {
    if (observation.blockedReason) return observation.blockedReason;
    const s = observation.state,
      now = this.now();
    if (
      !s ||
      !validClock(s.observedAt) ||
      s.observedAt > now ||
      now - s.observedAt > 15_000
    )
      return "observation-not-fresh";
    if (
      !validClock(s.contextRevision) ||
      !validIdentity(s.identity) ||
      !UUID.test(s.session?.id ?? "") ||
      !validText(s.session?.projectKey) ||
      !validText(s.session?.transcriptRevision) ||
      !validText(s.session?.permissionMode)
    )
      return "exact-session-unverified";
    const source = this.deps
      .snapshot()
      .accounts.find((account) => account.id === s.identity.profileId);
    if (!enrolled(source) || !sameIdentity(identity(source), s.identity))
      return "identity-not-enrolled";
    return undefined;
  }
  /** Read-only observation: never arms, changes an account or sends a message. */
  inspect() {
    return this.serial(async () => {
      if (this.persistenceFault) return this.snapshot();
      try {
        const observation = await this.deps.observe();
        const reason = this.observationReason(observation);
        const arm = this.saved.arm ?? this.saved.pending?.arm;
        const value = {
          ...this.view,
          checkedAt: new Date(this.now()).toISOString(),
          canArm: !reason && !this.saved.pending,
          executable: !this.contractReason(),
          enabled: !!this.saved.arm,
          observationReason: reason ?? this.contractReason(),
        };
        if (!arm && !reason) {
          // A fresh unarmed check prepares a new authorization context. Do not
          // attach the previous completed badge/target to another conversation.
          value.status = "off";
          value.reason = "disabled";
          value.sourceId = observation.state.identity.profileId;
          value.targetId = undefined;
          value.targetSelection = undefined;
          value.allowedTargetCount = undefined;
          value.sessionId = observation.state.session.id;
          value.projectKey = observation.state.session.projectKey;
          value.permissionMode = observation.state.session.permissionMode;
          value.requestId = undefined;
        }
        return this.publish(value);
      } catch (error) {
        return this.publish({
          ...this.view,
          canArm: false,
          checkedAt: new Date(this.now()).toISOString(),
          observationReason: observationErrorReason(error),
        });
      }
    });
  }
  arm(input: {
    targetAccountId: string;
    executionPolicy?: "guarded-native-at-most-once";
  }) {
    return this.serial(async () => {
      if (this.persistenceFault)
        throw new Error("continuation-state-unreadable");
      if (this.saved.pending) throw new Error("unfinished-attempt");
      const observation = await this.deps.observe();
      const reason = this.observationReason(observation);
      if (reason) throw new Error(reason);
      if (
        this.deps.capabilities.kind === "guarded-native" &&
        input.executionPolicy !== "guarded-native-at-most-once"
      )
        throw new Error("guarded-native-policy-required");
      if (
        input.executionPolicy !== undefined &&
        input.executionPolicy !== "guarded-native-at-most-once"
      )
        throw new Error("invalid-execution-policy");
      const current = this.deps.snapshot();
      const automatic = input.targetAccountId === "automatic";
      const allowedTargets: ContinuationIdentity[] = [];
      if (automatic) {
        const seen = new Set<string>();
        for (const account of [...current.accounts].sort((a, b) =>
          a.id.localeCompare(b.id),
        )) {
          if (!enrolled(account)) continue;
          const candidate = identity(account);
          const key = `${candidate.accountUuid}:${candidate.orgId}`;
          if (
            candidate.profileId === observation.state.identity.profileId ||
            (candidate.accountUuid ===
              observation.state.identity.accountUuid.toLowerCase() &&
              candidate.orgId ===
                observation.state.identity.orgId.toLowerCase()) ||
            seen.has(key)
          )
            continue;
          seen.add(key);
          allowedTargets.push(candidate);
        }
        if (!allowedTargets.length || allowedTargets.length > 100)
          throw new Error("automatic-target-enrollment-unavailable");
      }
      const target = current.accounts.find(
        (account) =>
          account.id ===
          (automatic ? allowedTargets[0].profileId : input.targetAccountId),
      );
      if (!enrolled(target)) throw new Error("target-not-enrolled");
      if (
        sameIdentity(observation.state.identity, identity(target)) ||
        (observation.state.identity.accountUuid.toLowerCase() ===
          target.desktop.accountUuid.toLowerCase() &&
          observation.state.identity.orgId.toLowerCase() ===
            target.desktop.orgId.toLowerCase())
      )
        throw new Error("duplicate-identity");
      const arm: DesktopContinuationArm = {
        id: randomUUID(),
        armedAt: this.now(),
        source: structuredClone(observation.state.identity),
        target: identity(target),
        targetSelection: automatic ? "automatic" : undefined,
        allowedTargets: automatic ? allowedTargets : undefined,
        sessionId: observation.state.session.id.toLowerCase(),
        projectKey: observation.state.session.projectKey,
        permissionMode: observation.state.session.permissionMode,
        executionPolicy: input.executionPolicy,
      };
      this.commit((state) => {
        state.arm = arm;
      });
      return this.publish(
        this.fields(
          this.contractReason() ? "blocked" : "armed",
          this.contractReason() ?? "awaiting-quota-stop",
          arm,
        ),
      );
    });
  }
  disarm() {
    return this.serial(async () => {
      if (this.persistenceFault)
        throw new Error("continuation-state-unreadable");
      this.commit((state) => {
        state.arm = undefined;
      });
      return this.publish(
        this.saved.pending
          ? this.fields(
              "reconciliation-required",
              this.saved.pending.ownQuotaWakeup === "cancellation-intent"
                ? "own-quota-wakeup-uncertain"
                : "unfinished-attempt",
              this.saved.pending.arm,
            )
          : {
              status: "off",
              reason: "disabled",
              canArm: this.view.canArm,
              enabled: false,
              executable: !this.contractReason(),
              observationReason: this.view.observationReason,
            },
      );
    });
  }
  private armReason(
    arm: DesktopContinuationArm,
    observation: DesktopContinuationObservation,
  ) {
    const s = observation.state;
    if (!sameIdentity(arm.source, s.identity)) return "source-account-changed";
    if (
      s.session.id.toLowerCase() !== arm.sessionId ||
      s.session.projectKey !== arm.projectKey
    )
      return "selected-session-changed";
    if (s.session.permissionMode !== arm.permissionMode)
      return "permission-mode-changed";
    if (arm.targetSelection === "automatic") return undefined;
    const target = this.deps
      .snapshot()
      .accounts.find((account) => account.id === arm.target.profileId);
    if (!enrolled(target) || !sameIdentity(identity(target), arm.target))
      return "target-identity-changed";
    return undefined;
  }
  private automaticTarget(
    arm: DesktopContinuationArm,
    observation: DesktopContinuationObservation,
  ): DesktopContinuationArm | undefined {
    const snapshot = this.deps.snapshot();
    const eligible = snapshot.accounts.filter((target) => {
      if (!enrolled(target)) return false;
      const enrolledTarget = identity(target);
      if (
        !arm.allowedTargets?.some((allowed) =>
          sameIdentity(allowed, enrolledTarget),
        )
      )
        return false;
      const selected = { ...arm, target: enrolledTarget };
      return !continuationPolicyReason(
        this.request(this.attemptFor(selected, observation)),
        this.now(),
      );
    });
    const chosen = rankContinuationTargets(
      eligible.map((account) => ({
        account,
        usage: snapshot.usage[account.id],
      })),
    )[0];
    if (!chosen || !enrolled(chosen.account)) return undefined;
    return { ...arm, target: identity(chosen.account) };
  }
  private quotaReason(
    observation: DesktopContinuationObservation,
    allowOwnWakeup = false,
  ) {
    const s = observation.state,
      stop = observation.quotaStop,
      now = this.now();
    if (!stop) return "awaiting-quota-stop";
    if (
      stop.reason !== "rate-limit" ||
      stop.sessionId.toLowerCase() !== s.session.id.toLowerCase() ||
      !KEY.test(stop.turnId) ||
      stop.turnId !== s.session.lastTurnId ||
      !validClock(stop.observedAt) ||
      stop.observedAt > now ||
      now - stop.observedAt > 15_000
    )
      return "quota-stop-unverified";
    if (s.session.status !== "stopped") return "session-not-stopped";
    const q = s.quiescence;
    if (
      !q ||
      q.coverage !==
        (this.deps.capabilities.kind === "simulated"
          ? "isolated-all"
          : this.deps.capabilities.kind === "guarded-native"
            ? "guarded-local"
            : "verified-all")
    )
      return "coverage-unverified";
    for (const name of [
      "busyWorkers",
      "subagents",
      "pendingTasks",
      "waiting",
      "queuedPrompts",
      "scheduledWakeups",
      "unknownWork",
    ] as const)
      if (
        !validClock(q[name]) ||
        (q[name] !== 0 &&
          !(
            allowOwnWakeup &&
            observation.ownQuotaWakeup === true &&
            name === "scheduledWakeups" &&
            q[name] === 1
          ))
      )
        return `not-quiescent:${name}`;
    return undefined;
  }
  private attemptFor(
    arm: DesktopContinuationArm,
    observation: DesktopContinuationObservation,
  ): DesktopContinuationAttempt {
    return {
      id: randomUUID(),
      arm: structuredClone(arm),
      episodeKey: createHash("sha256")
        .update(
          JSON.stringify({
            source: arm.source,
            session: arm.sessionId,
            turn: observation.quotaStop!.turnId,
          }),
        )
        .digest("hex"),
      transcriptRevision: observation.state.session.transcriptRevision,
      expectedContextRevision: observation.state.contextRevision,
      turnId: observation.quotaStop!.turnId,
    };
  }
  private async prepareOwnWakeup(
    arm: DesktopContinuationArm,
    before: DesktopContinuationObservation,
  ): Promise<{
    observation: DesktopContinuationObservation;
    reason?: string;
    attempt?: DesktopContinuationAttempt;
  }> {
    const reason = this.quotaReason(before);
    if (
      reason !== "not-quiescent:scheduledWakeups" ||
      this.deps.capabilities.kind !== "guarded-native" ||
      arm.executionPolicy !== "guarded-native-at-most-once" ||
      before.ownQuotaWakeup !== true ||
      before.state.quiescence.scheduledWakeups !== 1
    )
      return { observation: before, reason };
    const otherWork = this.quotaReason(before, true);
    if (otherWork) return { observation: before, reason: otherWork };
    const provisional = this.attemptFor(arm, before);
    if (
      this.saved.completed.some(
        (episode) => episode.key === provisional.episodeKey,
      )
    )
      return { observation: before, reason: "quota-episode-already-continued" };
    const policy = continuationPolicyReason(
      this.request(provisional),
      this.now(),
    );
    if (policy) return { observation: before, reason: policy };
    if (!this.deps.prepareQuotaStop)
      return { observation: before, reason: "own-quota-wakeup-can-takeover" };
    // Cancellation itself changes Desktop. Record its exact source binding before
    // the UI mutation, so a crash or failed reread cannot silently lose its timer.
    provisional.ownQuotaWakeup = "cancellation-intent";
    this.commit((state) => {
      state.pending = provisional;
      state.arm = undefined;
    });
    const after = await this.deps.prepareQuotaStop(
      before,
      this.request(provisional),
    );
    const changed =
      this.observationReason(after) ??
      this.armReason(arm, after) ??
      (after.state.session.transcriptRevision !==
        before.state.session.transcriptRevision ||
      after.quotaStop?.turnId !== before.quotaStop?.turnId
        ? "quota-checkpoint-changed"
        : undefined) ??
      this.quotaReason(after);
    if (changed) return { observation: after, reason: changed };
    const prepared: DesktopContinuationAttempt = {
      ...provisional,
      expectedContextRevision: after.state.contextRevision,
      ownQuotaWakeup: "cancelled-verified",
    };
    this.commit((state) => {
      state.pending = prepared;
    });
    return { observation: after, attempt: prepared };
  }
  private request(attempt: DesktopContinuationAttempt): ContinuationRequest {
    const snapshot = this.deps.snapshot();
    const source = snapshot.accounts.find(
      (account) => account.id === attempt.arm.source.profileId,
    );
    const target = snapshot.accounts.find(
      (account) => account.id === attempt.arm.target.profileId,
    );
    if (
      !enrolled(source) ||
      !sameIdentity(identity(source), attempt.arm.source) ||
      !enrolled(target) ||
      !sameIdentity(identity(target), attempt.arm.target)
    )
      throw new Error("attempt-identity-changed");
    return {
      id: attempt.id,
      source,
      target,
      settings: snapshot.settings,
      usage: snapshot.usage,
      sessionId: attempt.arm.sessionId,
      projectKey: attempt.arm.projectKey,
      permissionMode: attempt.arm.permissionMode,
      transcriptRevision: attempt.transcriptRevision,
      expectedContextRevision: attempt.expectedContextRevision,
      authorized: true,
      executionPolicy: attempt.arm.executionPolicy,
    };
  }
  private async execute(attempt: DesktopContinuationAttempt, recovery = false) {
    this.publish(this.fields("executing", "checkpointed-handoff", attempt.arm));
    try {
      const result = await this.deps.engine.execute(this.request(attempt));
      if (result.status === "continued") {
        this.commit((state) => {
          if (
            !state.completed.some(
              (episode) => episode.key === attempt.episodeKey,
            )
          )
            state.completed.push({ key: attempt.episodeKey, at: this.now() });
          state.completed = state.completed.slice(-100);
          state.arm = undefined;
          state.pending = undefined;
        });
        return this.publish(
          this.fields("continued", result.reason, attempt.arm, true),
        );
      }
      if (
        result.status === "blocked" &&
        !result.record &&
        !recovery &&
        !attempt.ownQuotaWakeup
      ) {
        // A preflight rejection occurred before any durable host intent. Retry
        // only after gathering a new observation; retain no stale request.
        this.commit((state) => {
          state.pending = undefined;
        });
        return this.publish(this.fields("blocked", result.reason, attempt.arm));
      }
      this.commit((state) => {
        state.arm = undefined;
      });
      return this.publish(
        this.fields("reconciliation-required", result.reason, attempt.arm),
      );
    } catch {
      try {
        this.commit((state) => {
          state.arm = undefined;
        });
      } catch {
        this.stopped = true;
      }
      return this.publish(
        this.fields(
          "reconciliation-required",
          "attempt-interrupted",
          attempt.arm,
        ),
      );
    }
  }
  tick() {
    return this.serial(async () => {
      if (this.stopped) return this.snapshot();
      if (this.saved.pending)
        return this.publish(
          this.fields(
            "reconciliation-required",
            this.saved.pending.ownQuotaWakeup === "cancellation-intent"
              ? "own-quota-wakeup-uncertain"
              : "unfinished-attempt",
            this.saved.pending.arm,
          ),
        );
      const savedArm = this.saved.arm;
      if (!savedArm) return this.snapshot();
      let arm = savedArm;
      try {
        return await this.deps.withDesktopLock(async () => {
          try {
            if (this.deps.pendingAuth?.())
              return this.publish(
                this.fields("waiting", "browser-sign-in", arm),
              );
            let observation = await this.deps.observe();
            let preparedAttempt: DesktopContinuationAttempt | undefined;
            let reason =
              this.observationReason(observation) ??
              this.contractReason(arm.executionPolicy, true) ??
              this.armReason(arm, observation);
            if (!reason && arm.targetSelection === "automatic") {
              const allowOwnWakeup =
                this.deps.capabilities.kind === "guarded-native" &&
                arm.executionPolicy === "guarded-native-at-most-once" &&
                observation.ownQuotaWakeup === true;
              reason = this.quotaReason(observation, allowOwnWakeup);
              if (!reason) {
                const selected = this.automaticTarget(arm, observation);
                if (selected) arm = selected;
                else reason = "automatic-target-unavailable";
              }
            }
            if (!reason) {
              const prepared = await this.prepareOwnWakeup(arm, observation);
              observation = prepared.observation;
              reason = prepared.reason;
              preparedAttempt = prepared.attempt;
            }
            if (reason && this.saved.pending)
              return this.publish({
                ...this.fields(
                  "reconciliation-required",
                  "own-quota-wakeup-uncertain",
                  arm,
                ),
                observationReason: reason,
              });
            if (reason)
              return this.publish(
                this.fields(
                  reason === "awaiting-quota-stop" ||
                    reason === "automatic-target-unavailable" ||
                    reason === "session-not-stopped" ||
                    reason.startsWith("not-quiescent:")
                    ? "waiting"
                    : "blocked",
                  reason,
                  arm,
                ),
              );
            const attempt =
              preparedAttempt ?? this.attemptFor(arm, observation);
            if (
              this.saved.completed.some(
                (episode) => episode.key === attempt.episodeKey,
              )
            )
              return this.publish(
                this.fields("blocked", "quota-episode-already-continued", arm),
              );
            this.commit((state) => {
              state.pending = attempt;
            });
            return this.execute(attempt);
          } catch (error) {
            if (this.saved.pending)
              return this.publish({
                ...this.fields(
                  "reconciliation-required",
                  this.saved.pending.ownQuotaWakeup === "cancellation-intent"
                    ? "own-quota-wakeup-uncertain"
                    : "attempt-interrupted",
                  this.saved.pending.arm,
                ),
                observationReason: observationErrorReason(error),
              });
            return this.publish(
              this.fields("blocked", observationErrorReason(error), arm),
            );
          }
        });
      } catch {
        const pending = this.pendingAttempt();
        if (pending)
          return this.publish(
            this.fields(
              "reconciliation-required",
              pending.ownQuotaWakeup === "cancellation-intent"
                ? "own-quota-wakeup-uncertain"
                : "attempt-interrupted",
              pending.arm,
            ),
          );
        return this.publish(
          this.fields("blocked", "desktop-lock-unavailable", arm),
        );
      }
    });
  }
  /** An unfinished send is never automatically retried on an application restart. */
  resumePending() {
    return this.serial(async () => {
      if (this.persistenceFault)
        throw new Error("continuation-state-unreadable");
      if (!this.saved.pending) throw new Error("no-unfinished-attempt");
      if (this.saved.pending.ownQuotaWakeup === "cancellation-intent")
        return this.publish(
          this.fields(
            "reconciliation-required",
            "own-quota-wakeup-uncertain",
            this.saved.pending.arm,
          ),
        );
      return this.deps.withDesktopLock(() =>
        this.execute(this.saved.pending!, true),
      );
    });
  }
  /** Cancel only a durable, positively unsent intent; possible sends stay blocked. */
  abandonPending() {
    return this.serial(async () => {
      if (this.persistenceFault)
        throw new Error("continuation-state-unreadable");
      const pending = this.saved.pending;
      if (!pending) throw new Error("no-unfinished-attempt");
      if (!this.deps.engine.abandonUnsent)
        throw new Error("unsent-cancellation-unavailable");
      return this.deps.withDesktopLock(async () => {
        await this.deps.engine.abandonUnsent!(pending.id);
        this.commit((state) => {
          state.arm = undefined;
          state.pending = undefined;
        });
        return this.publish(
          this.fields("off", "user-cancelled-unsent", pending.arm),
        );
      });
    });
  }
}
