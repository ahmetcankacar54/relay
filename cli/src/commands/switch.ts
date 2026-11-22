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
    throw new CliError(t("commandsSwitch.usageRelaySwitchName"), EXIT.usage);
  const ctx = await openContext(io, deps, parsed.flags, { write: true, desktop: true });
  const accounts = ctx.store.state.accounts;
  const target = resolveAccount(accounts, query, t);
  if (!target.desktop)
    throw new CliError(
      t("commandsSwitch.hasNoSavedClaudeAppSign", { targetName: target.name }),
      EXIT.failed,
    );
  const state = await assertCanQuitClaude(ctx);
  if (state.activeProfileId === target.id) {
    io.stdout(t("commandsSwitch.isAlreadyActive", { targetName: target.name }));
    return EXIT.ok;
  }
  const settings = ctx.store.state.settings;
  const sources = historySources(target, accounts, settings).filter((a) => a.id !== target.id);
  const history =
    settings.desktopHistoryTransfer === "off" || !sources.length
      ? t("commandsSwitch.codeHistoryNothingToBringOver", { historyModeText: historyModeText(settings.desktopHistoryTransfer, t) })
      : t("commandsSwitch.codeHistoryComesOverFrom", { join: sources.map((a) => a.name).join(", ") });
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
        t("commandsSwitch.theClaudeAppWillQuitAnd", { targetName: target.name }),
      ),
      ...quitLines(ctx),
      ...(browser
        ? [
            t("commandsSwitch.willAlsoQuitForAMoment", { browser }),
          ]
        : []),
      ...(terminalFollows
        ? [
            t("commandsSwitch.theTerminalClaudeSSignIn", { targetName: target.name }),
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
    t("commandsSwitch.switchedToConversationSCarried", { targetName: target.name, n }),
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
