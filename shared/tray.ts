import type { Account, AccountUsage, DesktopState, WindowAttempt } from "./types";
import { desktopCliMismatch } from "./account-state";
import { formatLeft, formatPercent, percentLeft } from "./percent";
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
    unavailable: "Claude app connection unavailable",
    statusUnavailable: "Claude app status unavailable",
    loading: "Checking the Claude app connection…",
    busy: "Claude app operation in progress",
    pending: "Finish the Claude app sign-in first",
    authBusy: "Finish the usage sign-in first",
    recovery: "Restore the backup first",
    unlinked: "Save Claude app sign-in",
    mismatch: "Sign-ins belong to different accounts",
    outdated: "outdated",
    fiveHour: "5h",
    week: "wk",
  },
  tr: {
    show: "Relay’i aç",
    quit: "Relay’den çık",
    active: "Aktif",
    unknownActive: "Kayıtlı aktif hesap yok",
    empty: "Relay’de hesap ekle",
    review: "Kalan limit · geçmek için hesap seç",
    unavailable: "Claude uygulaması bağlantısı kullanılamıyor",
    statusUnavailable: "Claude uygulamasının durumu okunamadı",
    loading: "Claude uygulaması bağlantısı kontrol ediliyor…",
    busy: "Claude uygulaması işlemi sürüyor",
    pending: "Önce Claude uygulaması girişini tamamla",
    authBusy: "Önce limit okuma girişini tamamla",
    recovery: "Önce yedeği geri yükle",
    unlinked: "Claude uygulaması girişini kaydet",
    mismatch: "Girişler farklı hesaplara ait",
    outdated: "güncel değil",
    fiveHour: "5 sa",
    week: "hafta",
  },
};

// Native menus interpret ampersands as access keys on some platforms. Keep
// user-provided names readable and prevent line breaks from adding false rows.
export function trayAccountName(name: string) {
  return name.replace(/[\r\n\t]/g, " ").replace(/&/g, "&&");
}

/** What is left of a window, with its word ("6% left"); "?" for a reading that cannot be right. */
function quotaLeft(used: number | undefined, language: TrayLanguage) {
  return used !== undefined && Number.isFinite(used) && used >= 0 && used <= 100
    ? formatLeft(used, language)
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
    return `${t.fiveHour} ? · ${t.week} ?${usage?.checkedAt ? ` · ${t.outdated}` : ""}`;
  return `${t.fiveHour} ${quotaLeft(usage.fiveHour?.usedPercent, language)} · ${t.week} ${quotaLeft(usage.sevenDay?.usedPercent, language)}`;
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

/**
 * The menu when a snapshot could not be read: opening Relay and quitting stay; no account
 * action is offered against unknown Claude app state.
 */
export function unavailableTrayMenu(
  language: TrayLanguage = "en",
): TrayMenuItem[] {
  const t = labels[language];
  return [
    { type: "normal", label: t.show, enabled: true, command: { type: "show" } },
    { type: "normal", label: t.statusUnavailable, enabled: false },
    { type: "separator" },
    { type: "normal", label: t.quit, enabled: true, command: { type: "quit" } },
  ];
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

/** The percent used of the Desktop-active account's five-hour window; undefined while unknown or old. */
function activeFiveHourUsed(snapshot: TraySnapshot, now: number) {
  const active = snapshot.accounts.find(
    (a) => a.id === snapshot.desktop?.activeProfileId,
  );
  const usage = active ? snapshot.usage[active.id] : undefined;
  if (!active || !freshUsage(usage, now) || usage.fiveHour === undefined)
    return undefined;
  return usage.fiveHour.usedPercent;
}

/** The account's name and, when known, what its five-hour window has left, with the word the title leaves out. */
export function trayTooltip(
  snapshot: TraySnapshot,
  language: TrayLanguage = "en",
  now = Date.now(),
) {
  const active = snapshot.accounts.find(
    (a) => a.id === snapshot.desktop?.activeProfileId,
  );
  if (!active) return "Relay";
  const used = activeFiveHourUsed(snapshot, now);
  const left = used === undefined ? "" : ` · ${formatLeft(used, language)}`;
  return `Relay — ${active.name.replace(/[\r\n\t]/g, " ")}${left}`;
}

/**
 * Menu-bar text: what the Desktop-active account's five-hour window has left, compact ("%6" / "6%";
 * the tooltip adds the word), empty when unknown. The menu bar panda shows the warning; the title stays a plain number.
 */
export function trayTitle(
  snapshot: TraySnapshot,
  now = Date.now(),
  language: TrayLanguage = "en",
) {
  const left = percentLeft(activeFiveHourUsed(snapshot, now));
  return left === undefined ? "" : formatPercent(left, language);
}
