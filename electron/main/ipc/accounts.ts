/** Accounts: their planning and switch line, sign-ins, terminals, and the files Relay asks the user to pick. */
import { app, ipcMain } from "electron";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { antigravityAccountRisks } from "../../../shared/feature-risk";
import { REMOTE_NOTIFY_URL_MAX } from "../../../shared/remote-notify";
import { forgetSignInSession } from "../../auth-window";
import { isClaudeDesktopExecutable } from "../../core/environment";
import { accountPlanningSchema, accountSchema, createAccountSchema } from "../../core/store";
import { say } from "../../i18n";
import { antigravityBridges, antigravityOAuthTimers, pendingAntigravityOAuth } from "../antigravity";
import { desktopLock, manualDesktopLock, profileLocks } from "../desktop-lock";
import { alignDesktopWorkspace } from "../desktop-support";
import { proxySettings, resetProxyExtrasCache } from "../gateway";
import { remoteNotifier } from "../notifications";
import {
  antigravitySwitcher,
  autoSwitch,
  desktop,
  keeper,
  proxyServer,
  service,
  tray,
  usage,
  usageCredentialRefresher,
} from "../state";
import { broadcastChanged, openDialog } from "../windows";
import type { IpcKit } from "./index";
import { trusted } from "./trust";
export function registerAccountIpc({ handle, id, key, requireRisk }: IpcKit) {
  handle("account-planning", (accountId, input) => {
    if (desktop.isBusy || desktopLock.busy)
      throw new Error(
        "Finish the Desktop operation before changing preferences.",
      );
    const account = service.store.account(id.parse(accountId));
    const planning = accountPlanningSchema.parse(input);
    service.store.update((s) => {
      s.accounts.find((a) => a.id === account.id)!.planning = planning;
    });
    // Capacity shapes the plan: replan as after a planning edit.
    keeper.resume();
    void keeper.tick();
    return service.store.account(account.id);
  });
  // An account's own switch line: the ranking, the suggestion and preparing on quit read it next.
  handle("account-switch-at", (accountId, input) => {
    if (desktop.isBusy || desktopLock.busy)
      throw new Error(
        "Finish the Desktop operation before changing preferences.",
      );
    const account = service.store.account(id.parse(accountId));
    const percent = accountSchema.shape.switchAtPercent.parse(input ?? undefined);
    service.store.update((s) => {
      const saved = s.accounts.find((a) => a.id === account.id)!;
      if (percent === undefined) delete saved.switchAtPercent;
      else saved.switchAtPercent = percent;
    });
    broadcastChanged();
    return service.store.account(account.id);
  });
  // A sample event to the URL in the form, saved or not; the answer never holds the URL.
  handle("test-remote-notify", (input) => {
    const target = z
      .object({ url: z.string().max(REMOTE_NOTIFY_URL_MAX), kind: z.enum(["ntfy", "webhook"]) })
      .strict()
      .parse(input);
    return remoteNotifier.test(target, {
      accountName: say("electronMain.remoteTestAccount"),
      window: "five_hour",
      usedPercent: 90,
      resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      title: say("electronMain.remoteTestTitle"),
      message: say("electronMain.remoteTestBody"),
    });
  });
  handle("create-account", (input) => {
    const account = createAccountSchema.parse(input);
    if (account.provider === "antigravity") requireRisk(antigravityAccountRisks(proxySettings().enabled));
    return service.store.create(account);
  });
  handle("update-account", (accountId, input) => {
    const updated = service.store.edit(id.parse(accountId), createAccountSchema.parse(input));
    void tray?.update();
    broadcastChanged();
    return updated;
  });
  // Under the Desktop lock, so no switch to the account starts while it goes. Its usage history
  // and token counts stay: they are the user's record; its profile's transcripts are gone.
  handle("remove-account", (accountId) => {
    const account = id.parse(accountId);
    if (desktop.isBusy)
      throw new Error(
        "Finish the Desktop handoff before starting another Desktop operation.",
      );
    return manualDesktopLock(() =>
      service.transaction(async () => {
        antigravityBridges.get(account)?.stop();
        antigravityBridges.delete(account);
        pendingAntigravityOAuth.delete(account);
        const oauthTimer = antigravityOAuthTimers.get(account);
        if (oauthTimer) clearInterval(oauthTimer);
        antigravityOAuthTimers.delete(account);
        const removed = await service.remove(account, {
          vault: path.join(app.getPath("userData"), "desktop-vault"),
          locks: profileLocks(),
          desktop: () => desktop.snapshot(),
        });
        usage.forget(account);
        // removeAccount took it out of proxy-pool.json; the gateway forgets its sessions.
        resetProxyExtrasCache();
        proxyServer?.sessionCache.evictAccount(account);
        // Its Antigravity app sign-in kept in the vault goes with it, like every other sign-in Relay keeps.
        await antigravitySwitcher?.forget(account).catch(() => {});
        void forgetSignInSession(account).catch(() => {});
        keeper.resume();
        void keeper.tick();
        void autoSwitch.tick();
        return removed;
      }),
    ).finally(() => {
      void tray?.update();
      broadcastChanged();
    });
  });
  handle("check-auth", (accountId) =>
    service.transaction(() => {
      const account = id.parse(accountId);
      if (usageCredentialRefresher.isRefreshing(account))
        throw new Error("Wait for the account connection refresh to finish.");
      return service.checkAuth(account).then(async (checked) => {
        await alignDesktopWorkspace(checked).catch(() => {});
        return service.store.account(account);
      });
    }),
  );
  handle("login", (accountId) => {
    if (desktopLock.busy)
      throw new Error("Finish the Desktop handoff before signing in.");
    return service.transaction(() => {
      const account = id.parse(accountId);
      if (usageCredentialRefresher.isRefreshing(account))
        throw new Error("Wait for the account connection refresh to finish.");
      return service.login(account);
    });
  });
  handle("reopen-login", (accountId, attemptId, where) =>
    service.auth.reopen(
      id.parse(accountId),
      id.parse(attemptId),
      z.enum(["window", "browser"]).optional().parse(where),
    ),
  );
  handle("cancel-login", (accountId, attemptId) =>
    service.auth.cancel(id.parse(accountId), id.parse(attemptId)),
  );
  handle("submit-login-code", (accountId, attemptId, code) =>
    service.auth.submitCode(
      id.parse(accountId),
      id.parse(attemptId),
      z.string().max(4096).parse(code),
    ),
  );
  handle("close-run", (runId) => service.runner.close(id.parse(runId)));
  handle("launch", (input) => service.transaction(() => service.launch(input)));
  handle("switch-account", (runId, accountId) =>
    service.transaction(() =>
      service.switchAccount(id.parse(runId), id.parse(accountId)),
    ),
  );
  handle("pick-folder", async () => {
    const result = await openDialog({
      properties: ["openDirectory"],
      title: say("electronMain.selectTheProjectFolder"),
    });
    return result.canceled ? null : result.filePaths[0];
  });
  handle("pick-executable", async () => {
    // The official installer puts `claude` in the hidden ~/.local/bin.
    const installed = path.join(os.homedir(), ".local", "bin");
    const opensThere = await fsp
      .stat(installed)
      .then((s) => s.isDirectory())
      .catch(() => false);
    const result = await openDialog({
      properties: ["openFile", "showHiddenFiles"],
      ...(opensThere ? { defaultPath: installed } : {}),
      title: say("electronMain.selectTheClaudeCodeCliFile"),
    });
    if (!result.canceled) {
      // Claude Desktop is not the CLI: running it for `auth status` or `--version` only opens it.
      if (isClaudeDesktopExecutable(result.filePaths[0]))
        throw new Error(
          say("electronMain.thisFileIsTheClaudeDesktop"),
        );
      service.store.update((s) => {
        s.executable = result.filePaths[0];
      });
      await service.diagnose();
    }
  });
  handle("pick-claude-app", async () => {
    const mac = process.platform === "darwin";
    const result = await openDialog({
      properties: ["openFile"],
      ...(mac ? { defaultPath: "/Applications" } : {}),
      title: say("electronMain.selectTheClaudeApp"),
    });
    if (result.canceled || !result.filePaths[0]) return;
    // The store's change reaches every window, which reads the Desktop state again.
    service.store.update((s) => {
      s.claudeApp = result.filePaths[0];
    });
  });
  handle("import", () => {
    service.store.update((s) => {
      s.importEnabled = true;
    });
  });
  handle("pin", (sessionKey, pinned) =>
    service.pin(key.parse(sessionKey), z.boolean().parse(pinned)),
  );
  handle("cooldown", (accountId, hours) =>
    service.cooldown(
      id.parse(accountId),
      z.number().int().min(0).max(168).parse(hours),
    ),
  );
  handle("transcript", (sessionKey) =>
    service.transcript(key.parse(sessionKey)),
  );
  handle("buffer", (runId) => service.runner.buffer(id.parse(runId)));
  handle("stop", (runId) => service.runner.stop(id.parse(runId)));
  ipcMain.on("relay:write", (event, runId, data) => {
    try {
      trusted(event);
      service.runner.write(id.parse(runId), z.string().max(64_000).parse(data));
    } catch {
      /* Ignore invalid one-way messages. */
    }
  });
  ipcMain.on("relay:resize", (event, runId, cols, rows) => {
    try {
      trusted(event);
      service.runner.resize(
        id.parse(runId),
        z.number().int().min(10).max(500).parse(cols),
        z.number().int().min(3).max(200).parse(rows),
      );
    } catch {
      /* Ignore invalid one-way messages. */
    }
  });
}
