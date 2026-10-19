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
import { logDraft, shortId, type DraftLog } from "./draft-diagnostics";
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
  /**
   * When Desktop last finished its draft wipe (`chat-draft-wipe-completed-at`, ms since the
   * epoch), as its Local Storage says; undefined when unknown. Without it, Claude is ready only
   * once it has run 15 s.
   */
  wipedAt?(): Promise<number | undefined>;
  /** Runs `fn` holding Relay's Desktop lock; undefined, without running it, when busy. */
  withLock<T>(fn: () => Promise<T>): Promise<T | undefined>;
  /** True when another caller waits for the Desktop lock while the restore holds it. */
  yielding(): boolean;
  notify(summary: { restored: number; left: number }): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  /**
   * A diagnosis log: each step of a run, as an event and fields that are ids (cut to 8
   * characters), states, reasons, issue codes, counts and booleans. Never a draft's text or
   * title, and never an error's message. A log that throws changes nothing about the run.
   */
  log?: DraftLog;
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
   * - `active`: Claude was not in front, the user had input in the last 3 s before Relay
   *   would take them elsewhere, or pressed a key in the last 1 s before Relay would type
   *   where they are, so Relay did not open or type anything;
   * - `elsewhere`: a draft's place was not on screen and Relay may not take the user there
   *   now (the run allows no visits, or where the user is cannot be told, so they could not
   *   be brought back); it stays pending for the user to open it;
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
/** A place for the diagnosis log: a conversation's alias cut to 8 characters, or the screen. */
const placeLabel = (place: Place | undefined): string | null =>
  place === undefined
    ? null
    : place === NEW_SESSION
      ? place
      : shortId(place.replace(/^local_/, ""));

/**
 * Desktop wipes its drafts about 2–6 s after an account loads. Without its marker, restore
 * only once Claude has run this long.
 */
const MIN_UPTIME_MS = 15_000;
/**
 * `ps etime` counts whole seconds, so Claude's start as Relay works it out may be up to 1 s
 * late: a wipe this much before it still counts as this launch's.
 */
const WIPE_SLACK_MS = 1_000;
/** How long a run right after a switch waits for Claude to start. */
const LAUNCH_MS = 10_000;
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
 * How long the user must have left the keyboard and mouse alone before Relay takes them to
 * another place.
 */
export const IDLE_MS = 3_000;
/**
 * How long no key may have been pressed before Relay types: where the user is, or after it
 * took them there. A mouse that moves does not count.
 */
export const QUIET_MS = 1_000;

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
 * Claude is in front and the user has not touched the keyboard or mouse for 3 s, so Relay may
 * take them to another place. A view that does not say is not one.
 */
const letsAct = (view: Snapshot) =>
  view.frontmost === true && (view.idleMs ?? 0) >= IDLE_MS;
/**
 * Claude is in front and no key has been pressed for 1 s, so Relay may type where the user
 * is: none of their keystrokes is on its way to the composer. A view from a helper that does
 * not tell keys apart needs 3 s without any input.
 */
const letsType = (view: Snapshot) =>
  view.frontmost === true &&
  (view.keyIdleMs !== undefined
    ? view.keyIdleMs >= QUIET_MS
    : (view.idleMs ?? 0) >= IDLE_MS);

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
  /** Desktop's wipe is known to be past from its marker, so 15 s of uptime is not needed. */
  wiped: boolean;
  /** Relay may take the user to a place not on screen, and back. */
  visits: boolean;
  /** Set by the first lock's look at the screen. */
  anchored: boolean;
  /** The place the user was on, to take them back to. */
  returnTo?: Place;
  /** The place Relay last saw on screen. Anything else means the user moved. */
  lastSeen?: Place;
}

export interface RestoreOptions {
  /**
   * Relay may take the user to a draft's place that is not on screen, and back; true unless
   * said otherwise. Without, only the drafts whose place is on screen are typed.
   */
  visits?: boolean;
  /** Right after a switch: Claude may still be starting, so the run waits up to 10 s for it. */
  launching?: boolean;
}

/** The place a draft is typed into, or undefined when it can only be copied by hand. */
export const draftPlace = (record: DraftRecord): string | undefined =>
  typeable(record);

