import type { AccountUsage } from "../../shared/types";
import type { RingState } from "@/components/UsageRing";
import type { Locale } from "../../shared/i18n/locales";
import type { T } from "../../shared/i18n/translate";
import type { Relay } from "@/data/relay-context";
import { windowAccounts, type OverviewRow } from "@/data/selectors";
import { accountHealth } from "@/lib/account-health";
import { formatPercent, percentUsed } from "@/lib/meter";
import { formatClock, formatRelative, formatReset, hoursMinutes } from "@/lib/time";
import { limitHeadline, modelOnlyUsage, quotaWindows } from "../../shared/quota-windows";
import { clockLocative } from "../../shared/tr-dative";
import { freshUsage } from "../../shared/usage";
import { accountPlan } from "../pages/accounts/accountLabels";

/** What is wrong with an account, in its status's words; undefined when nothing is (the panel row's line). */
export function rowProblem(
  row: OverviewRow,
  t: T,
  language: Locale,
  zone: string,
  now: number,
  waiting = false,
  platform?: string,
): string | undefined {
  const health = accountHealth(row.account, row.usage, { active: false, desktopRunning: false, waiting, language, platform, now, zone }, t);
  return health.tone !== "ok" ? health.label : undefined;
}

/**
 * Status line under an account name (Overview and the menu bar panel). When something is wrong it is
 * the account's status, the one the Accounts page shows; `waiting` is a browser approval in progress.
 */
export function accountRowSubtitle(
  row: OverviewRow,
  t: T,
  language: Locale,
  zone: string,
  now: number,
  waiting = false,
  platform?: string,
): string {
  const health = accountHealth(
    row.account,
    row.usage,
    { active: false, desktopRunning: false, waiting, language, platform, now, zone },
    t,
  );
  if (health.tone !== "ok") return health.label;
  switch (row.state) {
    case "window-open": {
      const reset = row.usage?.fiveHour?.resetsAt;
      const left = reset ? formatReset(reset, now, language, zone) : "";
      return left ? t("accountRow.periodOpen", { left }) : t("accountRow.periodOpen2");
    }
    case "ready":
      return t("accountRow.readyNoPeriodStarted");
    case "exhausted": {
      const at = row.availableAt
        ? formatClock(row.availableAt, language, zone)
        : "";
      return at
        ? t("accountRow.opens", { at, atLocative: clockLocative(at) })
        : t("accountRow.limitIsFull");
    }
    case "not-linked":
      return t("accountRow.noClaudeAppSignIn");
    default:
      return t("accountRow.usageDataIsOutOfDate");
  }
}

export type PanelRowBlock = "not-linked" | "window" | "busy" | "pending" | "recovery";

/**
 * Whether the panel’s “Geç” button may switch Desktop to this row’s account. An account whose
 * limit is full can still be switched to (`full`): the switch is tinted and says when it opens.
 */
export function panelRowState(
  row: OverviewRow,
  relay: Pick<Relay, "desktopBusy" | "pendingDesktop" | "desktop" | "data">,
): { canSwitch: boolean; reason?: PanelRowBlock; full?: boolean } {
  const blocked = (reason: PanelRowBlock) => ({ canSwitch: false, reason });
  // Codex and Antigravity accounts serve their own tools; the Claude app never switches to them.
  if ((row.account.provider ?? "claude") !== "claude") return { canSwitch: false };
  if (row.state === "not-linked") return blocked("not-linked");
  // Its own window holds its sign-in until it closes.
  if (windowAccounts(relay.data).has(row.account.id))
    return blocked("window");
  if (relay.desktopBusy) return blocked("busy");
  if (relay.pendingDesktop) return blocked("pending");
  if (relay.desktop?.recoveryRequired) return blocked("recovery");
  return row.state === "exhausted" ? { canSwitch: true, full: true } : { canSwitch: true };
}

