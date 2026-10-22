import type { Account, AccountUsage, DesktopState, UsageIssue, WindowAttempt } from "./types";
import { desktopCliMismatch, displayedIssue } from "./account-state";
import { percentUsed } from "./percent";
import { freshUsage, maxUsedPercent } from "./usage";

export type MascotPose = "alert" | "away" | "warming" | "sleeping" | "full" | "hungry" | "idle";
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
/** The percent used from which the menu bar title also counts down to the five-hour reset. */
export const HUNGRY_PERCENT = 80;
/** A reading of the active account older than this no longer counts: the panda sleeps and the title shows "—". */
export const READING_MAX_AGE_MS = 30 * 60_000;
const SIGN_IN_ISSUES: ReadonlySet<UsageIssue> = new Set([
  "keychain-locked",
  "renewal-required",
  "expired",
  "identity-mismatch",
]);

/**
 * The Desktop-active account's reading while it still counts: fresh and under READING_MAX_AGE_MS old. A
 * refresh in progress keeps the reading it started from, so the menu bar does not flicker while it runs.
 */
export function activeReading(input: MascotInput, now = Date.now()): AccountUsage | undefined {
  const id = input.desktop?.activeProfileId;
  const u = id ? input.usage[id] : undefined;
  if (!u) return undefined;
  const reading: AccountUsage = u.status === "loading" ? { ...u, status: "ready" } : u;
  if (!freshUsage(reading, now)) return undefined;
  const age = now - Date.parse(reading.checkedAt!);
  return age >= -60_000 && age < READING_MAX_AGE_MS ? reading : undefined;
}

/**
 * Why the menu bar panda sleeps, if it does: Claude is closed, or the active account's limits are not
 * known (its reading failed or is too old). Before the first reading has finished, with no saved
 * account active, and between a window's reset and the reading after it, it does not.
 */
export function mascotRest(input: MascotInput, now = Date.now()): "closed" | "unknown" | undefined {
  const { desktop } = input;
  if (!desktop) return undefined;
  if (!desktop.running) return "closed";
  const id = desktop.activeProfileId;
  if (!id) return undefined;
  const u = input.usage[id];
  if (!u || (!u.checkedAt && (u.status === "idle" || u.status === "loading"))) return undefined;
  if (activeReading(input, now)) return undefined;
  const age = now - Date.parse(u.checkedAt ?? "");
  return u.status === "error" || u.stale || !(age < READING_MAX_AGE_MS) ? "unknown" : undefined;
}

/** The active account's five-hour window is used up. */
export function activeFull(input: MascotInput, now = Date.now()) {
  return percentUsed(activeReading(input, now)?.fiveHour?.usedPercent) === 100;
}

/** The pose for one snapshot; the first matching rule wins. */
export function mascotPose(input: MascotInput, now = Date.now()): MascotPose {
  const { desktop, accounts, usage } = input;
  const activeId = desktop?.activeProfileId;
  const active = activeId ? usage[activeId] : undefined;
  // The issue every surface shows: a flag left under a rate-limit or an outage is no sign-in problem.
  const issue = displayedIssue(active);
  if (desktop && (desktop.recoveryRequired || !!desktop.error || !desktop.available))
    return "alert";
  if (issue && SIGN_IN_ISSUES.has(issue)) return "alert";
  // A usage sign-in of another account is a sign-in problem, whatever its last read says.
  const activeAccount = activeId
    ? accounts.find((a) => a.id === activeId)
    : undefined;
  if (activeAccount && desktopCliMismatch(activeAccount)) return "alert";
  if (desktop?.busy) return "away";
  if (
    input.attempts?.some((a) => {
      const at = Date.parse(a.at);
      return a.status === "started" && at <= now && now - at < WARMING_MS;
    })
  )
    return "warming";
  if (mascotRest(input, now)) return "sleeping";
  // The active account's five-hour window is used up, or every account is known to be full.
  if (
    activeFull(input, now) ||
    (accounts.length > 0 &&
      accounts.every((a) => {
        const u = usage[a.id];
        return freshUsage(u, now) && (maxUsedPercent(u) ?? 0) >= 100;
      }))
  )
    return "full";
  const used = percentUsed(activeReading(input, now)?.fiveHour?.usedPercent);
  if (used !== undefined && used >= HUNGRY_PERCENT) return "hungry";
  return "idle";
}

/** The panel header head. Leaving and warming show the normal head; a full window the wide eyes. */
export function headFor(pose: MascotPose): MascotHead {
  return pose === "alert"
    ? "alert"
    : pose === "sleeping"
      ? "sleep"
      : pose === "hungry" || pose === "full"
        ? "hungry"
        : "idle";
}
