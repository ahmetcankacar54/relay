import type { Account, PlanningHours } from "./types";
import { formatPercent } from "./percent";
import { localDate, planCapacity, wallTime } from "./planning";
import { historyIdentity, identityOwners } from "./usage-statistics";
import type { UsageRollups } from "./usage-rollups";

export type StatisticsRange = 7 | 30 | 90;

export interface UsageStatisticsView {
  range: StatisticsRange;
  status: "available" | "unavailable" | "empty";
  /** Observed minutes over the range so far, 0–100. */
  coveragePercent: number;
  totals: {
    proUnits: number;
    /** Full 5-hour periods used: each account's own limit points over 100, unweighted. */
    periods?: number;
    previousProUnits?: number;
    windows: number;
    hits: { fiveHour: number; weekly: number };
    /**
     * weekday 0 = Monday. `workShare` is the percentage (0–100) of use inside the user's work
     * hours (Planning), or weekdays 10–18 when none are given.
     */
    busiest?: { weekday: number; hour: number; workShare: number };
    /** The three local hours of the day with the most use: `start`…`end` (exclusive, may pass 24). */
    busiestWindow?: { start: number; end: number };
  };
  /**
   * Rows with in-range hours, windows or hits. Unmatched identities form one
   * row with `former: true` and the Turkish default name "Eski hesap".
   */
  accounts: {
    accountId?: string;
    former?: true;
    name: string;
    plan?: string;
    proUnits: number;
    /** Full 5-hour periods of this account used. */
    periods?: number;
    share: number;
    averageFill?: number;
    idleDays: number;
  }[];
  /**
   * Pro units per local day; keys are account ids, or "former". `periods` holds the same days in
   * full 5-hour periods, unweighted.
   */
  daily: { date: string; byAccount: Record<string, number>; periods?: Record<string, number> }[];
  /** [weekday 0 = Monday][local hour] → Pro units */
  heatmap: number[][];
  hits: {
    accountId?: string;
    former?: true;
    name: string;
    kind: "five-hour" | "weekly";
    at: string;
    until?: string;
  }[];
  insight?: { tr: string; en: string };
}

export interface StatisticsInput {
  rollups?: UsageRollups;
  available: boolean;
  accounts: Account[];
  range: StatisticsRange;
  accountId?: string;
  zone: string;
  now: number;
  /** The user's work hours, for the share of use inside them. */
  hours?: { weekday: PlanningHours; weekend: PlanningHours };
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};
/** Whether the local hour `hour` of `weekday` (0 = Monday) starts inside the work hours. */
export function inWorkHours(
  weekday: number,
  hour: number,
  hours: StatisticsInput["hours"],
): boolean {
  if (!hours) return weekday < 5 && hour >= 10 && hour < 18;
  const day = weekday < 5 ? hours.weekday : hours.weekend;
  if (!day.enabled) return false;
  const start = minutes(day.start);
  const end = minutes(day.end);
  const at = hour * 60;
  // An end before the start runs past midnight.
  return end > start ? at >= start && at < end : at >= start || at < end;
}

export const FORMER_KEY = "former";
export const FORMER_NAME = "Eski hesap";
const DAY_MS = 86_400_000;
const FIVE_HOURS_MS = 5 * 3_600_000;
const PREVIOUS_MAX_DAYS = 45;
const INSIGHT_MIN_WINDOWS = 5;
/** Days an account must have sat idle before the order insight names it. */
const INSIGHT_IDLE_DAYS = 3;

const PLAN_LABELS: Partial<Record<string, string>> = {
  pro: "Pro",
  max5: "Max 5×",
  max20: "Max 20×",
  team: "Team",
};

const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}
/** 0 = Monday … 6 = Sunday for a YYYY-MM-DD calendar date. */
function weekday(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

const hourFormatters = new Map<string, Intl.DateTimeFormat>();
function localHour(time: number, zone: string): number {
  let f = hourFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone: zone,
    });
    hourFormatters.set(zone, f);
  }
  return Number(f.format(new Date(time)));
}

/**
 * Days a row has sat idle up to today: observed days without use, counted
 * back to its last active day. Days Relay did not observe are skipped.
 */
