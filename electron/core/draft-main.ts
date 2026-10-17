import { z } from "zod";
import {
  restoreDrafts,
  type RestorerDeps,
  type RestoreResult,
} from "./draft-restorer";
import { logDraft, shortId, type DraftLog } from "./draft-diagnostics";
import type { DraftSummary } from "./draft-vault";

/**
 * The main process's side of draft restore: when the restorer runs, the notification it is
 * given, and what the panel may do with a draft. Draft text stays here. Its lock is
 * DesktopLock's `restore`.
 */

/** How often pending drafts are tried again while any wait. */
export const RETRY_MS = 10_000;
/** How long retries wait after a run in which Desktop's UI never answered. */
export const NOT_READY_BACKOFF_MS = 2 * 60_000;
/**
 * How long retries wait after a run that found the user working, in Claude or elsewhere, so
 * Desktop's UI is not inspected every 10 s while they do.
 */
export const ACTIVE_BACKOFF_MS = 60_000;
/** Runs in a row that may try a pending draft and move nothing, before it is left for Copy. */
export const MAX_STALLS = 3;

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
        : `${summary.restored} taslak geri yazıldı`,
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
const pendingIds = (drafts: readonly DraftSummary[]) =>
  new Set(drafts.filter((d) => d.state === "pending").map((d) => d.id));

/**
 * Counts, per pending draft, the runs in a row that tried it and moved no draft at all: none
 * restored, none left for copy or otherwise gone. A run tries the drafts that were pending for
 * the account it ran for, and only a run that stopped with a reason counts: one without
 * (Claude closed or not up long enough, nothing pending for the account) tried nothing, and
 * neither did one stopped `busy`, which found another Desktop operation holding the lock or
 * waiting for it, or `active`, which found the user working in Claude or Claude not in front.
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
  if (!reason || reason === "busy" || reason === "active" || !account)
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
  /** The restore to run; restoreDrafts unless a test gives another. */
  restore?: (deps: RestorerDeps) => Promise<RestoreResult>;
  /** Calls `fn` every `ms` until the returned function is called; setInterval unless a test gives another. */
  every?: (fn: () => void, ms: number) => () => void;
}

const anyPending = (drafts: readonly DraftSummary[]) =>
  drafts.some((d) => d.state === "pending");

function interval(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Runs the draft restorer after every switch, and every 10 s while a draft is pending, one
 * run at a time. After a run in which Desktop's UI never answered, the 10 s retries wait
 * 2 minutes, and after one that found the user active, 60 s; a switch does not. A pending
 * draft that `MAX_STALLS` runs in a row tried and
 * stopped on is left for Copy with the last stop reason, so none stays pending for ever.
 * Once accessibility is granted, `retryAccessibility` sets the drafts left for Copy for want
 * of it back to pending, one call at a time: from the user's grant every one, and from a
 * window gaining focus each at most once while Relay runs. Runs never throw.
 */
export class DraftScheduler {
  private running = false;
  private flight: Promise<void> = Promise.resolve();
  /** A switch came during the run: one more run after it. */
  private again = false;
  private cancel?: () => void;
  private notBefore = -Infinity;
  private stalls = new Map<string, number>();
  private stopped = false;
  /** The drafts `retryAccessibility` set back to pending while Relay runs. */
  private retried = new Set<string>();
  /** The `retryAccessibility` call in progress; the next one waits for it. */
  private retrying: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: DraftSchedulerDeps) {}

  /** Turns the 10 s retries on when drafts wait from before, as after Relay restarts. */
  async start(): Promise<void> {
    if (anyPending(await this.read())) this.arm();
  }

  /**
   * After a switch: a run now, whatever the backoff. A switch while a run is in flight gets a
   * run of its own once that one ends, never alongside it.
   */
  afterSwitch(): Promise<void> {
    this.notBefore = -Infinity;
    return this.run(true);
  }

  /** One 10 s retry: skipped while backing off, and dropped while a run is in flight. */
  tick(): Promise<void> {
    if (this.deps.restorer.now() < this.notBefore) return Promise.resolve();
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
      // ends: arm them after it.
      await this.flight;
      this.arm();
    } catch {
      // Nothing here is expected to throw; the drafts stay as they are.
    }
    return moved;
  }

  /** No more runs or retries; one in flight ends as it would. */
  stop(): void {
    this.stopped = true;
    this.disarm();
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
      }
    })().catch(() => {
      // A run never throws; should one, the next tick or switch runs again.
    });
    return this.flight;
  }

  private async once(): Promise<void> {
    const before = await this.read();
    if (!anyPending(before)) return this.disarm();
    const { restorer } = this.deps;
    let account: string | undefined;
    let asked = false;
    let result: RestoreResult;
    try {
      result = await (this.deps.restore ?? restoreDrafts)({
        ...restorer,
        // The restorer reads the account first and restores only that account's drafts.
        currentAccount: async () => {
          const value = await restorer.currentAccount();
          if (!asked) account = value;
          asked = true;
          return value;
        },
      });
    } catch {
      // A failure the restorer did not expect: counted, so one that repeats is given up.
      result = { status: "waiting", restored: 0, left: 0, reason: RESTORE_ERROR };
    }
    if (result.reason === "not-ready")
      this.notBefore = restorer.now() + NOT_READY_BACKOFF_MS;
    else if (result.reason === "active")
      this.notBefore = restorer.now() + ACTIVE_BACKOFF_MS;
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
    if (after.some((d) => d.state === "pending" && !given.has(d.id))) this.arm();
    else this.disarm();
  }

  private read(): Promise<DraftSummary[]> {
    return this.deps.drafts().catch(() => []);
  }

  private arm(): void {
    if (this.cancel || this.stopped) return;
    this.cancel = (this.deps.every ?? interval)(() => void this.tick(), RETRY_MS);
  }

  private disarm(): void {
    this.cancel?.();
    this.cancel = undefined;
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
