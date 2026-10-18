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

const MODES: RelaySettings["desktopHistoryTransfer"][] = ["all", "same-group", "selected", "off"];

/** The named account, or the one active in Claude Desktop. */
async function chosen(ctx: CliContext, query: string | undefined) {
  if (query) return resolveAccount(ctx.store.state.accounts, query, ctx.t);
  const active = (await ctx.desktop.snapshot()).activeProfileId;
  const account = ctx.store.state.accounts.find((a) => a.id === active);
  if (!account)
    throw new CliError(
      ctx.t("Claude Desktop'ta kayıtlı bir hesap açık değil; bir hesap adı verin.", "No saved account is signed in to Claude Desktop; name an account."),
      EXIT.usage,
    );
  return account;
}

export const history: Command = async ({ io, deps, parsed, t }) => {
  const [sub, ...args] = parsed.positionals;
  if (sub === "mode") {
    const mode = args[0] as RelaySettings["desktopHistoryTransfer"];
    if (!MODES.includes(mode) || args.length > 1)
      throw new CliError(t("Kullanım: relay history mode <all|same-group|selected|off> [--accounts a,b]", "Usage: relay history mode <all|same-group|selected|off> [--accounts a,b]"), EXIT.usage);
    const ctx = await openContext(io, deps, parsed.flags, { write: true, desktop: false });
    let selected: string[] | undefined;
    if (mode === "selected") {
      const names = String(ctx.flags.accounts ?? "").split(",").map((n) => n.trim()).filter(Boolean);
      selected = [...new Set(names.map((n) => resolveAccount(ctx.store.state.accounts, n, t).id))];
      if (selected.length < 2)
        throw new CliError(t("Seçili paylaşım en az iki hesap ister: --accounts A,B", "Selected sharing needs at least two accounts: --accounts A,B"), EXIT.usage);
    }
    ctx.store.update((s) => {
      s.settings.desktopHistoryTransfer = mode;
      if (selected) s.settings.desktopHistoryAccounts = selected;
    });
    io.stdout(t(`Code geçmişi artık ${historyModeText(mode, t)}.`, `Code history is now ${historyModeText(mode, t)}.`));
    return EXIT.ok;
  }
  if (sub === "sync") {
    if (args.length > 1) throw new CliError(t("Kullanım: relay history sync [<ad>]", "Usage: relay history sync [<name>]"), EXIT.usage);
    const ctx = await openContext(io, deps, parsed.flags, { write: true, desktop: true });
    const account = await chosen(ctx, args[0]);
    await assertCanQuitClaude(ctx);
    await confirm(
      io,
      t,
      [t(`${account.name} hesabına diğer hesapların Code geçmişi şimdi taşınacak; Claude Desktop kapanıp açılacak.`, `Code history from the other accounts will be brought into ${account.name} now; Claude Desktop will quit and reopen.`), ...quitLines(ctx)],
      ctx.yes,
    );
    await runDesktopOperation(ctx, () => ctx.desktop.syncHistory(account.id));
    const n = ctx.desktop.carriedCount;
    io.stdout(t(`${n} konuşma taşındı.`, `${n} conversation${n === 1 ? "" : "s"} carried.`));
    return EXIT.ok;
  }
  if (args.length) throw new CliError(t("Kullanım: relay history [<ad>]", "Usage: relay history [<name>]"), EXIT.usage);
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
  io.stdout(t(`Code geçmişi: ${historyModeText(settings.desktopHistoryTransfer, t)}`, `Code history: ${historyModeText(settings.desktopHistoryTransfer, t)}`));
  io.stdout(
    sources.length
      ? t(`${account.name} şu hesaplardan geçmiş alır: ${sources.map((a) => a.name).join(", ")}`, `${account.name} gets history from: ${sources.map((a) => a.name).join(", ")}`)
      : t(`${account.name} başka hesaptan geçmiş almaz.`, `${account.name} gets no history from other accounts.`),
  );
  io.stdout(
    t(
      `${summary.indexed} konuşma (${summary.archived} arşivli), ${summary.projects} proje, ${summary.transcriptsFound} konuşma kaydı bulundu, ${summary.missingTranscripts} eksik, ${summary.duplicates} kopya kart.`,
      `${summary.indexed} conversations (${summary.archived} archived), ${summary.projects} projects, ${summary.transcriptsFound} transcripts found, ${summary.missingTranscripts} missing, ${summary.duplicates} duplicate cards.`,
    ),
  );
  return EXIT.ok;
};
