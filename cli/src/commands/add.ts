import fs from "node:fs/promises";
import path from "node:path";
import { readObject } from "../../../electron/core/desktop-files";
import { readSignIn } from "../../../electron/core/sign-in-wait";
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
  return `${org}  ${t("add.conversationS", { count })}${newest?.title ? ` · “${newest.title}”` : ""}`;
}

/** The workspace (Code organization) to save: --org, the only one, or a numbered pick. */
async function pickOrg(
  ctx: CliContext,
  accountUuid: string,
  orgs: string[],
  /** The workspace the Claude app is in, used when --org names none. */
  preferred?: string,
): Promise<string> {
  const { t, io } = ctx;
  const flag = ctx.flags.org as string | undefined;
  if (flag) {
    const found = orgs.find((org) => org.toLowerCase() === flag.toLowerCase());
    if (!found)
      throw new CliError(t("add.thisAccountHasNoWorkspace", { flag }), EXIT.usage);
    return found;
  }
  if (!orgs.length)
    throw new CliError(
      t("add.thisAccountHasNoCodeWorkspace"),
      EXIT.failed,
    );
  if (orgs.length === 1) return orgs[0];
  if (preferred && orgs.includes(preferred)) return preferred;
  if (!io.isTTY)
    throw new CliError(
      t("add.thisAccountHasSeveralWorkspacesPick", { join: orgs.join(", ") }),
      EXIT.usage,
    );
  io.stdout(t("add.whichWorkspaceShouldBeSaved"));
  for (const [i, org] of orgs.entries()) io.stdout(`  ${i + 1}) ${await describeOrg(ctx, accountUuid, org)}`);
  const answer = Number((await io.prompt(`[1-${orgs.length}] `))?.trim());
  if (!Number.isInteger(answer) || answer < 1 || answer > orgs.length)
    throw new CliError(t("add.cancelledNothingChanged"), EXIT.failed);
  return orgs[answer - 1];
}

/** How long a worker (no terminal, nobody to press Ctrl+C) waits for a sign-in. */
const WORKER_SIGNIN_LIMIT_MS = 15 * 60_000;

/**
 * Waits for a new, unsaved account to be signed in to Claude Desktop with a Code workspace.
 * It stops, returning undefined, on Ctrl+C or a worker's time limit (the sign-in stays
 * pending), and when the sign-in stops being pending for `accountId` (finished or cancelled
 * elsewhere, in Relay.app for example).
 */
async function waitForSignIn(
  ctx: CliContext,
  accountId: string,
): Promise<{ accountUuid: string; orgs: string[]; preferred?: string } | undefined> {
  const { t, io } = ctx;
  const limit = Number(io.env.RELAY_SIGNIN_LIMIT_MS);
  const until =
    io.env.RELAY_WORKER === "1"
      ? io.now() + (Number.isFinite(limit) && limit > 0 ? limit : WORKER_SIGNIN_LIMIT_MS)
      : Infinity;
  const stillPending = t("add.stoppedWaitingTheSignInIs");
  const poll = Number(ctx.flags["poll-ms"] ?? 2000);
  const pollMs = Number.isFinite(poll) && poll > 0 ? poll : 2000;
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  let interrupted = false;
  let alreadyToldOf: string | undefined;
  io.onSignal(() => {
    interrupted = true;
    stop();
  });
  io.stdout(
    t("add.signInToTheClaudeApp"),
  );
  try {
    for (;;) {
      const state = await ctx.desktop.snapshot();
      if (state.pendingProfileId !== accountId) {
        io.stdout(
          t("add.theSignInIsNoLonger"),
        );
        return undefined;
      }
      if (io.now() >= until) {
        io.stdout(stillPending);
        return undefined;
      }
      const reading = readSignIn(state, ctx.store.state.accounts, accountId);
      if (reading.kind === "ready")
        return { accountUuid: reading.accountUuid, orgs: reading.orgs, preferred: reading.preferred };
      const saved = reading.kind === "saved-elsewhere" ? reading.account : undefined;
      // Signed back in with a saved account: say so once, and keep waiting for the new one.
      if (saved && saved.desktop?.accountUuid !== alreadyToldOf) {
        alreadyToldOf = saved.desktop?.accountUuid;
        io.stdout(
          t("add.theClaudeAppIsSignedIn", { savedName: saved.name }),
        );
      }
      await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, pollMs))]);
      if (interrupted) {
        io.stdout(stillPending);
        return undefined;
      }
    }
  } finally {
    io.onSignal(undefined);
  }
}

