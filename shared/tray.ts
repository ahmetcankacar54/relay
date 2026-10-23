import type { Account, AccountUsage, DesktopState, WindowAttempt } from "./types";
import { desktopCliMismatch } from "./account-state";
import { formatPercent, formatUsed, percentUsed, usedWord } from "./percent";
import { freshUsage } from "./usage";
import { activeReading, HUNGRY_PERCENT, mascotRest } from "./mascot";
import { clockLocative } from "./tr-dative";

export interface TraySnapshot {
  accounts: Account[];
  usage: Record<string, AccountUsage>;
  desktop?: DesktopState;
  authBusy?: boolean;
  /** The keeper's recent window starts, for the menu bar panda. */
  attempts?: WindowAttempt[];
  /** The account a running Desktop switch opens; the title names it while Desktop is busy. */
  switchingTo?: string;
  /** The planning time zone, for the clock a full window reopens at; the system's when absent. */
  timeZone?: string;
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
    unavailable: "The Claude app was not found",
    statusUnavailable: "Claude app status unavailable",
    loading: "Checking the Claude app connection…",
    busy: "A Claude app action is running",
    pending: "Finish the Claude app sign-in first",
    authBusy: "Finish the usage sign-in first",
    recovery: "Restore the backup first",
    unlinked: "Save Claude app sign-in",
    mismatch: "Sign-ins belong to different accounts",
    outdated: "usage data is out of date",
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
    unavailable: "Claude uygulaması bulunamadı",
    statusUnavailable: "Claude uygulamasının durumu okunamadı",
    loading: "Claude uygulaması bağlantısı kontrol ediliyor…",
    busy: "Claude uygulamasında bir işlem sürüyor",
    pending: "Önce Claude uygulaması girişini tamamla",
    authBusy: "Önce limit okuma girişini tamamla",
    recovery: "Önce yedeği geri yükle",
    unlinked: "Claude uygulaması girişini kaydet",
    mismatch: "Girişler farklı hesaplara ait",
    outdated: "limit verisi eski",
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

/** The Desktop-active account's five-hour window; undefined while unknown or old (the panda's rule). */
function activeFiveHour(snapshot: TraySnapshot, now: number) {
  const active = snapshot.accounts.find(
    (a) => a.id === snapshot.desktop?.activeProfileId,
  );
  return active ? activeReading(snapshot, now)?.fiveHour : undefined;
}

/** From this percent used on, the menu bar also says when the five-hour window renews; the panda gets hungry. */
export const TRAY_RESET_FROM = HUNGRY_PERCENT;
/** The title shows at most this many characters of the account a switch opens. */
export const TRAY_NAME_MAX = 14;

/** A name on one line. */
const oneLine = (name: string) => name.replace(/[\r\n\t]/g, " ");

/** The account a running Desktop switch opens, while Desktop is busy with it. */
function switchTarget(snapshot: TraySnapshot) {
  const id = snapshot.desktop?.busy ? snapshot.switchingTo : undefined;
  return id ? snapshot.accounts.find((a) => a.id === id) : undefined;
}

/** A name on one line, cut to TRAY_NAME_MAX characters; the "…" that follows it in the title also marks the cut. */
export function trayShortName(name: string) {
  const chars = Array.from(oneLine(name).trim());
  return chars.length <= TRAY_NAME_MAX
    ? chars.join("")
    : chars.slice(0, TRAY_NAME_MAX - 1).join("").trimEnd();
}

const resetClocks = new Map<string, Intl.DateTimeFormat>();
/** The clock time `resetsAt` comes at ("22:50"), in the time zone given or the system's; undefined when past or unknown. */
export function trayResetClock(
  resetsAt: string | undefined,
  now: number,
  language: TrayLanguage = "en",
  timeZone?: string,
): string | undefined {
  const at = resetsAt ? Date.parse(resetsAt) : NaN;
  if (!Number.isFinite(at) || at <= now) return undefined;
  const key = `${language}:${timeZone ?? ""}`;
  let format = resetClocks.get(key);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat(language === "tr" ? "tr-TR" : "en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone,
      });
    } catch {
      // An unknown zone: the system's clock is still right for the menu bar.
      return timeZone ? trayResetClock(resetsAt, now, language) : undefined;
    }
    resetClocks.set(key, format);
  }
  return format.format(at);
}

