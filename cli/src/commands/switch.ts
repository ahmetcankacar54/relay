import { historySources } from "../../../shared/history-policy";
import { extensionLine } from "../../../shared/extension-text";
import { terminalLine } from "../../../shared/terminal-identity";
import { resolveAccount } from "../accounts";
import type { Command } from "../command";
import { confirm } from "../confirm";
import { openContext } from "../context";
import { assertCanQuitClaude, quitLines, runDesktopOperation } from "../desktop-op";
import { historyModeText } from "../describe";
import { CliError, EXIT } from "../io";
import { detach, insideDesktop, sessionEndsLine } from "../inside-desktop";
import { paint } from "../output";

export const switchCommand: Command = async ({ io, deps, parsed, t, argv }) => {
  const query = parsed.positionals[0];
  if (!query || parsed.positionals.length > 1)
    throw new CliError(t("Kullanım: relay switch <ad>", "Usage: relay switch <name>"), EXIT.usage);
  const ctx = await openContext(io, deps, parsed.flags, { write: true, desktop: true });
  const accounts = ctx.store.state.accounts;
  const target = resolveAccount(accounts, query, t);
  if (!target.desktop)
    throw new CliError(
      t(
        `${target.name} hesabının Claude uygulaması girişi henüz kayıtlı değil. Kaydetmek için: relay add "${target.name}"`,
        `${target.name} has no saved Claude app sign-in yet. Save it with: relay add "${target.name}"`,
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
  const browser = await ctx.desktop.extensionQuitsBrowser();
  // The plain `claude` in a terminal follows the account too, unless that is turned off.
  const terminalStatus = await ctx.desktop.terminalStatus();
  const terminalFollows = terminalStatus !== undefined && terminalStatus.mode !== "off";
  const inside = await insideDesktop(ctx);
  await confirm(
    io,
    t,
    [
      paint(
        ctx.color,
        "bold",
        t(
          `Claude uygulaması kapanıp ${target.name} hesabıyla yeniden açılacak.`,
          `The Claude app will quit and reopen signed in as ${target.name}.`,
        ),
      ),
      ...quitLines(ctx),
      ...(browser
        ? [
            t(
              `Claude eklentisinin girişi için ${browser} tarayıcısı da kısa süreliğine kapanıp sekmeleriyle yeniden açılacak.`,
              `${browser} will also quit for a moment and reopen with its tabs, for the Claude extension’s sign-in.`,
            ),
          ]
        : []),
      ...(terminalFollows
        ? [
            t(
              `Terminaldeki claude’un girişi de (Anahtarlık ve ~/.claude.json) ${target.name} hesabına geçer; kapatmak için Relay.app → Ayarlar → Geçiş.`,
              `The terminal claude’s sign-in (Keychain and ~/.claude.json) will move to ${target.name} too; turn that off in Relay.app → Settings → Switching.`,
            ),
          ]
        : []),
      ...(inside ? [sessionEndsLine(ctx)] : []),
      history,
    ],
    ctx.yes,
  );
  if (inside) return detach(ctx, argv);
  await runDesktopOperation(ctx, () => ctx.desktop.switchTo(target.id));
  const n = ctx.desktop.carriedCount;
  io.stdout(
    t(
      `${target.name} hesabına geçildi; ${n} konuşma taşındı.`,
      `Switched to ${target.name}; ${n} conversation${n === 1 ? "" : "s"} carried.`,
    ),
  );
  // As the app does: what became of the Claude extension's sign-in, when there is something to say.
  const extension = ctx.desktop.extensionOutcome;
  const line = extension && extensionLine(extension, t);
  if (line) io.stdout(line);
  // And what became of the terminal's Claude Code sign-in.
  const terminal = terminalFollows ? (await ctx.desktop.terminalStatus())?.last : undefined;
  const terminalText = terminal && terminalLine(terminal, t, target.name);
  if (terminalText) io.stdout(terminalText);
  return EXIT.ok;
};
