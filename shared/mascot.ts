import type { Account, AccountUsage, DesktopState, UsageIssue, WindowAttempt } from "./types";
import { freshUsage, maxUsedPercent } from "./usage";

export type MascotPose = "alert" | "away" | "warming" | "sleeping" | "hungry" | "idle";
export type MascotCue = "rise" | "return" | "leave" | "stretch" | "munch" | "curl" | "rumble";
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

/** What the previous step saw, to detect one-off events. */
export interface MascotMemory {
  pose: MascotPose;
  /** The last known active profile. */
  active?: string;
  /** Set while Desktop is busy: the active profile when it became busy. */
  busyFrom?: { activeProfileId?: string };
  attempts: Record<string, WindowAttempt["status"]>;
  /** The last Desktop operation count seen. */
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

/**
 * One tray snapshot: its pose, the memory for the next step and at most one
 * one-off cue. The first step (no memory) only remembers, so old events do not
 * play when Relay opens.
 */
export function mascotStep(
  memory: MascotMemory | undefined,
  input: MascotInput,
  now = Date.now(),
): { memory: MascotMemory; pose: MascotPose; cue?: MascotCue } {
  const pose = mascotPose(input, now);
  const desktop = input.desktop;
  const busy = !!desktop?.busy;
  const active = desktop ? desktop.activeProfileId : memory?.active;
  const attempts: MascotMemory["attempts"] = {};
  for (const a of input.attempts ?? []) attempts[a.id] = a.status;
  const operations = input.desktopOperations ?? memory?.desktopOperations;
  // An operation began since the last step, even if no snapshot saw it busy.
  const began =
    memory?.desktopOperations !== undefined &&
    operations !== undefined &&
    operations > memory.desktopOperations;
  // Desktop files change during a switch, so compare with the account from
  // before it began, not with the previous snapshot.
  const busyFrom =
    memory?.busyFrom ?? (memory && began ? { activeProfileId: memory.active } : undefined);
  const next: MascotMemory = {
    pose,
    active,
    busyFrom: busy ? (busyFrom ?? { activeProfileId: memory ? memory.active : active }) : undefined,
    attempts,
    desktopOperations: operations,
  };
  if (!memory) return { memory: next, pose };
  // An operation that began and ended between two steps counts as finished.
  const returned =
    !!busyFrom &&
    !busy &&
    !!desktop?.activeProfileId &&
    desktop.activeProfileId !== busyFrom.activeProfileId;
  const left = !memory.busyFrom && busy && pose === "away";
  const warmed = (input.attempts ?? []).some(
    (a) =>
      (a.status === "verified" || a.status === "sent-unverified") &&
      (memory.attempts[a.id] === undefined || memory.attempts[a.id] === "started"),
  );
  const fed =
    (memory.pose === "hungry" || memory.pose === "sleeping") &&
    pose === "idle" &&
    !busy &&
    !memory.busyFrom &&
    !!desktop &&
    active === memory.active;
  const cue: MascotCue | undefined =
    pose === "alert" && memory.pose !== "alert"
      ? "rise"
      : returned
        ? "return"
        : left
          ? "leave"
          : warmed
            ? "stretch"
            : fed
              ? "munch"
              : pose === "sleeping" && memory.pose !== "sleeping"
                ? "curl"
                : pose === "hungry" && memory.pose !== "hungry"
                  ? "rumble"
                  : undefined;
  return { memory: next, pose, cue };
}

/** The panel header head: leaving and warming play in the menu bar only. */
export function headFor(pose: MascotPose): MascotHead {
  return pose === "alert"
    ? "alert"
    : pose === "sleeping"
      ? "sleep"
      : pose === "hungry"
        ? "hungry"
        : "idle";
}
