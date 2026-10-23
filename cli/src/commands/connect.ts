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
    throw new CliError(t("Kullanım: relay connect <ad>", "Usage: relay connect <name>"), EXIT.usage);
  const ctx = await openContext(io, deps, parsed.flags, { write: true, desktop: false });
  const account = resolveAccount(ctx.store.state.accounts, query, t);
  const claude = ctx.deps.claude(ctx.store.state.executable);
  if (!claude)
    throw new CliError(
      t(
        `Claude Code CLI bulunamadı. Kurmak için: ${EXTERNAL_LINKS.cliSetup}`,
        `The Claude Code CLI was not found. To install it: ${EXTERNAL_LINKS.cliSetup}`,
      ),
      EXIT.environment,
    );
  const profile = ctx.store.profile(account.id);
  const release = acquireProfileLock(ctx.paths.locks, account.id, "exclusive");
  try {
    io.stdout(
      t(
        `${account.name} için limit okuma girişi açılıyor; tarayıcıda bu hesapla giriş yap.`,
        `Opening the usage sign-in for ${account.name}; sign in with this account in the browser.`,
      ),
    );
    const code = await runClaude(ctx.deps, claude, ["auth", "login", "--claudeai"], profile, { inherit: true, env: io.env });
    if (code !== 0)
      throw new CliError(t("Giriş tamamlanmadı; hiçbir şey kaydedilmedi.", "The sign-in did not finish; nothing was saved."), EXIT.failed);
    const auth = await readProfileAuth(claude, profile, account.auth);
    if (!auth.loggedIn)
      throw new CliError(
        auth.error ? localizeError(auth.error, ctx.lang) : t("Giriş doğrulanamadı.", "The sign-in could not be confirmed."),
        EXIT.failed,
      );
    const desktop = account.desktop;
    if (
      desktop &&
      (auth.accountUuid?.toLowerCase() !== desktop.accountUuid.toLowerCase() ||
        auth.orgId?.toLowerCase() !== desktop.orgId.toLowerCase())
    ) {
      await runClaude(ctx.deps, claude, ["auth", "logout"], profile, { timeoutMs: 30_000, env: io.env }).catch(() => 1);
      const expected = desktop.email ?? t("Claude uygulamasındaki hesabı", "its Claude app account");
      throw new CliError(
        t(
          `${auth.email ?? "Başka bir hesap"} ile giriş yapıldı, ama ${account.name} için ${expected} ile giriş yapılmalı. Giriş geri alındı; doğru hesapla yeniden dene.`,
          `Signed in as ${auth.email ?? "another account"}, but ${account.name} must sign in as ${expected}. The sign-in was undone; try again with the right account.`,
        ),
        EXIT.failed,
      );
    }
    ctx.store.update((s) => {
      s.accounts.find((a) => a.id === account.id)!.auth = auth;
    });
    io.stdout(
      t(
        `${account.name} için limit okuma girişi yapıldı${auth.email ? ` (${auth.email})` : ""}. Limitleri görmek için: relay usage`,
        `Signed ${account.name} in to read usage${auth.email ? ` (${auth.email})` : ""}. For limits: relay usage`,
      ),
    );
    return EXIT.ok;
  } finally {
    release();
  }
};
