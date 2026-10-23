import { z } from "zod";
import {
  draftPlace,
  restoreDrafts,
  type RestoreOptions,
  type RestorerDeps,
  type RestoreResult,
} from "./draft-restorer";
import { logDraft, shortId, type DraftLog } from "./draft-diagnostics";
import type { DraftSummary } from "./draft-vault";
import type {
  DesktopWatch,
  DesktopWatchState,
  DesktopWatcher,
} from "./desktop-watch";

/**
 * The main process's side of draft restore: when the restorer runs, the notification it is
 * given, and what the panel may do with a draft. Draft text stays here. Its lock is
 * DesktopLock's `restore`.
 */

/** How often pending drafts are tried again while one waits for Desktop's current account. */
export const RETRY_MS = 10_000;
/**
 * How often Desktop's account alone is read while drafts wait only for other accounts. A
 * switch runs a pass of its own; this catches an account changed in Claude itself.
 */
export const ACCOUNT_CHECK_MS = 60_000;
/** How long retries wait after a run in which Desktop's UI never answered. */
export const NOT_READY_BACKOFF_MS = 2 * 60_000;
/** Runs in a row that may try a pending draft and move nothing, before it is left for Copy. */
export const MAX_STALLS = 3;
/**
 * For how long after Claude is ready on an account Relay may take the user to a draft's
 * place and back. After it, a draft is typed only where the user opens it.
 */
export const VISIT_MS = 2 * 60_000;
/**
 * For how long after Claude is ready on an account its drafts wait to be opened. After it,
 * the ones still pending are left for Copy as `not-opened`.
 */
export const WATCH_MS = 30 * 60_000;
/** The least time between the end of a run and one the watch starts. */
export const NUDGE_MS = 1_000;
/**
 * With a watch on, a 10 s retry still runs once this long has passed since the last run, in
 * case the watch missed the draft's place on screen.
 */
export const BACKSTOP_MS = 60_000;
/** Why a draft is left for Copy once the watch window ran out. */
export const NOT_OPENED = "not-opened";

/** The notification after a restore: counts only, never a draft's text or title. */
export function draftNotice(
  summary: { restored: number; left: number },
  language: "tr" | "en",
): string | undefined {
  const en = language === "en";
  const drafts = (n: number) => `${n} ${n === 1 ? "draft" : "drafts"}`;
  const parts: string[] = [];
  if (summary.restored > 0)
    parts.push(
      en
        ? `${drafts(summary.restored)} restored`
        : `${summary.restored} taslak yeniden yazıldı`,
    );
  if (summary.left > 0)
    parts.push(
      en
        ? `${drafts(summary.left)} waiting in the panel`
        : `${summary.left} taslak panelde bekliyor`,
    );
  return parts.length ? parts.join(" · ") : undefined;
}

/** The stop a restore that throws is counted as. */
export const RESTORE_ERROR = "error";

const sameAccount = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Two reads of Desktop's account name the same account, or both none. */
const sameRead = (a: string | undefined, b: string | undefined) =>
  a === b || (!!a && !!b && sameAccount(a, b));
const pendingIds = (drafts: readonly DraftSummary[]) =>
  new Set(drafts.filter((d) => d.state === "pending").map((d) => d.id));

/**
 * Counts, per pending draft, the runs in a row that tried it and moved no draft at all: none
 * restored, none left for copy or otherwise gone. A run tries the drafts that were pending for
 * the account it ran for, and only a run that stopped with a reason counts: one without
 * (Claude closed or not up long enough, nothing pending for the account) tried nothing, and
 * neither did one stopped `busy`, which found another Desktop operation holding the lock or
 * waiting for it, `active`, which found the user working in Claude or Claude not in front, or
 * `elsewhere`, which found a draft's place not on screen and could not go there.
 * Every other stop counts, a restore that threw (`error`) included. A run that moved any draft
 * starts every count again. A draft counted `MAX_STALLS` times is given up.
 */
