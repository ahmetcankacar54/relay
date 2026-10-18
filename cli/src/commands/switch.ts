import { historySources } from "../../../shared/history-policy";
import { resolveAccount } from "../accounts";
import type { Command } from "../command";
import { confirm } from "../confirm";
import { openContext } from "../context";
import { assertCanQuitClaude, quitLines, runDesktopOperation } from "../desktop-op";
import { historyModeText } from "../describe";
import { CliError, EXIT } from "../io";
import { paint } from "../output";

export const switchCommand: Command = async ({ io, deps, parsed, t }) => {
  const query = parsed.positionals[0];
  if (!query || parsed.positionals.length > 1)
    throw new CliError(t("Kullanım: relay switch <ad>", "Usage: relay switch <name>"), EXIT.usage);
  const ctx = await openContext(io, deps, parsed.flags, { write: true, desktop: true });
  const accounts = ctx.store.state.accounts;
  const target = resolveAccount(accounts, query, t);
  if (!target.desktop)
    throw new CliError(
      t(
        `${target.name} henüz Claude Desktop'a bağlı değil. Bağlamak için: relay add "${target.name}"`,
        `${target.name} is not linked to Claude Desktop yet. Link it with: relay add "${target.name}"`,
      ),
      EXIT.failed,
    );
  const state = await assertCanQuitClaude(ctx);
  if (state.activeProfileId === target.id) {
    io.stdout(t(`${target.name} zaten etkin.`, `${target.name} is already active.`));
    return EXIT.ok;
  }
  const settings = ctx.store.state.settings;
  const sources = historySources(target, accounts, settings).filter((a) => a.id !== target.id);
  const history =
    settings.desktopHistoryTransfer === "off" || !sources.length
      ? t(
          `Code geçmişi: taşınacak geçmiş yok (${historyModeText(settings.desktopHistoryTransfer, t)}).`,
          `Code history: nothing to bring over (${historyModeText(settings.desktopHistoryTransfer, t)}).`,
        )
      : t(
          `Code geçmişi şu hesaplardan gelir: ${sources.map((a) => a.name).join(", ")}.`,
          `Code history comes over from: ${sources.map((a) => a.name).join(", ")}.`,
        );
  await confirm(
    io,
    t,
    [
      paint(
        ctx.color,
        "bold",
        t(
          `Claude Desktop kapanıp ${target.name} hesabıyla yeniden açılacak.`,
          `Claude Desktop will quit and reopen signed in as ${target.name}.`,
        ),
      ),
      ...quitLines(ctx),
      history,
    ],
    ctx.yes,
  );
  await runDesktopOperation(ctx, () => ctx.desktop.switchTo(target.id));
  const n = ctx.desktop.carriedCount;
  io.stdout(
    t(
      `${target.name} hesabına geçildi; ${n} konuşma taşındı.`,
      `Switched to ${target.name}; ${n} conversation${n === 1 ? "" : "s"} carried.`,
    ),
  );
  return EXIT.ok;
};
