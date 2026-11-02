import { assertFreeName, resolveAccount } from "../accounts";
import type { Command } from "../command";
import { openContext } from "../context";
import { CliError, EXIT } from "../io";

export const rename: Command = async ({ io, deps, parsed, t }) => {
  const [query, next] = parsed.positionals;
  const name = next?.trim();
  if (!query || !name || parsed.positionals.length > 2 || name.length > 64)
    throw new CliError(t("Kullanım: relay rename <ad> <yeni-ad>", "Usage: relay rename <name> <new-name>"), EXIT.usage);
  const ctx = await openContext(io, deps, parsed.flags, { write: true, desktop: false });
  const account = resolveAccount(ctx.store.state.accounts, query, t);
  assertFreeName(ctx.store.state.accounts, name, t, account.id);
  ctx.store.update((s) => {
    s.accounts.find((a) => a.id === account.id)!.name = name;
  });
  io.stdout(t(`${account.name} → ${name}`, `${account.name} → ${name}`));
  return EXIT.ok;
};
