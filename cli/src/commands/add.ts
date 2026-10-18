import fs from "node:fs/promises";
import path from "node:path";
import { readObject } from "../../../electron/core/desktop-files";
import type { Account } from "../../../shared/types";
import { assertFreeName, foldName } from "../accounts";
import type { Command } from "../command";
import { confirm } from "../confirm";
import { openContext, type CliContext } from "../context";
import { assertCanQuitClaude, quitLines, runDesktopOperation } from "../desktop-op";
import { CliError, EXIT } from "../io";
import { detach, insideDesktop, sessionEndsLine } from "../inside-desktop";

/** A workspace of the signed-in account, as the user is shown it to pick one. */
async function describeOrg(ctx: CliContext, accountUuid: string, org: string) {
  const dir = path.join(ctx.paths.claude, "claude-code-sessions", accountUuid, org);
  let count = 0;
  let newest: { at: number; title: string } | undefined;
  try {
    for (const name of await fs.readdir(dir)) {
      if (!/^local_[0-9a-f-]{36}\.json$/i.test(name)) continue;
      count++;
      const record = await readObject(ctx.paths.claude, `claude-code-sessions/${accountUuid}/${org}/${name}`).catch(() => null);
      const at = Number(record?.lastActivityAt);
      if (record && Number.isFinite(at) && (!newest || at > newest.at))
        newest = { at, title: typeof record.title === "string" ? record.title.slice(0, 60) : "" };
    }
  } catch {
    // An unreadable folder shows no conversations.
  }
  const { t } = ctx;
  return `${org}  ${t(`${count} konuşma`, `${count} conversation${count === 1 ? "" : "s"}`)}${newest?.title ? ` · “${newest.title}”` : ""}`;
}

/** The workspace (Code organization) to save: --org, the only one, or a numbered pick. */
async function pickOrg(ctx: CliContext, accountUuid: string, orgs: string[]): Promise<string> {
  const { t, io } = ctx;
  const flag = ctx.flags.org as string | undefined;
  if (flag) {
    const found = orgs.find((org) => org.toLowerCase() === flag.toLowerCase());
    if (!found)
      throw new CliError(t(`Bu hesapta ${flag} çalışma alanı yok.`, `This account has no workspace ${flag}.`), EXIT.usage);
    return found;
  }
  if (!orgs.length)
    throw new CliError(
      t(
        "Bu hesabın Code çalışma alanı henüz yok: Claude Desktop'ta Code sekmesini bir kez açıp yeniden deneyin.",
        "This account has no Code workspace yet: open the Code tab in Claude Desktop once, then try again.",
      ),
      EXIT.failed,
    );
  if (orgs.length === 1) return orgs[0];
  if (!io.isTTY)
    throw new CliError(
      t(
        `Bu hesabın birden çok çalışma alanı var; birini --org ile seçin: ${orgs.join(", ")}`,
        `This account has several workspaces; pick one with --org: ${orgs.join(", ")}`,
      ),
      EXIT.usage,
    );
  io.stdout(t("Hangi çalışma alanı kaydedilsin?", "Which workspace should be saved?"));
  for (const [i, org] of orgs.entries()) io.stdout(`  ${i + 1}) ${await describeOrg(ctx, accountUuid, org)}`);
  const answer = Number((await io.prompt(`[1-${orgs.length}] `))?.trim());
  if (!Number.isInteger(answer) || answer < 1 || answer > orgs.length)
    throw new CliError(t("Vazgeçildi; hiçbir şey değişmedi.", "Cancelled; nothing changed."), EXIT.failed);
  return orgs[answer - 1];
}

/**
 * Waits for a new, unsaved account to be signed in to Claude Desktop with a Code workspace.
 * Ctrl+C stops waiting and leaves the sign-in pending; it then returns undefined.
 */
async function waitForSignIn(ctx: CliContext): Promise<{ accountUuid: string; orgs: string[] } | undefined> {
  const { t, io } = ctx;
  const poll = Number(ctx.flags["poll-ms"] ?? 2000);
  const pollMs = Number.isFinite(poll) && poll > 0 ? poll : 2000;
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  let interrupted = false;
  io.onSignal(() => {
    interrupted = true;
    stop();
  });
  io.stdout(
    t(
      "Claude Desktop'ta yeni hesapla giriş yapın ve Code sekmesini bir kez açın; bekleniyor… (Ctrl+C beklemeyi bırakır, giriş yarım kalır.)",
      "Sign in to Claude Desktop with the new account and open the Code tab once; waiting… (Ctrl+C stops waiting; the sign-in stays pending.)",
    ),
  );
  try {
    for (;;) {
      const state = await ctx.desktop.snapshot();
      const uuid = state.currentAccountUuid;
      if (uuid && !ctx.store.state.accounts.some((a) => a.desktop?.accountUuid === uuid) && state.organizations.length)
        return { accountUuid: uuid, orgs: state.organizations };
      await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, pollMs))]);
      if (interrupted) {
        io.stdout(
          t(
            "Bekleme bırakıldı; giriş yarım kaldı. Bitirmek için: relay add --resume · İptal için: relay add --cancel",
            "Stopped waiting; the sign-in is still pending. To finish: relay add --resume · To cancel: relay add --cancel",
          ),
        );
        return undefined;
      }
    }
  } finally {
    io.onSignal(undefined);
  }
}

/** Waits for the sign-in, then saves it into `account`. */
async function finishSignIn(ctx: CliContext, account: Account): Promise<number> {
  const signed = await waitForSignIn(ctx);
  if (!signed) return EXIT.failed;
  const org = await pickOrg(ctx, signed.accountUuid, signed.orgs);
  await runDesktopOperation(ctx, () => ctx.desktop.capture(account.id, org));
  ctx.io.stdout(ctx.t(`${account.name} kaydedildi.`, `Saved ${account.name}.`));
  return EXIT.ok;
}

