import type {
  Account,
  AccountUsage,
  DesktopState,
  MenuBarItem,
  WindowAttempt,
} from "./types";
import { desktopCliMismatch } from "./account-state";
import { formatPercent, formatUsed, percentUsed, usedWord } from "./percent";
import { freshUsage, lastKnownUsage, windowHolds } from "./usage";
import { activeReading, HUNGRY_PERCENT, mascotRest } from "./mascot";
import { clockLocative } from "./tr-dative";
import { formatCost } from "./number-format";
import { localDate } from "./planning";

/** Today so far across all accounts and terminals, from the token ledger once its first pass is done. */
export interface TrayToday {
  /** The planning-zone date the figures are for. */
  date: string;
  /** Every kind of token: input, output and cache. */
  tokens: number;
  /** Their API value, in USD. */
  cost: number;
  /** Part of the cost was estimated. */
  costEstimated?: boolean;
}

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
  /** What the title shows, in order; the five-hour percent alone when absent. */
  titleItems?: readonly MenuBarItem[];
  /** Today's tokens and API value, for the title's items that show them. */
  today?: TrayToday;
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
    review: "Select an account to switch",
    unavailable: "Claude app not found",
    statusUnavailable: "Claude app status unavailable",
    loading: "Relay checks the Claude app…",
    busy: "A Claude app action is running",
    pending: "Finish the Claude app sign-in first",
    authBusy: "Finish the usage sign-in first",
    recovery: "Restore the backup first",
    unlinked: "Save Claude app sign-in",
    mismatch: "Sign-ins belong to different accounts",
    outdated: "usage data is out of date",
    fiveHour: "5 h",
    week: "week",
  },
  tr: {
    show: "Relay’i aç",
    quit: "Relay’den çık",
    active: "Aktif",
    unknownActive: "Kayıtlı aktif hesap yok",
    empty: "Relay’de hesap ekle",
    review: "Geçmek için hesap seç",
    unavailable: "Claude uygulaması bulunamadı",
    statusUnavailable: "Claude uygulamasının durumu okunamadı",
    loading: "Claude uygulaması kontrol ediliyor…",
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

/**
 * An account's two windows for its menu row ("5 h 22% · week 92% used"). A reading that is old only
 * because the service could not be reached keeps its figures, marked as last known, until each
 * window resets ("5 h ~22% · week ~92% used · usage data is out of date").
 */
export function trayUsageLabel(
  accountId: string,
  usage: AccountUsage | undefined,
  language: TrayLanguage = "en",
  now = Date.now(),
) {
  const t = labels[language];
  const own = usage?.accountId === accountId;
  const fresh =
    own &&
    freshUsage(usage, now) &&
    Date.parse(usage.checkedAt!) <= now + 60_000;
  if (!fresh && !(own && lastKnownUsage(usage, now)))
    return `${t.fiveHour} ? · ${t.week} ?${usage?.checkedAt ? ` · ${t.outdated}` : ""}`;
  const figure = (window: AccountUsage["fiveHour"]) => {
    if (!fresh && !windowHolds(window, now)) return "?";
    const used = quotaUsed(window?.usedPercent, language);
    return fresh || used === "?" ? used : LAST_KNOWN_MARK + used;
  };
  const five = figure(usage!.fiveHour);
  const week = figure(usage!.sevenDay);
  // One word at the end covers both figures; with nothing to describe it is left out.
  const word = five === "?" && week === "?" ? "" : ` ${usedWord(language)}`;
  return `${t.fiveHour} ${five} · ${t.week} ${week}${word}${fresh ? "" : ` · ${t.outdated}`}`;
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

/** Every item the title can show, in the order Settings lists them. */
export const MENU_BAR_ITEMS: readonly MenuBarItem[] = [
  "five-hour",
  "week",
  "reset",
  "tokens",
  "cost",
  "account",
];
/** The title Relay has always shown: the five-hour percent, with its reset once it matters. */
export const DEFAULT_MENU_BAR_ITEMS: readonly MenuBarItem[] = ["five-hour"];
/** At most this many items: macOS hides a status item that no longer fits, the panda with it. */
export const MENU_BAR_MAX_ITEMS = 4;

/**
 * The title's items as kept: known ones, each once, at most MENU_BAR_MAX_ITEMS in the order given;
 * anything that is not a list is the default. An empty list leaves the panda alone.
 */
export function menuBarItems(value: unknown): MenuBarItem[] {
  if (!Array.isArray(value)) return [...DEFAULT_MENU_BAR_ITEMS];
  const items: MenuBarItem[] = [];
  for (const item of value)
    if (MENU_BAR_ITEMS.includes(item) && !items.includes(item)) items.push(item);
  return items.slice(0, MENU_BAR_MAX_ITEMS);
}

/** The mark before a figure kept from the last reading while a newer one cannot be read. */
export const LAST_KNOWN_MARK = "~";
/** Between the title's parts; with thin spaces once there are more than three, so the item stays short. */
const SEPARATOR = " · ";
const NARROW_SEPARATOR = " · ";

const activeAccount = (snapshot: TraySnapshot) =>
  snapshot.accounts.find((a) => a.id === snapshot.desktop?.activeProfileId);

/**
 * The Desktop-active account's reading for the title: fresh as the panda reads it, else the last
 * known one (`stale`) while only a passing issue or its age keeps it from being fresh. Each of its
 * windows counts until it resets (`heldWindow`).
 */
function titleReading(snapshot: TraySnapshot, now: number) {
  const active = activeAccount(snapshot);
  if (!active) return undefined;
  const fresh = activeReading(snapshot, now);
  if (fresh) return { usage: fresh, stale: false };
  const u = snapshot.usage[active.id];
  return lastKnownUsage(u, now) ? { usage: u, stale: true } : undefined;
}

/** A window of the title's reading, while it holds. */
function heldWindow(
  reading: ReturnType<typeof titleReading>,
  key: "fiveHour" | "sevenDay",
  now: number,
) {
  const window = reading?.usage[key];
  return windowHolds(window, now) ? window : undefined;
}

/** Today's figures, while they are still today's in the planning time zone. */
function todayFigures(snapshot: TraySnapshot, now: number) {
  const today = snapshot.today;
  if (!today) return undefined;
  try {
    const zone =
      snapshot.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    return localDate(now, zone) === today.date ? today : undefined;
  } catch {
    return undefined;
  }
}

const numberFormats = new Map<string, Intl.NumberFormat>();
function trayNumber(language: TrayLanguage, options: Intl.NumberFormatOptions) {
  const key = `${language}:${JSON.stringify(options)}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(language === "tr" ? "tr-TR" : "en-GB", options);
    numberFormats.set(key, format);
  }
  return format;
}

/**
 * Tokens in millions, short: "12,4M" / "12.4M"; whole millions from 100M ("184M"); from a billion,
 * billions ("1,8Mr" / "1.8B"; "milyar" in Turkish, where B would read as "bin"), so a busy day's
 * cache reads never make the menu bar title long.
 */
export function trayTokens(tokens: number, language: TrayLanguage = "en") {
  const count = Math.max(0, Number.isFinite(tokens) ? tokens : 0);
  const billions = count >= 999.5e6;
  const value = billions ? count / 1e9 : count / 1e6;
  const digits = value < 99.95 ? 1 : 0;
  const format = trayNumber(language, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${format.format(value)}${billions ? (language === "tr" ? "Mr" : "B") : "M"}`;
}

/** An API value, short: "$18,20" / "$18.20"; whole dollars from $100 ("$184"); "≈" when partly estimated. */
export function trayCost(cost: number, language: TrayLanguage = "en", estimated = false) {
  const value = Math.max(0, Number.isFinite(cost) ? cost : 0);
  const text =
    value < 99.995
      ? formatCost(value, language)
      : trayNumber(language, {
          style: "currency",
          currency: "USD",
          currencyDisplay: "narrowSymbol",
          maximumFractionDigits: 0,
        }).format(value);
  return `${estimated ? "≈" : ""}${text}`;
}

/** How long ago a reading was taken: "12 dk önce" / "12 min ago". */
function readAgo(checkedAt: string, now: number, language: TrayLanguage) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(checkedAt)) / 60_000));
  const tr = language === "tr";
  if (!minutes) return tr ? "az önce" : "just now";
  if (minutes < 60) return tr ? `${minutes} dk önce` : `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return tr ? `${hours} sa önce` : `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return tr ? `${days} gün önce` : `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** From this percent used on, the menu bar also says when the five-hour window renews; the panda gets hungry. */
export const TRAY_RESET_FROM = HUNGRY_PERCENT;
/** The title shows at most this many characters of the account a switch opens. */
export const TRAY_NAME_MAX = 14;
/** The account item, which stays in the title, shows fewer. */
export const TRAY_ITEM_NAME_MAX = 10;

/** A name on one line. */
const oneLine = (name: string) => name.replace(/[\r\n\t]/g, " ");

/** The account a running Desktop switch opens, while Desktop is busy with it. */
function switchTarget(snapshot: TraySnapshot) {
  const id = snapshot.desktop?.busy ? snapshot.switchingTo : undefined;
  return id ? snapshot.accounts.find((a) => a.id === id) : undefined;
}

/** A name on one line, cut to `max` characters (TRAY_NAME_MAX); the "…" that follows it in the title also marks the cut. */
export function trayShortName(name: string, max = TRAY_NAME_MAX) {
  const chars = Array.from(oneLine(name).trim());
  return chars.length <= max
    ? chars.join("")
    : chars.slice(0, max - 1).join("").trimEnd();
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

/**
 * Why the limit items show "—" unless a last known reading stands in: the panda sleeps. During another
 * Desktop operation Claude may be closed for a moment.
 */
function trayRest(snapshot: TraySnapshot, now: number) {
  return snapshot.desktop?.busy ? undefined : mascotRest(snapshot, now);
}

/**
 * The title in words: the account's name and, when known, the percent used of its five-hour window with
 * the word the title leaves out, and when the window renews (at a clock time once it is full). Figures
 * kept from the last reading carry its mark and say how old they are. It names the week's percent and
 * today's tokens and API value when the title shows them. During a switch it names the account being
 * opened; while the panda sleeps with no figure to show, why.
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
      : `Relay switches to ${oneLine(target.name)}…`;
  const tr = language === "tr";
  const active = activeAccount(snapshot);
  const items = snapshot.titleItems ?? DEFAULT_MENU_BAR_ITEMS;
  const rest = trayRest(snapshot, now);
  const reading = rest === "closed" ? undefined : titleReading(snapshot, now);
  const parts: string[] = active ? [oneLine(active.name)] : [];
  if (rest === "closed")
    parts.push(tr ? "Claude uygulaması kapalı" : "Claude app closed");
  else if (reading) {
    const mark = reading.stale ? LAST_KNOWN_MARK : "";
    const window = heldWindow(reading, "fiveHour", now);
    const used = window?.usedPercent;
    if (used !== undefined) parts.push(mark + formatUsed(used, language));
    const clock =
      percentUsed(used) === 100
        ? trayResetClock(window?.resetsAt, now, language, snapshot.timeZone)
        : undefined;
    const left = trayCountdown(window?.resetsAt, now);
    // A full window opens again at a clock time; one with room renews after the time left.
    if (clock) parts.push(tr ? `${clockLocative(clock)} açılır` : `opens at ${clock}`);
    else if (left)
      parts.push(tr ? `${spokenCountdown(left)} sonra yenilenir` : `renews in ${left}`);
    const week = heldWindow(reading, "sevenDay", now);
    if (week && items.includes("week"))
      parts.push(`${tr ? "hafta" : "week"} ${mark}${formatUsed(week.usedPercent, language)}`);
    if (reading.stale) {
      const ago = readAgo(reading.usage.checkedAt!, now, language);
      parts.push(
        tr ? `limit verisi eski, ${ago} okundu` : `usage data is out of date, read ${ago}`,
      );
    }
  } else if (rest === "unknown")
    parts.push(tr ? "limit verisi eski" : "usage data is out of date");
  const today = todayFigures(snapshot, now);
  const figures = !today
    ? []
    : [
        ...(items.includes("tokens")
          ? [`${trayTokens(today.tokens, language)} ${tr ? "token" : "tokens"}`]
          : []),
        ...(items.includes("cost")
          ? [`${trayCost(today.cost, language, today.costEstimated)} ${tr ? "API karşılığı" : "API value"}`]
          : []),
      ];
  if (figures.length) parts.push(`${tr ? "bugün" : "today"} ${figures.join(", ")}`);
  return parts.length ? `Relay — ${parts.join(" · ")}` : "Relay";
}

/**
 * Menu-bar text, from the items the user chose (`titleItems`) in their order. By default it is the
 * percent used of the Desktop-active account's five-hour window alone, compact ("%94" / "94%"; the
 * tooltip adds the word), empty when unknown. Without the reset's own item, from 80 % on, when the
 * window's end starts to matter, the percent adds the time left until it renews ("%94 · 1:50") if
 * fewer than four items are chosen, and a full window gives the clock it reopens at instead ("22:50",
 * in the planning time zone). The other items are the week's percent, the time left, today's tokens
 * ("12,4M") and API value ("$18,20") and the account's name; past three parts they are joined more
 * narrowly.
 *
 * When the last read failed only because the service could not be reached, or the reading has grown
 * old, its figures stay, each marked "~" ("~%94"), until their window resets; the panda sleeps over
 * them. With Claude closed, or limits a sign-in problem keeps unknown, the limit items show one "—".
 * While a switch runs the title names the account being opened ("Max…").
 */
export function trayTitle(
  snapshot: TraySnapshot,
  now = Date.now(),
  language: TrayLanguage = "en",
) {
  const target = switchTarget(snapshot);
  if (target) return `${trayShortName(target.name)}…`;
  const items = snapshot.titleItems ?? DEFAULT_MENU_BAR_ITEMS;
  const rest = trayRest(snapshot, now);
  const reading = rest === "closed" ? undefined : titleReading(snapshot, now);
  // A limit item without a figure: a dash while the panda sleeps, else nothing yet.
  const missing = rest ? ["—"] : [];
  const mark = (text: string) => (reading?.stale ? LAST_KNOWN_MARK + text : text);
  const five = heldWindow(reading, "fiveHour", now);
  const fiveUsed = percentUsed(five?.usedPercent);
  // A full window stays full until it resets, so its clock holds for a last known reading too.
  const clock =
    fiveUsed === 100
      ? trayResetClock(five?.resetsAt, now, language, snapshot.timeZone)
      : undefined;
  const today = todayFigures(snapshot, now);
  const parts = items.flatMap((item): string[] => {
    switch (item) {
      case "five-hour": {
        if (fiveUsed === undefined) return missing;
        const percent = mark(formatPercent(fiveUsed, language));
        // Without an item of its own, the reset joins the percent once it starts to matter, while
        // that leaves the title at most MENU_BAR_MAX_ITEMS parts.
        if (items.includes("reset")) return [percent];
        if (clock) return [clock];
        const left =
          fiveUsed >= TRAY_RESET_FROM && items.length < MENU_BAR_MAX_ITEMS
            ? trayCountdown(five?.resetsAt, now)
            : undefined;
        return left ? [percent, left] : [percent];
      }
      case "week": {
        const used = percentUsed(heldWindow(reading, "sevenDay", now)?.usedPercent);
        return used === undefined ? missing : [mark(formatPercent(used, language))];
      }
      case "reset": {
        if (fiveUsed === undefined) return missing;
        const left = clock ?? trayCountdown(five?.resetsAt, now);
        return left ? [left] : [];
      }
      case "tokens":
        return today ? [trayTokens(today.tokens, language)] : [];
      case "cost":
        return today ? [trayCost(today.cost, language, today.costEstimated)] : [];
      case "account": {
        const active = activeAccount(snapshot);
        if (!active) return [];
        const name = trayShortName(active.name, TRAY_ITEM_NAME_MAX);
        return [name === oneLine(active.name).trim() ? name : `${name}…`];
      }
      default:
        return [];
    }
  });
  // One dash says the limits are unknown, however many of their items are chosen.
  const shown = parts.filter((part, i) => part !== "—" || parts.indexOf("—") === i);
  return shown.join(shown.length > 3 ? NARROW_SEPARATOR : SEPARATOR);
}

/**
 * The title these items would give, for Settings to preview: 40 % of the five-hour window used with
 * 1:50 left, 35 % of the week, and today 12,4M tokens worth $18,20, on the account `name`.
 */
export function menuBarPreview(
  items: readonly MenuBarItem[],
  language: TrayLanguage = "en",
  name = "Max",
  now = Date.now(),
) {
  const zone = "UTC";
  const at = (ms: number) => new Date(now + ms).toISOString();
  return trayTitle(
    {
      accounts: [{ id: "preview", name } as Account],
      usage: {
        preview: {
          accountId: "preview",
          status: "ready",
          stale: false,
          checkedAt: at(0),
          fiveHour: { usedPercent: 40, resetsAt: at(110 * 60_000) },
          sevenDay: { usedPercent: 35, resetsAt: at(3 * 86_400_000) },
        },
      },
      desktop: {
        available: true,
        running: true,
        organizations: [],
        activeProfileId: "preview",
        busy: false,
        recoveryRequired: false,
        errorRevision: 0,
      },
      titleItems: items,
      today: { date: localDate(now, zone), tokens: 12_430_000, cost: 18.2 },
      timeZone: zone,
    },
    now,
    language,
  );
}