/** Waits for the sign-in, then saves it into `account`. */
async function finishSignIn(ctx: CliContext, account: Account): Promise<number> {
  const signed = await waitForSignIn(ctx, account.id);
  if (!signed) return EXIT.failed;
  const org = await pickOrg(ctx, signed.accountUuid, signed.orgs, signed.preferred);
  await runDesktopOperation(ctx, () => ctx.desktop.capture(account.id, org));
  ctx.io.stdout(ctx.t("add.saved", { accountName: account.name }));
  return EXIT.ok;
}

function forget(ctx: CliContext, id: string) {
  ctx.store.update((s) => {
    s.accounts = s.accounts.filter((a) => a.id !== id);
  });
}

export const add: Command = async ({ io, deps, parsed, t, argv }) => {
  const { flags } = parsed;
  // The CLI adds Claude accounts only; Codex and Antigravity are connected in Relay.app,
  // which checks their sign-in. Checked first, so a mistyped provider never quits Claude.
  const provider = typeof flags.provider === "string" ? flags.provider.toLowerCase() : undefined;
  if (provider !== undefined && provider !== "claude")
    throw new CliError(
      t("add.relayAddOnlyAddsClaudeAccounts"),
      EXIT.usage,
    );
  const ctx = await openContext(io, deps, flags, { write: true, desktop: true });
  const accounts = ctx.store.state.accounts;
  if (flags.cancel || flags.resume) {
    const state = await assertCanQuitClaude(ctx, { allowPending: true });
    const inside = await insideDesktop(ctx);
    const ends = inside ? [sessionEndsLine(ctx)] : [];
    const pending = state.pendingProfileId ? accounts.find((a) => a.id === state.pendingProfileId) : undefined;
    if (!state.pendingProfileId) {
      io.stdout(t("add.noSignInIsPending"));
      return flags.cancel ? EXIT.ok : EXIT.failed;
    }
    if (flags.resume) {
      if (!pending)
        throw new CliError(t("add.thePendingSignInSAccount"), EXIT.failed);
      await confirm(io, t, [t("add.theSignInWillBeSaved", { pendingName: pending.name }), ...quitLines(ctx), ...ends], ctx.yes);
      if (inside) return detach(ctx, argv);
      return finishSignIn(ctx, pending);
    }
    await confirm(io, t, [t("add.thePendingSignInWillBe"), ...quitLines(ctx), ...ends], ctx.yes);
    if (inside) return detach(ctx, argv);
    await runDesktopOperation(ctx, () => ctx.desktop.cancelLogin());
    if (pending && !pending.desktop && !pending.auth) forget(ctx, pending.id);
    io.stdout(t("add.theSignInWasCancelled"));
    return EXIT.ok;
  }
  const name = parsed.positionals[0]?.trim();
  if (!name || parsed.positionals.length > 1 || name.length > 64)
    throw new CliError(t("add.usageRelayAddNameWorkGroup"), EXIT.usage);
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
        t("add.theAccountSignedInToThe", { slice: current.slice(0, 8), name }),
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
    io.stdout(t("add.saved2", { name }));
    return EXIT.ok;
  }
  if (current && !currentSaved)
    throw new CliError(
      t("add.theAccountSignedInToThe2"),
      EXIT.failed,
    );
  await confirm(
    io,
    t,
    [
      t("add.theClaudeAppWillQuitAnd"),
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
