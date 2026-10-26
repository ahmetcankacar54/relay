import type { AccountUsage } from "../../shared/types";
import type { RingState } from "@/components/UsageRing";
import type { Language, T } from "@/data/i18n";
import type { Relay } from "@/data/relay-context";
import type { OverviewRow } from "@/data/selectors";
import { accountHealth } from "@/lib/account-health";
import { formatPercent, percentUsed } from "@/lib/meter";
import { formatClock, formatRelative, formatReset } from "@/lib/time";
import { quotaWindows } from "../../shared/quota-windows";
import { clockLocative } from "../../shared/tr-dative";
import { freshUsage } from "../../shared/usage";
import { planColumn } from "../pages/accounts/accountLabels";

/**
 * Status line under an account name (Overview and the menu bar panel). When something is wrong it is
 * the account's status, the one the Accounts page shows; `waiting` is a browser approval in progress.
 */
export function accountRowSubtitle(
  row: OverviewRow,
  t: T,
  language: Language,
  zone: string,
  now: number,
  waiting = false,
): string {
  const health = accountHealth(
    row.account,
    row.usage,
    { active: false, desktopRunning: false, waiting },
    t,
  );
  if (health.tone !== "ok") return health.label;
  switch (row.state) {
    case "window-open": {
      const reset = row.usage?.fiveHour?.resetsAt;
      const left = reset ? formatReset(reset, now, language, zone) : "";
      return t(
        `Dönem açık${left ? ` · ${left}` : ""}`,
        `Period open${left ? ` · ${left}` : ""}`,
      );
    }
    case "ready":
      return t("Hazır · dönem başlamadı", "Ready · no period started");
    case "exhausted": {
      const at = row.availableAt
        ? formatClock(row.availableAt, language, zone)
        : "";
      return at
        ? t(`${clockLocative(at)} açılır`, `Opens ${at}`)
        : t("Açılış saati bilinmiyor", "Opening time unknown");
    }
    case "not-linked":
      return t("Claude uygulaması girişi yok", "No Claude app sign-in");
    default:
      return t("Limit verisi eski", "Usage data is out of date");
  }
}

export type PanelRowBlock = "not-linked" | "busy" | "pending" | "recovery";

/**
 * Whether the panel’s “Geç” button may switch Desktop to this row’s account. An account whose
 * limit is full can still be switched to (`full`): the switch is tinted and says when it opens.
 */
export function panelRowState(
  row: OverviewRow,
  relay: Pick<Relay, "desktopBusy" | "pendingDesktop" | "desktop">,
): { canSwitch: boolean; reason?: PanelRowBlock; full?: boolean } {
  const blocked = (reason: PanelRowBlock) => ({ canSwitch: false, reason });
  if (row.state === "not-linked") return blocked("not-linked");
  if (relay.desktopBusy) return blocked("busy");
  if (relay.pendingDesktop) return blocked("pending");
  if (relay.desktop?.recoveryRequired) return blocked("recovery");
  return row.state === "exhausted" ? { canSwitch: true, full: true } : { canSwitch: true };
}

/** How long until `ms`: days from a day on ("2 gün"), else `timeLeft`'s hours and minutes. */
function leftUntil(ms: number, now: number, t: T): string | undefined {
  if (ms - now < 86_400_000) return timeLeft(new Date(ms).toISOString(), now, t);
  const days = Math.round((ms - now) / 86_400_000);
  return t(`${days} gün`, `${days} ${days === 1 ? "day" : "days"}`);
}

/**
 * A full account's switch, in a few words: "Limit dolu · 14:00’te açılır (2 sa 10 dk)", or
 * "Limit dolu" when its reopening is unknown or past.
 */
export function fullLimitNote(
  availableAt: string | undefined,
  t: T,
  language: Language,
  zone: string,
  now: number,
): string {
  const ms = availableAt ? Date.parse(availableAt) : NaN;
  const left = Number.isFinite(ms) ? leftUntil(ms, now, t) : undefined;
  if (!left) return t("Limit dolu", "Limit is full");
  const at = formatClock(ms, language, zone);
  return t(
    `Limit dolu · ${clockLocative(at)} açılır (${left})`,
    `Limit is full · opens ${at} (${left})`,
  );
}

/** What switching to a full account means, for the confirmations before it. */
export function fullLimitWarning(
  availableAt: string | undefined,
  t: T,
  language: Language,
  zone: string,
  now: number,
): string {
  const ms = availableAt ? Date.parse(availableAt) : NaN;
  const left = Number.isFinite(ms) ? leftUntil(ms, now, t) : undefined;
  const at = left ? formatClock(ms, language, zone) : "";
  return left
    ? t(
        `Bu hesabın limiti dolu; ${clockLocative(at)} açılır (${left} sonra). O zamana kadar bu hesapla yeni mesaj gönderemezsin.`,
        `This account’s limit is full; it opens at ${at} (in ${left}). Until then you can’t send new messages on it.`,
      )
    : t(
        "Bu hesabın limiti dolu ve ne zaman açılacağı bilinmiyor. Açılana kadar bu hesapla yeni mesaj gönderemezsin.",
        "This account’s limit is full, and when it opens is unknown. Until it does, you can’t send new messages on it.",
      );
}

