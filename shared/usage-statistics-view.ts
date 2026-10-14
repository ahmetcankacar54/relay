import type { Account } from "./types";
import { localDate, planCapacity, wallTime } from "./planning";
import { usageIdentity } from "./usage-statistics";
import type { UsageRollups } from "./usage-rollups";

export type StatisticsRange = 7 | 30 | 90;

export interface UsageStatisticsView {
  range: StatisticsRange;
  status: "available" | "unavailable" | "empty";
  /** Observed minutes over the range so far, 0–100. */
  coveragePercent: number;
  totals: {
    proUnits: number;
    previousProUnits?: number;
    windows: number;
    hits: { fiveHour: number; weekly: number };
    /** weekday 0 = Monday; workShare is a percentage (0–100). */
    busiest?: { weekday: number; hour: number; workShare: number };
  };
  /** Unmatched identities form one row without accountId ("Eski hesap"). */
  accounts: {
    accountId?: string;
    name: string;
    plan?: string;
    proUnits: number;
    share: number;
    averageFill?: number;
    idleDays: number;
  }[];
  /** Pro units per local day; keys are account ids, or "former". */
  daily: { date: string; byAccount: Record<string, number> }[];
  /** [weekday 0 = Monday][local hour] → Pro units */
  heatmap: number[][];
  hits: {
    accountId?: string;
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
}

export const FORMER_KEY = "former";
export const FORMER_NAME = "Eski hesap";
const DAY_MS = 86_400_000;
const FIVE_HOURS_MS = 5 * 3_600_000;
const PREVIOUS_MAX_DAYS = 45;
const INSIGHT_MIN_WINDOWS = 5;

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
  const previous = new Set(
    Array.from({ length: range }, (_, i) => shiftDate(dates[0], i - range)),
  );

