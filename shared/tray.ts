import type { Account, AccountUsage, DesktopState, WindowAttempt } from "./types";
import { desktopCliMismatch } from "./account-state";
import { freshUsage } from "./usage";

export interface TraySnapshot {
  accounts: Account[];
  usage: Record<string, AccountUsage>;
  desktop?: DesktopState;
  authBusy?: boolean;
  /** The keeper's recent window starts, for the menu bar panda. */
  attempts?: WindowAttempt[];
}

export type TrayLanguage = "tr" | "en";
export type TrayCommand =
  | { type: "show" }
  | { type: "review-switch"; profileId: string }
  | { type: "quit" };
export type TrayMenuItem =
  | { type: "separator" }
  | {
      type: "normal" | "checkbox";
      label: string;
      enabled: boolean;
      checked?: boolean;
      command?: TrayCommand;
    };

const labels = {
  en: {
    show: "Open Relay",
    quit: "Quit Relay",
    active: "Active",
    unknownActive: "No saved account active",
    empty: "Add an account in Relay",
    review: "Remaining quota · select an account to switch",
    unavailable: "Desktop connection unavailable",
    loading: "Checking Desktop connection…",
    busy: "Desktop operation in progress",
    pending: "Finish Desktop sign-in first",
    authBusy: "Finish account sign-in first",
    recovery: "Restore Desktop backup first",
    unlinked: "Connect Desktop",
    mismatch: "Account identity mismatch",
    outdated: "outdated",
    week: "wk",
  },
  tr: {
    show: "Relay’i aç",
    quit: "Relay’den çık",
    active: "Aktif",
    unknownActive: "Kayıtlı aktif hesap yok",
    empty: "Relay’de hesap ekle",
    review: "Kalan limit · geçmek için hesap seç",
    unavailable: "Desktop bağlantısı kullanılamıyor",
    loading: "Desktop bağlantısı kontrol ediliyor…",
    busy: "Desktop işlemi sürüyor",
    pending: "Önce Desktop girişini tamamla",
    authBusy: "Önce hesap girişini tamamla",
    recovery: "Önce Desktop yedeğini geri yükle",
    unlinked: "Desktop’a bağla",
    mismatch: "Hesap kimliği eşleşmiyor",
    outdated: "güncel değil",
    week: "hf",
  },
};

// Native menus interpret ampersands as access keys on some platforms. Keep
// user-provided names readable and prevent line breaks from adding false rows.
export function trayAccountName(name: string) {
  return name.replace(/[\r\n\t]/g, " ").replace(/&/g, "&&");
}

function quotaPercent(used: number | undefined) {
  return used !== undefined && Number.isFinite(used) && used >= 0 && used <= 100
    ? `${Math.floor(100 - used)}%`
    : "?";
}

export function trayUsageLabel(
  accountId: string,
  usage: AccountUsage | undefined,
  language: TrayLanguage = "en",
  now = Date.now(),
) {
  const t = labels[language];
  const valid =
    usage?.accountId === accountId &&
    freshUsage(usage, now) &&
    Date.parse(usage.checkedAt!) <= now + 60_000;
  if (!valid)
    return `5h ? · ${t.week} ?${usage?.checkedAt ? ` · ${t.outdated}` : ""}`;
  return `5h ${quotaPercent(usage.fiveHour?.usedPercent)} · ${t.week} ${quotaPercent(usage.sevenDay?.usedPercent)}`;
}

function blockedLabel(snapshot: TraySnapshot, language: TrayLanguage) {
  const t = labels[language];
  const desktop = snapshot.desktop;
  if (!desktop) return t.loading;
  if (desktop.recoveryRequired) return t.recovery;
  if (desktop.busy) return t.busy;
  if (desktop.pendingProfileId) return t.pending;
  if (snapshot.authBusy) return t.authBusy;
  if (!desktop.available) return t.unavailable;
}

export function canRequestTraySwitch(
  snapshot: TraySnapshot,
  profileId: string,
) {
  const account = snapshot.accounts.find((a) => a.id === profileId);
  return (
    !blockedLabel(snapshot, "en") &&
    !!account?.desktop?.accountUuid &&
    !!account.desktop.orgId &&
    !desktopCliMismatch(account) &&
    snapshot.desktop?.activeProfileId !== profileId
  );
}

/** These commands only open a review. Executing a Desktop switch is deliberately
 * outside this menu's contract and remains behind Relay's restart confirmation. */
export function buildTrayMenu(
  snapshot: TraySnapshot,
  language: TrayLanguage = "en",
  now = Date.now(),
): TrayMenuItem[] {
  const t = labels[language];
  const active = snapshot.accounts.find(
    (a) => a.id === snapshot.desktop?.activeProfileId,
  );
  const blocked = blockedLabel(snapshot, language);
  return [
    { type: "normal", label: t.show, enabled: true, command: { type: "show" } },
    {
      type: "normal",
      label: active
        ? `${t.active}: ${trayAccountName(active.name)}`
        : t.unknownActive,
      enabled: false,
    },
    { type: "separator" },
    {
      type: "normal",
      label: blocked ?? t.review,
      enabled: false,
    },
    ...snapshot.accounts.map((account): TrayMenuItem => {
      const connected =
        !!account.desktop?.accountUuid && !!account.desktop.orgId;
      const mismatch = desktopCliMismatch(account);
      const detail = !connected
        ? t.unlinked
        : mismatch
          ? t.mismatch
          : trayUsageLabel(
              account.id,
              snapshot.usage[account.id],
              language,
              now,
            );
      const enabled = canRequestTraySwitch(snapshot, account.id);
      return {
        type: "checkbox",
        label: `${trayAccountName(account.name)} · ${detail}`,
        checked: account.id === snapshot.desktop?.activeProfileId,
        enabled,
        ...(enabled
          ? {
              command: {
                type: "review-switch",
                profileId: account.id,
              } as const,
            }
          : {}),
      };
    }),
    ...(!snapshot.accounts.length
      ? [{ type: "normal" as const, label: t.empty, enabled: false }]
      : []),
    { type: "separator" },
    { type: "normal", label: t.quit, enabled: true, command: { type: "quit" } },
  ];
}

export function trayTooltip(snapshot: TraySnapshot) {
  const active = snapshot.accounts.find(
    (a) => a.id === snapshot.desktop?.activeProfileId,
  );
  return active ? `Relay — ${active.name.replace(/[\r\n\t]/g, " ")}` : "Relay";
}

/** Menu-bar text: the Desktop-active account's five-hour percent, empty when unknown. */
export function trayTitle(snapshot: TraySnapshot, now = Date.now()) {
  const active = snapshot.accounts.find((a) => a.id === snapshot.desktop?.activeProfileId);
  const usage = active ? snapshot.usage[active.id] : undefined;
  if (!active || !freshUsage(usage, now) || usage.fiveHour === undefined) return "";
  // The menu bar panda shows the warning; the title stays a plain percent.
  return `${Math.round(usage.fiveHour.usedPercent)}%`;
}
