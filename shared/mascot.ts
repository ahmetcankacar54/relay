import type { Account, AccountUsage, DesktopState, UsageIssue, WindowAttempt } from "./types";
import { freshUsage, maxUsedPercent } from "./usage";

export type MascotPose = "alert" | "away" | "warming" | "sleeping" | "hungry" | "idle";
export type MascotHead = "idle" | "hungry" | "sleep" | "alert";

/** The parts of the tray snapshot the panda reads. */
export interface MascotInput {
  accounts: Account[];
  usage: Record<string, AccountUsage>;
  desktop?: DesktopState;
  /** The keeper's recent window starts. */
  attempts?: WindowAttempt[];
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
