import fs from "node:fs";
import { diagnoseCli } from "../../../electron/core/cli-diagnostics";
import { claudeExecutable } from "../../../electron/core/desktop-host-node";
import { VaultKeyError, readVaultKey } from "../../../electron/core/vault-key";
import { readsUsage } from "../../../shared/cli-version";
import { peekTerminal } from "../../../electron/core/terminal-identity";
import { DEFAULT_TERMINAL_MODE, sameIdentity, terminalIdentities } from "../../../shared/terminal-identity";
import { localizeError } from "../../../shared/error-text";
import type { Command } from "../command";
import { openContext } from "../context";
import { relayAppRunning } from "../describe";
import { olderThan } from "../guards";
import { EXIT } from "../io";
import { paint, printJson } from "../output";

type Status = "ok" | "warn" | "fail";
interface Check {
  check: string;
  status: Status;
  detail: string;
}

export const doctor: Command = async ({ io, deps, parsed, t }) => {
  const ctx = await openContext(io, deps, parsed.flags, { write: false, desktop: false });
  const checks: Check[] = [];
  const add = (check: string, status: Status, detail: string) => checks.push({ check, status, detail });
  add("platform", ctx.deps.platform === "darwin" ? "ok" : "fail", `${ctx.deps.platform} ${process.arch}`);
  add(
    "node",
    olderThan(process.versions.node, "22.12.0") ? "fail" : "ok",
    t("doctor.node2212OrNewerNeeded", { versionsNode: process.versions.node }),
  );
  const app = claudeExecutable(ctx.paths.claudeApps);
  add("claude-app", app ? "ok" : "fail", app ?? t("doctor.theClaudeAppWasNotFound"));
  const cli = await diagnoseCli(ctx.deps.claude(ctx.store.state.executable), ctx.paths.data);
  add(
    "claude-cli",
    !cli.executable || cli.error || !readsUsage(cli.version ?? "") ? "warn" : "ok",
    !cli.executable
      ? t("doctor.noClaudeCodeCliOnlyNeeded")
      : cli.error
        ? localizeError(cli.error, ctx.lang)
        : readsUsage(cli.version ?? "")
          ? `${cli.executable} · ${cli.version}`
          : t("doctor.limitsNeed21296Or", { cliVersion: cli.version }),
  );
  let folder: Check["status"] = "ok";
  let folderDetail = ctx.paths.data;
  try {
    const stat = fs.lstatSync(ctx.paths.data);
    if (stat.isSymbolicLink()) [folder, folderDetail] = ["fail", t("doctor.isASymbolicLink", { pathsData: ctx.paths.data })];
    else if (stat.mode & 0o077) [folder, folderDetail] = ["warn", t("doctor.shouldBePrivate0700", { pathsData: ctx.paths.data })];
  } catch {
    [folder, folderDetail] = ["warn", t("doctor.doesNotExist", { pathsData: ctx.paths.data })];
  }
  add("data-folder", folder, folderDetail);
  const vault = ctx.vault;
  add(
    "vault",
    vault.kind === "legacy" || vault.kind === "newer" ? "fail" : "ok",
    vault.kind === "legacy"
      ? ctx.appVersion && !olderThan(ctx.appVersion, "0.12.0")
        ? t("doctor.oldFormatOpenRelayAppAnd")
        : t("doctor.oldFormatUpdateRelayAppTo")
      : vault.kind === "newer"
        ? t("doctor.writtenByANewerRelayUpdate")
        : vault.kind === "empty"
          ? t("doctor.emptyMadeWithTheFirstAccount")
          : t("doctor.ready"),
  );
  if (vault.kind === "ready" || vault.kind === "newer") {
    try {
      await readVaultKey(ctx.deps.securityTool);
      add("key", "ok", t("doctor.relayVaultKeyIsReadableIn"));
    } catch (error) {
      add(
        "key",
        "fail",
        error instanceof VaultKeyError && error.reason !== "locked"
          ? `${localizeError(error.message, ctx.lang)} ${t("doctor.toStartOverRelayResetVault")}`
          : error instanceof VaultKeyError
            ? localizeError(error.message, ctx.lang)
            : String(error),
      );
    }
  } else add("key", "ok", t("doctor.madeWithTheFirstAccount"));
  let appRunning = false;
  try {
    appRunning = relayAppRunning(await ctx.deps.processList());
  } catch {
    // Unknown.
  }
  add(
    "relay-app",
    ctx.appVersion && olderThan(ctx.appVersion, "0.12.0") ? "fail" : "ok",
    ctx.appVersion
      ? `${ctx.appVersion}${appRunning ? t("doctor.running") : t("doctor.notRunning")}${olderThan(ctx.appVersion, "0.12.0") ? t("doctor.updateTo012OrLater") : ""}`
      : t("doctor.notInstalledNotNeeded"),
  );
  const holder = ctx.lock.holder();
  add("lock", holder ? "warn" : "ok", holder ? `${holder.by} · ${holder.kind} · ${holder.startedAt}` : t("doctor.free"));
  const state = await ctx.desktop.snapshot();
  add(
    "desktop",
    state.pendingProfileId || state.recoveryRequired ? "warn" : "ok",
    state.recoveryRequired
      ? t("doctor.interruptedSwitchRelayRecover")
      : state.pendingProfileId
        ? t("doctor.pendingSignInRelayAddResume")
        : t("doctor.readyToSwitch"),
  );
  if (ctx.deps.terminal && (ctx.store.state.settings.terminalCli ?? DEFAULT_TERMINAL_MODE) !== "off") {
    const accounts = ctx.store.state.accounts;
    const seen = await peekTerminal(ctx.deps.terminal, accounts.flatMap(terminalIdentities));
    const on =
      seen.accountUuid && seen.orgId
        ? accounts.find((a) => terminalIdentities(a).some((x) => sameIdentity(x, seen as { accountUuid: string; orgId: string })))
        : undefined;
    const active = state.activeProfileId ? accounts.find((a) => a.id === state.activeProfileId) : undefined;
    add(
      "terminal",
      seen.state === "signed-in" && on && (!active || active.id === on.id) ? "ok" : "warn",
      seen.state === "unreadable"
        ? t("doctor.couldNotReadTheTerminalClaude")
        : seen.state === "signed-out"
          ? t("doctor.theTerminalClaudeIsSignedOut")
          : !on
            ? t("doctor.theTerminalClaudeIsOnAn", { join: [seen.email, seen.orgName].filter(Boolean).join(" · ") })
            : active && active.id !== on.id
              ? t("doctor.theTerminalClaudeIsOnDesktop", { onName: on.name, activeName: active.name })
              : t("doctor.theTerminalClaudeIsOn", { onName: on.name }),
    );
  }
  add(
    "gui-session",
    ctx.deps.guiSession() ? "ok" : "warn",
    ctx.deps.guiSession()
      ? t("doctor.macosDesktopSession")
      : t("doctor.noDesktopSessionSshClaudeCannot"),
  );
  add(
    "automation",
    "ok",
    t("doctor.macosAsksForTheAutomationPermission"),
  );
  const failed = checks.some((c) => c.status === "fail");
  if (ctx.json) printJson(io, checks);
  else
    for (const c of checks) {
      const mark = c.status === "ok" ? paint(ctx.color, "green", "✓") : c.status === "warn" ? paint(ctx.color, "yellow", "!") : paint(ctx.color, "red", "✗");
      io.stdout(`${mark} ${c.check.padEnd(12)} ${c.detail}`);
    }
  return failed ? EXIT.environment : EXIT.ok;
};
