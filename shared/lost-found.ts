// The panda's lost-and-found: what a week of use left behind
// (docs/superpowers/specs/2026-10-19-lost-found-design.md). Every item is a real moment of that week,
// found in the usage rollups, the active-account timeline and the token ledger; nothing here is a
// constant dressed up as a joke.
import { desktopAccountFor } from "./desktop-account";
import { localDate, localHour, wallTime } from "./planning";
import type { Account } from "./types";
import type { UsageRollups } from "./usage-rollups";
import { identityOwners, historyIdentity } from "./usage-statistics";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const FIVE_HOURS_MS = 5 * HOUR_MS;

/** A five-hour window that ran out this soon after it began is an hourglass. */
export const HOURGLASS_MAX_MS = 150 * MINUTE_MS;
/** This many active hours in a row make a long scroll. */
export const SCROLL_MIN_HOURS = 8;
/** Two accounts' windows resetting this close together ring as twin clocks. */
export const CLOCKS_MAX_GAP_MS = 10 * MINUTE_MS;
/** Leaving an account and coming back within this time is a boomerang. */
export const BOOMERANG_MAX_MS = 15 * MINUTE_MS;
/** Night hours run from midnight to this local hour. */
export const NIGHT_END_HOUR = 5;
/** The trophy day is the busiest of this many days, the week's own included. */
export const TROPHY_DAYS = 30;
/** How many weeks back the bureau can look: the rollups keep 90 days. */
export const LOST_FOUND_WEEKS = 12;

/** The items, most striking first: the first one found is the week's featured item. */
export const LOST_ITEM_KINDS = [
  "hourglass",
  "boomerang",
  "trophy",
  "scroll",
  "scarf",
  "clocks",
  "spare",
  "feather",
] as const;
export type LostItemKind = (typeof LOST_ITEM_KINDS)[number];

export type LostItem =
  /** A five-hour window ran out `minutes` after it began; `at` is when it ran out. */
  | { kind: "hourglass"; at: string; accountId?: string; minutes: number }
  /** Left `accountIds[0]` for `accountIds[1]` at `at` and came back `minutes` later. */
  | {
      kind: "boomerang";
      at: string;
      accountIds: [string, string];
      minutes: number;
    }
  /** `date` was the busiest of the last 30 days, `times` an ordinary active day of them. */
  | { kind: "trophy"; date: string; tokens: number; times: number }
  /** `hours` active hours in a row from `at`. */
  | { kind: "scroll"; at: string; hours: number }
  /** `accountIds.length` accounts were used on `date`, busiest first. */
  | { kind: "scarf"; date: string; accountIds: string[] }
  /** Two accounts' five-hour windows reset `gapMinutes` apart at `at`; `count` such pairs that week. */
  | {
      kind: "clocks";
      at: string;
      accountIds: [string, string];
      gapMinutes: number;
      count: number;
    }
  /** `accountIds` were never used while other accounts hit a five-hour limit `hits` times. */
  | { kind: "spare"; accountIds: string[]; hits: number }
  /** `hours` active hours after midnight; the latest began at `at`. */
  | { kind: "feather"; at: string; hours: number };

export interface LostFoundWeek {
  /** The Monday the week starts, in the planning zone. */
  start: string;
  /** The Sunday it ends. */
  end: string;
  /** Monday of the newest complete week, which is the latest a user can open. */
  latest: string;
  /** Monday of the oldest week the bureau can still look into. */
  oldest: string;
  /** What the week left behind, most striking first. */
  items: LostItem[];
}

export interface LostFoundInput {
  rollups?: UsageRollups;
  /** Active-account segments, oldest first (electron/core/active-account-timeline.ts). */
  segments: {
    accountUuid: string;
    orgId?: string;
    from: string;
    to?: string;
  }[];
  /** Token ledger days: date → who → model → counts. */
  ledgerDays: Record<
    string,
    Record<
      string,
      Record<
        string,
        { input: number; output: number; cacheWrite: number; cacheRead: number }
      >
    >
  >;
  accounts: Account[];
  zone: string;
  now: number;
  /** A Monday; the newest complete week when missing or out of reach. */
  weekStart?: string;
}

/** `date` plus `days` calendar days. */
export function addDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** The Monday of the week `date` falls in. */
export function mondayOf(date: string) {
  const weekday = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(date, -weekday);
}

const isoAt = (time: number) => new Date(time).toISOString();