export function tallyStalls(
  counts: ReadonlyMap<string, number>,
  run: {
    before: readonly DraftSummary[];
    after: readonly DraftSummary[];
    /** The account the run read first; undefined when it read none. */
    account: string | undefined;
    result: RestoreResult;
  },
): { counts: Map<string, number>; giveUp: string[] } {
  const before = pendingIds(run.before);
  const after = run.after.filter((d) => d.state === "pending");
  const still = new Set(after.map((d) => d.id));
  if (run.result.restored > 0 || [...before].some((id) => !still.has(id)))
    return { counts: new Map(), giveUp: [] };
  // Only drafts still pending keep a count.
  const next = new Map<string, number>();
  for (const draft of after) {
    const count = counts.get(draft.id);
    if (count) next.set(draft.id, count);
  }
  const giveUp: string[] = [];
  const account = run.account;
  const { reason } = run.result;
  if (
    !reason ||
    reason === "busy" ||
    reason === "active" ||
    reason === "elsewhere" ||
    !account
  )
    return { counts: next, giveUp };
  for (const draft of after) {
    if (!before.has(draft.id) || !sameAccount(draft.to, account)) continue;
    const count = (next.get(draft.id) ?? 0) + 1;
    if (count >= MAX_STALLS) {
      next.delete(draft.id);
      giveUp.push(draft.id);
    } else next.set(draft.id, count);
  }
  return { counts: next, giveUp };
}

export interface DraftSchedulerDeps {
  /** What each run gives restoreDrafts: a plain object. */
  restorer: RestorerDeps;
  /** Every record's summary; [] when the vault cannot be read. */
  drafts(): Promise<DraftSummary[]>;
  /** Tells the renderers that the drafts changed. */
  changed(): void;
  /**
   * Whether drafts are re-typed into Claude. Off, every pending draft is left for Copy and
   * neither the restorer nor anything of Desktop's UI is used.
   */
  retype(): boolean;
  /** The restore to run; restoreDrafts unless a test gives another. */
  restore?: (
    deps: RestorerDeps,
    options?: RestoreOptions,
  ) => Promise<RestoreResult>;
  /** Calls `fn` every `ms` until the returned function is called; setInterval unless a test gives another. */
  every?: (fn: () => void, ms: number) => () => void;
  /** Calls `fn` once after `ms` unless the returned function is called first; setTimeout unless a test gives another. */
  later?: (fn: () => void, ms: number) => () => void;
  /**
   * Watches where the user is in Claude, cheaply, while drafts wait for Desktop's account;
   * without one, the 10 s retries look instead.
   */
  watch?: DesktopWatcher;
}

const anyPending = (drafts: readonly DraftSummary[]) =>
  drafts.some((d) => d.state === "pending");

function interval(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms);
  timer.unref?.();
  return () => clearInterval(timer);
}

