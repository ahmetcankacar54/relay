import { readObject } from "../../electron/core/desktop-files";
import { anyExclusiveProfileLock } from "../../electron/core/profile-lock";
import { redact } from "../../electron/core/redact";
import { localizeError } from "../../shared/error-text";
import type { CliContext } from "./context";
import { guiSessionGuard } from "./guards";
import { CliError, EXIT } from "./io";
import { shielded } from "./shield";

/** What the user is told before any command that quits the Claude app. */
export function quitLines(ctx: CliContext): string[] {
  const { t } = ctx;
  return [
    t("desktopOp.theClaudeAppSRunningCode"),
    t("desktopOp.theCliDoesnTReType"),
  ];
}

/**
 * Refuses a Claude-quitting command before it asks anything: a pending sign-in, an
 * interrupted switch, an account connection being renewed, or no desktop session.
 */
export async function assertCanQuitClaude(ctx: CliContext, options: { allowPending?: boolean } = {}) {
  const { t } = ctx;
  const state = await ctx.desktop.snapshot();
  if (state.pendingProfileId && !options.allowPending)
    throw new CliError(
      t("desktopOp.aSignInIsPendingFinish"),
      EXIT.busy,
    );
  if (state.recoveryRequired)
    throw new CliError(
      t("desktopOp.aSwitchWasInterruptedRunRelay"),
      EXIT.busy,
    );
  if (anyExclusiveProfileLock(ctx.paths.locks))
    throw new CliError(
      t("desktopOp.anAccountSConnectionIsBeing"),
      EXIT.busy,
    );
  guiSessionGuard(ctx.deps, t);
  return state;
}

const AUTOMATION = /-1743|Not authorized to send Apple events|not allowed to send Apple events/i;

/**
 * Runs a Desktop operation that quits Claude, held against signals. A failure says what to do
 * next: grant the Automation permission, or run `relay recover` when a journal was left.
 */
export async function runDesktopOperation<T>(ctx: CliContext, fn: () => Promise<T>): Promise<T> {
  const { t } = ctx;
  try {
    return await shielded(ctx.io, t, fn);
  } catch (error) {
    const full = error instanceof Error ? error.message : String(error);
    if (AUTOMATION.test(full))
      throw new CliError(
        t("desktopOp.macosDidNotLetThisTerminal"),
        EXIT.environment,
      );
    if (await readObject(ctx.paths.vault, "journal.json").catch(() => null))
      throw new CliError(
        `${localizeError(redact(full), ctx.lang)} ${t("desktopOp.quitClaudeAndRunRelayRecover")}`,
        EXIT.failed,
      );
    throw error;
  }
}
