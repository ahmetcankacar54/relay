import type { Command } from "../command";
import { confirm } from "../confirm";
import { openContext } from "../context";
import { quitLines, runDesktopOperation } from "../desktop-op";
import { guiSessionGuard } from "../guards";
import { CliError, EXIT } from "../io";

export const recover: Command = async ({ io, deps, parsed, t }) => {
  if (parsed.positionals.length)
    throw new CliError(t("Kullanım: relay recover", "Usage: relay recover"), EXIT.usage);
  const ctx = await openContext(io, deps, parsed.flags, { write: true, desktop: true });
  const state = await ctx.desktop.snapshot();
  if (!state.recoveryRequired) {
    io.stdout(t("Geri alınacak bir şey yok.", "Nothing to recover."));
    return EXIT.ok;
  }
  guiSessionGuard(ctx.deps, t);
  await confirm(
    io,
    t,
    [
      t(
        "Claude Desktop kapanacak, yarıda kalan geçişin dosyaları yedeğinden geri yüklenecek ve Claude yeniden açılacak.",
        "Claude Desktop will quit, the interrupted switch's files will be restored from its backup, and Claude will reopen.",
      ),
      ...quitLines(ctx),
    ],
    ctx.yes,
  );
  await runDesktopOperation(ctx, () => ctx.desktop.recover());
  io.stdout(t("Yarıda kalan geçiş geri alındı.", "The interrupted switch was restored."));
  return EXIT.ok;
};
