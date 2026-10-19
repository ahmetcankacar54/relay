import { historySources } from "../../../shared/history-policy";
import { BROWSERS } from "../../../shared/browser-profiles";
import { openBrowserProfile } from "../../../electron/core/browser-profiles";
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
  const inside = await insideDesktop(ctx);
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
  // As the app does after a switch: the account's browser profile, unless it has a window.
  const browser = ctx.store.state.accounts.find((a) => a.id === target.id)?.browser;
  if (browser) {
    const profile = `${BROWSERS[browser.app].name} · ${browser.name}`;
    const result = await openBrowserProfile(ctx.deps.browser, browser);
    if (result === "opened")
      io.stdout(t(`Tarayıcı profili açıldı: ${profile}.`, `Opened the browser profile ${profile}.`));
    else if (result === "missing")
      io.stdout(
        t(`Bu profil artık tarayıcıda yok: ${profile}.`, `The browser no longer has this profile: ${profile}.`),
      );
    else if (result === "failed")
      io.stdout(t(`Tarayıcı profili açılamadı: ${profile}.`, `Could not open the browser profile ${profile}.`));
  }
  return EXIT.ok;
};
