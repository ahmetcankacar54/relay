/** Settings and planning, usage reads, Claude Code's status line and the Claude app's sign-in. */
import { app, nativeTheme } from "electron";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { meterRisks, planningRisks } from "../../../shared/feature-risk";
import { themeSource } from "../../core/appearance";
import {
  ClaudeSettingsUnreadable,
  STATUSLINE_PREVIOUS_FILE,
  installStatusline,
  statuslineCommand,
  statuslineSetup,
  uninstallStatusline,
} from "../../core/claude-statusline";
import { findRelayCli } from "../../core/relay-cli-path";
import { planningPatchSchema, planningSchema, settingsPatchSchema } from "../../core/store";
import { say } from "../../i18n";
import { desktopLock } from "../desktop-lock";
import { desktopUsageAllowed, desktopUsageReader } from "../desktop-usage";
import { applyLaunchAtLogin } from "../login-item";
import { draftRetype } from "../logs";
import { meters } from "../notifications";
import {
  autoSwitch,
  desktop,
  draftRestore,
  globalShortcuts,
  keeper,
  service,
  signInRenewal,
  usage,
} from "../state";
import { appUpdates } from "../updates";
import { broadcastChanged } from "../windows";
import type { IpcKit } from "./index";
export function registerSettingsIpc({ handle, id, requireRisk }: IpcKit) {
  handle("update-settings", (input) => {
    if (desktop.isBusy || desktopLock.busy)
      throw new Error(
        "Finish the Desktop operation before changing preferences.",
      );
    const patch = settingsPatchSchema.parse(input);
    if (patch.meters) requireRisk(meterRisks(service.store.state.settings.meters, patch.meters));
    for (const selected of [
      patch.desktopHistoryAccounts,
      patch.autoSwitchAccounts,
    ]) {
      if (
        selected &&
        (new Set(selected).size !== selected.length ||
          selected.some(
            (profileId) =>
              !service.store.state.accounts.some(
                (account) => account.id === profileId,
              ),
          ))
      )
        throw new Error("Select existing Relay accounts once each.");
    }
    const retype = draftRetype();
    const launchAtLogin = service.store.state.settings.launchAtLogin;
    const updateChannel = service.store.state.settings.updateChannel ?? "stable";
    service.store.update((s) => {
      Object.assign(s.settings, patch);
    });
    nativeTheme.themeSource = themeSource(service.store.state.settings);
    if (service.store.state.settings.launchAtLogin !== launchAtLogin) void applyLaunchAtLogin();
    if (patch.shortcuts) globalShortcuts?.apply(service.store.state.settings.shortcuts);
    if ((service.store.state.settings.updateChannel ?? "stable") !== updateChannel)
      void appUpdates?.channelChanged();
    usage.tick();
    // A meter just turned on is read now; the others wait for their interval.
    if (patch.meters) void meters.tick();
    void autoSwitch.tick();
    // Turned off, the drafts still pending go to Copy now, not at the next switch.
    if (draftRetype() !== retype) void draftRestore.retypeChanged();
    return service.store.state.settings;
  });
  handle("update-planning", (input) => {
    if (desktop.isBusy || desktopLock.busy)
      throw new Error(
        "Finish the Desktop operation before changing preferences.",
      );
    const patch = planningPatchSchema.parse(input);
    requireRisk(planningRisks(service.store.state.settings.planning, patch));
    const next = planningSchema.parse({
      ...service.store.state.settings.planning,
      ...patch,
    });
    if (
      next.accounts.some(
        ({ id }) => !service.store.state.accounts.some((a) => a.id === id),
      )
    )
      throw new Error("Select existing Relay accounts once each.");
    service.store.update((s) => {
      s.settings.planning = next;
    });
    keeper.resume();
    void keeper.tick();
    return next;
  });
  handle("refresh-usage", (accountId, allowPrompt) =>
    usage.refresh(
      id.parse(accountId),
      z.boolean().optional().parse(allowPrompt),
    ),
  );
  // Relay in Claude Code's status line (`relay statusline`), as `relay statusline install|uninstall`
  // sets it; `enable` turns it on or off, then the state comes back with where relay is installed.
  // Without an installed relay it is never turned on: Claude Code would run a missing command.
  handle("claude-statusline", async (raw) => {
    const enable = z.boolean().optional().parse(raw);
    const claudeDir = path.join(os.homedir(), ".claude");
    const previous = path.join(app.getPath("userData"), STATUSLINE_PREVIOUS_FILE);
    const cli = await findRelayCli();
    try {
      if (enable === true && cli) installStatusline(claudeDir, previous, statuslineCommand([cli]));
      if (enable === false) uninstallStatusline(claudeDir, previous);
      return { ...statuslineSetup(claudeDir), ...(cli ? { cli } : {}) };
    } catch (error) {
      if (error instanceof ClaudeSettingsUnreadable)
        throw new Error(say("statusline.settingsUnreadable", { file: error.file }));
      throw error;
    }
  });
  handle("claude-app-access", async (raw) => {
    const ask = z.boolean().optional().parse(raw) ?? false;
    if (process.platform !== "darwin" || !desktopUsageReader) return { supported: false, allowed: false };
    const allowed = desktopUsageAllowed;
    if (ask) {
      // A refusal comes back as the state below; it is not an error to show.
      await desktopUsageReader.allowKeychain().catch(() => {});
      if (await allowed()) {
        // Reads and renewals that waited for it run now, not at their next turn.
        for (const account of service.store.state.accounts)
          if (usage.snapshot()[account.id]?.issue === "expired") void usage.refresh(account.id, true).catch(() => {});
        void signInRenewal?.retryUnavailable().catch(() => {});
      }
    }
    return { supported: true, allowed: await allowed() };
  });
  handle("renew-sign-in-now", async (accountId) => {
    const account = service.store.account(id.parse(accountId));
    if (!signInRenewal) return { result: "unavailable", detail: "only on macOS" };
    const outcome = await signInRenewal.renewNow(account);
    broadcastChanged();
    return outcome;
  });
}