  // Identity → row: current accounts in their order, then one "former" row.
  const rows: Row[] = [];
  const rowOf = new Map<string, Row>();
  for (const account of accounts) {
    if (input.accountId && account.id !== input.accountId) continue;
    const identity = usageIdentity(account);
    if (!identity) continue;
    let row = rows.find((r) => r.account?.id === account.id);
    if (!row) {
      row = {
        key: account.id,
        account,
        identities: [],
        capacity: planCapacity(account),
      };
      rows.push(row);
    }
    if (!rowOf.has(identity)) {
      row.identities.push(identity);
      rowOf.set(identity, row);
    }
  }
  if (!input.accountId) {
    const known = new Set(accounts.map(usageIdentity));
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
  const units = new Map<Row, number>();
  const observedDays = new Map<Row, Set<string>>();
  const activeDays = new Map<Row, Set<string>>();
  const coverage = new Map<string, number>();
  let total = 0;
  let previousTotal = 0;
  let observedAny = false;

  for (const row of rows) {
    units.set(row, 0);
    observedDays.set(row, new Set());
    activeDays.set(row, new Set());
    for (const identity of row.identities) {
      for (const [key, hour] of Object.entries(rollups.hours[identity] ?? {})) {
        const time = Date.parse(key);
        const date = localDate(time, zone);
        const value = hour.points * row.capacity;
        if (previous.has(date)) previousTotal += value;
        if (!inRange.has(date)) continue;
        observedAny = true;
        observedDays.get(row)!.add(date);
        coverage.set(
          key,
          Math.max(coverage.get(key) ?? 0, Math.min(60, hour.coveredMinutes)),
        );
        if (hour.points > 0) activeDays.get(row)!.add(date);
        if (!value) continue;
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

  // Windows that started (resetAt − 5h) inside the range.
  const fills = new Map<Row, number[]>();
  for (const row of rows) {
    const list: number[] = [];
    for (const identity of row.identities)
      for (const w of rollups.windows[identity] ?? []) {
        const date = localDate(Date.parse(w.resetAt) - FIVE_HOURS_MS, zone);
        if (!inRange.has(date)) continue;
        list.push(w.maxPercent);
        activeDays.get(row)!.add(date);
      }
    fills.set(row, list);
    view.totals.windows += list.length;
  }

  view.accounts = rows.map((row) => {
    const list = fills.get(row)!;
    const active = activeDays.get(row)!;
    const plan = row.account && PLAN_LABELS[row.account.planning?.plan ?? ""];
    const proUnits = round2(units.get(row)!);
    return {
      ...(row.account ? { accountId: row.account.id } : {}),
      name: row.account?.name ?? FORMER_NAME,
      ...(plan ? { plan } : {}),
      proUnits,
      share: total > 0 ? round1((units.get(row)! / total) * 100) : 0,
      ...(list.length
        ? { averageFill: round1(list.reduce((a, b) => a + b, 0) / list.length) }
        : {}),
      idleDays: [...observedDays.get(row)!].filter((d) => !active.has(d))
        .length,
    };
  });

  view.totals.proUnits = round2(total);
  if (range <= PREVIOUS_MAX_DAYS)
    view.totals.previousProUnits = round2(previousTotal);

  view.heatmap = view.heatmap.map((row) => row.map(round2));
  if (total > 0) {
    let best = { weekday: 0, hour: 0, value: -1 };
    let work = 0;
    view.heatmap.forEach((row, day) =>
      row.forEach((value, hour) => {
        if (value > best.value) best = { weekday: day, hour, value };
        if (day < 5 && hour >= 10 && hour < 18) work += value;
      }),
    );
    view.totals.busiest = {
      weekday: best.weekday,
      hour: best.hour,
      workShare: round1((work / total) * 100),
    };
  }

  const start = wallTime(dates[0], "00:00", zone) ?? now - range * DAY_MS;
  const rangeMinutes = Math.max(1, (now - start) / 60_000);
  const covered = [...coverage.values()].reduce((a, b) => a + b, 0);
  view.coveragePercent = Math.min(100, round1((covered / rangeMinutes) * 100));

  for (const hit of rollups.hits) {
    const row = rowOf.get(hit.identity);
    if (!row || !inRange.has(localDate(Date.parse(hit.at), zone))) continue;
    view.hits.push({
      ...(row.account ? { accountId: row.account.id } : {}),
      name: row.account?.name ?? FORMER_NAME,
      kind: hit.kind,
      at: hit.at,
      ...(hit.until ? { until: hit.until } : {}),
    });
    if (hit.kind === "five-hour") view.totals.hits.fiveHour += 1;
    else view.totals.hits.weekly += 1;
  }
  view.hits.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const insight = buildInsight(rows, view.accounts, fills);
  if (insight) view.insight = insight;
  return view;
}

function buildInsight(
  rows: Row[],
  out: UsageStatisticsView["accounts"],
  fills: Map<Row, number[]>,
): UsageStatisticsView["insight"] {
  const candidates = rows
    .map((row, i) => ({ row, view: out[i] }))
    .filter(({ row, view }) => row.account && view.averageFill !== undefined);
  const label = (c: (typeof candidates)[number]) =>
    c.view.plan ? `${c.view.name} (${c.view.plan})` : c.view.name;
  // Stable sorts keep account order between equal capacities.
  const sparse = candidates
    .filter(
      ({ row, view }) =>
        fills.get(row)!.length >= INSIGHT_MIN_WINDOWS && view.averageFill! < 20,
    )
    .sort((a, b) => b.row.capacity - a.row.capacity)[0];
  if (sparse) {
    const n = Math.round(sparse.view.averageFill!);
    return {
      tr: `${label(sparse)} pencerelerinin yalnızca %${n}’ini dolduruyor.`,
      en: `${label(sparse)} fills only ${n}% of its windows.`,
    };
  }
  const full = candidates
    .filter(({ view }) => view.averageFill! > 80)
    .sort((a, b) => a.row.capacity - b.row.capacity)[0];
  if (full)
    return {
      tr: `${label(full)} açıldığında neredeyse hep doluyor.`,
      en: `${label(full)} is almost always full when it opens.`,
    };
}
