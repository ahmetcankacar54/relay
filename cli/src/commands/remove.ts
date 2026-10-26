import {
  AccountRemovalRefused,
  removalBlock,
  removeAccount,
  type RemovalBlock,
} from "../../../electron/core/account-removal";
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
  const refuse = (reason: RemovalBlock): never => {
    throw new CliError(
      reason === "active"
        ? t(
            `${account.name} şu an Claude uygulamasında açık. Önce başka bir hesaba geç: relay switch <ad>`,
            `${account.name} is signed in to the Claude app now. Switch to another account first: relay switch <name>`,
          )
        : t("Bu hesabın girişi yarım kaldı; önce relay add --cancel çalıştır.", "This account’s sign-in is pending; run relay add --cancel first."),
      EXIT.busy,
    );
  };
  const blocked = removalBlock(account.id, await ctx.desktop.snapshot());
  if (blocked) refuse(blocked);
  await confirm(
    io,
    t,
    [
      t(
        `${account.name} unutulacak: kayıtlı Claude uygulaması girişi ve Claude Code profili (limit okuma girişi) silinir. Claude uygulamasının kendi verisine dokunulmaz.`,
        `${account.name} will be forgotten: its saved Claude app sign-in and its Claude Code profile (usage sign-in) are deleted. The Claude app’s own data is not touched.`,
      ),
    ],
    ctx.yes,
  );
  const claude = ctx.deps.claude(ctx.store.state.executable);
  let removed;
  try {
    // The shared core checks Desktop again, so a switch made while the question was open still counts.
    removed = await removeAccount(account.id, {
      store: ctx.store,
      vault: ctx.paths.vault,
      locks: ctx.paths.locks,
      desktop: () => ctx.desktop.snapshot(),
      signOut: claude
        ? async (profile) => {
            try {
              return (await runClaude(ctx.deps, claude, ["auth", "logout"], profile, { timeoutMs: 30_000, env: io.env })) === 0;
            } catch (error) {
              io.stderr(`relay: ${redact(error)}`);
              return false;
            }
          }
        : undefined,
    });
  } catch (error) {
    if (error instanceof AccountRemovalRefused) refuse(error.reason);
    throw error;
  }
  if (removed.signedOut === false)
    io.stderr(
      t(
        "Uyarı: Limit okuma girişinden çıkış yapılamadı; Anahtarlık’taki kaydı kalabilir.",
        "Warning: could not sign out of the usage sign-in; its Keychain item may remain.",
      ),
    );
  io.stdout(t(`${account.name} unutuldu.`, `Forgot ${account.name}.`));
  return EXIT.ok;
};
