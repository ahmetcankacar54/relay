import {
  formatChange,
  formatCost,
  formatTokens,
  type NumberLanguage,
} from "./number-format";
import { formatPercent, percentUsed } from "./percent";
import type {
  TokenCounts,
  TokenToday,
  TokenUsageView,
} from "./token-usage-view";
import type { Account, AccountUsage, RelaySettings } from "./types";
import { freshUsage, suggestedAccount } from "./usage";
import { desktopCliMismatch } from "./account-state";
import { withDative } from "./tr-dative";
import { relaySwitchLink } from "./relay-link";
import { overviewAccounts } from "../src/data/selectors";

/** The file's layout; the widget reads only this version. */
export const WIDGET_SNAPSHOT_VERSION = 2;
/** Other accounts the widget lists, the suggested one first. */
export const WIDGET_OTHER_ACCOUNTS = 3;
/** Accounts with a colour of their own in the stacked bars; the rest share one. */
export const WIDGET_SERIES = 3;
/** The series of everything past the first three accounts: former, terminal, unknown and the rest. */
export const WIDGET_REST_KEY = "rest";

/** One account's limits and today's use, every string formatted. */
export interface WidgetAccount {
  id: string;
  name: string;
  /** Percent used of the five-hour window, 0–100 rounded down; omitted while unknown or old. */
  fiveHour?: number;
  /** Percent used of the week, 0–100 rounded down; omitted while unknown or old. */
  week?: number;
  /** When the five-hour window renews, epoch milliseconds; the widget counts down to it. */
  fiveHourResetsAt?: number;
  /** Today's API value and tokens on this account. */
  cost: number;
  tokens: number;
  /** Its colour in the stacked bars: 0–2, or 3 for the rest. */
  color: number;
  text: {
    /** "%94"; "—" while unknown. */
    fiveHour: string;
    week: string;
    /** "%22 / %35": five hours, then the week. */
    limits: string;
    cost: string;
    tokens: string;
    /** "$69,18 · 64,2 Mn" */
    costTokens: string;
    /** Time left in the five-hour window when the file was written ("1:50"); "" without one. */
    left: string;
    /** When the week renews ("Cmt 21:30"); "" without one. */
    weekReset: string;
    /** "hafta %68"; "" while unknown. */
    weekShort: string;
  };
}

/** The account open in Claude. */
export interface WidgetActive extends WidgetAccount {
  text: WidgetAccount["text"] & {
    /** "Hafta %68 · Cmt 21:30 sıfırlanır"; "" while unknown. */
    weekLine: string;
    /** "$69,18 bugün" */
    costChip: string;
    /** "64,2 Mn token" */
    tokensChip: string;
  };
}

/** Another account, as the panel ranks it. */
export interface WidgetOther extends WidgetAccount {
  /** The account Relay suggests switching to (the panel's badge). */
  suggested: boolean;
  /** Its Claude app sign-in is saved and its limit is not full: Relay can review a switch to it. */
  switchable: boolean;
  /** `relay://switch?account=<id>` while switchable: opens Relay's switch review, never switches. */
  link?: string;
  text: WidgetAccount["text"] & {
    /** "Vertex’e geç · %22" */
    switchTo: string;
  };
}

/** A series of the stacked bars: an account, or the rest. */
export interface WidgetSeries {
  key: string;
  name: string;
  color: number;
}

/** Today's cost share of one series. */
export interface WidgetSplitPart extends WidgetSeries {
  cost: number;
  /** Of today's cost, 0–1. */
  share: number;
  text: { cost: string };
}

/**
 * The panda's face in the widgets: "happy" while all is well, "alert" (wide eyes) once the open
 * account's five-hour window is 80 % used, "worried" when one of its limits is full, and
 * "sleeping" while there is nothing to watch: the first scan runs, or no Relay account is open in
 * Claude. The widget also lets it sleep once the file is 30 minutes old.
 */
export type WidgetMood = "happy" | "alert" | "worried" | "sleeping";
/** The open account's five-hour use from which the panda looks alarmed. */
export const WIDGET_ALERT_PERCENT = 80;

