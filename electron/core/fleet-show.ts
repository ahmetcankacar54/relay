import {
  DesktopAutomationError,
  type DesktopAutomationSnapshot,
} from "./desktop-continuation-host";

/** How long a continuation waits for its conversation to show after a switch. */
export const CONTINUE_SHOW_MS = 3 * 60_000;
/** No input for this long: the user is not at work in Claude, and Relay may act there. */
export const CONTINUE_IDLE_MS = 5_000;
/** The least time between two links to the same conversation: each makes Claude load its page again. */
export const CONTINUE_REOPEN_MS = 30_000;
/** The most links one continuation sends. */
export const CONTINUE_OPENS = 3;
/** How often the conversation's transcript is read again for a turn of the user's own. */
const MOVED_CHECK_MS = 5_000;
const POLL_MS = 1_000;

export interface ShowDeps {
  inspect(): Promise<DesktopAutomationSnapshot>;
  open(localSessionId: string): Promise<void>;
  /** Whether Claude's page has booted; false holds the links back, undefined does not. */
  booted(): Promise<boolean | undefined>;
  /** The stopped conversation has not moved on: no turn since the stop, the user's own included. */
  unchanged(): boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export type ShowResult =
  | { shown: DesktopAutomationSnapshot }
  | {
      skipped: "moved-on" | "not-shown" | "user-active";
      last?: DesktopAutomationSnapshot;
      issue?: string;
      opened: number;
    };

/**
 * Waits until `localSessionId` shows in Claude with its mode readable and the user idle, opening it
 * by link meanwhile. A conversation the user continued by hand is theirs: the wait ends at once.
 * Links go only while the user is idle, at most CONTINUE_OPENS and CONTINUE_REOPEN_MS apart, since
 * each one reloads Claude's page and takes the user to that conversation.
 */
export async function waitForConversation(
  localSessionId: string,
  deps: ShowDeps,
): Promise<ShowResult> {
  const deadline = deps.now() + CONTINUE_SHOW_MS;
  let last: DesktopAutomationSnapshot | undefined;
  let issue: string | undefined;
  let openedAt = -Infinity;
  let checkedAt = -Infinity;
  let opened = 0;
  let wasIdle = false;
  while (deps.now() < deadline) {
    if (deps.now() - checkedAt >= MOVED_CHECK_MS) {
      checkedAt = deps.now();
      if (!deps.unchanged()) return { skipped: "moved-on", last, opened };
    }
    try {
      const view = await deps.inspect();
      last = view;
      issue = undefined;
      const idle = (view.idleMs ?? CONTINUE_IDLE_MS) >= CONTINUE_IDLE_MS;
      if (idle) wasIdle = true;
      if (view.localSessionId === localSessionId && view.permissionMode) {
        if (idle) return { shown: view };
      } else if (
        idle &&
        opened < CONTINUE_OPENS &&
        deps.now() - openedAt >= CONTINUE_REOPEN_MS &&
        // A link makes Claude load its page again: none while it is still loading.
        (await deps.booted()) !== false
      ) {
        openedAt = deps.now();
        opened += 1;
        await deps.open(localSessionId);
      }
    } catch (error) {
      // Not ready yet.
      issue = error instanceof DesktopAutomationError ? error.issue : "failed";
    }
    await deps.sleep(POLL_MS);
  }
  return {
    skipped: wasIdle ? "not-shown" : "user-active",
    last,
    ...(issue ? { issue } : {}),
    opened,
  };
}
