import type { Command } from "../command";
import { confirm } from "../confirm";
import { openContext } from "../context";
import { quitLines, runDesktopOperation } from "../desktop-op";
import { guiSessionGuard } from "../guards";
import { CliError, EXIT } from "../io";
import { detach, insideDesktop, sessionEndsLine } from "../inside-desktop";

export const recover: Command = async ({ io, deps, parsed, t, argv }) => {
  if (parsed.positionals.length)
    throw new CliError(t("recover.usageRelayRecover"), EXIT.usage);
  const ctx = await openContext(io, deps, parsed.flags, { write: true, desktop: true });
  const state = await ctx.desktop.snapshot();
  if (!state.recoveryRequired) {
    io.stdout(t("recover.noBackupToRestore"));
    return EXIT.ok;
  }
  guiSessionGuard(ctx.deps, t);
  const inside = await insideDesktop(ctx);
  await confirm(
    io,
    t,
    [
      t("recover.theClaudeAppWillQuitThe"),
      ...quitLines(ctx),
      ...(inside ? [sessionEndsLine(ctx)] : []),
    ],
    ctx.yes,
  );
  if (inside) return detach(ctx, argv);
  await runDesktopOperation(ctx, () => ctx.desktop.recover());
  io.stdout(t("recover.theInterruptedSwitchSBackupWas"));
  return EXIT.ok;
};
