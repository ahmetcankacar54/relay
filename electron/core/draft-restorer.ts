import {
  automationGuard,
  DesktopAutomationError,
  isLocalSessionId,
  newSessionGuard,
  type DesktopAutomation,
  type DesktopAutomationIssue,
  type DesktopAutomationSnapshot,
  type DesktopDraftGuard,
} from "./desktop-continuation-host";
import type { DraftRecord, DraftState } from "./draft-vault";

export interface RestorerDeps {
  automation: Pick<
    DesktopAutomation,
    "inspect" | "openSession" | "openNewSession" | "writeDraft"
  >;
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
  /** True when another caller waits for the Desktop lock while the restore holds it. */
  yielding(): boolean;
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
   * - `busy`: another Desktop operation held the lock, or waited for it;
   * - `active`: Claude was not in front, or the user had input in the last 3 s, so Relay
   *   did not open or type anything;
   * - `moved`: the user went to another conversation or screen;
   * - `changed`: Claude's account, uptime or process changed;
   * - `claude-not-running`;
   * - `budget`: the run took 5 minutes.
   */
  reason?: string;
};

type Snapshot = DesktopAutomationSnapshot;

/** Code's new-session screen, where the draft of a session that does not exist yet goes. */
const NEW_SESSION = "new-session";
/** Where a draft goes, or where the user is: a conversation's `local_` id, or NEW_SESSION. */
type Place = string;
/**
 * The place `view` shows: a conversation, the new-session screen, or undefined while Desktop
 * loads or shows a screen Relay does not name.
 */
const placeOf = (view: Snapshot): Place | undefined =>
  view.localSessionId ?? (view.newSession === true ? NEW_SESSION : undefined);

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
/** How long the user must have left the keyboard and mouse alone before Relay acts. */
const IDLE_MS = 3_000;

/**
 * Ends a run. With `pending`, the draft in hand and those after it stay pending; with `copy`,
 * they are all left for copy with `reason`. Either way a draft in hand that was being typed
 * is left for copy as `maybe-typed`.
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

/**
 * Claude is in front and the user has not touched the keyboard or mouse for 3 s, so nothing
 * Relay opens or types meets the user's keystrokes. A view that does not say is not one.
 */
const letsAct = (view: Snapshot) =>
  view.frontmost === true && (view.idleMs ?? 0) >= IDLE_MS;

/**
 * Why a draft is left for copy once a write was tried: it may be in its composer, unless
 * Desktop wiped it twice or the helper found the composer not empty and typed nothing.
 */
const afterWrite = (reason: string) =>
  reason === "lost" || reason === "composer-not-empty" ? reason : "maybe-typed";

/** Another Desktop operation waits for the lock: let it go first. */
function yieldTo(deps: RestorerDeps): void {
  if (deps.yielding()) throw new Stop("pending", "busy");
}

/** What a run holds to: Desktop's account and Claude's process, and where the user is. */
interface Run {
  account: string;
  pid: number;
  /** Set by the first lock's look at the screen. */
  anchored: boolean;
  /** The place the user was on, to take them back to. */
  returnTo?: Place;
  /** The place Relay last saw on screen. Anything else means the user moved. */
  lastSeen?: Place;
}