function timeout(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/** A run got past Claude's readiness: it looked at Desktop's UI, whatever came of it. */
const readyRun = (result: RestoreResult) =>
  result.status === "done" ||
  (result.reason !== undefined &&
    !["not-ready", "claude-not-running", RESTORE_ERROR].includes(result.reason));

/**
 * Runs the draft restorer after every switch, one run at a time, and every 10 s while a
 * pending draft is for Desktop's current account. While drafts wait only for other accounts,
 * Desktop's account alone is read every 60 s and a full pass runs once it is another; while
 * none waits, nothing is armed. After a run in which Desktop's UI never answered, the 10 s
 * retries wait 2 minutes; a switch does not. The run after a switch waits for Claude to start.
 *
 * Once a run finds Claude ready on an account, the account's windows open: for `VISIT_MS`
 * runs may take the user to a draft's place and back, and after `WATCH_MS` the drafts still
 * pending for it are left for Copy as `not-opened`. A switch, or another account, opens new
 * ones. While drafts wait for Desktop's account and Claude was ready, the watch reports where
 * the user is; a run starts, at least `NUDGE_MS` after the last, when a pending draft's place
 * is on screen with Claude in front and no key pressed for 1 s, or, while visits are allowed,
 * when the user leaves Claude alone in front for 3 s. A report during a run is weighed once it
 * ends. With a watch on, a 10 s retry runs only while its last report would start a run, the
 * watch window is over, or `BACKSTOP_MS` passed since the last run, and otherwise reads
 * Desktop's account alone.
 *
 * A pending draft that `MAX_STALLS` runs in a row tried and stopped on is left for Copy with
 * the last stop reason, so none stays pending for ever.
 * Once accessibility is granted, `retryAccessibility` sets the drafts left for Copy for want
 * of it back to pending, one call at a time: from the user's grant every one, and from a
 * window gaining focus each at most once while Relay runs.
 * With re-typing off, a pass leaves every pending draft, whatever its account, for Copy as
 * `manual` without running the restorer, and `retryAccessibility` moves nothing. Runs never
 * throw.
 */
export class DraftScheduler {
  private running = false;
  private flight: Promise<void> = Promise.resolve();
  /** A switch came during the run: one more run after it. */
  private again = false;
  private cancel?: () => void;
  /** The armed timer's period: RETRY_MS or ACCOUNT_CHECK_MS. */
  private period?: number;
  /** Desktop's account as the last pass to arm the timers read it; the 60 s check compares. */
  private account?: string;
  /** Passes begun, so `start` leaves the timers to a pass begun after it read the drafts. */
  private passes = 0;
  private notBefore = -Infinity;
  private stalls = new Map<string, number>();
  private stopped = false;
  /** The drafts `retryAccessibility` set back to pending while Relay runs. */
  private retried = new Set<string>();
  /** Since when Claude has been ready on `account`, as a run first found it. */
  private window?: { account: string; since: number };
  /** A switch asked for the next run: Claude may still be starting. */
  private switched = false;
  /** Switches so far: a run begun before the last one opens no window for the new Claude. */
  private generation = 0;
  /** The watch while one runs, and its last report. */
  private watching?: { watch: DesktopWatch; state?: DesktopWatchState };
  /** The places of the drafts pending for Desktop's account, as the watch looks for them. */
  private targets = new Set<string>();
  /** When the last run ended. */
  private lastRunEnd = -Infinity;
  /** A report came during a run: weigh it once the run ends. */
  private nudged = false;
  private nudgeTimer?: () => void;
  /** The `retryAccessibility` call in progress; the next one waits for it. */
  private retrying: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: DraftSchedulerDeps) {}

  /**
   * When drafts wait from before, as after Relay restarts: with re-typing off they are left
   * for Copy now; on, the 10 s retries or the 60 s check are armed for them, as after a pass.
   */
  async start(): Promise<void> {
    const passes = this.passes;
    const drafts = await this.read();
    if (!anyPending(drafts)) return;
    if (!this.deps.retype()) return this.run(false);
    const account = await this.currentAccount();
    // A pass begun since the drafts were read armed for what it found: that stands.
    if (this.running || this.passes !== passes) return;
    this.schedule(drafts, account);
  }

  /**
   * Draft re-typing was turned on or off: one pass now, or right after the one in flight.
   * Turned off, it leaves every draft still pending for Copy.
   */
  retypeChanged(): Promise<void> {
    return this.run(true);
  }

  /**
   * After a switch: a run now, whatever the backoff, that waits for Claude to start. A switch
   * while a run is in flight gets a run of its own once that one ends, never alongside it. It
   * means a new Claude: the windows open again, and the watch of the last one ends.
   */
  afterSwitch(): Promise<void> {
    this.notBefore = -Infinity;
    this.window = undefined;
    this.switched = true;
    this.generation++;
    this.unwatch();
    return this.run(true);
  }

  /**
   * One 10 s retry: skipped while backing off, and dropped while a run is in flight. With a
   * watch on, it runs only while the watch's last report would start a run, the watch window
   * is over or the last run was `BACKSTOP_MS` ago; otherwise it reads Desktop's account alone,
   * and runs once that is another.
   */
  tick(): Promise<void> {
    const now = this.deps.restorer.now();
    if (now < this.notBefore) return Promise.resolve();
    if (
      this.watching &&
      !this.go() &&
      !this.expired(now) &&
      now - this.lastRunEnd < BACKSTOP_MS
    )
      return this.check();
    return this.run(false);
  }

  /**
   * Accessibility is granted: every draft left for Copy only because it was missing goes back
   * to pending, with its reason and its count of stops cleared, and the 10 s retries are armed.
   * With `once`, as when a window gains focus, a draft this already set back while Relay runs
   * stays for Copy; without, as after the user grants the permission, every one goes back. A
   * call waits for the one before it, then reads the drafts. Resolves with how many drafts
   * moved. Never throws: a vault that cannot be read or changed moves none.
   */
  retryAccessibility(options?: { once?: boolean }): Promise<number> {
    const once = options?.once === true;
    const turn = this.retrying.then(async () => {
      const moved = await this.moveBack(once);
      logDraft(this.deps.restorer.log, "retry-accessibility", { moved, once });
      return moved;
    });
    this.retrying = turn;
    return turn;
  }

  /** One `retryAccessibility`, with none other in progress. */
  private async moveBack(once: boolean): Promise<number> {
    if (this.stopped) return 0;
    let moved = 0;
    try {
      // Re-typing off: every draft left for Copy stays there, whatever left it.
      if (!this.deps.retype()) return 0;
      const waiting = (await this.read()).filter(
        (d) =>
          d.state === "needs-copy" &&
          d.reason === "accessibility" &&
          !(once && this.retried.has(d.id)),
      );
      for (const draft of waiting)
        try {
          await this.deps.restorer.mark(draft.id, "pending");
          this.stalls.delete(draft.id);
          this.retried.add(draft.id);
          moved++;
        } catch {
          // A vault that cannot be changed leaves the draft for Copy.
        }
      if (!moved) return 0;
      try {
        this.deps.changed();
      } catch {
        // The panel reads the drafts again on its next refresh.
      }
      // A run in flight may have read the drafts before this and turn the retries off as it
      // ends: arm them after it. The next run arms for the account they wait for.
      await this.flight;
      this.arm(RETRY_MS);
    } catch {
      // Nothing here is expected to throw; the drafts stay as they are.
    }
    return moved;
  }

  /** No more runs, retries or watch; one in flight ends as it would. */
  stop(): void {
    this.stopped = true;
    this.disarm();
    this.unwatch();
  }

  private run(again: boolean): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      if (again) this.again = true;
      return this.flight;
    }
    this.running = true;
    this.flight = (async () => {
      try {
        do {
          this.again = false;
          await this.once();
        } while (this.again && !this.stopped);
      } finally {
        this.running = false;
        this.lastRunEnd = this.deps.restorer.now();
      }
      // What the watch said meanwhile, now that the run has changed what is pending.
      if (this.nudged) {
        this.nudged = false;
        this.consider();
      }
    })().catch(() => {
      // A run never throws; should one, the next tick or switch runs again.
    });
    return this.flight;
  }

  private async once(): Promise<void> {
    this.passes++;
    let before = await this.read();
    if (!anyPending(before)) {
      this.unwatch();
      return this.disarm();
    }
    if (!this.deps.retype()) {
      this.unwatch();
      return this.leaveAll(before);
    }
    const { restorer } = this.deps;
    if (this.expired(restorer.now())) {
      before = await this.expire(before);
      if (!anyPending(before)) {
        this.unwatch();
        return this.disarm();
      }
    }
    let account: string | undefined;
    let asked = false;
    let result: RestoreResult;
    const launching = this.switched;
    this.switched = false;
    const generation = this.generation;
    const started = restorer.now();
    try {
      result = await (this.deps.restore ?? restoreDrafts)(
        {
          ...restorer,
          // The restorer reads the account first and restores only that account's drafts.
          currentAccount: async () => {
            const value = await restorer.currentAccount();
            if (!asked) account = value;
            asked = true;
            return value;
          },
        },
        { visits: this.visits(started), launching },
      );
    } catch {
      // A failure the restorer did not expect: counted, so one that repeats is given up.
      result = { status: "waiting", restored: 0, left: 0, reason: RESTORE_ERROR };
    }
    if (result.reason === "not-ready")
      this.notBefore = restorer.now() + NOT_READY_BACKOFF_MS;
    // The windows are the account's: another account's run opens its own.
    if (
      this.window &&
      (!account || !sameAccount(this.window.account, account))
    )
      this.window = undefined;
    // A run begun before a switch found the Claude that switch replaced.
    const ready = readyRun(result) && generation === this.generation;
    if (!this.window && account && ready)
      this.window = { account, since: started };
    // A run with nothing for this account changed nothing.
    const after = result.status === "idle" ? before : await this.read();
    const tally = tallyStalls(this.stalls, { before, after, account, result });
    this.stalls = tally.counts;
    logDraft(restorer.log, "stalls", {
      giveUp: tally.giveUp.length,
      reason: result.reason ?? null,
      status: result.status,
    });
    const given = new Set<string>();
    for (const id of tally.giveUp) {
      let marked = false;
      try {
        await restorer.mark(id, "needs-copy", result.reason);
        given.add(id);
        marked = true;
      } catch {
        // A vault that cannot be changed keeps the draft pending; the next run tries again.
      }
      logDraft(restorer.log, "give-up", {
        id: shortId(id),
        reason: result.reason ?? null,
        marked,
      });
    }
    if (given.size)
      try {
        restorer.notify({ restored: 0, left: given.size });
      } catch {
        // A notification that fails changes nothing about the drafts.
      }
    if (given.size || JSON.stringify(before) !== JSON.stringify(after))
      try {
        this.deps.changed();
      } catch {
        // The panel reads the drafts again on its next refresh.
      }
    const left = after.filter((d) => !given.has(d.id));
    // The account the restorer read first; read here only when it read none.
    const current = asked ? account : await this.currentAccount();
    this.schedule(left, current);
    await this.watchFor(left, current, ready);
  }

  /** Relay may take the user elsewhere and back: Claude is not ready yet, or only just. */
  private visits(now: number): boolean {
    return !this.window || now < this.window.since + VISIT_MS;
  }

  /** The watch window of Desktop's account is over. */
  private expired(now: number): boolean {
    return !!this.window && now >= this.window.since + WATCH_MS;
  }

  /**
   * The watch window is over: every draft still pending for its account, while Desktop is on
   * it, is left for Copy as `not-opened`, and the watch ends. Resolves with the drafts as they
   * are after it. A draft whose mark fails stays pending, and the next run tries again.
   */
  private async expire(
    before: DraftSummary[],
  ): Promise<DraftSummary[]> {
    const { restorer } = this.deps;
    const account = this.window!.account;
    if (!sameRead(await this.currentAccount(), account)) return before;
    this.unwatch();
    let left = 0;
    for (const draft of before) {
      if (draft.state !== "pending" || !sameAccount(draft.to, account)) continue;
      try {
        await restorer.mark(draft.id, "needs-copy", NOT_OPENED);
        this.stalls.delete(draft.id);
        left++;
      } catch {
        // A vault that cannot be changed keeps the draft pending.
      }
    }
    logDraft(restorer.log, "watch-over", { left });
    if (!left) return before;
    try {
      restorer.notify({ restored: 0, left });
    } catch {
      // A notification that fails changes nothing about the drafts.
    }
    try {
      this.deps.changed();
    } catch {
      // The panel reads the drafts again on its next refresh.
    }
    return this.read();
  }

  /**
   * Keeps the watch on while drafts are pending for Desktop's `account` and a run found Claude
   * ready, with the places it looks for; ends it otherwise. The places come from the records,
   * read here in main.
   */
  private async watchFor(
    drafts: readonly DraftSummary[],
    account: string | undefined,
    ready: boolean,
  ): Promise<void> {
    if (
      this.stopped ||
      !this.deps.watch ||
      !account ||
      !drafts.some((d) => d.state === "pending" && sameAccount(d.to, account))
    )
      return this.unwatch();
    let places: Set<string>;
    try {
      places = new Set(
        (await this.deps.restorer.pending())
          .filter((r) => r.state === "pending" && sameAccount(r.to, account))
          .map(draftPlace)
          .filter((place): place is string => place !== undefined),
      );
    } catch {
      // Records that cannot be read: nothing to look for until the next run.
      return this.unwatch();
    }
    this.targets = places;
    if (!places.size) return this.unwatch();
    if (!this.watching && ready) this.startWatch();
  }

  private startWatch(): void {
    const watcher = this.deps.watch;
    if (!watcher || this.stopped) return;
    const log = this.deps.restorer.log;
    const entry: { watch: DesktopWatch; state?: DesktopWatchState } = {
      watch: { stop() {} },
    };
    this.watching = entry;
    logDraft(log, "watch-start", { places: this.targets.size });
    try {
      entry.watch = watcher({
        state: (state) => {
          if (this.watching !== entry) return;
          entry.state = state;
          this.consider();
        },
        end: (reason) => {
          if (this.watching !== entry) return;
          this.watching = undefined;
          logDraft(log, "watch-end", { reason });
          // The helper's own 10 minutes: a new one, while drafts still wait.
          if (reason === "expired" && this.targets.size) this.startWatch();
        },
      });
    } catch {
      if (this.watching === entry) this.watching = undefined;
      logDraft(log, "watch-end", { reason: "failed" });
    }
  }

  private unwatch(): void {
    this.nudgeTimer?.();
    this.nudgeTimer = undefined;
    this.nudged = false;
    const current = this.watching;
    if (!current) return;
    this.watching = undefined;
    try {
      current.watch.stop();
    } catch {
      // A watch that cannot be stopped ends with Relay, or on its own after 10 minutes.
    }
  }

  /**
   * The watch's last report would start a run: Claude in front, and either a pending draft's
   * place on screen with no key for 1 s, or, while visits are allowed, the user idle 3 s.
   */
  private go(): boolean {
    const state = this.watching?.state;
    if (!state?.frontmost) return false;
    if (state.place && this.targets.has(state.place) && state.quiet) return true;
    return state.idle && this.visits(this.deps.restorer.now());
  }

  /** Starts a run when the watch's last report says so, at least NUDGE_MS after the last run. */
  private consider(): void {
    if (this.stopped || !this.go()) return;
    if (this.running) {
      this.nudged = true;
      return;
    }
    const wait = this.lastRunEnd + NUDGE_MS - this.deps.restorer.now();
    if (wait <= 0) {
      void this.run(false);
      return;
    }
    this.nudgeTimer ??= (this.deps.later ?? timeout)(() => {
      this.nudgeTimer = undefined;
      this.consider();
    }, wait);
  }

  /**
   * Re-typing is off: every pending draft, whatever its account, is left for Copy as `manual`,
   * without the restorer or Desktop's account. One whose mark fails stays pending, and the
   * 10 s retries try it again.
   */
  private async leaveAll(before: readonly DraftSummary[]): Promise<void> {
    const { restorer } = this.deps;
    let left = 0;
    let failed = 0;
    for (const draft of before) {
      if (draft.state !== "pending") continue;
      try {
        await restorer.mark(draft.id, "needs-copy", "manual");
        this.stalls.delete(draft.id);
        left++;
      } catch {
        // A vault that cannot be changed keeps the draft pending; the next pass tries again.
        failed++;
      }
    }
    logDraft(restorer.log, "retype-off", { left, failed });
    if (left) {
      try {
        restorer.notify({ restored: 0, left });
      } catch {
        // A notification that fails changes nothing about the drafts.
      }
      try {
        this.deps.changed();
      } catch {
        // The panel reads the drafts again on its next refresh.
      }
    }
    if (failed) this.arm(RETRY_MS);
    else this.disarm();
  }

  /**
   * Arms what the pending `drafts` need: the 10 s retries while one is for Desktop's
   * `account`, the 60 s check while they wait only for other accounts, nothing while none
   * waits.
   */
  private schedule(
    drafts: readonly DraftSummary[],
    account: string | undefined,
  ): void {
    this.account = account;
    const pending = drafts.filter((d) => d.state === "pending");
    if (!pending.length) return this.disarm();
    if (account && pending.some((d) => sameAccount(d.to, account)))
      this.arm(RETRY_MS);
    else this.arm(ACCOUNT_CHECK_MS);
  }

  /** The 60 s check: Desktop's account alone, and a full pass once it is another. */
  private async check(): Promise<void> {
    if (this.running || this.stopped) return;
    if (sameRead(await this.currentAccount(), this.account)) return;
    await this.run(false);
  }

  /** Desktop's account; undefined when it cannot be read. */
  private async currentAccount(): Promise<string | undefined> {
    try {
      return await this.deps.restorer.currentAccount();
    } catch {
      return undefined;
    }
  }

  private read(): Promise<DraftSummary[]> {
    return this.deps.drafts().catch(() => []);
  }

  private arm(period: number): void {
    if (this.stopped || (this.cancel && this.period === period)) return;
    this.disarm();
    this.period = period;
    this.cancel = (this.deps.every ?? interval)(
      period === RETRY_MS ? () => void this.tick() : () => void this.check(),
      period,
    );
  }

  private disarm(): void {
    this.cancel?.();
    this.cancel = undefined;
    this.period = undefined;
  }
}