/** How long until `ms`: days from a day on ("2 gün"), else `timeLeft`'s hours and minutes. */
function leftUntil(ms: number, now: number, t: T): string | undefined {
  if (ms - now < 86_400_000) return timeLeft(new Date(ms).toISOString(), now, t);
  const days = Math.round((ms - now) / 86_400_000);
  return t("format.days", { days });
}

/**
 * A full account's switch, in a few words: "Limit dolu · 14:00’te açılır (2 sa 10 dk)", or
 * "Limit dolu" when its reopening is unknown or past.
 */
export function fullLimitNote(
  availableAt: string | undefined,
  t: T,
  language: Locale,
  zone: string,
  now: number,
): string {
  const ms = availableAt ? Date.parse(availableAt) : NaN;
  const left = Number.isFinite(ms) ? leftUntil(ms, now, t) : undefined;
  if (!left) return t("accountRow.limitIsFull");
  const at = formatClock(ms, language, zone);
  return t("accountRow.limitIsFullOpens", { at, left, atLocative: clockLocative(at) });
}

/** What switching to a full account means, for the confirmations before it. */
export function fullLimitWarning(
  availableAt: string | undefined,
  t: T,
  language: Locale,
  zone: string,
  now: number,
): string {
  const ms = availableAt ? Date.parse(availableAt) : NaN;
  const left = Number.isFinite(ms) ? leftUntil(ms, now, t) : undefined;
  const at = left ? formatClock(ms, language, zone) : "";
  return left
    ? t("accountRow.thisAccountSLimitIsFull", { at, left, atLocative: clockLocative(at) })
    : t("accountRow.thisAccountSLimitIsFull2");
}

/** Time left until `at` as "1 sa 50 dk" / "1 h 50 min" (minutes only under an hour); undefined once past. */
export function timeLeft(at: string | undefined, now: number, t: T): string | undefined {
  const ms = at ? Date.parse(at) - now : NaN;
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const minutes = Math.ceil(ms / 60_000);
  return hoursMinutes(Math.floor(minutes / 60), minutes % 60, t);
}


/**
 * How far an account's rings can be trusted (`RingState`): without a reading they are unknown, a
 * reading `freshUsage` no longer accepts is stale, and a fresh one with a window used up is full.
 */
export function ringState(usage: AccountUsage | undefined, now: number): RingState {
  if (!usage?.checkedAt || (!usage.fiveHour && !usage.sevenDay)) return "unknown";
  if (!freshUsage(usage, now)) return "stale";
  // Usage made only of model limits shows its fullest model, so a spent model is a full ring.
  if (modelOnlyUsage(usage)) return (limitHeadline(usage, now)?.usedPercent ?? 0) >= 100 ? "full" : "fresh";
  return (quotaWindows(usage) ?? []).some((w) => w.usedPercent >= 100) ? "full" : "fresh";
}

/**
 * How long until the account's five-hour period changes on its own, as the reading has it: "3 sa
 * 10 dk sonra yenilenir", or "… açılır" for a full one. Undefined without a reset still ahead. A
 * reset time stays true however old the reading is.
 */
function resetAhead(row: OverviewRow, t: T, now: number): { full: boolean; left: string } | undefined {
  // An Antigravity account has no five-hour period: its fullest model is the one that changes.
  const five = modelOnlyUsage(row.usage) ? limitHeadline(row.usage, now) : row.usage?.fiveHour;
  const full = row.state === "exhausted" || (five?.usedPercent ?? 0) >= 100;
  const at = Date.parse((row.state === "exhausted" ? row.availableAt : five?.resetsAt) ?? "");
  const left = Number.isFinite(at) ? leftUntil(at, now, t) : undefined;
  return left ? { full, left } : undefined;
}

/** `resetAhead` in words: "3 sa 10 dk sonra yenilenir" / "Resets in 3 h 10 min". */
function nextReset(row: OverviewRow, t: T, now: number): string | undefined {
  const ahead = resetAhead(row, t, now);
  if (!ahead) return undefined;
  return ahead.full ? t("accountRow.opensIn", { left: ahead.left }) : t("accountRow.resetsIn", { left: ahead.left });
}