/**
 * Types the drafts captured for Desktop's current account back into the empty composers of
 * their conversations, and of Code's new-session screen for the draft of a session that does
 * not exist yet, once Claude has run 15 s, and takes the user back to where they were. It
 * never sends, and never writes into a composer that is not empty.
 *
 * It waits for Desktop's UI without the Desktop lock, then takes the lock for each draft and
 * re-checks Claude under it. It acts only while Claude is in front and the user has left it
 * alone for 3 s. It stops, leaving the rest pending, when the lock is busy or another
 * operation waits for it, the user is active or moves, Claude changes or the run passes 5
 * minutes. A draft it cannot type, or cannot see in its composer afterwards, is marked
 * `needs-copy` with the reason: `maybe-typed` once a write was tried.
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
      lastSeen: placeOf(first),
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
    // A draft being typed may be in its composer: copy, never type it again. As `maybe-typed`,
    // so no retry after accessibility sets it back to pending.
    if (error.leaves === "copy") {
      for (let i = next; i < records.length; i++)
        await leave(
          records[i],
          i === next && typing.wrote ? "maybe-typed" : error.reason,
        );
      return end("done");
    }
    if (typing.wrote) await leave(records[next], "maybe-typed");
    return end("waiting", error.reason);
  }
  if (run.anchored && run.returnTo && run.returnTo !== run.lastSeen)
    try {
      await locked(deps, async () => {
        await confirm(deps, run);
        await go(deps, run.returnTo!).catch(() => {
          // The user can go back by hand, and one who is active stays where they are.
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

/**
 * Where `record` is typed: its conversation's `local_` id, or the new-session screen for the
 * draft of a session that does not exist yet. Undefined when it can only be copied by hand.
 */
