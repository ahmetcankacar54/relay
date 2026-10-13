import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  Account,
  AccountUsage,
  KeeperAccountStatus,
  KeeperSnapshot,
  PlanningSettings,
  WindowAttempt,
} from "../../shared/types";
import { localDate, planningIdentity } from "../../shared/planning";
import {
  dayPlan,
  nextPlannedStart,
  shouldHaveWindow,
} from "../../shared/day-plan";
import {
  privateJournalDirectory,
  readPrivateJson,
  writePrivateJson,
} from "./continuation-journal";

export const KEEPER_TICK_MS = 60_000;
export const KEEPER_COOLDOWN_MS = 15 * 60_000;
export const KEEPER_DAILY_LIMIT = 8;
const FRESH_MS = 5 * 60_000;
const NOTIFY_MS = 60 * 60_000;
/**
 * Refusals that repeat on every attempt (administrator policy, an unsupported
 * system or CLI). They stop the account until the plan changes.
 */
export const KEEPER_STOP_REASONS = new Set([
  "routine-policy-unverified",
  "routine-platform-unsupported",
  "routine-cli-unavailable",
  "routine-cli-unsupported",
]);

export interface KeeperState {
  settings: PlanningSettings;
  accounts: Account[];
  usage: Record<string, AccountUsage>;
  /** Another Relay operation owns Claude or a sign-in is in progress. */
  blocked: boolean;
  /** Accounts with a running Relay CLI session. */
  busyAccountIds: string[];
}
export interface KeeperDeps {
  directory: string;
  now?: () => number;
  state(): KeeperState;
  refresh(accountId: string): Promise<unknown>;
  refreshAfterStart(accountId: string): Promise<AccountUsage>;
  /** Sends the isolated window-start message; throws a sanitized reason. */
  start(account: Account): Promise<void>;
  notify?(account: Account, reason: string): void;
  changed(): void;
}
type Decision = KeeperAccountStatus & { refresh?: boolean };

/** Planned accounts that still exist in Relay; deleted ones take no slot. */
function planned(state: Pick<KeeperState, "settings" | "accounts">) {
  const ids = new Set(state.accounts.map((a) => a.id));
  return {
    ...state.settings,
    accounts: state.settings.accounts.filter((a) => ids.has(a.id)),
  };
}

function fresh(usage: AccountUsage | undefined, now: number) {
  const checked = Date.parse(usage?.checkedAt ?? "");
  return (
    !!usage &&
    usage.status === "ready" &&
    !usage.stale &&
    Number.isFinite(checked) &&
    now - checked <= FRESH_MS
  );
}
/** What the keeper should do for one planned account right now. */
export function keeperDecision(
  account: Account,
  usage: AccountUsage | undefined,
  settings: PlanningSettings,
  attempts: WindowAttempt[],
  now: number,
  busy: boolean,
  stopped?: string,
): Decision {
  const base = { accountId: account.id };
  if (!settings.autoStart) return { ...base, state: "off" };
  const identity = planningIdentity(account);
  if (!identity) return { ...base, state: "blocked", reason: "identity" };
  if (stopped) return { ...base, state: "blocked", reason: stopped };
  if (!shouldHaveWindow(account.id, now, settings)) {
    const next = nextPlannedStart(account.id, now, settings);
    return {
      ...base,
      state: "outside",
      ...(next ? { nextStartAt: new Date(next).toISOString() } : {}),
    };
  }
  if (!fresh(usage, now))
    return { ...base, state: "waiting", reason: "usage-stale", refresh: true };
  const reset = Date.parse(usage!.fiveHour?.resetsAt ?? "");
  if (Number.isFinite(reset) && reset > now)
    return {
      ...base,
      state: "active",
      resetsAt: new Date(reset).toISOString(),
    };
  if ((usage!.sevenDay?.usedPercent ?? 0) >= 100)
    return { ...base, state: "blocked", reason: "weekly-limit" };
  if (busy) return { ...base, state: "waiting", reason: "in-use" };
  const mine = attempts.filter((a) => a.identityKey === identity);
  const today = localDate(now, settings.timeZone);
  if (
    mine.filter((a) => localDate(Date.parse(a.at), settings.timeZone) === today)
      .length >= KEEPER_DAILY_LIMIT
  )
    return { ...base, state: "blocked", reason: "daily-limit" };
  // A timestamp in the future (clock moved back) does not block for hours.
  const recent = mine.some((a) => {
    const time = Date.parse(a.at);
    return time <= now && now - time < KEEPER_COOLDOWN_MS;
  });
  if (recent) return { ...base, state: "waiting", reason: "cooldown" };
  return { ...base, state: "due" };
}

/**
 * Keeps each planned account's five-hour window running from its first warm-up
 * until work ends, starting at most one window per tick.
 */