/** The rollup identity → account id map, as the statistics read it. */
function identityAccounts(accounts: Account[]) {
  const map = new Map<string, string>();
  for (const [identity, account] of identityOwners(accounts))
    map.set(identity, account.id);
  for (const account of accounts) {
    const identity = historyIdentity(account);
    if (identity && !map.has(identity)) map.set(identity, account.id);
  }
  return map;
}

/** Everything the week left behind, most striking first. */
export function lostFoundWeek(input: LostFoundInput): LostFoundWeek {
  const { zone, now, accounts } = input;
  const today = localDate(now, zone);
  const latest = addDays(mondayOf(today), -7);
  const oldest = addDays(latest, -7 * (LOST_FOUND_WEEKS - 1));
  const asked = input.weekStart && mondayOf(input.weekStart);
  const start = asked && asked >= oldest && asked <= latest ? asked : latest;
  const end = addDays(start, 6);
  const from =
    wallTime(start, "00:00", zone) ?? Date.parse(`${start}T00:00:00Z`);
  const to = wallTime(addDays(start, 7), "00:00", zone) ?? from + 7 * DAY_MS;
  const within = (time: number) => time >= from && time < to;
  const owner = identityAccounts(accounts);
  const rollups = input.rollups;

  // Active hours: UTC hour start → account id (or identity, for a former account) → points.
  const hours = new Map<number, Map<string, number>>();
  for (const [identity, byHour] of Object.entries(rollups?.hours ?? {}))
    for (const [key, hour] of Object.entries(byHour)) {
      const time = Date.parse(key);
      if (!within(time) || !(hour.points > 0)) continue;
      const who = owner.get(identity) ?? identity;
      const row = hours.get(time) ?? new Map<string, number>();
      row.set(who, (row.get(who) ?? 0) + hour.points);
      hours.set(time, row);
    }
  const activeHours = [...hours.keys()].sort((a, b) => a - b);
  const known = (who: string) => accounts.some((a) => a.id === who);

  const found: LostItem[] = [];

  // Hourglass: the window that ran out soonest after it began.
  const fiveHourHits = (rollups?.hits ?? []).filter(
    (hit) => hit.kind === "five-hour" && within(Date.parse(hit.at)),
  );
  let hourglass: Extract<LostItem, { kind: "hourglass" }> | undefined;
  for (const hit of fiveHourHits) {
    if (!hit.resetAt) continue;
    const ms = Date.parse(hit.at) - (Date.parse(hit.resetAt) - FIVE_HOURS_MS);
    if (!(ms > 0 && ms <= HOURGLASS_MAX_MS)) continue;
    const minutes = Math.round(ms / MINUTE_MS);
    if (hourglass && minutes >= hourglass.minutes) continue;
    const accountId = owner.get(hit.identity);
    hourglass = {
      kind: "hourglass",
      at: hit.at,
      ...(accountId ? { accountId } : {}),
      minutes,
    };
  }
  if (hourglass) found.push(hourglass);

  // Boomerang: A, then B for a few minutes, then A again, all within the week.
  const segments = input.segments
    .map((segment) => ({
      account: desktopAccountFor(segment, accounts)?.id,
      from: Date.parse(segment.from),
      to: segment.to === undefined ? now : Date.parse(segment.to),
    }))
    .filter((s) => Number.isFinite(s.from) && Number.isFinite(s.to));
  let boomerang: Extract<LostItem, { kind: "boomerang" }> | undefined;
  for (let i = 0; i + 2 < segments.length; i++) {
    const [a, b, c] = [segments[i], segments[i + 1], segments[i + 2]];
    if (!a.account || !b.account || a.account === b.account) continue;
    if (c.account !== a.account || !within(b.from)) continue;
    const away = c.from - b.from;
    if (!(away > 0 && away <= BOOMERANG_MAX_MS)) continue;
    const minutes = Math.max(1, Math.round(away / MINUTE_MS));
    if (boomerang && minutes >= boomerang.minutes) continue;
    boomerang = {
      kind: "boomerang",
      at: isoAt(b.from),
      accountIds: [a.account, b.account],
      minutes,
    };
  }
  if (boomerang) found.push(boomerang);

  // Trophy: the week's busiest token day, when it is also the busiest of the last 30 days.
  const dayTotal = (date: string) =>
    Object.values(input.ledgerDays[date] ?? {}).reduce(
      (sum, byModel) =>
        sum +
        Object.values(byModel).reduce(
          (s, c) => s + c.input + c.output + c.cacheWrite + c.cacheRead,
          0,
        ),
      0,
    );
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const busiest = weekDays
    .map((date) => ({ date, tokens: dayTotal(date) }))
    .reduce<{ date: string; tokens: number } | undefined>(
      (best, day) => (day.tokens > (best?.tokens ?? 0) ? day : best),
      undefined,
    );
  if (busiest) {
    const window = Array.from({ length: TROPHY_DAYS }, (_, i) =>
      dayTotal(addDays(busiest.date, -i)),
    ).filter((tokens) => tokens > 0);
    const sorted = [...window].sort((a, b) => b - a);
    const ordinary = sorted[Math.floor(sorted.length / 2)];
    if (sorted.length >= 5 && sorted[0] === busiest.tokens && ordinary > 0)
      found.push({
        kind: "trophy",
        date: busiest.date,
        tokens: busiest.tokens,
        times: Math.round((busiest.tokens / ordinary) * 10) / 10,
      });
  }

  // Scroll: the longest run of active hours.
  let run = { from: 0, hours: 0 };
  let current = { from: 0, hours: 0 };
  activeHours.forEach((time, i) => {
    current =
      i > 0 && time - activeHours[i - 1] === HOUR_MS
        ? { from: current.from, hours: current.hours + 1 }
        : { from: time, hours: 1 };
    if (current.hours > run.hours) run = current;
  });
  if (run.hours >= SCROLL_MIN_HOURS)
    found.push({ kind: "scroll", at: isoAt(run.from), hours: run.hours });

  // Scarf: the day the most accounts took a turn, three at least.
  const byDay = new Map<string, Map<string, number>>();
  for (const time of activeHours) {
    const date = localDate(time, zone);
    const day = byDay.get(date) ?? new Map<string, number>();
    for (const [who, points] of hours.get(time)!)
      if (known(who)) day.set(who, (day.get(who) ?? 0) + points);
    byDay.set(date, day);
  }
  let scarf: Extract<LostItem, { kind: "scarf" }> | undefined;
  for (const [date, day] of [...byDay].sort(([a], [b]) => a.localeCompare(b)))
    if (day.size >= 3 && day.size > (scarf?.accountIds.length ?? 0))
      scarf = {
        kind: "scarf",
        date,
        accountIds: [...day].sort((a, b) => b[1] - a[1]).map(([who]) => who),
      };
  if (scarf) found.push(scarf);

  // Clocks: two accounts' five-hour windows resetting close together.
  const resets = Object.entries(rollups?.windows ?? {})
    .flatMap(([identity, windows]) =>
      windows.map((w) => ({
        who: owner.get(identity),
        time: Date.parse(w.resetAt),
      })),
    )
    .filter(
      (r): r is { who: string; time: number } =>
        r.who !== undefined && within(r.time),
    )
    .sort((a, b) => a.time - b.time);
  const pairs: { a: (typeof resets)[number]; b: (typeof resets)[number] }[] =
    [];
  resets.forEach((a, i) => {
    const b = resets[i + 1];
    if (b && b.who !== a.who && b.time - a.time <= CLOCKS_MAX_GAP_MS)
      pairs.push({ a, b });
  });
  if (pairs.length) {
    const closest = pairs.reduce((best, pair) =>
      pair.b.time - pair.a.time < best.b.time - best.a.time ? pair : best,
    );
    found.push({
      kind: "clocks",
      at: isoAt(closest.a.time),
      accountIds: [closest.a.who, closest.b.who],
      gapMinutes: Math.round((closest.b.time - closest.a.time) / MINUTE_MS),
      count: pairs.length,
    });
  }

  // Spare: accounts never used while the others ran into five-hour limits.
  if (fiveHourHits.length) {
    const used = new Set(
      activeHours.flatMap((time) => [...hours.get(time)!.keys()]),
    );
    const idle = accounts
      .filter((a) => historyIdentity(a) && !used.has(a.id))
      .map((a) => a.id);
    if (idle.length && used.size)
      found.push({
        kind: "spare",
        accountIds: idle,
        hits: fiveHourHits.length,
      });
  }

  // Feather: hours after midnight; the latest is the one nearest morning.
  const night = activeHours.filter(
    (time) => localHour(time, zone) < NIGHT_END_HOUR,
  );
  if (night.length) {
    const latest = night.reduce((best, time) =>
      localHour(time, zone) >= localHour(best, zone) ? time : best,
    );
    found.push({ kind: "feather", at: isoAt(latest), hours: night.length });
  }

  const rank = (kind: LostItemKind) => LOST_ITEM_KINDS.indexOf(kind);
  found.sort((a, b) => rank(a.kind) - rank(b.kind));
  return { start, end, latest, oldest, items: found };
}