/**
 * Types the drafts captured for Desktop's current account back into the empty composers of
 * their conversations, and of Code's new-session screen for the draft of a session that does
 * not exist yet, once Desktop's draft wipe is past, and takes the user back to where they
 * were. It never sends, and never writes into a composer that is not empty.
 *
 * The wipe is past once Desktop's marker says it finished after Claude started, or once Claude
 * has run 15 s; a run that finds Claude running but not there yet waits for it, checking the
 * marker every 500 ms. It waits for Desktop's UI without the Desktop lock, then takes the lock
 * for each draft and re-checks Claude under it. The draft whose place is on screen goes
 * first, and is typed where the user is while Claude is in front and no key has been pressed
 * for 1 s. Taking the user elsewhere needs the run to allow visits, a place to bring them
 * back to, and Claude in front with the user idle for 3 s; a draft that cannot be gone to now
 * stays pending, and the run ends `elsewhere`. It stops, leaving the rest pending, when the
 * lock is busy or another operation waits for it, the user is active or moves, Claude
 * changes or the run passes 5 minutes. A draft it cannot type, or cannot see in its composer
 * afterwards, is marked `needs-copy` with the reason: `maybe-typed` once a write was tried,
 * except a write the helper refused for want of accessibility, which typed nothing and stays
 * `accessibility`.
 */
export async function restoreDrafts(
  deps: RestorerDeps,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  let result: RestoreResult;
  try {
    result = await restore(deps, options);
  } catch (error) {
    // Its name only: a message could hold anything, a draft's text included.
    logDraft(deps.log, "restore-end", {
      status: "threw",
      error: error instanceof Error ? error.name : "unknown",
      ...(error instanceof DesktopAutomationError
        ? { issue: error.issue }
        : {}),
    });
    throw error;
  }
  logDraft(deps.log, "restore-end", {
    status: result.status,
    restored: result.restored,
    left: result.left,
    reason: result.reason ?? null,
  });
  return result;
}

async function restore(
  deps: RestorerDeps,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const started = deps.now();
  let account: string | undefined;
  let records: DraftRecord[] = [];
  /** Every record read, whatever its account or state; undefined before they are read. */
  let all: number | undefined;
  let ready: Ready | undefined;
  const start = (ready: Ready | undefined | null, error?: string) =>
    logDraft(deps.log, "restore-start", {
      account: shortId(account),
      records: records.length,
      all: all ?? null,
      ready: ready === null ? null : !!ready,
      ...(ready ? { wiped: ready.wiped, waitedMs: ready.waitedMs } : {}),
      ...(error ? { error } : {}),
    });
  try {
    account = await deps.currentAccount();
    if (!account) {
      start(null);
      return { status: "idle", restored: 0, left: 0 };
    }
    const read = await deps.pending();
    all = read.length;
    records = read.filter(
      (record) => record.state === "pending" && sameAccount(account, record.to),
    );
    if (!records.length) {
      start(null);
      return { status: "idle", restored: 0, left: 0 };
    }
    ready = await claudeReady(deps, options.launching === true);
  } catch {
    start(undefined, "start-failed");
    return { status: "waiting", restored: 0, left: records.length };
  }
  start(ready);
  if (!ready) return { status: "waiting", restored: 0, left: records.length };

  let restored = 0;
  let copied = 0;
  const leave = async (record: DraftRecord, reason: string) => {
    let marked = false;
    try {
      await deps.mark(record.id, "needs-copy", reason);
      copied++;
      marked = true;
    } catch {
      // A vault that cannot be read fails a change; the other drafts go on.
    }
    logDraft(deps.log, "leave", { id: shortId(record.id), reason, marked });
  };
  /** Drafts whose place was not on screen and could not be gone to: still pending. */
  let skipped = 0;
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
      wiped: ready.wiped,
      visits: options.visits !== false,
      anchored: false,
      lastSeen: placeOf(first),
    };
    // The draft of the place on screen first: it needs no visit.
    const here = placeOf(first);
    records = [
      ...records.filter((record) => here && typeable(record) === here),
      ...records.filter((record) => !here || typeable(record) !== here),
    ];
    for (; next < records.length; next++) {
      typing.wrote = false;
      if (deps.now() - started >= BUDGET_MS)
        throw new Stop("pending", "budget");
      const record = records[next];
      const id = shortId(record.id);
      logDraft(deps.log, "record-start", {
        id,
        target: shortId(record.targetAlias),
        newSession: record.newSession === true,
      });
      const target = typeable(record);
      if (!target) {
        await leave(record, "manual");
        continue;
      }
      const reason = await locked(deps, async () => {
        if ((await confirm(deps, run, target)) === SKIP) return SKIP;
        return restoreOne(deps, run, target, record.text, typing, id);
      });
      if (reason === SKIP) {
        skipped++;
        logDraft(deps.log, "skip", {
          id,
          visits: run.visits,
          returnKnown: run.returnTo !== undefined,
        });
      } else if (reason !== undefined) await leave(record, reason);
      else {
        restored++;
        let removed = true;
        try {
          await deps.remove(record.id);
        } catch {
          // As above: the next drafts go on.
          removed = false;
        }
        logDraft(deps.log, "restored", { id, removed });
      }
    }
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    logDraft(deps.log, "stop", {
      leaves: error.leaves,
      reason: error.reason,
      wrote: typing.wrote,
      phase: "records",
    });
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
        // Relay went there itself, so a visit is allowed: SKIP never comes back here.
        if ((await confirm(deps, run, run.returnTo!)) === SKIP) return;
        await go(deps, run.returnTo!).catch(() => {
          // The user can go back by hand, and one who is active stays where they are.
        });
      });
    } catch (error) {
      if (!(error instanceof Stop)) throw error;
      // The user moved, or Desktop is busy: the drafts are done, the user stays.
      logDraft(deps.log, "stop", {
        leaves: error.leaves,
        reason: error.reason,
        wrote: false,
        phase: "return",
      });
    }
  return skipped ? end("waiting", "elsewhere") : end("done");
}