function idleStreak(
  dates: string[],
  covered: Set<string>,
  active: Set<string>,
): number {
  let days = 0;
  for (let i = dates.length - 1; i >= 0; i--) {
    if (active.has(dates[i])) break;
    if (covered.has(dates[i])) days += 1;
  }
  return days;
}

interface Row {
  key: string;
  account?: Account;
  identities: string[];
  capacity: number;
}

function emptyView(
  range: StatisticsRange,
  status: UsageStatisticsView["status"],
  dates: string[],
): UsageStatisticsView {
  return {
    range,
    status,
    coveragePercent: 0,
    totals: { proUnits: 0, windows: 0, hits: { fiveHour: 0, weekly: 0 } },
    accounts: [],
    daily: dates.map((date) => ({ date, byAccount: {} })),
    heatmap: Array.from({ length: 7 }, () => Array<number>(24).fill(0)),
    hits: [],
  };
}

/**
 * Builds the Usage page model from hourly rollups. Days and hours follow
 * `zone`; the range is the last `range` local days including today. Pro units
 * apply each account's current plan capacity.
 */
export function buildStatisticsView(
  input: StatisticsInput,
): UsageStatisticsView {
  const { rollups, accounts, range, zone, now } = input;
  const today = localDate(now, zone);
  const dates = Array.from({ length: range }, (_, i) =>
    shiftDate(today, i - range + 1),
  );
  if (!input.available) return emptyView(range, "unavailable", dates);

  const inRange = new Set(dates);
  const previousFirst = shiftDate(dates[0], -range);
  const previous = new Set(
    Array.from({ length: range }, (_, i) => shiftDate(previousFirst, i)),
  );

  // Identity → row: current accounts in their order, then one "former" row.
  // A signed-out account keeps its history; of accounts sharing an identity,
  // the first signed-in one, else the first one, owns it.
  const owner = identityOwners(
    input.accountId
      ? accounts.filter((account) => account.id === input.accountId)
      : accounts,
  );
  const rows: Row[] = [];
  const rowOf = new Map<string, Row>();
  for (const account of accounts) {
    const identity = historyIdentity(account);
    if (!identity || owner.get(identity) !== account) continue;
    const row: Row = {
      key: account.id,
      account,
      identities: [identity],
      capacity: planCapacity(account),
    };
    rows.push(row);
    rowOf.set(identity, row);
  }
  if (!input.accountId) {
    const known = new Set(accounts.map(historyIdentity));
    const former: Row = {
      key: FORMER_KEY,
      identities: [],
      capacity: 1,
    };
    const seen = new Set([
      ...Object.keys(rollups?.hours ?? {}),
      ...Object.keys(rollups?.windows ?? {}),
      ...(rollups?.hits ?? []).map((hit) => hit.identity),
    ]);
    for (const identity of seen)
      if (!known.has(identity)) {
        former.identities.push(identity);
        rowOf.set(identity, former);
      }
    if (former.identities.length) rows.push(former);
  }
  if (!rollups || !rows.length) return emptyView(range, "empty", dates);

  const view = emptyView(range, "available", dates);
  const daily = new Map(view.daily.map((d) => [d.date, d.byAccount]));
  const dailyPeriods = new Map(
    view.daily.map((d) => [d.date, (d.periods = {} as Record<string, number>)]),
  );
  const periods = new Map<Row, number>();
  let periodsTotal = 0;
  const units = new Map<Row, number>();
  const coveredDays = new Map<Row, Set<string>>();
  const present = new Set<Row>();
  const activeDays = new Map<Row, Set<string>>();
  const coverage = new Map<string, number>();
  let total = 0;
  let previousTotal = 0;
  /** Earliest stored hour of the identities shown. */
  let recordedFrom = Infinity;
  let observedAny = false;

  for (const row of rows) {
    units.set(row, 0);
    coveredDays.set(row, new Set());
    activeDays.set(row, new Set());
    for (const identity of row.identities) {
      for (const [key, hour] of Object.entries(rollups.hours[identity] ?? {})) {
        const time = Date.parse(key);
        recordedFrom = Math.min(recordedFrom, time);
        const date = localDate(time, zone);
        const value = hour.points * row.capacity;
        if (previous.has(date)) previousTotal += value;
        if (!inRange.has(date)) continue;
        observedAny = true;
        present.add(row);
        if (hour.coveredMinutes > 0) coveredDays.get(row)!.add(date);
        coverage.set(
          key,
          Math.max(coverage.get(key) ?? 0, Math.min(60, hour.coveredMinutes)),
        );
        if (hour.points > 0) activeDays.get(row)!.add(date);
        if (!value) continue;
        const used = hour.points / 100;
        periodsTotal += used;
        periods.set(row, (periods.get(row) ?? 0) + used);
        const dayPeriods = dailyPeriods.get(date)!;
        dayPeriods[row.key] = round2((dayPeriods[row.key] ?? 0) + used);
        total += value;
        units.set(row, units.get(row)! + value);
        const day = daily.get(date)!;
        day[row.key] = round2((day[row.key] ?? 0) + value);
        const cell = view.heatmap[weekday(date)];
        const h = localHour(time, zone);
        cell[h] = cell[h] + value;
      }
    }
  }
  if (!observedAny) return emptyView(range, "empty", dates);

  // Windows that started (resetAt − 5h) inside the range; a window still
  // open at `now` counts as started but its fill is not final.
  const fills = new Map<Row, number[]>();
  for (const row of rows) {
    const list: number[] = [];
    for (const identity of row.identities)
      for (const w of rollups.windows[identity] ?? []) {
        const resetAt = Date.parse(w.resetAt);
        const date = localDate(resetAt - FIVE_HOURS_MS, zone);
        if (!inRange.has(date)) continue;
        present.add(row);
        activeDays.get(row)!.add(date);
        view.totals.windows += 1;
        if (resetAt <= now) list.push(w.maxPercent);
      }
    fills.set(row, list);
  }

  for (const hit of rollups.hits) {
    const row = rowOf.get(hit.identity);
    if (!row || !inRange.has(localDate(Date.parse(hit.at), zone))) continue;
    present.add(row);
    // A hit ends at its reset at the latest, even without a later sample.
    const until =
      hit.until ??
      (hit.resetAt && Date.parse(hit.resetAt) <= now ? hit.resetAt : undefined);
    view.hits.push({
      ...(row.account ? { accountId: row.account.id } : { former: true }),
      name: row.account?.name ?? FORMER_NAME,
      kind: hit.kind,
      at: hit.at,
      ...(until ? { until } : {}),
    });
    if (hit.kind === "five-hour") view.totals.hits.fiveHour += 1;
    else view.totals.hits.weekly += 1;
  }
  view.hits.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const shown = rows.filter((row) => present.has(row));
  view.accounts = shown.map((row) => {
    const list = fills.get(row)!;
    const active = activeDays.get(row)!;
    const plan = row.account && PLAN_LABELS[row.account.planning?.plan ?? ""];
    const proUnits = round2(units.get(row)!);
    return {
      ...(row.account ? { accountId: row.account.id } : { former: true }),
      name: row.account?.name ?? FORMER_NAME,
      ...(plan ? { plan } : {}),
      proUnits,
      periods: round2(periods.get(row) ?? 0),
      share: total > 0 ? round1((units.get(row)! / total) * 100) : 0,
      ...(list.length
        ? { averageFill: round1(list.reduce((a, b) => a + b, 0) / list.length) }
        : {}),
      idleDays: [...coveredDays.get(row)!].filter((d) => !active.has(d)).length,
    };
  });

  view.totals.proUnits = round2(total);
  view.totals.periods = round2(periodsTotal);
  // Compare only with a previous period that recording covers from its
  // start; a partly recorded one would read as growth.
  const previousStart =
    wallTime(previousFirst, "00:00", zone) ?? now - 2 * range * DAY_MS;
  if (range <= PREVIOUS_MAX_DAYS && recordedFrom <= previousStart)
    view.totals.previousProUnits = round2(previousTotal);

  view.heatmap = view.heatmap.map((row) => row.map(round2));
  if (total > 0) {
    let best = { weekday: 0, hour: 0, value: -1 };
    let work = 0;
    const byHour = Array<number>(24).fill(0);
    view.heatmap.forEach((row, day) =>
      row.forEach((value, hour) => {
        if (value > best.value) best = { weekday: day, hour, value };
        if (inWorkHours(day, hour, input.hours)) work += value;
        byHour[hour] += value;
      }),
    );
    view.totals.busiest = {
      weekday: best.weekday,
      hour: best.hour,
      workShare: round1((work / total) * 100),
    };
    // The three hours in a row (around midnight too) with the most use.
    let start = 0;
    let most = -1;
    for (let h = 0; h < 24; h++) {
      const sum = byHour[h] + byHour[(h + 1) % 24] + byHour[(h + 2) % 24];
      if (sum > most) [most, start] = [sum, h];
    }
    view.totals.busiestWindow = { start, end: start + 3 };
  }

  const start = wallTime(dates[0], "00:00", zone) ?? now - range * DAY_MS;
  const rangeMinutes = Math.max(1, (now - start) / 60_000);
  const covered = [...coverage.values()].reduce((a, b) => a + b, 0);
  view.coveragePercent = Math.min(100, round1((covered / rangeMinutes) * 100));

  const idle = new Map(
    shown.map((row) => [
      row,
      idleStreak(dates, coveredDays.get(row)!, activeDays.get(row)!),
    ]),
  );
  const insight = buildInsight(shown, view.accounts, fills, idle);
  if (insight) view.insight = insight;
  return view;
}

