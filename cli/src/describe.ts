import type { Account, RelaySettings } from "../../shared/types";
import type { Translate } from "./i18n";
import { RELAY_APPS } from "./deps";

export function historyModeText(mode: RelaySettings["desktopHistoryTransfer"], t: Translate): string {
  switch (mode) {
    case "all":
      return t("tüm hesaplar arasında paylaşılıyor", "shared across all accounts");
    case "same-group":
      return t("her grubun hesapları arasında paylaşılıyor", "shared within each group");
    case "selected":
      return t("seçili hesaplar arasında paylaşılıyor", "shared between the selected accounts");
    case "off":
      return t("paylaşılmıyor", "not shared");
  }
}

/** The group's name as the user typed it, or undefined for a work account in its own group. */
export function groupName(account: Account): string | undefined {
  if (account.kind !== "work" || !account.group.startsWith("work:")) return undefined;
  const name = account.group.slice(5);
  return name === account.id ? undefined : name;
}

export function kindText(account: Account, t: Translate): string {
  if (account.kind === "personal") return t("kişisel", "personal");
  const group = groupName(account);
  return group ? `${t("iş", "work")} · ${group}` : t("iş", "work");
}

export type LimitsState = "connected" | "not-connected" | "error";
export function limitsState(account: Account): LimitsState {
  if (account.auth?.error) return "error";
  return account.auth?.loggedIn ? "connected" : "not-connected";
}

export function limitsText(state: LimitsState, t: Translate): string {
  return state === "connected"
    ? t("bağlı", "connected")
    : state === "error"
      ? t("yeniden bağlanmalı", "needs reconnecting")
      : t("bağlı değil", "not connected");
}

/** Whether a process inside a Relay.app bundle is in a `ps -axo pid=,ppid=,comm=` listing. */
export function relayAppRunning(listing: string): boolean {
  return listing
    .split("\n")
    .some((line) => RELAY_APPS.some((app) => line.includes(`${app}/Contents/MacOS/`)) || /\/Relay\.app\/Contents\/MacOS\/Relay\s*$/.test(line));
}

export const seconds = (from: string, now: number) =>
  Math.max(0, Math.round((now - Date.parse(from)) / 1000));
