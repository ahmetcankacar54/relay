/** Relay's notifications, on this computer and posted to the user's ntfy topic or webhook. */
import { app, Notification } from "electron";
import path from "node:path";
import { meterRisk, needsRiskAck } from "../../shared/feature-risk";
import { FORMAT_LOCALE } from "../../shared/i18n/locales";
import { enabledMeters } from "../../shared/meters";
import { notificationSettings } from "../../shared/notifications";
import { formatPercent, percentUsed } from "../../shared/percent";
import type { ProxyLoopAlarm } from "../../shared/proxy-types";
import type { Account, FleetContinuationState } from "../../shared/types";
import { draftNotice } from "../core/draft-main";
import { fleetNotice } from "../core/fleet-continuation";
import { LimitNotices, type LimitWindowKind } from "../core/limit-notice";
import { MeterService } from "../core/meters";
import { RemoteNotifier } from "../core/remote-notify";
import type { KeeperDeps } from "../core/window-keeper";
import { getAppLocale, say } from "../i18n";
import { recordMainError } from "./errors";
import { desktop, observedDesktop, service } from "./state";
import { broadcastChanged, openPage } from "./windows";
/**
 * The limit notices: a warning when the account in use crosses the threshold (also gated by "Mark
 * accounts near their limit"), and "ready again" after a window that reached it resets.
 */
export const limitNotices = new LimitNotices({
  settings: () => service.store.state.settings,
  inUse: () => observedDesktop?.activeProfileId,
  notify: notifyLimitNear,
  ready: notifyLimitReady,
  file: () => path.join(app.getPath("userData"), "limit-notices.json"),
});
/**
 * The remote notifications (Settings → General → Notifications): the same events, posted to the
 * saved ntfy topic or webhook. A failed post is recorded redacted, without the URL.
 */
export const remoteNotifier = new RemoteNotifier({
  settings: () => service.store.state.settings,
  version: () => app.getVersion(),
  log: (line) => recordMainError("remote-notify", line),
});
/**
 * The other tools' usage meters (Settings → Other tools): only those turned on and whose risk is
 * accepted, so a list restored from a backup without the answer reads nothing until it is given.
 */
export const meters = new MeterService({
  enabled: () => {
    const settings = service.store.state.settings;
    return enabledMeters(settings).filter((provider) => !needsRiskAck(settings, meterRisk(provider)));
  },
  onChange: () => broadcastChanged(),
  log: (line) => recordMainError("meters", line),
});
/** Whether a notification type is on in Settings → General → Notifications. */
export const notifies = (kind: "switches" | "signIns" | "earlyStart" | "updates") =>
  notificationSettings(service.store.state.settings)[kind];
/** Accounts the extension notice was shown for since Relay started: once each, not every switch. */
const extensionNoticeShown = new Set<string>();
/**
 * After a manual switch whose extension step left the Claude browser extension on another
 * account (mode "guide", or "closed" with the browser open): Claude's browser tools only work
 * when the extension is on the conversation's account, so the user hears it here and not only
 * in the panel. A click opens Settings → Switching.
 */
export function notifyExtensionLeft(target: Account) {
  const outcome = desktop.extensionOutcome;
  // Every outcome that leaves the extension elsewhere, not only a running browser: the target
  // has no pair saved ("saved", "no-saved-login"), its owner is unclear, or the step failed.
  // Before 2026-11-14 a switch to an account without a pair left it behind without a word.
  const quiet = new Set(["off", "not-installed", "already-there", "not-opened", "choose-instance"]);
  const left =
    !!outcome &&
    (outcome.result === "saved" ||
      ((outcome.result === "skipped" || outcome.result === "failed") && !quiet.has(outcome.reason ?? "")));
  if (
    !Notification.isSupported() ||
    !notifies("switches") ||
    !outcome ||
    !left ||
    Date.now() - Date.parse(outcome.at) > 5 * 60_000 ||
    extensionNoticeShown.has(target.id)
  )
    return;
  extensionNoticeShown.add(target.id);
  const current = outcome.current;
  const on =
    current?.state === "signed-in" && current.accountUuid
      ? service.store.state.accounts.find((a) =>
          [a.desktop?.accountUuid, a.auth?.accountUuid].some(
            (uuid) => uuid?.toLowerCase() === current.accountUuid!.toLowerCase(),
          ),
        )?.name
      : undefined;
  const notice = new Notification({
    title: on
      ? say("electronMain.extensionStillOn", { on })
      : say("electronMain.extensionNotSwitched"),
    body: say("electronMain.claudeSBrowserToolsDoNot", { targetName: target.name }),
  });
  notice.on("click", () => openPage("gecis"));
  notice.show();
}
/**
 * After a step put a claude.ai login in place and the extension could not sign in to `account`
 * with it: Relay forgot that login, and Claude's browser tools stay off until the user signs in
 * again. A click opens Settings → Switching, where the reconnect steps are.
 */
