import type { Account, RelaySettings } from "../../shared/types";
import type { Translate } from "./i18n";
import { RELAY_APPS } from "./deps";
import type { LockInfo } from "../../electron/core/process-lock";

/** What a lock's holder is doing, in words: "Relay.app is switching accounts" and so on. */
export function lockHolderText(holder: LockInfo, t: Translate): string {
  const who =
    holder.by === "app"
      ? "Relay.app"
      : holder.by === "cli"
        ? t("Başka bir relay komutu", "Another relay command")
        : t("Başka bir Relay işlemi", "Another Relay process");
  const doing: Record<string, [string, string]> = {
    switch: ["hesap değiştiriyor", "is switching accounts"],
    save: ["bir hesabı kaydediyor", "is saving an account"],
    link: ["yeni bir giriş başlatıyor", "is starting a sign-in"],
    "cancel-link": ["bir girişi iptal ediyor", "is cancelling a sign-in"],
    merge: ["Code geçmişini taşıyor", "is bringing Code history over"],
    restore: ["yarıda kalan geçişin yedeğini geri yüklüyor", "is restoring an interrupted switch’s backup"],
    reset: ["kasayı sıfırlıyor", "is resetting the vault"],
    "desktop-task": ["Claude uygulamasında bir iş yapıyor", "is doing a task in the Claude app"],
    "draft-retype": ["bir taslağı yeniden yazıyor", "is re-typing a draft"],
  };
  const [tr, en] = doing[holder.kind] ?? ["Claude uygulamasında bir işlem yapıyor", "is running a Claude app operation"];
  return `${who} ${t(tr, en)}`;
}

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
    ? t("var", "signed in")
    : state === "error"
      ? t("bağlantı yenilenmeli", "connection needs renewing")
      : t("yok", "none");
}

/** Whether a process inside a Relay.app bundle is in a `ps -axo pid=,ppid=,comm=` listing. */
export function relayAppRunning(listing: string): boolean {
  return listing
    .split("\n")
    .some((line) => RELAY_APPS.some((app) => line.includes(`${app}/Contents/MacOS/`)) || /\/Relay\.app\/Contents\/MacOS\/Relay\s*$/.test(line));
}

export const seconds = (from: string, now: number) =>
  Math.max(0, Math.round((now - Date.parse(from)) / 1000));
