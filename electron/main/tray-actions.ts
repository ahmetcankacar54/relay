/** What the menu bar and the global shortcuts do: a confirmed switch, the panel, the window. */
import { app, dialog } from "electron";
import { localizeError } from "../../shared/error-text";
import { shortcutSwitchTarget } from "../core/global-shortcuts";
import { getAppLocale, say } from "../i18n";
import { manualDesktopLock } from "./desktop-lock";
import { separateWindows } from "./desktop-support";
import { notifyExtensionLeft, notifySwitched } from "./notifications";
import { desktop, observedDesktop, service, tray, trayPanel, usage } from "./state";
import { widgetTempoRate } from "./tokens-widget";
import { broadcastChanged, showWindow } from "./windows";
/** Menu-bar switch: one native confirmation, then the normal saved-login switch. */
export async function traySwitch(profileId: string) {
  const account = service.store.state.accounts.find((a) => a.id === profileId);
  if (!account) return;
  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: [
      say("electronMain.switchAndRestartTheClaudeApp"),
      say("common.cancel"),
    ],
    defaultId: 0,
    cancelId: 1,
    message: say("electronMain.switchTheClaudeAppTo", { accountName: account.name }),
    detail: say("electronMain.theClaudeAppQuitsAndReopens"),
  });
  if (response !== 0) return;
  try {
    await manualDesktopLock(() => desktop.switchTo(profileId));
    notifySwitched(account.name);
    notifyExtensionLeft(account);
  } catch (error) {
    dialog.showErrorBox(
      say("electronMain.switchFailed"),
      localizeError(
        error instanceof Error ? error.message : String(error),
        getAppLocale(),
      ),
    );
  } finally {
    void tray?.update();
    broadcastChanged();
  }
}
/**
 * The "open Relay" shortcut: the menu bar panel on macOS, shown without bringing Relay forward
 * like a click on the menu bar icon (a second press closes it); the main window elsewhere, or
 * when the panel cannot open.
 */
export function openFromShortcut() {
  const bounds = tray?.bounds();
  if (trayPanel?.usable() && bounds) return trayPanel.toggle(bounds);
  showWindow();
}
/** A shortcut's switch question is on screen: another press does not ask twice. */
let shortcutSwitchAsking = false;
/**
 * The "switch to the suggested account" shortcut: the account the panel's badge names, through
 * the menu bar's own confirmation, never silently. Without one, Relay opens to show why.
 */
export async function switchFromShortcut() {
  if (shortcutSwitchAsking) return;
  shortcutSwitchAsking = true;
  try {
    const now = Date.now();
    const windows = await separateWindows();
    const target = shortcutSwitchTarget({
      activeId: observedDesktop?.activeProfileId,
      accounts: service.store.state.accounts,
      usage: usage.snapshot(),
      settings: service.store.state.settings,
      now,
      rate: widgetTempoRate(now),
      inWindows: new Set(windows?.open.map((open) => open.accountId)),
    });
    if (!target) return openFromShortcut();
    // From another app the question would open behind it: Relay comes forward to ask.
    if (process.platform === "darwin") app.focus({ steal: true });
    await traySwitch(target.id);
  } finally {
    shortcutSwitchAsking = false;
  }
}
