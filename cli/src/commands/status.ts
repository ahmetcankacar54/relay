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
      ? t(`kayıtsız bir hesap (${state.currentAccountUuid.slice(0, 8)})`, `an unsaved account (${state.currentAccountUuid.slice(0, 8)})`)
      : undefined;
  const desktopLine = !state.available
    ? t("kurulu değil", "not installed")
    : [
        state.running ? paint(ctx.color, "green", t("açık", "running")) : t("kapalı", "not running"),
        who ? t(`${who} hesabıyla giriş yapılmış`, `signed in as ${who}`) : t("giriş yapılmamış", "not signed in"),
      ].join(" · ");
  const lines = [`Claude Desktop: ${desktopLine}`];
  if (pendingSignIn)
    lines.push(
      paint(ctx.color, "yellow", t(`Yarım kalan giriş: ${pendingSignIn.name}`, `Pending sign-in: ${pendingSignIn.name}`)) +
        t(" → bitirmek için relay add --resume, iptal için relay add --cancel", " → finish with relay add --resume, cancel with relay add --cancel"),
    );
  if (state.recoveryRequired)
    lines.push(paint(ctx.color, "red", t("Yarıda kalan bir geçiş var → relay recover", "A switch was interrupted → relay recover")));
  lines.push(
    `Relay.app: ${
      appRunning
        ? t(`açık${ctx.appVersion ? ` (${ctx.appVersion})` : ""}`, `running${ctx.appVersion ? ` (${ctx.appVersion})` : ""}`)
        : ctx.appVersion
          ? t(`kurulu (${ctx.appVersion}), kapalı`, `installed (${ctx.appVersion}), not running`)
          : t("kurulu değil", "not installed")
    }`,
  );
  if (holder)
    lines.push(
      t(
        `Kilit: ${lockHolderText(holder, t)} (${seconds(holder.startedAt, io.now())} sn)`,
        `Lock: ${lockHolderText(holder, t)} (${seconds(holder.startedAt, io.now())} s)`,
      ),
    );
  if (ctx.vault.kind === "legacy")
    lines.push(t("Kasa: eski biçimde → Relay.app'i 0.12 veya üstüne güncelleyip bir kez açın", "Vault: old format → update Relay.app to 0.12 or later and open it once"));
  if (ctx.vault.kind === "newer")
    lines.push(t("Kasa: daha yeni bir Relay yazmış → relay'i güncelleyin", "Vault: written by a newer Relay → update relay"));
  lines.push(t(`Code geçmişi: ${historyModeText(historyMode, t)}`, `Code history: ${historyModeText(historyMode, t)}`));
  // A worker's result is shown once, after it ends; while it runs, every time.
  if (last && !last.shown) {
    const what = `relay ${last.argv.join(" ")}`;
    if (last.status === "pending" || last.status === "running")
      lines.push(t(`Ayrı süreçte sürüyor: ${what}`, `Running in a separate process: ${what}`));
    else {
      lines.push(
        last.status === "done"
          ? paint(ctx.color, "green", t(`${what}: tamamlandı`, `${what}: done`))
          : paint(ctx.color, "red", t(`${what}: başarısız — ${last.error ?? ""}`, `${what}: failed — ${last.error ?? ""}`)),
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