/** Time left until `resetsAt` as "h:mm" ("1:50", "0:07"); undefined when past or unknown. */
export function trayCountdown(resetsAt: string | undefined, now: number) {
  const at = resetsAt ? Date.parse(resetsAt) : NaN;
  if (!Number.isFinite(at) || at <= now) return undefined;
  const minutes = Math.ceil((at - now) / 60_000);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/** A "h:mm" countdown as Turkish says it after a number: "1 sa 50 dk", "50 dk", "2 sa". */
function spokenCountdown(left: string) {
  const [hours, minutes] = left.split(":").map(Number);
  if (!hours) return `${minutes} dk`;
  return minutes ? `${hours} sa ${minutes} dk` : `${hours} sa`;
}

/** Why the title shows "—": the panda sleeps. During another Desktop operation Claude may be closed for a moment. */
function trayRest(snapshot: TraySnapshot, now: number) {
  return snapshot.desktop?.busy ? undefined : mascotRest(snapshot, now);
}

/**
 * The title in words: the account's name and, when known, the percent used of its five-hour window with
 * the word the title leaves out, and when the window renews (at a clock time once it is full). During a
 * switch it names the account being opened; while the panda sleeps, why.
 */
export function trayTooltip(
  snapshot: TraySnapshot,
  language: TrayLanguage = "en",
  now = Date.now(),
) {
  const target = switchTarget(snapshot);
  if (target)
    return language === "tr"
      ? `Relay — ${oneLine(target.name)} hesabına geçiliyor…`
      : `Relay — Switching to ${oneLine(target.name)}…`;
  const active = snapshot.accounts.find(
    (a) => a.id === snapshot.desktop?.activeProfileId,
  );
  const rest = trayRest(snapshot, now);
  const why =
    rest === "closed"
      ? language === "tr"
        ? "Claude uygulaması kapalı"
        : "Claude app closed"
      : rest === "unknown"
        ? language === "tr"
          ? "limit verisi eski"
          : "usage data is out of date"
        : undefined;
  if (!active) return why ? `Relay — ${why}` : "Relay";
  if (why) return `Relay — ${oneLine(active.name)} · ${why}`;
  const window = activeFiveHour(snapshot, now);
  const used = window?.usedPercent;
  const figure = used === undefined ? "" : ` · ${formatUsed(used, language)}`;
  const clock =
    percentUsed(used) === 100
      ? trayResetClock(window?.resetsAt, now, language, snapshot.timeZone)
      : undefined;
  const left = trayCountdown(window?.resetsAt, now);
  // A full window opens again at a clock time; one with room renews after the time left.
  const renews = clock
    ? language === "tr"
      ? ` · ${clockLocative(clock)} açılır`
      : ` · opens at ${clock}`
    : left
      ? language === "tr"
        ? ` · ${spokenCountdown(left)} sonra yenilenir`
        : ` · renews in ${left}`
      : "";
  return `Relay — ${oneLine(active.name)}${figure}${renews}`;
}

/**
 * Menu-bar text: the percent used of the Desktop-active account's five-hour window, compact ("%94" /
 * "94%"; the tooltip adds the word), empty when unknown. From 80 % on, when the window's end
 * starts to matter, it adds the time left until it renews ("%94 · 1:50"); below that the item
 * stays as narrow as a number. A full window gives the clock it reopens at instead ("22:50", in the
 * planning time zone). While a switch runs it names the account being opened ("Max…"), and while
 * the panda sleeps (Claude closed, or the reading failed or is old) it shows "—". The menu bar
 * panda shows the warning.
 */
export function trayTitle(
  snapshot: TraySnapshot,
  now = Date.now(),
  language: TrayLanguage = "en",
) {
  const target = switchTarget(snapshot);
  if (target) return `${trayShortName(target.name)}…`;
  if (trayRest(snapshot, now)) return "—";
  const window = activeFiveHour(snapshot, now);
  const used = percentUsed(window?.usedPercent);
  if (used === undefined) return "";
  const clock =
    used === 100 ? trayResetClock(window?.resetsAt, now, language, snapshot.timeZone) : undefined;
  if (clock) return clock;
  const left = used >= TRAY_RESET_FROM ? trayCountdown(window?.resetsAt, now) : undefined;
  return formatPercent(used, language) + (left ? ` · ${left}` : "");
}
