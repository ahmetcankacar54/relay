import { readObject } from "../../../electron/core/desktop-files";
import type { Command } from "../command";
import { openContext } from "../context";
import { historyModeText, lockHolderText, relayAppRunning, seconds } from "../describe";
import { paint, printJson } from "../output";
import { lastWorkerRecord, writeWorkerRecord } from "../inside-desktop";

export const status: Command = async ({ io, deps, parsed, t }) => {
  const ctx = await openContext(io, deps, parsed.flags, { write: false, desktop: false });
  const state = await ctx.desktop.snapshot();
  const accounts = ctx.store.state.accounts;
  const active = accounts.find((a) => a.id === state.activeProfileId);
  let pendingSignIn: { name: string; since?: string } | undefined;
  if (state.pendingProfileId) {
    const pending = await readObject(ctx.paths.vault, "pending.json").catch(() => null);
    pendingSignIn = {
      name: accounts.find((a) => a.id === state.pendingProfileId)?.name ?? state.pendingProfileId,
      ...(typeof pending?.startedAt === "string" ? { since: pending.startedAt } : {}),
    };
  }
  let appRunning = false;
  try {
    appRunning = relayAppRunning(await ctx.deps.processList());
  } catch {
    // Unknown: shown as not running.
  }
  const holder = ctx.lock.holder();
  const lock = holder ? { by: holder.by, kind: holder.kind, since: holder.startedAt } : undefined;
  const historyMode = ctx.store.state.settings.desktopHistoryTransfer;
  const last = lastWorkerRecord(ctx.paths.cliOperations);
  const lastOperation = last
    ? {
        command: last.argv.join(" "),
        status: last.status,
        ...(last.finishedAt ? { finishedAt: last.finishedAt } : {}),
        ...(last.error ? { error: last.error } : {}),
      }
    : undefined;
  if (ctx.json) {
    printJson(io, {
      desktop: {
        installed: state.available,
        running: state.running,
        ...(state.currentAccountUuid
          ? {
              account: {
                ...(active ? { id: active.id, name: active.name, orgId: active.desktop?.orgId } : {}),
                accountUuid: state.currentAccountUuid,
              },
            }
          : {}),
        ...(pendingSignIn ? { pendingSignIn } : {}),
        recoveryRequired: state.recoveryRequired,
      },
      relay: {
        appRunning,
        ...(ctx.appVersion ? { appVersion: ctx.appVersion } : {}),
        vault: ctx.vault.kind,
        ...(lock ? { lock } : {}),
        historyMode,
        ...(lastOperation ? { lastOperation } : {}),
      },
    });
    return 0;
  }
  const who = active
    ? active.name
    : state.currentAccountUuid
      ? t("status.anUnsavedAccount", { slice: state.currentAccountUuid.slice(0, 8) })
      : undefined;
  const desktopLine = !state.available
    ? t("status.notInstalled")
    : [
        state.running ? paint(ctx.color, "green", t("status.running")) : t("status.notRunning"),
        who ? t("status.signedInAs", { who }) : t("status.notSignedIn"),
      ].join(" · ");
  const lines = [`${t("common.claudeApp")}: ${desktopLine}`];
  if (pendingSignIn)
    lines.push(
      paint(ctx.color, "yellow", t("status.pendingSignIn", { pendingSignInName: pendingSignIn.name })) +
        t("status.finishWithRelayAddResumeCancel"),
    );
  if (state.recoveryRequired)
    lines.push(paint(ctx.color, "red", t("status.aSwitchWasInterruptedRelayRecover")));
  lines.push(
    `Relay.app: ${
      appRunning
        ? ctx.appVersion
          ? t("status.running2", { version: ctx.appVersion })
          : t("status.running")
        : ctx.appVersion
          ? t("status.installedNotRunning", { ctxAppVersion: ctx.appVersion })
          : t("status.notInstalled")
    }`,
  );
  if (holder)
    lines.push(
      t("status.lockS", { lockHolderText: lockHolderText(holder, t), seconds: seconds(holder.startedAt, io.now()) }),
    );
  if (ctx.vault.kind === "legacy")
    lines.push(t("status.vaultOldFormatUpdateRelayApp"));
  if (ctx.vault.kind === "newer")
    lines.push(t("status.vaultWrittenByANewerRelay"));
  lines.push(t("status.codeHistory", { historyModeText: historyModeText(historyMode, t) }));
  // A worker's result is shown once, after it ends; while it runs, every time.
  if (last && !last.shown) {
    const what = `relay ${last.argv.join(" ")}`;
    if (last.status === "pending" || last.status === "running")
      lines.push(t("status.runningInASeparateProcess", { what }));
    else {
      lines.push(
        last.status === "done"
          ? paint(ctx.color, "green", t("status.done", { what }))
          : paint(ctx.color, "red", t("status.failed", { what, p1: last.error ?? "" })),
      );
      try {
        writeWorkerRecord(ctx.paths.cliOperations, { ...last, shown: true });
      } catch {
        // Shown again next time.
      }
    }
  }
  for (const line of lines) io.stdout(line);
  return 0;
};