/** A prompt through the gateway went past a loop bound: said once per prompt; a click opens the gateway page. */
export function notifyLoopAlarm(alarm: ProxyLoopAlarm) {
  if (!Notification.isSupported()) return;
  const account = service.store.state.accounts.find((a) => a.id === alarm.accountId)?.name;
  const notice = new Notification({
    title: say("electronMain.aPromptKeepsSendingRequests"),
    body: say("electronMain.requestsSubagentsItMayBeIn", { alarmRequests: alarm.requests, alarmSubagents: alarm.subagents, p1: account ? ` · ${account}` : "" }),
  });
  notice.on("click", () => openPage("proxy"));
  notice.show();
}
export function notifyExtensionBroken(account: Account) {
  if (!Notification.isSupported() || !notifies("signIns")) return;
  const notice = new Notification({
    title: say("electronMain.extensionCannotSignIn"),
    body: say("electronMain.claudeSBrowserToolsDoNot2", { accountName: account.name }),
  });
  notice.on("click", () => openPage("gecis"));
  notice.show();
}
/** Says that an account's Claude Code sign-in ends soon (or ended) and Relay could not renew it. */
export function notifySignInEnding(account: Account, endsAt?: string) {
  const end = endsAt ? Date.parse(endsAt) : NaN;
  const days = Number.isFinite(end) && end > Date.now() ? Math.max(1, Math.ceil((end - Date.now()) / 86_400_000)) : 0;
  const title = days
    ? say("electronMain.claudeCodeSignInEndsIn", { accountName: account.name, days })
    : say("electronMain.claudeCodeSignInEnded", { accountName: account.name });
  const body = say("electronMain.signInToThisAccountAgain");
  remoteNotifier.notify({ event: "sign-in-ending", accountName: account.name, title, message: body });
  if (!Notification.isSupported() || !notifies("signIns")) return;
  const notice = new Notification({ title, body });
  notice.on("click", () => openPage("hesaplar"));
  notice.show();
}
/** Says that the account in use passed the warning threshold, and when that window resets; a click opens Overview. */
function notifyLimitNear(account: Account, kind: LimitWindowKind, window: { usedPercent: number; resetsAt?: string }) {
  const language = getAppLocale();
  // Rounded down, as every bar shows it: 99.6 reads 99, not 100.
  const percent = formatPercent(percentUsed(window.usedPercent), language);
  const reset = window.resetsAt ? new Date(window.resetsAt) : undefined;
  const when =
    reset && Number.isFinite(reset.getTime())
      ? reset.toLocaleString(FORMAT_LOCALE[language], kind === "five_hour" ? { hour: "2-digit", minute: "2-digit" } : { weekday: "long", hour: "2-digit", minute: "2-digit" })
      : undefined;
  const title = say(kind === "five_hour" ? "electronMain.fiveHourLimitNear" : "electronMain.weeklyLimitNear", { accountName: account.name, percent });
  const body = when ? say("electronMain.limitResetsAt", { when }) : "";
  remoteNotifier.notify({
    event: "limit-near",
    accountName: account.name,
    window: kind,
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
    title,
    message: body,
  });
  if (!Notification.isSupported()) return;
  const notice = new Notification({ title, body });
  notice.on("click", () => openPage("genel"));
  notice.show();
}
/** Says that a window which reached the warning threshold has reset; a click opens Overview. */
function notifyLimitReady(account: Account, kind: LimitWindowKind) {
  const title = say("electronMain.accountReadyAgain", { accountName: account.name });
  const body = say(kind === "five_hour" ? "electronMain.fiveHourLimitReset" : "electronMain.weeklyLimitReset");
  remoteNotifier.notify({ event: "limit-ready", accountName: account.name, window: kind, title, message: body });
  if (!Notification.isSupported()) return;
  const notice = new Notification({ title, body });
  notice.on("click", () => openPage("genel"));
  notice.show();
}
/** Says that an account's saved Claude sign-in ended; a click opens the account. */
export function notifySignInEnded(account: Account) {
  const title = say("electronMain.claudeSignInEnded");
  const body = say("electronMain.theSavedSignInOfNo", { accountName: account.name });
  remoteNotifier.notify({ event: "sign-in-ended", accountName: account.name, title, message: body });
  if (!Notification.isSupported() || !notifies("signIns")) return;
  const notice = new Notification({ title, body });
  notice.on("click", () => openPage("hesaplar"));
  notice.show();
}
/** Says once per version that a downloaded update is ready; a click opens Overview, where the sidebar row offers it. */
export function notifyUpdate(version: string) {
  if (!Notification.isSupported() || !notifies("updates")) return;
  const notice = new Notification({
    title: say("electronMain.updateReady"),
    body: say("electronMain.clickToInstallRelay", { version }),
  });
  notice.on("click", () => openPage("genel"));
  notice.show();
}
/** Same copy as the menu bar switch; shown after a tray or panel switch. */
export function notifySwitched(name: string) {
  if (!Notification.isSupported() || !notifies("switches")) return;
  new Notification({
    title: say("electronMain.switchComplete"),
    body: say("electronMain.theClaudeAppSwitchedTo", { name }),
  }).show();
}
/** After the fleet switched at the limit: where Claude went, and what became of the conversations. */
export function notifyFleet(
  last: NonNullable<FleetContinuationState["last"]>,
  reason?: string,
) {
  const target = service.store.state.accounts.find((a) => a.id === last.targetId);
  const name = target?.name ?? say("electronMain.another");
  const title = say("electronMain.automaticSwitch");
  const body = fleetNotice(last, name, getAppLocale(), reason);
  if (target) remoteNotifier.notify({ event: "auto-switch", accountName: target.name, title, message: body });
  if (!Notification.isSupported() || !notifies("switches")) return;
  new Notification({ title, body }).show();
}
/**
 * After preparing on quit put the Claude app on another account: posted remotely only, as the
 * window's automation card already says it and Relay never showed a notification for it.
 */
