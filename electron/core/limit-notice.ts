import type { Account, AccountUsage, RelaySettings, UsageWindow } from "../../shared/types";

export type LimitWindowKind = "five_hour" | "seven_day";

export type LimitNoticeDeps = {
  settings: () => Pick<RelaySettings, "usageWarnings" | "usageWarningPercent">;
  /** The account the Claude app is signed in to now: only its limits are worth a notification. */
  inUse: () => string | undefined;
  notify: (account: Account, kind: LimitWindowKind, window: UsageWindow) => void;
};

/** How far under the threshold a window must fall before it can tell again: in practice, its reset. */
export const REARM_MARGIN = 10;

/**
 * Tells once when the account in use crosses the warning threshold in its 5-hour or weekly window.
 * Only a crossing counts: a reading already past the threshold when Relay starts, or when the user
 * switches to that account, says nothing, so a restart never repeats a notification.
 *
 * Once told, a window tells again only after it falls well under the threshold (its reset). A
 * gateway answer (a fraction) and a later poll (whole, sometimes older) can disagree by a point
 * around the threshold; that must not read as a second crossing. Reset times are not compared:
 * they drift by seconds between reads.
 */
export class LimitNotices {
  /** Per account and window: whether a crossing would tell now. */
  private armed = new Map<string, boolean>();

  constructor(private deps: LimitNoticeDeps) {}

  observe(account: Account, usage: AccountUsage) {
    const settings = this.deps.settings();
    const threshold = settings.usageWarningPercent;
    const watched = settings.usageWarnings && this.deps.inUse() === account.id;
    const windows: [LimitWindowKind, UsageWindow | undefined][] = [
      ["five_hour", usage.fiveHour],
      ["seven_day", usage.sevenDay],
    ];
    for (const [kind, window] of windows) {
      if (!window) continue;
      const key = `${account.id}:${kind}`;
      const armed = this.armed.get(key);
      const used = window.usedPercent;
      if (armed === undefined) {
        // The first reading only arms: under the threshold it can tell later, past it it cannot.
        this.armed.set(key, used < threshold);
      } else if (used < threshold - REARM_MARGIN) {
        this.armed.set(key, true);
      } else if (armed && used >= threshold) {
        // Disarmed whether told or not: an account crossing while not in use says nothing later.
        this.armed.set(key, false);
        if (watched) this.deps.notify(account, kind, window);
      }
    }
  }
}
