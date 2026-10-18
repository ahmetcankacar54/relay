import fs from "node:fs";
import path from "node:path";
import { writeBytes } from "../../../electron/core/desktop-files";
import { acquireProfileLock } from "../../../electron/core/profile-lock";
import { redact } from "../../../electron/core/redact";
import { resolveAccount } from "../accounts";
import { runClaude } from "../claude-cli";
import type { Command } from "../command";
import { confirm } from "../confirm";
import { openContext } from "../context";
import { CliError, EXIT } from "../io";

export const remove: Command = async ({ io, deps, parsed, t }) => {
  const query = parsed.positionals[0];
  if (!query || parsed.positionals.length > 1)
    throw new CliError(t("Kullanım: relay remove <ad>", "Usage: relay remove <name>"), EXIT.usage);
  const ctx = await openContext(io, deps, parsed.flags, { write: true, desktop: false });
  const account = resolveAccount(ctx.store.state.accounts, query, t);
  const state = await ctx.desktop.snapshot();
  if (state.activeProfileId === account.id)
    throw new CliError(
      t(
        `${account.name} şu an Claude Desktop'ta açık. Önce başka bir hesaba geçin: relay switch <ad>`,
        `${account.name} is signed in to Claude Desktop now. Switch to another account first: relay switch <name>`,
      ),
      EXIT.busy,
    );
  if (state.pendingProfileId === account.id)
    throw new CliError(
      t("Bu hesabın girişi yarım kaldı; önce relay add --cancel çalıştırın.", "This account's sign-in is pending; run relay add --cancel first."),
      EXIT.busy,
    );
  await confirm(
    io,
    t,
    [
      t(
        `${account.name} unutulacak: kayıtlı Claude Desktop girişi ve Claude Code profili silinir. Claude Desktop'un kendi verisine dokunulmaz.`,
        `${account.name} will be forgotten: its saved Claude Desktop sign-in and its Claude Code profile are deleted. Claude Desktop's own data is not touched.`,
      ),
    ],
    ctx.yes,
  );
  const release = acquireProfileLock(ctx.paths.locks, account.id, "exclusive");
  try {
    const profile = ctx.store.profile(account.id);
    if (account.auth?.loggedIn) {
      const claude = ctx.deps.claude(ctx.store.state.executable);
      let signedOut = false;
      if (claude)
        try {
          signedOut = (await runClaude(ctx.deps, claude, ["auth", "logout"], profile, { timeoutMs: 30_000, env: io.env })) === 0;
        } catch (error) {
          io.stderr(`relay: ${redact(error)}`);
        }
      if (!signedOut)
        io.stderr(
          t(
            "Uyarı: Claude Code girişi kapatılamadı; Keychain'deki öğesi kalabilir.",
            "Warning: the Claude Code login could not be signed out; its Keychain item may remain.",
          ),
        );
    }
    fs.rmSync(profile, { recursive: true, force: true });
    if (account.desktop)
      await writeBytes(ctx.paths.vault, `accounts/${account.desktop.accountUuid.toLowerCase()}.bin`, null);
    ctx.store.update((s) => {
      s.accounts = s.accounts.filter((a) => a.id !== account.id);
      s.settings.desktopHistoryAccounts = s.settings.desktopHistoryAccounts.filter((id) => id !== account.id);
      s.settings.autoSwitchAccounts = s.settings.autoSwitchAccounts.filter((id) => id !== account.id);
      s.settings.planning.accounts = s.settings.planning.accounts.filter((a) => a.id !== account.id);
    });
  } finally {
    release();
    fs.rmSync(path.join(ctx.paths.locks, account.id), { recursive: true, force: true });
  }
  io.stdout(t(`${account.name} unutuldu.`, `Forgot ${account.name}.`));
  return EXIT.ok;
};
