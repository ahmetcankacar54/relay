import {
  automationGuard,
  DesktopAutomationError,
  type DesktopAutomation,
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
  /** Drafts typed into their composer and still there 5 s later. */
  restored: number;
  /** This account's other pending drafts: now left for copy, or still pending. */
  left: number;
  /** Marks and removals the vault refused, when there were any. The rest went on. */
  vaultErrors?: number;
};

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
/** The longest draft `writeDraft` takes. Longer ones are left for Copy. */
const MAX_TEXT = 16_384;

type Halting = "accessibility-permission-required" | "claude-not-running";
/** Thrown through a draft's steps when the whole restore must stop. */
class Halt {
  constructor(readonly issue: Halting) {}
}
const issueOf = (error: unknown): DesktopAutomationIssue =>
  error instanceof DesktopAutomationError
    ? error.issue
    : "desktop-ui-unsupported";
/** Throws a Halt when `error` ends the restore. Any other failure is the caller's. */
function haltOn(error: unknown): void {
  const issue = issueOf(error);
  if (
    issue === "accessibility-permission-required" ||
    issue === "claude-not-running"
  )
    throw new Halt(issue);
}

const sameAccount = (a: string | undefined, b: string) =>
  !!a && a.toLowerCase() === b.toLowerCase();

interface Due {
  account: string;
  records: DraftRecord[];
  /** Claude runs, and has run long enough for Desktop's wipe to be over. */
  ready: boolean;
}
/** The pending drafts of Desktop's current account, or undefined when there are none. */
async function due(deps: RestorerDeps): Promise<Due | undefined> {
  const account = await deps.currentAccount();
  if (!account) return undefined;
  const records = (await deps.pending()).filter(
    (record) => record.state === "pending" && sameAccount(account, record.to),
  );
  if (!records.length) return undefined;
  const uptime = (await deps.running()) ? await deps.uptimeMs() : undefined;
  return {
    account,
    records,
    ready: uptime !== undefined && uptime >= MIN_UPTIME_MS,
  };
}

const outcome = (
  status: RestoreResult["status"],
  restored: number,
  left: number,
  vaultErrors = 0,
): RestoreResult => ({
  status,
  restored,
  left,
  ...(vaultErrors ? { vaultErrors } : {}),
});

/**
 * Types the drafts captured for Desktop's current account back into their conversations'
 * empty composers, once Claude has run 15 s, and returns the user to the conversation they
 * were on. It never sends, and never writes into a composer that is not empty. A draft it
 * cannot type is marked `needs-copy` with the reason. It acts in Desktop only while holding
 * Relay's Desktop lock, and does nothing when Desktop is busy.
 */
export async function restoreDrafts(
  deps: RestorerDeps,
): Promise<RestoreResult> {
  let before: Due | undefined;
  try {
    before = await due(deps);
  } catch {
    return outcome("waiting", 0, 0);
  }
  if (!before) return outcome("idle", 0, 0);
  const count = before.records.length;
  if (!before.ready) return outcome("waiting", 0, count);
  const ran = await deps.withLock(async () => {
    // Read again under the lock: a switch may have ended in between.
    let now: Due | undefined;
    try {
      now = await due(deps);
    } catch {
      return outcome("waiting", 0, count);
    }
    if (!now) return outcome("idle", 0, 0);
    if (!now.ready) return outcome("waiting", 0, now.records.length);
    return restore(deps, now);
  });
  return ran ?? outcome("waiting", 0, count);
}

