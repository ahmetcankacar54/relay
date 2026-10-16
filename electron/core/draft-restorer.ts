import {
  automationGuard,
  DesktopAutomationError,
  isLocalSessionId,
  type DesktopAutomation,
  type DesktopAutomationGuard,
  type DesktopAutomationIssue,
  type DesktopAutomationSnapshot,
} from "./desktop-continuation-host";
import type { DraftRecord, DraftState } from "./draft-vault";

export interface RestorerDeps {
  automation: Pick<DesktopAutomation, "inspect" | "openSession" | "writeDraft">;
  /** Records with text, main process only. */
  pending(): Promise<DraftRecord[]>;
  mark(id: string, state: DraftState, reason?: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Desktop's currentAccountUuid. */
  currentAccount(): Promise<string | undefined>;
  running(): Promise<boolean>;
  uptimeMs(): Promise<number | undefined>;
  /** Runs `fn` holding Relay's Desktop lock; undefined, without running it, when busy. */
  withLock<T>(fn: () => Promise<T>): Promise<T | undefined>;
  notify(summary: { restored: number; left: number }): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export type RestoreResult = {
  status: "idle" | "waiting" | "done";
  /** Drafts typed into their composer and seen there 5 s later. */
  restored: number;
  /** This account's other drafts of the run: now left for copy, or still pending. */
  left: number;
  /**
   * Why a run stopped with drafts still pending:
   * - `not-ready`: Desktop's UI never answered;
   * - `busy`: another Desktop operation held the lock;
   * - `moved`: the user went to another conversation;
   * - `changed`: Claude's account, uptime or process changed;
   * - `claude-not-running`;
   * - `budget`: the run took 5 minutes.
   */
  reason?: string;
};

type Snapshot = DesktopAutomationSnapshot;

/** Desktop wipes its drafts about 6 s after an account loads. Restore only well after that. */
const MIN_UPTIME_MS = 15_000;
const POLL_MS = 500;
/** How long Desktop's UI may take to answer at all. */
const READY_MS = 60_000;
/** How long an opened conversation may take to show, and how often its link is sent again. */
const SHOWN_MS = 30_000;
const RESEND_MS = 5_000;
/** When a written draft is read again, to catch a wipe that came after it. */
const RECHECK_MS = 5_000;
/** The longest a whole run may take before the drafts left wait for the next one. */
const BUDGET_MS = 5 * 60_000;
/** The longest draft `writeDraft` takes. Longer ones are left for Copy. */
const MAX_TEXT = 16_384;

/**
 * Ends a run. With `pending`, the draft in hand and those after it stay pending, unless the
 * draft in hand was being typed. With `copy`, they are all left for copy with `reason`.
 */
class Stop {
  constructor(
    readonly leaves: "pending" | "copy",
    readonly reason: string,
  ) {}
}
const issueOf = (error: unknown): DesktopAutomationIssue =>
  error instanceof DesktopAutomationError
    ? error.issue
    : "desktop-ui-unsupported";
/** Throws a Stop when `error` ends the run. Any other failure is the caller's. */
function haltOn(error: unknown): void {
  const issue = issueOf(error);
  if (issue === "accessibility-permission-required")
    throw new Stop("copy", "accessibility");
  if (issue === "claude-not-running") throw new Stop("pending", issue);
}

const sameAccount = (a: string | undefined, b: string) =>
  !!a && a.toLowerCase() === b.toLowerCase();

/** What a run holds to: Desktop's account and Claude's process, and where the user is. */
interface Run {
  account: string;
  pid: number;
  /** Set by the first lock's look at the screen. */
  anchored: boolean;
  /** The conversation the user was on, to take them back to. */
  returnTo?: string;
  /** The conversation Relay last saw on screen. Anything else means the user moved. */
  lastSeen?: string;
}

/**
 * Types the drafts captured for Desktop's current account back into their conversations'
 * empty composers, once Claude has run 15 s, and takes the user back to the conversation
 * they were on. It never sends, and never writes into a composer that is not empty.
 *
 * It waits for Desktop's UI without the Desktop lock, then takes the lock for each draft and
 * re-checks Claude under it. It stops, leaving the rest pending, when the lock is busy, the
 * user moves, Claude changes or the run passes 5 minutes. A draft it cannot type, or cannot
 * see in its composer afterwards, is marked `needs-copy` with the reason.
 */
export async function restoreDrafts(
  deps: RestorerDeps,
): Promise<RestoreResult> {
  const started = deps.now();
  let account: string | undefined;
  let records: DraftRecord[] = [];
  let ready: boolean;
  try {
    account = await deps.currentAccount();
    if (!account) return { status: "idle", restored: 0, left: 0 };
    records = (await deps.pending()).filter(
      (record) => record.state === "pending" && sameAccount(account, record.to),
    );
    if (!records.length) return { status: "idle", restored: 0, left: 0 };
    ready = await claudeReady(deps);
  } catch {
    return { status: "waiting", restored: 0, left: records.length };
  }
  if (!ready) return { status: "waiting", restored: 0, left: records.length };

  let restored = 0;
  let copied = 0;
  const leave = async (record: DraftRecord, reason: string) => {
    try {
      await deps.mark(record.id, "needs-copy", reason);
      copied++;
    } catch {
      // A vault that cannot be read fails a change; the other drafts go on.
    }
  };
  const end = (status: RestoreResult["status"], reason?: string) => {
    if (restored + copied > 0)
      try {
        deps.notify({ restored, left: copied });
      } catch {
        // A notification that fails changes nothing about the drafts.
      }
    return {
      status,
      restored,
      left: records.length - restored,
      ...(reason ? { reason } : {}),
    };
  };

  let next = 0;
  const typing = { wrote: false };
  let run: Run;
  try {
    // Waiting for the UI only inspects, so it holds no lock.
    const first = await uiReady(deps);
    if (!first) throw new Stop("pending", "not-ready");
    run = {
      account,
      pid: first.pid,
      anchored: false,
      lastSeen: first.localSessionId,
    };
    for (; next < records.length; next++) {
      typing.wrote = false;
      if (deps.now() - started >= BUDGET_MS)
        throw new Stop("pending", "budget");
      const record = records[next];
      const target = typeable(record);
      if (!target) {
        await leave(record, "manual");
        continue;
      }
      const reason = await locked(deps, async () => {
        await confirm(deps, run);
        return restoreOne(deps, run, target, record.text, typing);
      });
      if (reason !== undefined) await leave(record, reason);
      else {
        restored++;
        try {
          await deps.remove(record.id);
        } catch {
          // As above: the next drafts go on.
        }
      }
    }
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    if (error.leaves === "copy") {
      for (const record of records.slice(next))
        await leave(record, error.reason);
      return end("done");
    }
    // A draft being typed may be in its composer: copy, never type it again.
    if (typing.wrote) await leave(records[next], error.reason);
    return end("waiting", error.reason);
  }
  if (run.anchored && run.returnTo && run.returnTo !== run.lastSeen)
    try {
      await locked(deps, async () => {
        await confirm(deps, run);
        await deps.automation.openSession(run.returnTo!).catch(() => {
          // The user can go back by hand.
        });
      });
    } catch (error) {
      if (!(error instanceof Stop)) throw error;
      // The user moved, or Desktop is busy: the drafts are done, the user stays.
    }
  return end("done");
}

/** Claude runs, and has run long enough for Desktop's wipe to be over. */
async function claudeReady(deps: RestorerDeps): Promise<boolean> {
  if (!(await deps.running())) return false;
  const uptime = await deps.uptimeMs();
  return uptime !== undefined && uptime >= MIN_UPTIME_MS;
}

/** The `local_` id to open for `record`, or undefined when it can only be copied by hand. */
function typeable(record: DraftRecord): string | undefined {
  const { text, targetAlias, newSession } = record;
  if (
    newSession ||
    !targetAlias ||
    !text ||
    text.length > MAX_TEXT ||
    text.includes("\0")
  )
    return undefined;
  const target = `local_${targetAlias}`;
  return isLocalSessionId(target) ? target : undefined;
}

/** Runs `fn` under the Desktop lock. A busy lock stops the run. */
async function locked<T>(deps: RestorerDeps, fn: () => Promise<T>): Promise<T> {
  // Boxed, so a result of undefined is told apart from a busy lock.
  const box = await deps.withLock(async () => ({ value: await fn() }));
  if (!box) throw new Stop("pending", "busy");
  return box.value;
}

/**
 * Under the lock, before Relay acts: Desktop is on the run's account, Claude is the same
 * process and has run 15 s, and the screen shows what Relay last saw there. The first lock's
 * look is where the user is taken back to.
 */
async function confirm(deps: RestorerDeps, run: Run): Promise<void> {
  const account = await deps.currentAccount().catch(() => undefined);
  if (!(await deps.running().catch(() => false)))
    throw new Stop("pending", "claude-not-running");
  const uptime = await deps.uptimeMs().catch(() => undefined);
  if (
    !sameAccount(account, run.account) ||
    uptime === undefined ||
    uptime < MIN_UPTIME_MS
  )
    throw new Stop("pending", "changed");
  let view: Snapshot;
  try {
    view = await deps.automation.inspect();
  } catch (error) {
    haltOn(error);
    // What the user is looking at is unknown: as good as moved.
    throw new Stop("pending", "moved");
  }
  if (view.pid !== run.pid) throw new Stop("pending", "changed");
  if (view.localSessionId !== run.lastSeen) throw new Stop("pending", "moved");
  if (!run.anchored) {
    run.anchored = true;
    run.returnTo = view.localSessionId;
  }
}

/** The first answer from Desktop's UI, every 500 ms for up to 60 s. */
async function uiReady(deps: RestorerDeps): Promise<Snapshot | undefined> {
  const deadline = deps.now() + READY_MS;
  for (;;) {
    const view = await look(deps);
    if (view) return view;
    if (deps.now() >= deadline) return undefined;
    await deps.sleep(POLL_MS);
  }
}

/** `target` is on screen in the run's Claude, stopped, with its composer there. */
const composing = (view: Snapshot, run: Run, target: string) =>
  view.localSessionId === target &&
  view.pid === run.pid &&
  view.status === "stopped" &&
  view.composerPresent === true;

/** A guard from a view that shows the target. Without one, no draft can be typed. */
function guardOf(view: Snapshot): DesktopAutomationGuard {
  try {
    return automationGuard(view);
  } catch {
    throw new Stop("copy", "unsupported");
  }
}

/**
 * Types one draft into its conversation's empty composer and reads it again 5 s later.
 * Resolves with why it is left for copy, or undefined when it was restored. `typing.wrote`
 * tells whether a write was attempted, so the caller knows it may be in a composer.
 */
async function restoreOne(
  deps: RestorerDeps,
  run: Run,
  target: string,
  text: string,
  typing: { wrote: boolean },
): Promise<string | undefined> {
  let view = await show(deps, target);
  if (!view) return "exact-session-not-observed";
  run.lastSeen = target;
  if (view.status === "running" || view.status === "waiting") return "busy";
  if (view.composerPresent !== true || view.status !== "stopped")
    return "no-composer";
  if (!view.composerEmpty) return "composer-not-empty";
  // One write, and one more only when the same composer is seen there and empty again.
  for (let again = false; ; again = true) {
    const guard = guardOf(view);
    try {
      typing.wrote = true;
      await deps.automation.writeDraft(guard, text);
    } catch (error) {
      haltOn(error);
      // Past its guard a failed write may have typed the text: never type it blindly again.
      return issueOf(error);
    }
    await deps.sleep(RECHECK_MS);
    let fresh: Snapshot;
    try {
      fresh = await deps.automation.inspect();
    } catch (error) {
      haltOn(error);
      return "unconfirmed";
    }
    if (!composing(fresh, run, target)) return "unconfirmed";
    if (!fresh.composerEmpty) return undefined;
    if (again) return "lost";
    view = fresh;
  }
}

/**
 * Opens `target` and waits, every 500 ms for up to 30 s and sending the link again every 5 s,
 * until it shows with its composer or busy. Resolves with the last view when it shows by
 * then, with or without one, and undefined when it never shows.
 */
async function show(
  deps: RestorerDeps,
  target: string,
): Promise<Snapshot | undefined> {
  const deadline = deps.now() + SHOWN_MS;
  let openedAt = deps.now();
  await open(deps, target);
  for (;;) {
    const view = await look(deps);
    const shown = view?.localSessionId === target ? view : undefined;
    if (
      shown &&
      (shown.composerPresent === true ||
        shown.status === "running" ||
        shown.status === "waiting")
    )
      return shown;
    if (deps.now() >= deadline) return shown;
    await deps.sleep(POLL_MS);
    if (deps.now() - openedAt >= RESEND_MS && deps.now() < deadline) {
      openedAt = deps.now();
      await open(deps, target);
    }
  }
}

/** One inspect; undefined while Desktop cannot answer yet. */
async function look(deps: RestorerDeps): Promise<Snapshot | undefined> {
  try {
    return await deps.automation.inspect();
  } catch (error) {
    haltOn(error);
    return undefined;
  }
}

async function open(deps: RestorerDeps, target: string): Promise<void> {
  try {
    await deps.automation.openSession(target);
  } catch (error) {
    // A link that did not take is sent again; showing the conversation is what counts.
    haltOn(error);
  }
}
