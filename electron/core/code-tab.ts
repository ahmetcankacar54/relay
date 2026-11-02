/** Claude's new-session screen in Code: opening it once makes Claude create the account's Code workspace. */
export const CODE_TAB_LINK = "claude://code/new";

export interface CodeTabDeps {
  /** Starts Claude, or brings a running one forward. */
  open(): Promise<void>;
  /** Whether Claude's claude.ai page has booted; undefined when its log cannot tell. */
  booted(): Promise<boolean | undefined>;
  running(): Promise<boolean>;
  openLink(url: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** How long a Claude whose log cannot tell gets before the link is sent anyway. */
const UNTOLD_GRACE_MS = 4_000;
const POLL_MS = 500;

/**
 * Opens Claude on its Code tab: starts or brings Claude forward, waits for its claude.ai page to
 * boot (a `claude://` link makes Claude load the page again, so one sent while it boots restarts
 * that), then opens the new-session screen. "timeout": Claude is open but the link was not sent.
 */
export async function openCodeTab(
  deps: CodeTabDeps,
  timeoutMs = 30_000,
): Promise<"opened" | "timeout"> {
  await deps.open();
  const start = deps.now();
  let runningSince: number | undefined;
  while (deps.now() - start < timeoutMs) {
    const booted = await deps.booted();
    if (booted === true) break;
    if (booted === undefined && (await deps.running())) {
      runningSince ??= deps.now();
      if (deps.now() - runningSince >= UNTOLD_GRACE_MS) break;
    }
    await deps.sleep(POLL_MS);
  }
  if (deps.now() - start >= timeoutMs) return "timeout";
  await deps.openLink(CODE_TAB_LINK);
  return "opened";
}