async function restore(
  deps: RestorerDeps,
  { account, records }: Due,
): Promise<RestoreResult> {
  let restored = 0;
  let vaultErrors = 0;
  // A vault that cannot be read fails a change; the other drafts go on.
  const change = async (step: () => Promise<void>) => {
    try {
      await step();
    } catch {
      vaultErrors++;
    }
  };
  const leave = (record: DraftRecord, reason: string) =>
    change(() => deps.mark(record.id, "needs-copy", reason));
  const finish = (status: RestoreResult["status"]) =>
    outcome(status, restored, records.length - restored, vaultErrors);
  const tell = () => {
    try {
      deps.notify({ restored, left: records.length - restored });
    } catch {
      // A notification that fails changes nothing about the drafts.
    }
  };
  let next = 0;
  const typing = { wrote: false };
  let returnTo: string | undefined;
  let lastOpened: string | undefined;
  try {
    const first = await ready(deps);
    if (!first) return finish("waiting");
    returnTo = first.localSessionId;
    for (; next < records.length; next++) {
      // Desktop's account can change under a restore. The rest wait for theirs.
      const current = await deps.currentAccount().catch(() => undefined);
      if (!sameAccount(current, account)) return finish("waiting");
      const record = records[next];
      typing.wrote = false;
      const reason = await restoreOne(deps, record, typing, (target) => {
        lastOpened = target;
      });
      if (reason === undefined) {
        restored++;
        await change(() => deps.remove(record.id));
      } else await leave(record, reason);
    }
  } catch (error) {
    if (!(error instanceof Halt)) throw error;
    if (error.issue === "claude-not-running") {
      // A draft being typed may be in its composer: copy, never type again. The rest wait.
      if (typing.wrote) await leave(records[next], error.issue);
      return finish("waiting");
    }
    // Without accessibility nothing more can be typed.
    for (const record of records.slice(next))
      await leave(record, "accessibility");
    tell();
    return finish("done");
  }
  if (returnTo && lastOpened && returnTo !== lastOpened)
    await deps.automation.openSession(returnTo).catch(() => {
      // The user can go back by hand; the drafts are done either way.
    });
  tell();
  return finish("done");
}

/** The first answer from Desktop's UI, every 500 ms for up to 60 s. */
async function ready(
  deps: RestorerDeps,
): Promise<DesktopAutomationSnapshot | undefined> {
  const deadline = deps.now() + READY_MS;
  for (;;) {
    const view = await look(deps);
    if (view) return view;
    if (deps.now() >= deadline) return undefined;
    await deps.sleep(POLL_MS);
  }
}

/**
 * Types one draft into its conversation's empty composer and reads it again 5 s later.
 * Resolves with why it is left for copy, or undefined when it was restored. `typing.wrote`
 * tells whether a write was attempted, so the caller knows it may be in a composer.
 */
async function restoreOne(
  deps: RestorerDeps,
  record: DraftRecord,
  typing: { wrote: boolean },
  opened: (target: string) => void,
): Promise<string | undefined> {
  const { text, targetAlias } = record;
  if (
    record.newSession ||
    !targetAlias ||
    !text ||
    text.length > MAX_TEXT ||
    text.includes("\0")
  )
    return "manual";
  const target = `local_${targetAlias}`;
  opened(target);
  let view = await show(deps, target);
  if (!view) return "exact-session-not-observed";
  if (view.status !== "stopped") return "busy";
  if (!view.composerEmpty) return "composer-not-empty";
  // One write, and one more only when this conversation's composer is found empty again.
  for (let again = false; ; again = true) {
    try {
      const guard = automationGuard(view);
      typing.wrote = true;
      await deps.automation.writeDraft(guard, text);
    } catch (error) {
      haltOn(error);
      // Past its guard a failed write may have typed the text: never type it blindly again.
      return issueOf(error);
    }
    await deps.sleep(RECHECK_MS);
    try {
      view = await deps.automation.inspect();
    } catch (error) {
      haltOn(error);
      return issueOf(error);
    }
    const here = view.localSessionId === target;
    // With no composer on screen the helper reads it as not empty, which proves nothing.
    if (here && view.status !== "unknown" && !view.composerEmpty)
      return undefined;
    if (again) return "lost";
    if (!here) return "context-changed";
    // An emptied composer in a running conversation may have been sent.
    if (view.status !== "stopped") return "busy";
  }
}

/**
 * Opens `target` and waits until it shows, loaded, every 500 ms for up to 30 s, sending the
 * link again every 5 s. Undefined when it never shows.
 */
async function show(
  deps: RestorerDeps,
  target: string,
): Promise<DesktopAutomationSnapshot | undefined> {
  const deadline = deps.now() + SHOWN_MS;
  let openedAt = deps.now();
  await open(deps, target);
  for (;;) {
    const view = await look(deps);
    if (view && loaded(view, target)) return view;
    if (deps.now() >= deadline) return undefined;
    await deps.sleep(POLL_MS);
    if (deps.now() - openedAt >= RESEND_MS && deps.now() < deadline) {
      openedAt = deps.now();
      await open(deps, target);
    }
  }
}

/** `target` is on screen with its composer, and a guard can be taken from the view. */
const loaded = (view: DesktopAutomationSnapshot, target: string) =>
  view.localSessionId === target &&
  view.status !== "unknown" &&
  !!view.accountLabel &&
  !!view.permissionMode;

/** One inspect; undefined while Desktop cannot answer yet. */
async function look(
  deps: RestorerDeps,
): Promise<DesktopAutomationSnapshot | undefined> {
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