export function widgetMood(
  state: WidgetSnapshot["state"],
  active: Pick<WidgetAccount, "fiveHour" | "week"> | undefined,
): WidgetMood {
  if (state === "scanning" || !active) return "sleeping";
  if ((active.fiveHour ?? 0) >= 100 || (active.week ?? 0) >= 100)
    return "worried";
  if ((active.fiveHour ?? 0) >= WIDGET_ALERT_PERCENT) return "alert";
  return "happy";
}

/** The last seven days, oldest first, ending today. */
export interface WidgetWeek {
  days: {
    date: string;
    /** "Pzt" / "Mon" */
    label: string;
    today: boolean;
    cost: number;
    /** The cost of each series that day, in `series` order. */
    parts: number[];
  }[];
  cost: number;
  tokens: number;
  /** The cost per day. */
  average: number;
  /** Times a limit was reached in these days; omitted while Relay's history is unavailable. */
  hits?: number;
  text: {
    title: string;
    cost: string;
    /** "412 Mn token" */
    tokens: string;
    /** "Günde $58,80" */
    average: string;
    /** "En yoğun Sal · $142,10"; "" with no cost at all. */
    busiest: string;
    /** "Limit 2 kez doldu"; "" when `hits` is omitted. */
    hits: string;
    /** "Kişisel · hafta %68"; "" without an active account's week. */
    activeWeek: string;
  };
}

/**
 * What the macOS widgets draw, written by Relay to
 * `<userData>/widget/today.json`. Every string is formatted here, so the
 * widget only lays them out; it never formats numbers or translates. Parts
 * Relay has no real data for are omitted, and the widget leaves them out.
 */
export interface WidgetSnapshot {
  version: 2;
  generatedAt: number;
  date: string;
  zone: string;
  /** "data", "empty" (no tokens today yet) or "scanning" (the first scan is running). */
  state: "data" | "empty" | "scanning";
  mood: WidgetMood;
  totals: { input: number; output: number; cache: number; total: number };
  cost: number;
  change: number | null;
  /** The API value per quarter hour today; null after the current one. */
  slots: (number | null)[];
  yesterdayAverage: number | null;
  /** The account open in Claude; omitted when none of Relay's accounts is. */
  active?: WidgetActive;
  /** Up to three other accounts, the suggested one first. */
  accounts: WidgetOther[];
  /** The stacked bars' series, in colour order. */
  series: WidgetSeries[];
  /** Today's cost per series, in series order; empty without cost today. */
  split: WidgetSplitPart[];
  week?: WidgetWeek;
  text: {
    title: string;
    subtitle: string;
    rows: [string, string, string];
    input: string;
    output: string;
    cache: string;
    total: string;
    cost: string;
    /** "" without a change. */
    change: string;
    /** The line under the title while `state` is not "data". */
    status: string;
    /** What a new day shows before Relay writes it: the widget switches to it at midnight. */
    empty: string;
    /** Shown in place of the subtitle once the file is 30 minutes old. */
    stale: string;
    /** "$91,48 · 86,5 Mn token" */
    costTokens: string;
    /** "86,5 Mn token" */
    tokens: string;
    /** "Bugün · API değeri": the Today widget's title. */
    apiTitle: string;
    /** "Diğer hesaplar": the heading over the other accounts. */
    others: string;
    /** "bugün": the heading over their cost today. */
    todayWord: string;
    /** "Claude’da açık": over the active account's name. */
    inClaude: string;
    /** "önerilen": beside the suggested account's name. */
    suggested: string;
    /** "Bugün toplam $91,48 · 86,5 Mn token" */
    todayLine: string;
    /** "Bugün · tüm hesaplar" */
    allToday: string;
    /** "Geç" */
    switch: string;
    /** What follows a countdown: "kaldı" / "left". */
    left: string;
    /** The account widgets' line while none of Relay's accounts is open in Claude. */
    noActive: string;
  };
}