/**
 * A row's status in a few words: what is wrong, how old a reading is that is no longer fresh (with
 * when its period resets, while that is ahead), else when the account matters next. `short` is the
 * menu bar panel's wording, which leads with the time left.
 */
function rowStatus(
  row: OverviewRow,
  t: T,
  language: Locale,
  zone: string,
  now: number,
  waiting: boolean,
  short: boolean,
  platform?: string,
): string {
  if (row.state === "not-linked") return t("accountRow.signInNotSaved");
  const health = accountHealth(
    row.account,
    row.usage,
    { active: false, desktopRunning: false, waiting, language, platform, now, zone },
    t,
  );
  // Besides a browser approval, the one warning without a fix is a failed or old read; with a
  // reading kept, the row says how old it is instead.
  const outOfDate = health.tone === "warn" && !health.fix && !waiting;
  if (health.tone !== "ok" && !outOfDate) return health.label;
  if (row.usage?.checkedAt && ringState(row.usage, now) === "stale") {
    const age = formatRelative(row.usage.checkedAt, now, language);
    if (short) {
      const next = nextReset(row, t, now);
      return next ? t("accountRow.read", { next, age }) : t("accountRow.read2", { age });
    }
    const ahead = resetAhead(row, t, now);
    if (!ahead) return t("accountRow.usageDataRead", { age });
    return ahead.full
      ? t("accountRow.usageDataReadOpensIn", { age, left: ahead.left })
      : t("accountRow.usageDataReadResetsIn", { age, left: ahead.left });
  }
  if (outOfDate) return health.label;
  switch (row.state) {
    case "window-open": {
      const left = timeLeft(row.usage?.fiveHour?.resetsAt, now, t);
      if (!left) return t("accountRow.periodOpen2");
      return short
        ? nextReset(row, t, now)!
        : t("accountRow.periodOpenLeft", { left });
    }
    case "ready":
      return t("common.ready");
    case "exhausted": {
      const at = row.availableAt ? formatClock(row.availableAt, language, zone) : "";
      if (!at) return t("common.full");
      const next = nextReset(row, t, now);
      if (short && next) return next;
      const left = next && leftUntil(Date.parse(row.availableAt!), now, t);
      return left
        ? t("accountRow.opens2", { at, left, atLocative: clockLocative(at) })
        : t("accountRow.opens", { at, atLocative: clockLocative(at) });
    }
    default:
      return t("accountRow.usageDataIsOutOfDate");
  }
}

/**
 * The Overview row's line under the name: the plan, as the Accounts table names it, then the status
 * ("Team · Dönem açık · 3 sa 10 dk", "ChatGPT Plus · Limit verisi 2 sa önce"). The full status is its title.
 */
export function accountTileLine(
  row: OverviewRow,
  t: T,
  language: Locale,
  zone: string,
  now: number,
  waiting = false,
  platform?: string,
): string {
  const status = rowStatus(row, t, language, zone, now, waiting, false, platform);
  const plan = accountPlan(row.account)?.label;
  return plan ? `${plan} · ${status}` : status;
}

/**
 * The menu bar panel row's line: the short status first, so a narrow panel cuts the percents and
 * never the time left, then the reading's five-hour and week percents, which the ring shows too
 * ("3 sa 10 dk sonra yenilenir · %22 · %35", "1 sa sonra açılır · %100 · %57").
 */
export function panelRowLine(
  row: OverviewRow,
  t: T,
  language: Locale,
  zone: string,
  now: number,
  waiting = false,
  platform?: string,
): string {
  const status = rowStatus(row, t, language, zone, now, waiting, true, platform);
  const percents =
    ringState(row.usage, now) === "unknown"
      ? []
      : (modelOnlyUsage(row.usage) ? [limitHeadline(row.usage, now)] : [row.usage?.fiveHour, row.usage?.sevenDay]).flatMap((w) =>
          w ? [formatPercent(percentUsed(w.usedPercent), language)] : [],
        );
  return [status, ...percents].join(" · ");
}
