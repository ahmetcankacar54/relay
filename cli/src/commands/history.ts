import { historySources } from "../../../shared/history-policy";
import type { RelaySettings } from "../../../shared/types";
import { resolveAccount } from "../accounts";
import type { Command } from "../command";
import { confirm } from "../confirm";
import { openContext, type CliContext } from "../context";
import { assertCanQuitClaude, quitLines, runDesktopOperation } from "../desktop-op";
import { historyModeText } from "../describe";
import { CliError, EXIT } from "../io";
import { printJson } from "../output";
import { detach, insideDesktop, sessionEndsLine } from "../inside-desktop";

const MODES: RelaySettings["desktopHistoryTransfer"][] = ["all", "same-group", "selected", "off"];

/** The named account, or the one open in the Claude app. */
async function chosen(ctx: CliContext, query: string | undefined) {
  if (query) return resolveAccount(ctx.store.state.accounts, query, ctx.t);
  const active = (await ctx.desktop.snapshot()).activeProfileId;
  const account = ctx.store.state.accounts.find((a) => a.id === active);
  if (!account)
    throw new CliError(
      ctx.t("history.noSavedAccountIsSignedIn"),
      EXIT.usage,
    );
  return account;
}

export const history: Command = async ({ io, deps, parsed, t, argv }) => {
  const [sub, ...args] = parsed.positionals;
  if (sub === "mode") {
    const mode = args[0] as RelaySettings["desktopHistoryTransfer"];
    if (!MODES.includes(mode) || args.length > 1)
      throw new CliError(t("history.usageRelayHistoryModeAllSame"), EXIT.usage);
    const ctx = await openContext(io, deps, parsed.flags, { write: true, desktop: false });
    let selected: string[] | undefined;
    if (mode === "selected") {
      const names = String(ctx.flags.accounts ?? "").split(",").map((n) => n.trim()).filter(Boolean);
      selected = [...new Set(names.map((n) => resolveAccount(ctx.store.state.accounts, n, t).id))];
      if (selected.length < 2)
        throw new CliError(t("history.selectedSharingNeedsAtLeastTwo"), EXIT.usage);
    }
    ctx.store.update((s) => {
      s.settings.desktopHistoryTransfer = mode;
      if (selected) s.settings.desktopHistoryAccounts = selected;
    });
    io.stdout(t("history.codeHistoryIsNow", { historyModeText: historyModeText(mode, t) }));
    return EXIT.ok;
  }
  if (sub === "sync") {
    if (args.length > 1) throw new CliError(t("history.usageRelayHistorySyncName"), EXIT.usage);
    const ctx = await openContext(io, deps, parsed.flags, { write: true, desktop: true });
    const account = await chosen(ctx, args[0]);
    await assertCanQuitClaude(ctx);
    const inside = await insideDesktop(ctx);
    await confirm(
      io,
      t,
      [
        t("history.codeHistoryFromTheOtherAccounts", { accountName: account.name }),
        ...quitLines(ctx),
        ...(inside ? [sessionEndsLine(ctx)] : []),
      ],
      ctx.yes,
    );
    if (inside) return detach(ctx, argv);
    await runDesktopOperation(ctx, () => ctx.desktop.syncHistory(account.id));
    const n = ctx.desktop.carriedCount;
    io.stdout(t("history.conversationSCarried", { n }));
    return EXIT.ok;
  }
  if (args.length) throw new CliError(t("history.usageRelayHistoryName"), EXIT.usage);
  const ctx = await openContext(io, deps, parsed.flags, { write: false, desktop: false });
  const account = await chosen(ctx, sub);
  const settings = ctx.store.state.settings;
  const sources = historySources(account, ctx.store.state.accounts, settings).filter((a) => a.id !== account.id);
  const summary = await ctx.desktop.historySummary(account.id);
  if (ctx.json) {
    printJson(io, {
      mode: settings.desktopHistoryTransfer,
      account: { id: account.id, name: account.name },
      sources: sources.map((a) => a.name),
      summary,
    });
    return EXIT.ok;
  }
  io.stdout(t("history.codeHistory", { historyModeText: historyModeText(settings.desktopHistoryTransfer, t) }));
  io.stdout(
    sources.length
      ? t("history.getsHistoryFrom", { accountName: account.name, join: sources.map((a) => a.name).join(", ") })
      : t("history.getsNoHistoryFromOtherAccounts", { accountName: account.name }),
  );
  io.stdout(
    t("history.conversationsArchivedProjectsTranscripts", { summaryIndexed: summary.indexed, summaryArchived: summary.archived, summaryProjects: summary.projects, summaryTranscriptsFound: summary.transcriptsFound, summaryMissingTranscripts: summary.missingTranscripts, summaryDuplicates: summary.duplicates }),
  );
  return EXIT.ok;
};