export interface WidgetSnapshotInput {
  today: TokenToday;
  progress: { complete: boolean; percent: number };
  language: NumberLanguage;
  zone: string;
  now: number;
  /** The token view's days (the last seven, ending today): per-account costs and the week. */
  days?: TokenUsageView["days"];
  /** Relay's accounts and limits; without them the widget shows no accounts. */
  limits?: {
    accounts: Account[];
    usage: Record<string, AccountUsage>;
    /** The account open in Claude. */
    activeId?: string;
    settings: RelaySettings;
    /** The keeper's tempo now, Pro units per hour, as the panel ranks with it. */
    rate?: number;
  };
  /** Limits reached in the seven days, when Relay's history is available. */
  hits?: number;
}

const locale = (language: NumberLanguage) =>
  language === "tr" ? "tr-TR" : "en-GB";

const clock = new Map<string, Intl.DateTimeFormat>();
function timeOf(time: number, zone: string, language: NumberLanguage) {
  const key = `${language}:${zone}`;
  let f = clock.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale(language), {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: zone,
    });
    clock.set(key, f);
  }
  return f.format(time);
}

const weekdays = new Map<string, Intl.DateTimeFormat>();
function weekdayOf(time: number, zone: string, language: NumberLanguage) {
  const key = `${language}:${zone}`;
  let f = weekdays.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale(language), {
      weekday: "short",
      timeZone: zone,
    });
    weekdays.set(key, f);
  }
  return f.format(time).replace(/\.$/, "");
}
/** "Pzt" / "Mon" for a calendar date. */
const dayLabel = (date: string, language: NumberLanguage) =>
  weekdayOf(Date.parse(`${date}T12:00:00Z`), "UTC", language);