export class WindowKeeper {
  private attempts: WindowAttempt[] = [];
  private statuses: KeeperAccountStatus[] = [];
  private running = false;
  private timer?: ReturnType<typeof setInterval>;
  private notified = new Map<string, number>();
  /** Identity → the refusal that stopped it; cleared when the plan changes. */
  private stopped = new Map<string, string>();
  private readonly file: string;
  private readonly now: () => number;
  constructor(private readonly deps: KeeperDeps) {
    this.now = deps.now ?? Date.now;
    privateJournalDirectory(deps.directory);
    this.file = path.join(deps.directory, "attempts.json");
    try {
      const saved = readPrivateJson(this.file) as {
        version?: number;
        attempts?: WindowAttempt[];
      };
      if (saved?.version === 1 && Array.isArray(saved.attempts))
        this.attempts = saved.attempts;
    } catch {
      // First run or unreadable log: start empty.
    }
    // A send that may have happened when Relay stopped is never repeated.
    let interrupted = false;
    for (const attempt of this.attempts)
      if (attempt.status === "started") {
        attempt.status = "failed";
        attempt.reason = "interrupted";
        interrupted = true;
      }
    if (interrupted) this.persist();
    // A stop survives restarts: the newest attempt per identity decides.
    for (const attempt of this.attempts)
      if (
        attempt.status === "failed" &&
        KEEPER_STOP_REASONS.has(attempt.reason ?? "")
      )
        this.stopped.set(attempt.identityKey, attempt.reason!);
      else this.stopped.delete(attempt.identityKey);
  }
  private persist() {
    this.attempts = this.attempts.slice(-200);
    writePrivateJson(this.file, { version: 1, attempts: this.attempts });
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), KEEPER_TICK_MS);
    this.timer.unref();
    void this.tick();
  }
  /** The plan changed: try stopped accounts again. */
  resume() {
    this.stopped.clear();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  snapshot(): KeeperSnapshot {
    const settings = planned(this.deps.state());
    const now = this.now();
    const today = dayPlan(localDate(now, settings.timeZone), settings);
    const upcoming = this.statuses
      .map((s) => ({ accountId: s.accountId, at: s.nextStartAt ?? s.resetsAt }))
      .filter((s): s is { accountId: string; at: string } => !!s.at)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
    return {
      enabled: settings.autoStart,
      running: this.running,
      accounts: structuredClone(this.statuses),
      attempts: structuredClone(this.attempts.slice(-20).reverse()),
      plannedToday: today.accounts.reduce((n, a) => n + a.windows.length, 0),
      ...(upcoming ? { next: upcoming } : {}),
    };
  }
  private evaluate(state: KeeperState) {
    const now = this.now();
    const settings = planned(state);
    return settings.accounts
      .map(({ id }) => state.accounts.find((a) => a.id === id)!)
      .map((account) =>
        keeperDecision(
          account,
          state.usage[account.id],
          settings,
          this.attempts,
          now,
          state.busyAccountIds.includes(account.id),
          this.stopped.get(planningIdentity(account) ?? ""),
        ),
      );
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      let state = this.deps.state();
      let decisions = this.evaluate(state);
      if (state.settings.autoStart && !state.blocked) {
        const stale = decisions.filter((d) => d.refresh);
        for (const d of stale)
          await this.deps.refresh(d.accountId).catch(() => {});
        if (stale.length) {
          state = this.deps.state();
          decisions = this.evaluate(state);
        }
        const due = decisions.find((d) => d.state === "due");
        if (due && !state.blocked) {
          await this.startOne(
            state.accounts.find((a) => a.id === due.accountId)!,
          );
          state = this.deps.state();
          decisions = this.evaluate(state);
        }
      }
      this.statuses = decisions.map(({ refresh, ...status }) =>
        state.blocked && status.state === "due"
          ? { ...status, state: "waiting" as const, reason: "relay-busy" }
          : status,
      );
    } finally {
      this.running = false;
      this.deps.changed();
    }
  }
  private async startOne(account: Account) {
    const attempt: WindowAttempt = {
      id: randomUUID(),
      accountId: account.id,
      identityKey: planningIdentity(account)!,
      at: new Date(this.now()).toISOString(),
      status: "started",
    };
    this.attempts.push(attempt);
    this.persist();
    try {
      await this.deps.start(account);
      const after = await this.deps
        .refreshAfterStart(account.id)
        .catch(() => undefined);
      const reset = Date.parse(after?.fiveHour?.resetsAt ?? "");
      if (Number.isFinite(reset) && reset > this.now()) {
        attempt.status = "verified";
        attempt.resetAt = new Date(reset).toISOString();
      } else attempt.status = "sent-unverified";
    } catch (error) {
      attempt.status = "failed";
      attempt.reason =
        error instanceof Error ? error.message : "routine-request-failed";
      if (KEEPER_STOP_REASONS.has(attempt.reason))
        this.stopped.set(attempt.identityKey, attempt.reason);
      const last = this.notified.get(account.id) ?? -Infinity;
      if (this.now() - last >= NOTIFY_MS) {
        this.notified.set(account.id, this.now());
        this.deps.notify?.(account, attempt.reason);
      }
    }
    this.persist();
  }
}
