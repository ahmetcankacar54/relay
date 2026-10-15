import type { Account, AccountUsage, DesktopState, UsageIssue, WindowAttempt } from "./types";
import { freshUsage, maxUsedPercent } from "./usage";

export type MascotPose = "alert" | "away" | "warming" | "sleeping" | "hungry" | "idle";
/** What a Desktop operation did; drives the switch window. */
export type DesktopEvent = "left" | "switched" | "back" | "failed";
export type MascotHead = "idle" | "hungry" | "sleep" | "alert";

/** The parts of the tray snapshot the panda reads. */
export interface MascotInput {
  accounts: Account[];
  usage: Record<string, AccountUsage>;
  desktop?: DesktopState;
  /** The keeper's recent window starts. */
  attempts?: WindowAttempt[];
  /**
   * How many Desktop operations have begun since Relay opened. It only grows, so
   * an operation that began and ended between two snapshots is not missed.
   */
  desktopOperations?: number;
}

/** A "started" attempt older than this was interrupted, not warming. */
export const WARMING_MS = 2 * 60_000;
/** Same threshold the menu bar title used for its warning. */
export const HUNGRY_PERCENT = 90;
const SIGN_IN_ISSUES: ReadonlySet<UsageIssue> = new Set([
  "renewal-required",
  "expired",
  "identity-mismatch",
]);

/** The pose for one snapshot; the first matching rule wins. */
export function mascotPose(input: MascotInput, now = Date.now()): MascotPose {
  const { desktop, accounts, usage } = input;
  const activeId = desktop?.activeProfileId;
  const active = activeId ? usage[activeId] : undefined;
  if (desktop && (desktop.recoveryRequired || !!desktop.error || !desktop.available))
    return "alert";
  if (active && (active.connectionRenewalRequired || (!!active.issue && SIGN_IN_ISSUES.has(active.issue))))
    return "alert";
  if (desktop?.busy) return "away";
  if (
    input.attempts?.some((a) => {
      const at = Date.parse(a.at);
      return a.status === "started" && at <= now && now - at < WARMING_MS;
    })
  )
    return "warming";
  if (
    accounts.length > 0 &&
    accounts.every((a) => {
      const u = usage[a.id];
      return freshUsage(u, now) && (maxUsedPercent(u) ?? 0) >= 100;
    })
  )
    return "sleeping";
  if (freshUsage(active, now) && active.fiveHour && Math.round(active.fiveHour.usedPercent) >= HUNGRY_PERCENT)
    return "hungry";
  return "idle";
}

/** The Desktop state from before an operation began. */
interface OperationStart {
  activeProfileId?: string;
  errorRevision?: number;
  recoveryRequired?: boolean;
  /** The operation was already open at the first step: its start was never seen, so its end is not reported. */
  unseen?: boolean;
}

/** What the previous step saw, to detect Desktop operations. */
export interface MascotMemory {
  pose: MascotPose;
  /** The last known active profile, error revision and recovery flag. */
  active?: string;
  errorRevision?: number;
  recoveryRequired?: boolean;
  /** Set while a Desktop operation is open: the state from before it began. */
  busyFrom?: OperationStart;
  /** The last Desktop operation count seen. */
  desktopOperations?: number;
}

/**
 * One tray snapshot: its pose, the memory for the next step and at most one
 * Desktop event. The first step only remembers, so an operation already
 * running when Relay opens reports nothing: neither its start nor its end.
 */
export function mascotStep(
  memory: MascotMemory | undefined,
  input: MascotInput,
  now = Date.now(),
): { memory: MascotMemory; pose: MascotPose; event?: DesktopEvent } {
  const pose = mascotPose(input, now);
  const desktop = input.desktop;
  const busy = !!desktop?.busy;
  // Desktop files change during a switch, so an operation is judged against the
  // state from before it began, not against the previous snapshot.
  const before: OperationStart = memory
    ? { activeProfileId: memory.active, errorRevision: memory.errorRevision, recoveryRequired: memory.recoveryRequired }
    : {
        activeProfileId: desktop?.activeProfileId,
        errorRevision: desktop?.errorRevision,
        recoveryRequired: desktop?.recoveryRequired,
      };
  const operations = input.desktopOperations ?? memory?.desktopOperations;
  // An operation began since the last step, even if no snapshot saw it busy.
  const began =
    memory?.desktopOperations !== undefined &&
    operations !== undefined &&
    operations > memory.desktopOperations;
  // An operation first seen already open (no memory) has an unknown start: mark it unseen.
  const open = memory?.busyFrom ?? (busy || began ? (memory ? before : { ...before, unseen: true }) : undefined);
  const next: MascotMemory = {
    pose,
    active: desktop ? desktop.activeProfileId : memory?.active,
    errorRevision: desktop ? desktop.errorRevision : memory?.errorRevision,
    recoveryRequired: desktop ? desktop.recoveryRequired : memory?.recoveryRequired,
    // Without Desktop state the operation may still be running: keep it open.
    busyFrom: busy || !desktop ? open : undefined,
    desktopOperations: operations,
  };
  if (!memory) return { memory: next, pose };
  let event: DesktopEvent | undefined;
  if (busy && !memory.busyFrom) event = "left";
  else if (!busy && desktop && open && !open.unseen) {
    const failed =
      (!!desktop.error && desktop.errorRevision > (open.errorRevision ?? -1)) ||
      (desktop.recoveryRequired && !open.recoveryRequired);
    event = failed
      ? "failed"
      : desktop.activeProfileId && desktop.activeProfileId !== open.activeProfileId
        ? "switched"
        : "back";
  }
  return { memory: next, pose, event };
}

/** The panel header head. Leaving and warming show the normal head. */
export function headFor(pose: MascotPose): MascotHead {
  return pose === "alert"
    ? "alert"
    : pose === "sleeping"
      ? "sleep"
      : pose === "hungry"
        ? "hungry"
        : "idle";
}
