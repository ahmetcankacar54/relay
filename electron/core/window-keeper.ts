import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  Account,
  AccountUsage,
  KeeperAccountStatus,
  KeeperAdaptation,
  KeeperSnapshot,
  PlanningSettings,
  WindowAttempt,
} from "../../shared/types";
import { displayedIssue } from "../../shared/account-state";
import { localDate, planningIdentity } from "../../shared/planning";
import {
  dayPlan,
  nextPlannedStart,
  planContext,
  shouldHaveWindow,
  type PlanContext,
} from "../../shared/day-plan";
import type { Tempo } from "../../shared/tempo";
import type { UsageSample } from "../../shared/usage-statistics";
import { AdaptiveSchedule, type AdaptiveResult } from "./adaptive-schedule";
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
const TRANSIENT_ISSUES = new Set(["rate-limited", "unavailable"]);
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
  /** What the plan assumes about the work pace (learned or chosen). */
  tempo: Tempo;
  /** Another Relay operation owns Claude or a sign-in is in progress. */
  blocked: boolean;
  /** Accounts with a running Relay CLI session. */
  busyAccountIds: string[];
  /** Raw usage samples of the last hour: today's pace. */
  recentSamples: UsageSample[];
  /** The account Claude Desktop uses now. */
  activeId?: string;
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
  /** Today's schedule changed (already throttled): tell the user. */
  adapted?(notice: {
    kind: "updated" | "normal";
    schedule: KeeperAdaptation["schedule"];
  }): void;
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
/** Capacities and tempo the plan is drawn with. */
const keeperContext = (state: Pick<KeeperState, "accounts" | "tempo">) =>
  planContext(state.accounts, state.tempo);
