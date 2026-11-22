import { readProfileAuth } from "../../../electron/core/profile-auth";
import { acquireProfileLock } from "../../../electron/core/profile-lock";
import { localizeError } from "../../../shared/error-text";
import { EXTERNAL_LINKS } from "../../../shared/external-links";
import { resolveAccount } from "../accounts";
import { runClaude } from "../claude-cli";
import type { Command } from "../command";
import { openContext } from "../context";
import { CliError, EXIT } from "../io";

export const connect: Command = async ({ io, deps, parsed, t }) => {
  const query = parsed.positionals[0];
  if (!query || parsed.positionals.length > 1)
    throw new CliError(t("connect.usageRelayConnectName"), EXIT.usage);
  const ctx = await openContext(io, deps, parsed.flags, { write: true, desktop: false });
  const account = resolveAccount(ctx.store.state.accounts, query, t);
  const claude = ctx.deps.claude(ctx.store.state.executable);
  if (!claude)
    throw new CliError(
      t("connect.theClaudeCodeCliWasNot", { EXTERNAL_LINKSCliSetup: EXTERNAL_LINKS.cliSetup }),
      EXIT.environment,
    );
  const profile = ctx.store.profile(account.id);
  const release = acquireProfileLock(ctx.paths.locks, account.id, "exclusive");
  try {
    io.stdout(
      t("connect.openingTheUsageSignInFor", { accountName: account.name }),
    );
    const code = await runClaude(ctx.deps, claude, ["auth", "login", "--claudeai"], profile, { inherit: true, env: io.env });
    if (code !== 0)
      throw new CliError(t("connect.theSignInDidNotFinish"), EXIT.failed);
    const auth = await readProfileAuth(claude, profile, account.auth);
    if (!auth.loggedIn)
      throw new CliError(
        auth.error ? localizeError(auth.error, ctx.lang) : t("connect.theSignInCouldNotBe"),
        EXIT.failed,
      );
    const desktop = account.desktop;
    // The profile's own account in another of its workspaces: the profile moves there when the
    // Claude app has that workspace. Signing in again could never make the two agree.
    let moved = false;
    if (
      desktop &&
      auth.orgId &&
      auth.accountUuid?.toLowerCase() === desktop.accountUuid.toLowerCase() &&
      auth.orgId.toLowerCase() !== desktop.orgId.toLowerCase()
    ) {
      ctx.store.update((s) => {
        s.accounts.find((a) => a.id === account.id)!.auth = auth;
      });
      moved = await ctx.desktop.rebindOrg(account.id, auth.orgId).catch(() => false);
      if (!moved) {
        ctx.store.update((s) => {
          const stored = s.accounts.find((a) => a.id === account.id)!;
          if (account.auth) stored.auth = account.auth;
          else delete stored.auth;
        });
        await runClaude(ctx.deps, claude, ["auth", "logout"], profile, { timeoutMs: 30_000, env: io.env }).catch(() => 1);
        throw new CliError(
          localizeError(
            "Bu giriş, hesabın Claude uygulamasında henüz açılmamış bir çalışma alanına ait. Claude uygulamasında o çalışma alanında Code’u aç, sonra girişi yenile.",
            ctx.lang,
          ),
          EXIT.failed,
        );
      }
    }
    if (
      desktop &&
      !moved &&
      (auth.accountUuid?.toLowerCase() !== desktop.accountUuid.toLowerCase() ||
        auth.orgId?.toLowerCase() !== desktop.orgId.toLowerCase())
    ) {
      await runClaude(ctx.deps, claude, ["auth", "logout"], profile, { timeoutMs: 30_000, env: io.env }).catch(() => 1);
      const expected = desktop.email ?? t("connect.itsClaudeAppAccount");
      throw new CliError(
        auth.email
          ? t("connect.signedInAsButMustSign", { email: auth.email, accountName: account.name, expected })
          : t("connect.signedInAsAnotherAccountBut", { accountName: account.name, expected }),
        EXIT.failed,
      );
    }
    ctx.store.update((s) => {
      s.accounts.find((a) => a.id === account.id)!.auth = auth;
    });
    io.stdout(
      auth.email
        ? t("connect.signedInToReadUsageFor2", { accountName: account.name, email: auth.email })
        : t("connect.signedInToReadUsageFor", { accountName: account.name }),
    );
    return EXIT.ok;
  } finally {
    release();
  }
};