/** Claude is ready: `wiped` when its marker said so before 15 s; how long the run waited. */
interface Ready {
  wiped: boolean;
  waitedMs: number;
}

/**
 * Claude runs, and Desktop's wipe is over: its marker says it finished after Claude started,
 * or Claude has run 15 s. While Claude runs but neither holds yet, it waits, reading the
 * marker every 500 ms; the uptime is read once and counted on from there, so `ps` runs once.
 * With `launching`, it first waits up to 10 s for Claude to run at all. Undefined when Claude
 * does not run or its uptime cannot be read.
 */
async function claudeReady(
  deps: RestorerDeps,
  launching: boolean,
): Promise<Ready | undefined> {
  const begun = deps.now();
  let uptime: number | undefined;
  for (;;) {
    if (await deps.running()) uptime = await deps.uptimeMs();
    if (uptime !== undefined) break;
    if (!launching || deps.now() - begun >= LAUNCH_MS) return undefined;
    await deps.sleep(POLL_MS);
  }
  const read = deps.now();
  const startedAt = read - uptime;
  for (;;) {
    const waitedMs = deps.now() - begun;
    if (uptime + (deps.now() - read) >= MIN_UPTIME_MS)
      return { wiped: false, waitedMs };
    const wipedAt = await deps.wipedAt?.().catch(() => undefined);
    if (wipedAt !== undefined && wipedAt >= startedAt - WIPE_SLACK_MS)
      return { wiped: true, waitedMs };
    await deps.sleep(POLL_MS);
  }
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

/** What `confirm` says of a draft whose place is not on screen and cannot be gone to now. */
const SKIP = Symbol("skip");

/** Runs `fn` under the Desktop lock. A busy lock stops the run. */
async function locked<T>(deps: RestorerDeps, fn: () => Promise<T>): Promise<T> {
  // Boxed, so a result of undefined is told apart from a busy lock.
  const box = await deps.withLock(async () => ({ value: await fn() }));
  if (!box) throw new Stop("pending", "busy");
  return box.value;
}

/**
 * Under the lock, before Relay acts on `target`: Desktop is on the run's account, Claude is
 * the same process and past its wipe (by its marker, or 15 s of uptime), and the screen shows
 * what Relay last saw there. The first lock's look is where the user is taken back to, and
 * nothing the screen showed before it counts as the user moving. With `target` on screen,
 * Claude must be in front with no key pressed for 1 s. Elsewhere, Relay goes there only when
 * the run allows visits and knows where to bring the user back, and then with Claude in front
 * and the user idle for 3 s; without both, SKIP.
 */
async function confirm(
  deps: RestorerDeps,
  run: Run,
  target: Place,
): Promise<typeof SKIP | void> {
  const account = await deps.currentAccount().catch(() => undefined);
  if (!(await deps.running().catch(() => false)))
    throw new Stop("pending", "claude-not-running");
  const uptime = await deps.uptimeMs().catch(() => undefined);
  if (
    !sameAccount(account, run.account) ||
    uptime === undefined ||
    (uptime < MIN_UPTIME_MS && !run.wiped)
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
  const place = placeOf(view);
  if (!run.anchored) {
    // Relay has done nothing yet, so a screen still settling is no move of the user's.
    run.anchored = true;
    run.returnTo = place;
    run.lastSeen = place;
  } else if (place !== run.lastSeen) throw new Stop("pending", "moved");
  if (place === target) {
    if (!letsType(view)) throw new Stop("pending", "active");
    return;
  }
  if (!run.visits || run.returnTo === undefined) return SKIP;
  if (!letsAct(view)) throw new Stop("pending", "active");
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
 * was, every reason but `lost` and `composer-not-empty` is `maybe-typed`. A write refused for
 * want of accessibility or because the user was active typed nothing and resets it.
 */
async function restoreOne(
  deps: RestorerDeps,
  run: Run,
  target: Place,
  text: string,
  typing: { wrote: boolean },
  /** The draft's id, cut to 8 characters, for the diagnosis log. */
  id: string | null,
): Promise<string | undefined> {
  const seen: { view?: Snapshot } = {};
  let view = await show(deps, run, target, seen);
  if (!view) {
    const last = seen.view;
    logDraft(deps.log, "shown-timeout", {
      id,
      sessionMatches: !!last && placeOf(last) === target,
      seen: last ? placeLabel(placeOf(last)) : null,
      status: last?.status ?? null,
      composerPresent: last?.composerPresent ?? null,
    });
    return "exact-session-not-observed";
  }
  logDraft(deps.log, "shown", {
    id,
    matched: shows(view, target),
    status: view.status,
    composerPresent: view.composerPresent ?? null,
    composerEmpty: view.composerEmpty,
    frontmost: view.frontmost ?? null,
    idleMs: view.idleMs ?? null,
    guardable: guardable(view, target),
    sessionMatches: placeOf(view) === target,
  });
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
    const attempt = again ? 2 : 1;
    try {
      typing.wrote = true;
      await deps.automation.writeDraft(guard, text, { keysIdleMs: QUIET_MS });
      logDraft(deps.log, "write", { id, ok: true, attempt });
    } catch (error) {
      logDraft(deps.log, "write", {
        id,
        ok: false,
        attempt,
        issue: issueOf(error),
      });
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
      logDraft(deps.log, "recheck", {
        id,
        inspected: false,
        issue: issueOf(error),
      });
      haltOn(error);
      return afterWrite("unconfirmed");
    }
    logDraft(deps.log, "recheck", {
      id,
      composerPresent: fresh.composerPresent ?? null,
      composerEmpty: fresh.composerEmpty,
      status: fresh.status,
      pidSame: fresh.pid === run.pid,
      sessionMatches: placeOf(fresh) === target,
    });
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

/**
 * `view` shows `target` with a composer a draft can be typed into, or one that already holds
 * text, which no draft is typed into, or busy.
 */
const shows = (view: Snapshot, target: Place) =>
  placeOf(view) === target &&
  ((view.composerPresent === true &&
    (guardable(view, target) || !view.composerEmpty)) ||
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
  /** Set to the last view seen, for the diagnosis log when the target never shows. */
  seen: { view?: Snapshot },
): Promise<Snapshot | undefined> {
  const deadline = deps.now() + SHOWN_MS;
  let openedAt: number | undefined;
  /** The target has been on screen: from then on only it, or loading, is waited for. */
  let appeared = false;
  for (;;) {
    yieldTo(deps);
    const view = await look(deps);
    if (view) seen.view = view;
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