/** Time left until `at` as "1 sa 50 dk" / "1 h 50 m" (minutes only under an hour); undefined once past. */
export function timeLeft(at: string | undefined, now: number, t: T): string | undefined {
  const ms = at ? Date.parse(at) - now : NaN;
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const minutes = Math.ceil(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h
    ? t(`${h} sa${m ? ` ${m} dk` : ""}`, `${h} h${m ? ` ${m} m` : ""}`)
    : t(`${m} dk`, `${m} m`);
}


/**
 * How far an account's rings can be trusted (`RingState`): without a reading they are unknown, a
 * reading `freshUsage` no longer accepts is stale, and a fresh one with a window used up is full.
 */
export function ringState(usage: AccountUsage | undefined, now: number): RingState {
  if (!usage?.checkedAt || (!usage.fiveHour && !usage.sevenDay)) return "unknown";
  if (!freshUsage(usage, now)) return "stale";
  return (quotaWindows(usage) ?? []).some((w) => w.usedPercent >= 100) ? "full" : "fresh";
}

/** A status after a lead (the plan, the percents) reads on in lower case; Claude and Keychain keep their capitals. */
const onward = (text: string, language: Language) =>
  /^(Claude|Keychain)\b/.test(text)
    ? text
    : text.charAt(0).toLocaleLowerCase(language) + text.slice(1);

/**
 * A row's status in a few words: what is wrong, how old a reading is that is no longer fresh, else
 * when the account matters next. `short` is the menu bar panel's wording.
 */
function rowStatus(
  row: OverviewRow,
  t: T,
  language: Language,
  zone: string,
  now: number,
  waiting: boolean,
  short: boolean,
): string {
  if (row.state === "not-linked") return t("Giriş kaydedilmedi", "Sign-in not saved");
  const health = accountHealth(
    row.account,
    row.usage,
    { active: false, desktopRunning: false, waiting },
    t,
  );
  // Besides a browser approval, the one warning without a fix is a failed or old read; with a
  // reading kept, the row says how old it is instead.
  const outOfDate = health.tone === "warn" && !health.fix && !waiting;
  if (health.tone !== "ok" && !outOfDate) return health.label;
  if (row.usage?.checkedAt && ringState(row.usage, now) === "stale") {
    const age = formatRelative(row.usage.checkedAt, now, language);
    return short ? t(`${age} okundu`, `Read ${age}`) : t(`Limit verisi ${age} okundu`, `Usage data read ${age}`);
  }
  if (outOfDate) return health.label;
  switch (row.state) {
    case "window-open": {
      const left = timeLeft(row.usage?.fiveHour?.resetsAt, now, t);
      if (!left) return t("Dönem açık", "Period open");
      return short
        ? t(`Dönem açık ${left} kaldı`, `Period open ${left} left`)
        : t(`Dönem açık · ${left} kaldı`, `Period open · ${left} left`);
    }
    case "ready":
      return t("Hazır", "Ready");
    case "exhausted": {
      const at = row.availableAt ? formatClock(row.availableAt, language, zone) : "";
      return at ? t(`${clockLocative(at)} açılır`, `Opens ${at}`) : t("Dolu", "Full");
    }
    default:
      return t("Limit verisi eski", "Usage data is out of date");
  }
}

/**
 * The Overview row's line under the name: the plan, as the Accounts table names it, then the status
 * ("Team · dönem açık · 3 sa 10 dk", "Max · limit verisi 2 sa önce"). The full status is its title.
 */
export function accountTileLine(
  row: OverviewRow,
  t: T,
  language: Language,
  zone: string,
  now: number,
  waiting = false,
): string {
  const status = rowStatus(row, t, language, zone, now, waiting, false);
  const plan = planColumn(row.account)?.label;
  return plan ? `${plan} · ${onward(status, language)}` : status;
}

/**
 * The menu bar panel row's line: the reading's five-hour and week percents, then the short status
 * ("%22 · %35 · dönem açık 3 sa", "%22 · %35 · veri 2 sa önce").
 */
export function panelRowLine(
  row: OverviewRow,
  t: T,
  language: Language,
  zone: string,
  now: number,
  waiting = false,
): string {
  const status = rowStatus(row, t, language, zone, now, waiting, true);
  const percents =
    ringState(row.usage, now) === "unknown"
      ? []
      : [row.usage?.fiveHour, row.usage?.sevenDay].flatMap((w) =>
          w ? [formatPercent(percentUsed(w.usedPercent), language)] : [],
        );
  return percents.length ? [...percents, onward(status, language)].join(" · ") : status;
}
