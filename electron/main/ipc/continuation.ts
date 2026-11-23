/** Continuing conversations at the limit, the Accessibility request, and the panel's draft and sidebar offers. */
import { clipboard, shell, systemPreferences } from "electron";
import { z } from "zod";
import { draftActions } from "../../core/draft-main";
import { sidebarActions } from "../../core/sidebar-main";
import { accessibilityWanted, logDraftEvent } from "../logs";
import { automation, continuation, desktop, draftRestore, fleet } from "../state";
import { broadcastChanged } from "../windows";
import type { IpcKit } from "./index";
export function registerContinuationIpc({ handle, id }: IpcKit) {
  handle("inspect-continuation", () => continuation.inspect());
  handle("arm-continuation", async (targetId, policy) => {
    const targetAccountId = z
      .union([z.literal("automatic"), id])
      .parse(targetId);
    const executionPolicy = z
      .literal("guarded-native-at-most-once")
      .parse(policy);
    // Ask for the saved sign-ins' Keychain consent now, not during the handoff.
    await desktop.verifySavedLogins();
    return continuation.arm({ targetAccountId, executionPolicy });
  });
  handle("disarm-continuation", () => continuation.disarm());
  handle("set-fleet-continuation", async (enabled) => {
    const on = z.boolean().parse(enabled);
    if (on) {
      // Ask for the saved sign-ins' Keychain consent now, not during a handoff.
      await desktop.verifySavedLogins();
      // One monitor at a time: the all-conversations mode replaces a single watch.
      if (continuation.snapshot().enabled) await continuation.disarm();
    }
    const state = fleet.setEnabled(on);
    if (on) void fleet.tick();
    return state;
  });
  handle("reconcile-continuation", () => continuation.resumePending());
  handle("abandon-continuation", () => continuation.abandonPending());
  handle("request-desktop-accessibility", async () => {
    if (process.platform !== "darwin") return false;
    // With draft re-typing and continuation off, nothing needs it: never ask.
    if (!accessibilityWanted()) return false;
    // Register the explicit permission request against the foreground Relay app.
    // A helper-only request can obscure which rebuilt app owns the OS consent.
    systemPreferences.isTrustedAccessibilityClient(true);
    // The child still verifies its real access; the main-process result alone
    // must never authorize Desktop inspection or any automation.
    const granted = (await automation.requestAccessibility?.()) ?? false;
    // Drafts left for Copy for want of access go back to waiting for the next run.
    if (granted) void draftRestore.retryAccessibility();
    if (process.platform === "darwin" && !granted)
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      );
    return granted;
  });
  const draft = draftActions({
    drafts: desktop,
    writeClipboard: (text) => clipboard.writeText(text),
    changed: broadcastChanged,
    log: logDraftEvent,
  });
  handle("copy-draft", (draftId) => draft.copy(draftId));
  handle("dismiss-draft", (draftId) => draft.dismiss(draftId));
  const sidebar = sidebarActions({
    gaps: desktop,
    writeClipboard: (text) => clipboard.writeText(text),
    changed: broadcastChanged,
    log: logDraftEvent,
  });
  handle("copy-sidebar-recipe", (gapId) => sidebar.copy(gapId));
  handle("dismiss-sidebar-gap", (gapId) => sidebar.dismiss(gapId));
}