export function remoteAutoSwitched(targetId: string) {
  const target = service.store.state.accounts.find((a) => a.id === targetId);
  if (!target) return;
  remoteNotifier.notify({
    event: "auto-switch",
    accountName: target.name,
    title: say("electronMain.automaticSwitch"),
    message: say("electronMain.theClaudeAppSwitchedTo", { name: target.name }),
  });
}
/** After a draft restore: how many drafts were typed back, and how many wait in the panel. */
export function notifyDrafts(summary: { restored: number; left: number }) {
  const body = draftNotice(summary, getAppLocale());
  if (!body || !Notification.isSupported() || !notifies("switches")) return;
  new Notification({ title: say("common.rescuedDrafts"), body }).show();
}
/** Today's plan was re-planned at today's pace, or is back to normal. */
export function notifyAdapted(
  notice: Parameters<NonNullable<KeeperDeps["adapted"]>>[0],
) {
  if (!Notification.isSupported() || !notifies("earlyStart")) return;
  const { accounts, settings } = service.store.state;
  // Clocks in the planning zone, without suffixes.
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: settings.planning.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const list = notice.schedule
    .flatMap(({ accountId, startAt }) => {
      const account = accounts.find((a) => a.id === accountId);
      return account
        ? [`${account.name} ${clock.format(new Date(startAt))}`]
        : [];
    })
    .join(", ");
  new Notification({
    title: say("electronMain.earlyStart"),
    body:
      notice.kind === "normal"
        ? say("electronMain.thePlanIsBackToNormal")
        : say("electronMain.planAdaptedToTodaySPace", { list }),
  }).show();
}
