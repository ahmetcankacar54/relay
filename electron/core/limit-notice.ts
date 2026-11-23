import type { Account, AccountUsage, RelaySettings, UsageWindow } from "../../shared/types";

export type LimitWindowKind = "five_hour" | "seven_day";

export type LimitNoticeDeps = {
  settings: () => Pick<RelaySettings, "usageWarnings" | "usageWarningPercent">;
  /** The account the Claude app is signed in to now: only its limits are worth a notification. */
  inUse: () => string | undefined;
  notify: (account: Account, kind: LimitWindowKind, window: UsageWindow) => void;
};

/**
 * Tells once when the account in use crosses the warning threshold in its 5-hour or weekly window.
 * Only a crossing counts: a reading already past the threshold when Relay starts, or when the user
 * switches to that account, says nothing, so a restart never repeats a notification. A window that
 * falls back under the threshold (its reset) can tell again.
 */
export class LimitNotices {
  /** The last used percent per account and window. */
  private last = new Map<string, number>();

  constructor(private deps: LimitNoticeDeps) {}

  observe(account: Account, usage: AccountUsage) {
    const settings = this.deps.settings();
    const watched = settings.usageWarnings && this.deps.inUse() === account.id;
    const windows: [LimitWindowKind, UsageWindow | undefined][] = [
      ["five_hour", usage.fiveHour],
      ["seven_day", usage.sevenDay],
    ];
    for (const [kind, window] of windows) {
      const key = `${account.id}:${kind}`;
      const before = this.last.get(key);
      if (!window) continue;
      this.last.set(key, window.usedPercent);
      if (!watched || before === undefined) continue;
      // A reset brings the window back under the threshold, which arms it again. Reset times are
      // not compared: they drift by seconds between reads.
      const threshold = settings.usageWarningPercent;
      if (before < threshold && window.usedPercent >= threshold) this.deps.notify(account, kind, window);
    }
  }
}