/** Time left until `at` as "h:mm" ("1:50", "0:07"); "" when past or unknown. */
export function widgetCountdown(at: number | undefined, now: number) {
  if (at === undefined || !Number.isFinite(at) || at <= now) return "";
  const minutes = Math.ceil((at - now) / 60_000);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

const tokensOf = (c: TokenCounts | undefined) =>
  c ? c.input + c.output + c.cacheWrite + c.cacheRead : 0;

/** A window's percent used, when the reading is the account's own and current. */
function limitsOf(
  account: Account,
  usage: AccountUsage | undefined,
  now: number,
): {
  fiveHour?: number;
  week?: number;
  fiveHourResetsAt?: number;
  weekResetsAt?: number;
} {
  if (!usage || usage.accountId !== account.id || !freshUsage(usage, now))
    return {};
  const reset = Date.parse(usage.fiveHour?.resetsAt ?? "");
  const weekReset = Date.parse(usage.sevenDay?.resetsAt ?? "");
  return {
    fiveHour: percentUsed(usage.fiveHour?.usedPercent),
    week: percentUsed(usage.sevenDay?.usedPercent),
    ...(Number.isFinite(reset) && reset > now
      ? { fiveHourResetsAt: reset }
      : {}),
    ...(Number.isFinite(weekReset) && weekReset > now
      ? { weekResetsAt: weekReset }
      : {}),
  };
}

export function buildWidgetSnapshot(
  input: WidgetSnapshotInput,
): WidgetSnapshot {
  const { today, progress, language, zone, now } = input;
  const t = (tr: string, en: string) => (language === "tr" ? tr : en);
  const { totals } = today;
  const cache = totals.cacheWrite + totals.cacheRead;
  const total = totals.input + totals.output + cache;
  const cost = totals.cost ?? 0;
  const state: WidgetSnapshot["state"] = !progress.complete
    ? "scanning"
    : total === 0
      ? "empty"
      : "data";
  const percent = new Intl.NumberFormat(locale(language), {
    style: "percent",
  }).format(progress.percent / 100);
  const money = (value: number, estimated?: boolean) =>
    `${estimated ? "≈" : ""}${formatCost(value, language)}`;
  const tokenWord = t("token", "tokens");
  const costText = money(cost, totals.costEstimated);
  const costTokens = `${costText} · ${formatTokens(total, language)} ${tokenWord}`;

  const accountsPart = buildAccounts(input, money, t);
  return {
    version: WIDGET_SNAPSHOT_VERSION,
    generatedAt: now,
    date: today.date,
    zone,
    state,
    mood: widgetMood(state, accountsPart.active),
    totals: { input: totals.input, output: totals.output, cache, total },
    cost,
    change: today.change,
    slots: today.slots,
    yesterdayAverage: today.yesterdayAverage,
    ...accountsPart,
    text: {
      title: t("Bugün", "Today"),
      subtitle: t("CLAUDE CODE · TOKEN", "CLAUDE CODE · TOKENS"),
      rows: [t("Girdi", "Input"), t("Çıktı", "Output"), t("Önbellek", "Cache")],
      input: formatTokens(totals.input, language),
      output: formatTokens(totals.output, language),
      cache: formatTokens(cache, language),
      total: formatTokens(total, language),
      cost: costText,
      change: today.change === null ? "" : formatChange(today.change, language),
      status:
        state === "scanning"
          ? t(`Relay tarıyor… ${percent}`, `Relay is scanning… ${percent}`)
          : state === "empty"
            ? t("Bugün henüz token yok", "No tokens yet today")
            : "",
      empty: t("Bugün henüz token yok", "No tokens yet today"),
      stale: t(
        `Güncel değil · ${timeOf(now, zone, language)}`,
        `Not current · ${timeOf(now, zone, language)}`,
      ),
      costTokens,
      tokens: `${formatTokens(total, language)} ${tokenWord}`,
      apiTitle: t("Bugün · API değeri", "Today · API value"),
      others: t("Diğer hesaplar", "Other accounts"),
      todayWord: t("bugün", "today"),
      inClaude: t("Claude’da açık", "Open in Claude"),
      suggested: t("önerilen", "suggested"),
      todayLine: t(`Bugün toplam ${costTokens}`, `Total today ${costTokens}`),
      allToday: t("Bugün · tüm hesaplar", "Today · all accounts"),
      switch: t("Geç", "Switch"),
      left: t("kaldı", "left"),
      noActive: t(
        "Claude’da Relay hesabı açık değil",
        "No Relay account is open in Claude",
      ),
    },
  };
}

type Money = (value: number, estimated?: boolean) => string;
type Say = (tr: string, en: string) => string;

/** The accounts, the stacked bars' series, today's split and the week. */
function buildAccounts(
  input: WidgetSnapshotInput,
  money: Money,
  t: Say,
): Pick<WidgetSnapshot, "active" | "accounts" | "series" | "split" | "week"> {
  const { limits, language, zone, now, today } = input;
  const days = input.days?.filter((d) => d.date <= today.date) ?? [];
  const todayRow = days.find((d) => d.date === today.date)?.byRow ?? {};
  const all = limits?.accounts ?? [];
  const active = all.find((a) => a.id === limits?.activeId);
  const pct = (value: number | undefined) => formatPercent(value, language);

  // Series: the active account first, then Relay's order, by cost in the days shown.
  const spent = new Map<string, number>();
  for (const day of days)
    for (const [key, counts] of Object.entries(day.byRow))
      spent.set(key, (spent.get(key) ?? 0) + (counts.cost ?? 0));
  const ordered = [
    ...(active ? [active] : []),
    ...all.filter((a) => a !== active),
  ];
  const own = ordered
    .filter((a) => (spent.get(a.id) ?? 0) > 0)
    .slice(0, WIDGET_SERIES);
  const series: WidgetSeries[] = own.map((a, color) => ({
    key: a.id,
    name: a.name,
    color,
  }));
  const restSpent = [...spent].some(
    ([key, value]) => value > 0 && !own.some((a) => a.id === key),
  );
  if (restSpent)
    series.push({
      key: WIDGET_REST_KEY,
      name: t("Diğer", "Other"),
      color: WIDGET_SERIES,
    });
  const seriesOf = (key: string) =>
    series.find((s) => s.key === key) ??
    series.find((s) => s.key === WIDGET_REST_KEY);
  const colorOf = (key: string) =>
    series.find((s) => s.key === key)?.color ?? WIDGET_SERIES;
  const byseries = (byRow: Record<string, TokenCounts>) => {
    const parts = series.map(() => 0);
    for (const [key, counts] of Object.entries(byRow)) {
      const s = seriesOf(key);
      if (s) parts[series.indexOf(s)] += counts.cost ?? 0;
    }
    return parts;
  };

  const line = (account: Account): WidgetAccount => {
    const known = limitsOf(account, limits?.usage[account.id], now);
    const counts = todayRow[account.id];
    const cost = counts?.cost ?? 0;
    const tokens = tokensOf(counts);
    const costText = money(cost, counts?.costEstimated);
    const tokensText = formatTokens(tokens, language);
    return {
      id: account.id,
      name: account.name,
      ...(known.fiveHour !== undefined ? { fiveHour: known.fiveHour } : {}),
      ...(known.week !== undefined ? { week: known.week } : {}),
      ...(known.fiveHourResetsAt !== undefined
        ? { fiveHourResetsAt: known.fiveHourResetsAt }
        : {}),
      cost,
      tokens,
      color: colorOf(account.id),
      text: {
        fiveHour: pct(known.fiveHour),
        week: pct(known.week),
        limits: `${pct(known.fiveHour)} / ${pct(known.week)}`,
        cost: costText,
        tokens: tokensText,
        costTokens: `${costText} · ${tokensText}`,
        left: widgetCountdown(known.fiveHourResetsAt, now),
        weekReset:
          known.weekResetsAt === undefined
            ? ""
            : `${weekdayOf(known.weekResetsAt, zone, language)} ${timeOf(known.weekResetsAt, zone, language)}`,
        weekShort:
          known.week === undefined
            ? ""
            : t(`hafta ${pct(known.week)}`, `week ${pct(known.week)}`),
      },
    };
  };

  let activeLine: WidgetActive | undefined;
  if (limits && active) {
    const base = line(active);
    const { week, text } = base;
    activeLine = {
      ...base,
      text: {
        ...text,
        weekLine:
          week === undefined
            ? ""
            : text.weekReset
              ? t(
                  `Hafta ${pct(week)} · ${text.weekReset} sıfırlanır`,
                  `Week ${pct(week)} · resets ${text.weekReset}`,
                )
              : t(`Hafta ${pct(week)}`, `Week ${pct(week)}`),
        costChip: t(`${text.cost} bugün`, `${text.cost} today`),
        tokensChip: `${text.tokens} ${t("token", "tokens")}`,
      },
    };
  }

  const others: WidgetOther[] = [];
  if (limits) {
    const suggestion = suggestedAccount(
      active,
      all,
      limits.usage,
      limits.settings,
      now,
      limits.rate,
    );
    // The panel's ranking and badge (src/panel/PanelAccounts.tsx `panelRows`).
    const rows = overviewAccounts(
      active,
      all,
      limits.usage,
      now,
      limits.rate,
    ).map((row) =>
      suggestion
        ? { ...row, recommended: row.account.id === suggestion.id }
        : row,
    );
    const first = rows.filter((r) => r.recommended);
    for (const row of [...first, ...rows.filter((r) => !r.recommended)].slice(
      0,
      WIDGET_OTHER_ACCOUNTS,
    )) {
      const base = line(row.account);
      const linked =
        !!row.account.desktop?.accountUuid &&
        !!row.account.desktop.orgId &&
        !desktopCliMismatch(row.account);
      const switchable =
        linked && (row.state === "ready" || row.state === "window-open");
      const figure =
        base.fiveHour === undefined ? "" : ` · ${base.text.fiveHour}`;
      others.push({
        ...base,
        suggested: row.recommended,
        switchable,
        ...(switchable ? { link: relaySwitchLink(row.account.id) } : {}),
        text: {
          ...base.text,
          switchTo: t(
            `${withDative(row.account.name)} geç${figure}`,
            `Switch to ${row.account.name}${figure}`,
          ),
        },
      });
    }
  }

  const todayCost = Object.values(todayRow).reduce(
    (sum, c) => sum + (c.cost ?? 0),
    0,
  );
  const split: WidgetSplitPart[] =
    todayCost > 0
      ? series
          .map((s, i) => ({ s, cost: byseries(todayRow)[i] }))
          .filter(({ cost }) => cost > 0)
          .map(({ s, cost }) => ({
            ...s,
            cost,
            share: cost / todayCost,
            text: { cost: money(cost) },
          }))
      : [];

  let week: WidgetWeek | undefined;
  if (days.length) {
    const rows = days.map((d) => {
      const parts = byseries(d.byRow);
      const cost = Object.values(d.byRow).reduce(
        (sum, c) => sum + (c.cost ?? 0),
        0,
      );
      return {
        date: d.date,
        label: dayLabel(d.date, language),
        today: d.date === today.date,
        cost,
        parts,
      };
    });
    const cost = rows.reduce((sum, d) => sum + d.cost, 0);
    const tokens = days.reduce(
      (sum, d) =>
        sum + Object.values(d.byRow).reduce((s, c) => s + tokensOf(c), 0),
      0,
    );
    const average = cost / rows.length;
    const busiest = rows.reduce<(typeof rows)[number] | undefined>(
      (best, d) => (d.cost > (best?.cost ?? 0) ? d : best),
      undefined,
    );
    const activeWeek =
      activeLine?.week === undefined
        ? ""
        : `${activeLine.name} · ${activeLine.text.weekShort}`;
    week = {
      days: rows,
      cost,
      tokens,
      average,
      ...(input.hits !== undefined ? { hits: input.hits } : {}),
      text: {
        title: t("Son 7 gün", "Last 7 days"),
        cost: money(cost),
        tokens: `${formatTokens(tokens, language)} ${t("token", "tokens")}`,
        average: t(`Günde ${money(average)}`, `${money(average)} a day`),
        busiest: busiest
          ? t(
              `En yoğun ${busiest.label} · ${money(busiest.cost)}`,
              `Busiest ${busiest.label} · ${money(busiest.cost)}`,
            )
          : "",
        hits:
          input.hits === undefined
            ? ""
            : input.hits === 0
              ? t("Limit hiç dolmadı", "No limit reached")
              : t(
                  `Limit ${input.hits} kez doldu`,
                  `Limit reached ${input.hits}×`,
                ),
        activeWeek,
      },
    };
  }

  return {
    ...(activeLine ? { active: activeLine } : {}),
    accounts: others,
    series,
    split,
    ...(week ? { week } : {}),
  };
}

/**
 * What the widget would draw differently: a new file whose key is unchanged
 * needs no reload. `generatedAt`, the stale line and the countdowns move on
 * every write; the widget counts down by itself from the reset time.
 */
export function widgetVisibleKey(snapshot: WidgetSnapshot): string {
  const { stale: _stale, ...text } = snapshot.text;
  const account = <A extends WidgetAccount>(a: A) => {
    const { left: _left, ...rest } = a.text;
    // Costs and tokens are drawn from their text.
    const { cost: _cost, tokens: _tokens, ...shown } = a;
    return {
      ...shown,
      // The minute the window renews: a new window moves it by hours.
      fiveHourResetsAt:
        a.fiveHourResetsAt === undefined
          ? null
          : Math.round(a.fiveHourResetsAt / 60_000),
      text: rest,
    };
  };
  const cents = (v: number) => Math.round(v * 100);
  return JSON.stringify([
    snapshot.date,
    snapshot.state,
    snapshot.mood,
    text,
    snapshot.slots.map((v) => (v === null ? null : cents(v))),
    snapshot.yesterdayAverage === null
      ? null
      : cents(snapshot.yesterdayAverage),
    snapshot.active ? account(snapshot.active) : null,
    snapshot.accounts.map(account),
    snapshot.series,
    snapshot.split.map((p) => [p.key, p.text.cost]),
    snapshot.week
      ? [
          snapshot.week.text,
          snapshot.week.days.map((d) => [d.label, d.parts.map(cents)]),
        ]
      : null,
  ]);
}