function forget(ctx: CliContext, id: string) {
  ctx.store.update((s) => {
    s.accounts = s.accounts.filter((a) => a.id !== id);
  });
}

export const add: Command = async ({ io, deps, parsed, t, argv }) => {
  const { flags } = parsed;
  const ctx = await openContext(io, deps, flags, { write: true, desktop: true });
  const accounts = ctx.store.state.accounts;
  if (flags.cancel || flags.resume) {
    const state = await assertCanQuitClaude(ctx, { allowPending: true });
    const inside = await insideDesktop(ctx);
    const ends = inside ? [sessionEndsLine(ctx)] : [];
    const pending = state.pendingProfileId ? accounts.find((a) => a.id === state.pendingProfileId) : undefined;
    if (!state.pendingProfileId) {
      io.stdout(t("Yarım kalan bir giriş yok.", "No sign-in is pending."));
      return flags.cancel ? EXIT.ok : EXIT.failed;
    }
    if (flags.resume) {
      if (!pending)
        throw new CliError(t("Yarım kalan girişin hesabı bulunamadı; relay add --cancel ile iptal edin.", "The pending sign-in's account is gone; cancel it with relay add --cancel."), EXIT.failed);
      await confirm(io, t, [t(`Giriş ${pending.name} hesabına kaydedilecek; Claude Desktop kısa bir süre kapanıp açılacak.`, `The sign-in will be saved as ${pending.name}; Claude Desktop will quit briefly and reopen.`), ...quitLines(ctx), ...ends], ctx.yes);
      if (inside) return detach(ctx, argv);
      return finishSignIn(ctx, pending);
    }
    await confirm(io, t, [t("Yarım kalan giriş iptal edilecek: Claude Desktop kapanıp önceki hesapla yeniden açılacak.", "The pending sign-in will be cancelled: Claude Desktop will quit and reopen signed in as before."), ...quitLines(ctx), ...ends], ctx.yes);
    if (inside) return detach(ctx, argv);
    await runDesktopOperation(ctx, () => ctx.desktop.cancelLogin());
    if (pending && !pending.desktop && !pending.auth) forget(ctx, pending.id);
    io.stdout(t("Giriş iptal edildi.", "The sign-in was cancelled."));
    return EXIT.ok;
  }
  const name = parsed.positionals[0]?.trim();
  if (!name || parsed.positionals.length > 1 || name.length > 64)
    throw new CliError(t("Kullanım: relay add <ad> [--work [--group <grup>]] [--org <kimlik>] [--new]", "Usage: relay add <name> [--work [--group <group>]] [--org <id>] [--new]"), EXIT.usage);
  // An account of that name without a Desktop link (made in Relay.app) is linked instead.
  const existing = accounts.find((a) => foldName(a.name) === foldName(name) && !a.desktop);
  if (!existing) assertFreeName(accounts, name, t);
  const state = await assertCanQuitClaude(ctx);
  const inside = await insideDesktop(ctx);
  const ends = inside ? [sessionEndsLine(ctx)] : [];
  const current = state.currentAccountUuid;
  const currentSaved = !!current && accounts.some((a) => a.desktop?.accountUuid === current);
  const create = () =>
    existing ??
    ctx.store.create({
      name,
      kind: flags.work ? "work" : "personal",
      group: flags.work ? ((flags.group as string | undefined) ?? undefined) : undefined,
    });
  if (current && !currentSaved && !flags.new) {
    const org = await pickOrg(ctx, current, state.organizations);
    await confirm(
      io,
      t,
      [
        t(
          `Claude Desktop'ta açık olan hesap (${current.slice(0, 8)}) ${name} adıyla kaydedilecek; Claude kısa bir süre kapanıp açılacak.`,
          `The account signed in to Claude Desktop (${current.slice(0, 8)}) will be saved as ${name}; Claude will quit briefly and reopen.`,
        ),
        ...quitLines(ctx),
        ...ends,
      ],
      ctx.yes,
    );
    // The worker has no terminal to pick a workspace in: it gets the one picked here.
    if (inside) return detach(ctx, ctx.flags.org ? argv : [...argv, "--org", org]);
    const account = create();
    try {
      await runDesktopOperation(ctx, () => ctx.desktop.capture(account.id, org));
    } catch (error) {
      if (!existing) forget(ctx, account.id);
      throw error;
    }
    io.stdout(t(`${name} kaydedildi.`, `Saved ${name}.`));
    return EXIT.ok;
  }
  if (current && !currentSaved)
    throw new CliError(
      t(
        "Claude Desktop'ta açık olan hesap henüz kayıtlı değil. Önce onu relay add <ad> ile kaydedin, sonra --new ile yenisini ekleyin.",
        "The account signed in to Claude Desktop is not saved yet. Save it first with relay add <name>, then add another with --new.",
      ),
      EXIT.failed,
    );
  await confirm(
    io,
    t,
    [
      t(
        "Claude Desktop kapanıp giriş ekranında açılacak. Yeni hesapla giriş yapıp Code sekmesini açın; bu terminal bekler.",
        "Claude Desktop will quit and reopen on its sign-in screen. Sign in with the new account and open the Code tab; this terminal waits.",
      ),
      ...quitLines(ctx),
      ...ends,
    ],
    ctx.yes,
  );
  if (inside) return detach(ctx, argv);
  const account = create();
  try {
    await runDesktopOperation(ctx, () => ctx.desktop.beginLogin(account.id));
  } catch (error) {
    if (!existing) forget(ctx, account.id);
    throw error;
  }
  return finishSignIn(ctx, ctx.store.account(account.id));
};