/** The schedule as a list with ISO times, earliest first, then in plan order. */
function startList(
  schedule: Record<string, number>,
  settings: PlanningSettings,
): KeeperAdaptation["schedule"] {
  const order = settings.accounts.map((a) => a.id);
  return Object.entries(schedule)
    .sort(([a, x], [b, y]) => x - y || order.indexOf(a) - order.indexOf(b))
    .map(([accountId, time]) => ({
      accountId,
      startAt: new Date(time).toISOString(),
    }));
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
/**
 * What the keeper should do for one planned account right now. A closed
 * window waits for `scheduledStart` (today's adapted schedule) when given.
 */
export function keeperDecision(
  account: Account,
  usage: AccountUsage | undefined,
  settings: PlanningSettings,
  context: PlanContext,
  attempts: WindowAttempt[],
  now: number,
  busy: boolean,
  stopped?: string,
  scheduledStart?: number,
): Decision {
  const base = { accountId: account.id };
  if (!settings.autoStart) return { ...base, state: "off" };
  const identity = planningIdentity(account);
  if (!identity) return { ...base, state: "blocked", reason: "identity" };
  if (stopped) return { ...base, state: "blocked", reason: stopped };
  if (!shouldHaveWindow(account.id, now, settings, context)) {
    const next = nextPlannedStart(account.id, now, settings, context);
    return {
      ...base,
      state: "outside",
      ...(next ? { nextStartAt: new Date(next).toISOString() } : {}),
    };
  }
  if (!fresh(usage, now)) {
    // A connection that needs the user is reported, not shown as refreshing. The issue is the one
    // every surface shows, so a flag left under a rate-limit or an outage does not block.
    const issue = displayedIssue(usage);
    return issue && !TRANSIENT_ISSUES.has(issue)
      ? { ...base, state: "blocked", reason: "usage-connection", refresh: true }
      : { ...base, state: "waiting", reason: "usage-stale", refresh: true };
  }
  const reset = Date.parse(usage!.fiveHour?.resetsAt ?? "");
  if (Number.isFinite(reset) && reset > now)
    return {
      ...base,
      state: "active",
      resetsAt: new Date(reset).toISOString(),
    };
  if ((usage!.sevenDay?.usedPercent ?? 0) >= 100)
    return { ...base, state: "blocked", reason: "weekly-limit" };
  if (scheduledStart !== undefined && now < scheduledStart)
    return {
      ...base,
      state: "waiting",
      reason: "adapted",
      nextStartAt: new Date(scheduledStart).toISOString(),
    };
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
  /** Today's next starts at today's pace; rebuilt after a restart. */
  private readonly adaptive: AdaptiveSchedule;
  constructor(private readonly deps: KeeperDeps) {
    this.now = deps.now ?? Date.now;
    this.adaptive = new AdaptiveSchedule({ now: this.now });
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
  /** The plan changed: try stopped accounts again and re-plan today, quietly. */
  resume() {
    this.stopped.clear();
    this.adaptive.reset();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  /** The newest attempts first, as in the snapshot, without building the day plan. */
  recentAttempts(): WindowAttempt[] {
    return structuredClone(this.attempts.slice(-20).reverse());
  }
  snapshot(): KeeperSnapshot {
    const state = this.deps.state();
    const settings = planned(state);
    const now = this.now();
    const today = dayPlan(
      localDate(now, settings.timeZone),
      settings,
      keeperContext(state),
    );
    const adaptive = this.adaptive.current();
    const upcoming = this.statuses
      .map((s) => {
        // A held restart or a deferred warm-up starts at its adopted time.
        const held =
          s.state === "blocked" || s.state === "off"
            ? undefined
            : adaptive.schedule[s.accountId];
        return {
          accountId: s.accountId,
          at:
            held === undefined
              ? (s.nextStartAt ?? s.resetsAt)
              : new Date(held).toISOString(),
        };
      })
      .filter((s): s is { accountId: string; at: string } => !!s.at)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
    const adaptation: KeeperAdaptation | undefined =
      adaptive.factor > 1 || Object.keys(adaptive.schedule).length
        ? {
            factor: adaptive.factor,
            ...(adaptive.observedRate === undefined
              ? {}
              : { observedRate: adaptive.observedRate }),
            schedule: startList(adaptive.schedule, settings),
            ...(adaptive.since === undefined
              ? {}
              : { since: new Date(adaptive.since).toISOString() }),
          }
        : undefined;
    return {
      enabled: settings.autoStart,
      running: this.running,
      accounts: structuredClone(this.statuses),
      attempts: this.recentAttempts(),
      plannedToday: today.accounts.reduce((n, a) => n + a.windows.length, 0),
      tempo: state.tempo,
      ...(upcoming ? { next: upcoming } : {}),
      ...(adaptation ? { adaptation } : {}),
    };
  }
  private evaluate(
    state: KeeperState,
    schedule: Record<string, number> = this.adaptive.current().schedule,
  ) {
    const now = this.now();
    const settings = planned(state);
    const context = keeperContext(state);
    return settings.accounts
      .map(({ id }) => state.accounts.find((a) => a.id === id)!)
      .map((account) =>
        keeperDecision(
          account,
          state.usage[account.id],
          settings,
          context,
          this.attempts,
          now,
          state.busyAccountIds.includes(account.id),
          this.stopped.get(planningIdentity(account) ?? ""),
          schedule[account.id],
        ),
      );
  }
  /**
   * Today's schedule for this tick: updated from the state (the user hears
   * about a change), kept as it is while Relay is busy, and the plan's own
   * starts if it cannot be computed.
   */
  private adapt(state: KeeperState): Record<string, number> {
    const settings = planned(state);
    // Another operation owns Claude: usage may be minutes old and the active
    // account mid-switch, so nothing is searched or adopted now. Turning
    // auto start or adaptation off only clears the schedule, and goes ahead.
    if (state.blocked && settings.autoStart && settings.adaptive !== false)
      return this.adaptive.current().schedule;
    // Accounts the keeper cannot start, whatever the schedule says.
    const blocked = this.evaluate(state, {})
      .filter((d) => d.state === "blocked" || d.state === "off")
      .map((d) => d.accountId);
    let result: AdaptiveResult;
    try {
      result = this.adaptive.update({
        settings,
        accounts: state.accounts,
        usage: state.usage,
        tempo: state.tempo,
        recentSamples: state.recentSamples,
        activeId: state.activeId,
        blocked,
        now: this.now(),
      });
    } catch {
      // A failing re-plan never stops the keep-alive.
      return {};
    }
    if (result.notice)
      try {
        this.deps.adapted?.({
          kind: result.notice.kind,
          schedule: startList(result.notice.schedule, settings),
        });
      } catch {
        // Not hearing about the schedule does not undo it.
      }
    return result.schedule;
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      let state = this.deps.state();
      if (state.settings.autoStart && !state.blocked) {
        const stale = this.evaluate(state).filter((d) => d.refresh);
        for (const d of stale)
          await this.deps.refresh(d.accountId).catch(() => {});
        if (stale.length) state = this.deps.state();
      }
      // The schedule is built from the refreshed usage, before any start.
      const schedule = this.adapt(state);
      let decisions = this.evaluate(state, schedule);
      const due = decisions.find((d) => d.state === "due");
      if (due && state.settings.autoStart && !state.blocked) {
        await this.startOne(
          state.accounts.find((a) => a.id === due.accountId)!,
        );
        state = this.deps.state();
        decisions = this.evaluate(state, schedule);
      }
      this.statuses = decisions.map(({ refresh, ...status }) =>
        // Nothing is refreshed or started while Relay is busy.
        state.blocked &&
        (status.state === "due" || status.reason === "usage-stale")
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
