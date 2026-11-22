import type { Account, RelaySettings } from "../../shared/types";
import type { MessageId, T } from "../../shared/i18n/translate";
import { RELAY_APPS } from "./deps";
import type { LockInfo } from "../../electron/core/process-lock";

/** What a lock's holder is doing, in words: "Relay.app is switching accounts" and so on. */
export function lockHolderText(holder: LockInfo, t: T): string {
  const who =
    holder.by === "app"
      ? "Relay.app"
      : holder.by === "cli"
        ? t("describe.anotherRelayCommand")
        : t("describe.anotherRelayProcess");
  const doing: Record<string, MessageId> = {
    switch: "describe.isSwitchingAccounts",
    save: "describe.isSavingAnAccount",
    link: "describe.isStartingASignIn",
    "cancel-link": "describe.isCancellingASignIn",
    merge: "describe.isBringingCodeHistoryOver",
    restore: "describe.isRestoringAnInterruptedSwitchS",
    reset: "describe.isResettingTheVault",
    "desktop-task": "describe.isDoingATaskInThe",
    "draft-retype": "describe.isReTypingADraft",
  };
  return t(doing[holder.kind] ?? "describe.isRunningAClaudeAppOperation", { who });
}

export function historyModeText(mode: RelaySettings["desktopHistoryTransfer"], t: T): string {
  switch (mode) {
    case "all":
      return t("describe.sharedAcrossAllAccounts");
    case "same-group":
      return t("describe.sharedWithinEachGroup");
    case "selected":
      return t("describe.sharedBetweenTheSelectedAccounts");
    case "off":
      return t("describe.notShared");
  }
}

/** The group's name as the user typed it, or undefined for a work account in its own group. */
export function groupName(account: Account): string | undefined {
  if (account.kind !== "work" || !account.group.startsWith("work:")) return undefined;
  const name = account.group.slice(5);
  return name === account.id ? undefined : name;
}

export function kindText(account: Account, t: T): string {
  if (account.kind === "personal") return t("describe.personal");
  const group = groupName(account);
  return group ? `${t("describe.work")} · ${group}` : t("describe.work");
}

export type LimitsState = "connected" | "not-connected" | "error";
export function limitsState(account: Account): LimitsState {
  if (account.auth?.error) return "error";
  return account.auth?.loggedIn ? "connected" : "not-connected";
}

export function limitsText(state: LimitsState, t: T): string {
  return state === "connected"
    ? t("describe.signedIn")
    : state === "error"
      ? t("describe.connectionNeedsRenewing")
      : t("describe.none");
}

/** Whether a process inside a Relay.app bundle is in a `ps -axo pid=,ppid=,comm=` listing. */
export function relayAppRunning(listing: string): boolean {
  return listing
    .split("\n")
    .some((line) => RELAY_APPS.some((app) => line.includes(`${app}/Contents/MacOS/`)) || /\/Relay\.app\/Contents\/MacOS\/Relay\s*$/.test(line));
}

export const seconds = (from: string, now: number) =>
  Math.max(0, Math.round((now - Date.parse(from)) / 1000));