function typeable(record: DraftRecord): Place | undefined {
  const { text, targetAlias, newSession } = record;
  if (!text || text.length > MAX_TEXT || text.includes("\0")) return undefined;
  if (newSession) return NEW_SESSION;
  if (!targetAlias) return undefined;
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
 * process and has run 15 s, the screen shows what Relay last saw there, and Claude is in
 * front with the user idle. The first lock's look is where the user is taken back to.
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
  if (placeOf(view) !== run.lastSeen) throw new Stop("pending", "moved");
  if (!letsAct(view)) throw new Stop("pending", "active");
  if (!run.anchored) {
    run.anchored = true;
    run.returnTo = placeOf(view);
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
const composing = (view: Snapshot, run: Run, target: Place) =>
  placeOf(view) === target &&
  view.pid === run.pid &&
  view.status === "stopped" &&
  view.composerPresent === true;

/** The guard for typing into `target`, from a view that shows it; throws without one. */
const guardFor = (view: Snapshot, target: Place): DesktopDraftGuard =>
  target === NEW_SESSION ? newSessionGuard(view) : automationGuard(view);

/**
 * A guard from a view that shows the target. Without one no draft can be typed there. A
 * conversation without one means none can be guarded, which stops the run; the new-session
 * screen is a screen of its own, so undefined leaves only its draft for copy.
 */
function guardOf(view: Snapshot, target: Place): DesktopDraftGuard | undefined {
  try {
    return guardFor(view, target);
  } catch {
    if (target === NEW_SESSION) return undefined;
    throw new Stop("copy", "unsupported");
  }
}

/**
 * Types one draft into its conversation's empty composer and reads it again 5 s later.
 * Resolves with why it is left for copy, or undefined when it was restored. `typing.wrote`
 * tells whether a write was attempted, so the caller knows it may be in a composer; once it
 * was, every reason but `lost` and `composer-not-empty` is `maybe-typed`.
 */
async function restoreOne(
  deps: RestorerDeps,
  run: Run,
  target: Place,
  text: string,
  typing: { wrote: boolean },
): Promise<string | undefined> {
  let view = await show(deps, run, target);
  if (!view) return "exact-session-not-observed";
  run.lastSeen = target;
  if (view.status === "running" || view.status === "waiting") return "busy";
  if (view.composerPresent !== true || view.status !== "stopped")
    return "no-composer";
  if (!view.composerEmpty) return "composer-not-empty";
  // One write, and one more only when the same composer is seen there and empty again.
  for (let again = false; ; again = true) {
    const guard = guardOf(view, target);
    if (!guard) return typing.wrote ? afterWrite("unsupported") : "unsupported";
    // Before the first write only: a rewrite finishes what the first one started.
    if (!typing.wrote) yieldTo(deps);
    try {
      typing.wrote = true;
      await deps.automation.writeDraft(guard, text);
    } catch (error) {
      // Without accessibility the helper can neither read nor type into Desktop's UI, so
      // nothing reached a composer: the draft stays retryable once access is granted.
      if (issueOf(error) === "accessibility-permission-required")
        typing.wrote = false;
      haltOn(error);
      if (issueOf(error) === "user-active") {
        // Refused before anything was typed: the draft waits for the user to pause.
        typing.wrote = false;
        throw new Stop("pending", "active");
      }
      // Past its guard a failed write may have typed the text: never type it blindly again.
      return afterWrite(issueOf(error));
    }
    await deps.sleep(RECHECK_MS);
    let fresh: Snapshot;
    try {
      fresh = await deps.automation.inspect();
    } catch (error) {
      haltOn(error);
      return afterWrite("unconfirmed");
    }
    if (!composing(fresh, run, target)) return afterWrite("unconfirmed");
    if (!fresh.composerEmpty) return undefined;
    if (again) return "lost";
    view = fresh;
  }
}

/** A guard for `target` can be built from `view`, so a draft can be typed into it. */
function guardable(view: Snapshot, target: Place): boolean {
  try {
    guardFor(view, target);
    return true;
  } catch {
    return false;
  }
}

/** `view` shows `target` with a composer a draft can be typed into, or busy. */
const shows = (view: Snapshot, target: Place) =>
  placeOf(view) === target &&
  ((view.composerPresent === true && guardable(view, target)) ||
    view.status === "running" ||
    view.status === "waiting");

/**
 * Waits, every 500 ms for up to 30 s, until `target` shows with a composer that can be
 * guarded, or busy. Until the target has appeared, it opens `target` only while the screen
 * still shows the place Relay last saw there, or is loading, and sends the link again every
 * 5 s while it does; it never opens a target already on screen, and never sends the link
 * again once the target has appeared. Any other place, a conversation or the new-session
 * screen, and after the target has appeared any place but the target, means the user moved:
 * it stops, and never takes them back. It opens nothing unless Claude is in front and the
 * user idle, and gives way to a Desktop operation waiting for the lock. Resolves with the
 * target's last view when it shows by then, guardable or not, and undefined when it is not
 * on screen at the end.
 */
async function show(
  deps: RestorerDeps,
  run: Run,
  target: Place,
): Promise<Snapshot | undefined> {
  const deadline = deps.now() + SHOWN_MS;
  let openedAt: number | undefined;
  /** The target has been on screen: from then on only it, or loading, is waited for. */
  let appeared = false;
  for (;;) {
    yieldTo(deps);
    const view = await look(deps);
    const place = view && placeOf(view);
    if (view && place === target) {
      appeared = true;
      if (shows(view, target) || deps.now() >= deadline) return view;
    } else if (place !== undefined && (appeared || place !== run.lastSeen)) {
      throw new Stop("pending", "moved");
    } else if (deps.now() >= deadline) {
      return undefined;
    } else if (
      // Without a view nothing says Relay may act: it looks again first.
      !appeared &&
      view &&
      (openedAt === undefined || deps.now() - openedAt >= RESEND_MS)
    ) {
      if (!letsAct(view)) throw new Stop("pending", "active");
      yieldTo(deps);
      openedAt = deps.now();
      await open(deps, target);
      // Look again at once: Desktop may already be there.
      continue;
    }
    await deps.sleep(POLL_MS);
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

/** Sends the link to `place`, the helper checking right before it that the user is idle. */
const go = (deps: RestorerDeps, place: Place) =>
  place === NEW_SESSION
    ? deps.automation.openNewSession({ requireIdle: true })
    : deps.automation.openSession(place, { requireIdle: true });

/** Opens `target`, the helper checking right before it that the user is idle. */
async function open(deps: RestorerDeps, target: Place): Promise<void> {
  try {
    await go(deps, target);
  } catch (error) {
    haltOn(error);
    // Nothing was opened: the drafts wait for the user to pause.
    if (issueOf(error) === "user-active") throw new Stop("pending", "active");
    // A link that did not take is sent again; showing the conversation is what counts.
  }
}
