import os from "node:os";
import { cliEnvironment } from "../environment";
import { acquireProfileLock } from "../../../electron/core/profile-lock";
import { EXTERNAL_LINKS } from "../../../shared/external-links";
import { resolveAccount } from "../accounts";
import type { Command } from "../command";
import { openContext } from "../context";
import { CliError, EXIT } from "../io";

/**
 * Runs Claude Code as an account: the official CLI with the account's own profile
 * (CLAUDE_CONFIG_DIR), this terminal and folder, holding the shared profile lock so neither
 * Relay.app nor another relay renews its credential meanwhile.
 */
export const run: Command = async ({ io, deps, parsed, t }) => {
  const query = parsed.positionals[0];
  if (!query || parsed.positionals.length > 1)
    throw new CliError(t("Kullanım: relay run <ad> [-- claude seçenekleri]", "Usage: relay run <name> [-- claude options]"), EXIT.usage);
  const ctx = await openContext(io, deps, parsed.flags, { write: false, desktop: false });
  const account = resolveAccount(ctx.store.state.accounts, query, t);
  if (!account.auth?.loggedIn)
    throw new CliError(
      t(
        `${account.name} hesabının Claude Code profili bağlı değil. Önce: relay connect "${account.name}"`,
        `${account.name}’s Claude Code profile is not connected. First: relay connect "${account.name}"`,
      ),
      EXIT.failed,
    );
  const claude = ctx.deps.claude(ctx.store.state.executable);
  if (!claude)
    throw new CliError(
      t(`Claude Code CLI bulunamadı. Kurmak için: ${EXTERNAL_LINKS.cliSetup}`, `The Claude Code CLI was not found. To install it: ${EXTERNAL_LINKS.cliSetup}`),
      EXIT.environment,
    );
  const release = acquireProfileLock(ctx.paths.locks, account.id, "shared");
  try {
    const child = ctx.deps.spawn(claude, parsed.rest, {
      cwd: io.cwd,
      env: cliEnvironment(ctx.store.profile(account.id), io.env),
      stdio: "inherit",
    });
    // The terminal sends Ctrl+C to Claude Code itself; passing it on again would double it.
    io.onSignal((signal) => {
      if (signal !== "SIGINT") child.kill(signal);
    });
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        resolve(code ?? 128 + (signal ? (os.constants.signals[signal] ?? 1) : 1)),
      );
    });
  } finally {
    io.onSignal(undefined);
    release();
  }
};
