import type { Account, AccountUsage, DesktopState, WindowAttempt } from "./types";
import { desktopCliMismatch } from "./account-state";
import { formatPercent, formatUsed, percentUsed, usedWord } from "./percent";
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
    review: "Quota used · select an account to switch",
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
    review: "Kullanılan limit · geçmek için hesap seç",
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

/** The percent used of a window, without its word ("94%"); "?" for a reading that cannot be right. */
function quotaUsed(used: number | undefined, language: TrayLanguage) {
  return used !== undefined && Number.isFinite(used) && used >= 0 && used <= 100
    ? formatPercent(percentUsed(used), language)
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
  const five = quotaUsed(usage.fiveHour?.usedPercent, language);
  const week = quotaUsed(usage.sevenDay?.usedPercent, language);
  // One word at the end covers both figures; with nothing to describe it is left out.
  const word = five === "?" && week === "?" ? "" : ` ${usedWord(language)}`;
  return `${t.fiveHour} ${five} · ${t.week} ${week}${word}`;
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

/** The Desktop-active account's five-hour window; undefined while unknown or old. */
function activeFiveHour(snapshot: TraySnapshot, now: number) {
  const active = snapshot.accounts.find(
    (a) => a.id === snapshot.desktop?.activeProfileId,
  );
  const usage = active ? snapshot.usage[active.id] : undefined;
  if (!active || !freshUsage(usage, now) || usage.fiveHour === undefined)
    return undefined;
  return usage.fiveHour;
}
/** The percent used of the Desktop-active account's five-hour window; undefined while unknown or old. */
function activeFiveHourUsed(snapshot: TraySnapshot, now: number) {
  return activeFiveHour(snapshot, now)?.usedPercent;
}

/** From this percent used on, the menu bar also says when the five-hour window renews. */
export const TRAY_RESET_FROM = 80;

/** Time left until `resetsAt` as "h:mm" ("1:50", "0:07"); undefined when past or unknown. */
export function trayCountdown(resetsAt: string | undefined, now: number) {
  const at = resetsAt ? Date.parse(resetsAt) : NaN;
  if (!Number.isFinite(at) || at <= now) return undefined;
  const minutes = Math.ceil((at - now) / 60_000);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/** The account's name and, when known, the percent used of its five-hour window, with the word the title leaves out. */
export function trayTooltip(
  snapshot: TraySnapshot,
  language: TrayLanguage = "en",
  now = Date.now(),
) {
  const active = snapshot.accounts.find(
    (a) => a.id === snapshot.desktop?.activeProfileId,
  );
  if (!active) return "Relay";
  const window = activeFiveHour(snapshot, now);
  const used = window?.usedPercent;
  const figure = used === undefined ? "" : ` · ${formatUsed(used, language)}`;
  const left = trayCountdown(window?.resetsAt, now);
  const renews = left
    ? language === "tr"
      ? ` · ${left} sonra yenilenir`
      : ` · renews in ${left}`
    : "";
  return `Relay — ${active.name.replace(/[\r\n\t]/g, " ")}${figure}${renews}`;
}

/**
 * Menu-bar text: the percent used of the Desktop-active account's five-hour window, compact ("%94" /
 * "94%"; the tooltip adds the word), empty when unknown. From 80 % on, when the window's end
 * starts to matter, it adds the time left until it renews ("%94 · 1:50"); below that the item
 * stays as narrow as a number. The menu bar panda shows the warning.
 */
export function trayTitle(
  snapshot: TraySnapshot,
  now = Date.now(),
  language: TrayLanguage = "en",
) {
  const window = activeFiveHour(snapshot, now);
  const used = percentUsed(window?.usedPercent);
  if (used === undefined) return "";
  const left = used >= TRAY_RESET_FROM ? trayCountdown(window?.resetsAt, now) : undefined;
  return formatPercent(used, language) + (left ? ` · ${left}` : "");
}
