import type { Account, AccountUsage, RelaySettings, UsageWindow } from "../../shared/types";
import { notificationSettings } from "../../shared/notifications";
import { readPrivateJson, writePrivateJson } from "./continuation-journal";

export type LimitWindowKind = "five_hour" | "seven_day";

export type LimitNoticeDeps = {
  settings: () => Pick<RelaySettings, "usageWarnings" | "usageWarningPercent" | "notifications">;
  /** The account the Claude app is signed in to now: only its limits are worth a warning. */
  inUse: () => string | undefined;
  notify: (account: Account, kind: LimitWindowKind, window: UsageWindow) => void;
  /** Says that a window which reached the warning threshold has reset: the account is ready again. */
  ready: (account: Account, kind: LimitWindowKind) => void;
  /**
   * Where the resets awaited and told are kept (userData/limit-notices.json), so a restart neither
   * repeats a "ready again" nor forgets a window that filled before it. None keeps them in memory.
   */
  file?: () => string;
  now?: () => number;
};

/** How far under the threshold a window must fall before it can tell again: in practice, its reset. */
export const REARM_MARGIN = 10;
/** Reset times drift by seconds to minutes between reads; within this they name the same reset. */
export const SAME_RESET_MS = 15 * 60_000;
/** A reset noticed later than this after it happened (Relay was closed or asleep) is old news and not told. */
export const READY_FRESH_MS = 60 * 60_000;
/** Windows remembered at most; removed accounts' entries fall out first. */
const MAX_WINDOWS = 400;

/** Per account and window: the reset awaited since it reached the threshold, and the last one told or passed. */
type ResetMemory = { awaiting?: string; told?: string };

/**
 * The notices about the 5-hour and weekly limits.
 *
 * The warning tells once when the account in use crosses the warning threshold. Only a crossing
 * counts: a reading already past the threshold when Relay starts, or when the user switches to that
 * account, says nothing, so a restart never repeats it. Once told, a window tells again only after
 * it falls well under the threshold (its reset). A gateway answer (a fraction) and a later poll
 * (whole, sometimes older) can disagree by a point around the threshold; that must not read as a
 * second crossing. Reset times are not compared: they drift by seconds between reads.
 *
 * "Ready again" tells once when a window that reached the threshold resets. The reset awaited and the
 * last reset told are saved, so a restart does not tell it twice, and an older poll still showing
 * the full window after the reset does not await it again.
 */
export class LimitNotices {
  /** Per account and window: whether a crossing would tell now. */
  private armed = new Map<string, boolean>();
  private memory?: Map<string, ResetMemory>;

  constructor(private deps: LimitNoticeDeps) {}

  observe(account: Account, usage: AccountUsage) {
    const settings = this.deps.settings();
    const choices = notificationSettings(settings);
    const threshold = settings.usageWarningPercent;
    const inUse = this.deps.inUse() === account.id;
    const windows: [LimitWindowKind, UsageWindow | undefined, boolean][] = [
      ["five_hour", usage.fiveHour, choices.limitFiveHour],
      ["seven_day", usage.sevenDay, choices.limitWeekly],
    ];
    for (const [kind, window, enabled] of windows) {
      if (!window) continue;
      const key = `${account.id}:${kind}`;
      this.warn(account, kind, window, key, threshold, enabled && settings.usageWarnings && inUse);
      const readyFor = choices.limitReset === "all" || (choices.limitReset === "in-use" && inUse);
      this.watchReset(account, kind, window, key, threshold, enabled && readyFor);
    }
  }

  private warn(account: Account, kind: LimitWindowKind, window: UsageWindow, key: string, threshold: number, watched: boolean) {
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

  private watchReset(account: Account, kind: LimitWindowKind, window: UsageWindow, key: string, threshold: number, tell: boolean) {
    const memory = this.load();
    const state = memory.get(key) ?? {};
    const resetAt = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
    const told = state.told ? Date.parse(state.told) : -Infinity;
    const awaiting = state.awaiting ? Date.parse(state.awaiting) : undefined;
    if (window.usedPercent >= threshold) {
      // Without a reset time there is no reset to wait for; one already told is an older reading.
      if (!Number.isFinite(resetAt) || resetAt <= told + SAME_RESET_MS) return;
      if (awaiting !== undefined && Math.abs(resetAt - awaiting) < SAME_RESET_MS) return;
      this.save(key, { ...state, awaiting: new Date(resetAt).toISOString() });
      return;
    }
    if (awaiting === undefined || window.usedPercent >= threshold - REARM_MARGIN) return;
    const now = this.deps.now?.() ?? Date.now();
    // Well under the threshold: a reset once its time came, or earlier when a later window began.
    const reset = now >= awaiting - SAME_RESET_MS || (Number.isFinite(resetAt) && resetAt > awaiting + SAME_RESET_MS);
    if (!reset) return;
    // Saved before telling: a failed notification must not tell again after a restart.
    this.save(key, { told: state.awaiting });
    if (tell && now - awaiting <= READY_FRESH_MS) this.deps.ready(account, kind);
  }

  private load() {
    if (this.memory) return this.memory;
    this.memory = new Map();
    if (!this.deps.file) return this.memory;
    try {
      const saved = readPrivateJson(this.deps.file()) as { windows?: Record<string, unknown> };
      for (const [key, value] of Object.entries(saved?.windows ?? {})) {
        if (!value || typeof value !== "object") continue;
        const { awaiting, told } = value as Record<string, unknown>;
        const entry: ResetMemory = {};
        if (typeof awaiting === "string" && Number.isFinite(Date.parse(awaiting))) entry.awaiting = awaiting;
        if (typeof told === "string" && Number.isFinite(Date.parse(told))) entry.told = told;
        this.memory.set(key, entry);
      }
    } catch {
      // Missing (a first run) or unreadable: start empty; the worst case is one missed "ready again".
    }
    return this.memory;
  }

  private save(key: string, entry: ResetMemory) {
    const memory = this.load();
    memory.delete(key);
    memory.set(key, entry);
    while (memory.size > MAX_WINDOWS) memory.delete(memory.keys().next().value!);
    if (!this.deps.file) return;
    try {
      writePrivateJson(this.deps.file(), { version: 1, windows: Object.fromEntries(memory) });
    } catch {
      // Kept in memory: a failed write must not stop the usage reading that called here.
    }
  }
}