function buildInsight(
  rows: Row[],
  out: UsageStatisticsView["accounts"],
  fills: Map<Row, number[]>,
  /** Each row's idle days up to today; see `idleStreak`. */
  idle: Map<Row, number>,
): UsageStatisticsView["insight"] {
  const accounts = rows
    .map((row, i) => ({ row, view: out[i] }))
    .filter(({ row }) => row.account);
  const candidates = accounts.filter(
    ({ view }) => view.averageFill !== undefined,
  );
  const label = (c: (typeof candidates)[number]) =>
    c.view.plan ? `${c.view.name} (${c.view.plan})` : c.view.name;
  // Rule 1 counts the same closed windows that averageFill is built from.
  // Stable sorts keep account order between equal capacities.
  const sparse = candidates
    .filter(
      ({ row, view }) =>
        fills.get(row)!.length >= INSIGHT_MIN_WINDOWS && view.averageFill! < 20,
    )
    .sort((a, b) => b.row.capacity - a.row.capacity)[0];
  if (sparse) {
    const fill = sparse.view.averageFill;
    return {
      tr: `${label(sparse)} dönemlerinin ortalama yalnızca ${formatPercent(fill, "tr")} kadarını dolduruyor.`,
      en: `${label(sparse)} fills only ${formatPercent(fill, "en")} of its periods.`,
    };
  }
  const full = candidates
    .filter(({ view }) => view.averageFill! > 80)
    .sort((a, b) => a.row.capacity - b.row.capacity)[0];
  // A full account beside one that has sat idle for days: shifting the order
  // moves work to the idle one (the longest idle is named) before the plain
  // note that it fills.
  const spare =
    full &&
    accounts
      .filter(
        (c) => c.row !== full.row && idle.get(c.row)! >= INSIGHT_IDLE_DAYS,
      )
      .sort((a, b) => idle.get(b.row)! - idle.get(a.row)!)[0];
  if (full && spare) {
    const days = idle.get(spare.row)!;
    return {
      tr: `${spare.view.name} ${days} gündür boşta; ${full.view.name} ise dönemi açıldığında neredeyse hep doluyor. ${spare.view.name} hesabını sırada öne almak 5 saatlik limite takılmayı azaltır.`,
      en: `${spare.view.name} has sat idle for ${days} days; ${full.view.name} is almost always full when it opens. Moving ${spare.view.name} up the order would cut 5-hour limit stops.`,
    };
  }
  if (full)
    return {
      tr: `${label(full)} açıldığında neredeyse hep doluyor.`,
      en: `${label(full)} is almost always full when it opens.`,
    };
}