/** The panel's view of the drafts: summaries, never text, and none when the vault cannot be read. */
export function draftSummaries(source: {
  pendingDrafts(): Promise<DraftSummary[]>;
}): Promise<DraftSummary[]> {
  return source.pendingDrafts().catch(() => []);
}

const GONE = "This draft is no longer there.";
const WAITING = "This draft is still waiting to be restored.";

/**
 * The panel's Copy and Dismiss, by record id, for a draft left for copy only: one still
 * waiting to be restored, or gone, is left as it is and the call rejects. Copy writes the text
 * to the clipboard here, in main, and then removes the record; neither ever resolves with
 * anything, so no text travels back to a renderer. A failure, a vault that cannot be read
 * included, rejects as an ordinary error. Either way the renderers are told to read the
 * drafts again.
 */
export function draftActions(deps: {
  drafts: {
    pendingDrafts(): Promise<DraftSummary[]>;
    draftText(id: string): Promise<string | undefined>;
    dismissDraft(id: string): Promise<void>;
  };
  writeClipboard(text: string): void;
  changed(): void;
  /** A diagnosis log: the draft's id cut to 8 characters and how the action ended, never text. */
  log?: DraftLog;
}) {
  const draftId = z.uuid();
  /** How an action ended, for the log: this code's own refusals say why, anything else does not. */
  const outcome = (error: unknown) =>
    error instanceof Error && (error.message === GONE || error.message === WAITING)
      ? { ok: false, reason: error.message }
      : { ok: false, reason: "failed" };
  /** Throws unless draft `id` waits to be copied by hand. */
  const leftForCopy = async (id: string) => {
    const draft = (await deps.drafts.pendingDrafts()).find((d) => d.id === id);
    if (!draft) throw new Error(GONE);
    if (draft.state !== "needs-copy")
      throw new Error(WAITING);
  };
  return {
    async copy(raw: unknown): Promise<void> {
      const id = draftId.parse(raw);
      try {
        await leftForCopy(id);
        const text = await deps.drafts.draftText(id);
        if (text === undefined) throw new Error(GONE);
        deps.writeClipboard(text);
        await deps.drafts.dismissDraft(id);
        logDraft(deps.log, "draft-copy", { id: shortId(id), ok: true });
      } catch (error) {
        logDraft(deps.log, "draft-copy", { id: shortId(id), ...outcome(error) });
        throw error;
      } finally {
        deps.changed();
      }
    },
    async dismiss(raw: unknown): Promise<void> {
      const id = draftId.parse(raw);
      try {
        await leftForCopy(id);
        await deps.drafts.dismissDraft(id);
        logDraft(deps.log, "draft-dismiss", { id: shortId(id), ok: true });
      } catch (error) {
        logDraft(deps.log, "draft-dismiss", {
          id: shortId(id),
          ...outcome(error),
        });
        throw error;
      } finally {
        deps.changed();
      }
    },
  };
}
