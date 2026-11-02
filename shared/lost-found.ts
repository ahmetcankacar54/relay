// The panda's lost-and-found: what a week of use left behind
// (docs/superpowers/specs/2026-10-19-lost-found-design.md). Every item is a real moment of that week,
// found in the usage rollups, the active-account timeline and the token ledger; nothing here is a
// constant dressed up as a joke.
import { desktopAccountFor } from "./desktop-account";
import { PLAN_PRICES } from "./plan-prices";
import { localDate, localHour, localSlot, wallTime } from "./planning";
import type { Account } from "./types";
import { sameReset, type UsageRollups } from "./usage-rollups";
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
/** It is compared with at least this many other active days… */
export const TROPHY_MIN_DAYS = 5;
/** …and is at least this many times an ordinary one. */
export const TROPHY_MIN_TIMES = 1.5;
/** The baton is handed on when another account takes over this soon after a limit hit. */
export const BATON_MAX_MS = 30 * MINUTE_MS;
/** …or this little before it: the hit is recorded at the poll that saw it, after the switch. */
export const BATON_EARLY_MS = 2 * MINUTE_MS;
/** A compass week has at least this many active hours and no limit hit. */
export const COMPASS_MIN_HOURS = 20;
/** Morning hours run from the end of the night to this local hour. */
export const MORNING_END_HOUR = 8;
/** A window that came this full without a limit hit walked the tightrope. */
export const TIGHTROPE_MIN_PERCENT = 95;
/** A weekend watch is at least this many active hours over Saturday and Sunday. */
export const LANTERN_MIN_HOURS = 6;
/** A rest day counts in a week with at least this many active days. */
export const HAMMOCK_MIN_DAYS = 4;
/** The scales weigh a week of at least this many active hours… */
export const SCALES_MIN_HOURS = 10;
/** …whose accounts' shares are at most this many points apart. */
export const SCALES_MAX_SPREAD = 15;
/** A treasure week is compared with at least this many earlier weeks of API value… */
export const CHEST_MIN_WEEKS = 4;
/** …and is at least this many times an ordinary one. */
export const CHEST_MIN_TIMES = 1.2;
/** A model family joins the fan with at least this share of the week's tokens. */
export const FAN_MIN_SHARE = 0.01;
/** How many weeks back the bureau can look: the rollups keep 90 days. */
export const LOST_FOUND_WEEKS = 12;

/** The items, most striking first: the first one found is the week's featured item. */
export const LOST_ITEM_KINDS = [
  "hourglass",
  "baton",
  "piggy",
  "chest",
  "boomerang",
  "trophy",
  "tightrope",
  "scroll",
  "tally",
  "compass",
  "scales",
  "scarf",
  "fan",
  "clocks",
  "spare",
  "lantern",
  "hammock",
  "feather",
  "teaglass",
] as const;
export type LostItemKind = (typeof LOST_ITEM_KINDS)[number];

/** Items the collection keeps secret until found once: they are surprises, not goals. */
export const SECRET_LOST_KINDS: readonly LostItemKind[] = [
  "boomerang",
  "clocks",
  "tightrope",
];

/** A pin's finish: how many weeks it was found in. */
export const LOST_TIERS = [
  { tier: "bronze", weeks: 1 },
  { tier: "silver", weeks: 3 },
  { tier: "gold", weeks: 6 },
] as const;
export type LostTier = (typeof LOST_TIERS)[number]["tier"];

/** The finish `weeks` finds earn, or undefined before the first. */
export function tierOf(weeks: number): LostTier | undefined {
  let tier: LostTier | undefined;
  for (const step of LOST_TIERS) if (weeks >= step.weeks) tier = step.tier;
  return tier;
}

/** The next finish and the weeks it needs, or undefined at gold. */
export function nextTier(weeks: number) {
  return LOST_TIERS.find((step) => weeks < step.weeks);
}

/** What a moment used: tokens and their API value in USD, from the token ledger. */
export interface LostSpend {
  tokens: number;
  cost: number;
}

/** A find, with what it used when the token ledger can tell. */
export type LostItem = LostMoment & { spend?: LostSpend };

export type LostMoment =
  /** A five-hour window ran out `minutes` after it began; `at` is when it ran out. */
  | { kind: "hourglass"; at: string; accountId?: string; minutes: number }
  /** Left `accountIds[0]` for `accountIds[1]` at `at` and came back `minutes` later. */
  | {
      kind: "boomerang";
      at: string;
      accountIds: [string, string];
      minutes: number;
    }
  /**
   * `accountIds[0]` hit a limit and `accountIds[1]` took over `minutes` after it at `at`; `count` such
   * hand-overs that week.
   */
  | {
      kind: "baton";
      at: string;
      accountIds: [string, string];
      minutes: number;
      count: number;
    }
  /** `date` was the busiest of the last 30 days, `times` an ordinary active day of them. */
  | { kind: "trophy"; date: string; tokens: number; times: number }
  /** `hours` active hours in a row from `at`. */
  | { kind: "scroll"; at: string; hours: number }
  /** Every day of the week had active hours, `hours` in all. */
  | { kind: "tally"; hours: number }
  /** `hours` active hours and not one limit hit. */
  | { kind: "compass"; hours: number }
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
  | { kind: "feather"; at: string; hours: number }
  /** `hours` active hours early in the morning; the earliest began at `at`. */
  | { kind: "teaglass"; at: string; hours: number }
  /** A five-hour window that reset at `at` came `percent` full without a limit hit. */
  | { kind: "tightrope"; at: string; accountId?: string; percent: number }
  /** `hours` active hours over Saturday and Sunday. */
  | { kind: "lantern"; hours: number }
  /** Nothing was done on `date`, between active days, in a week of `activeDays`. */
  | { kind: "hammock"; date: string; activeDays: number }
  /** `accountIds` (busiest first) shared the week's work, from `low` to `high` percent each. */
  | { kind: "scales"; accountIds: string[]; low: number; high: number }
  /** The week's API value was the highest of the weeks before it, `times` an ordinary one. */
  | { kind: "chest"; cost: number; tokens: number; times: number }
  /** `accountId`'s API value that week, `cost`, paid for its plan's month, `price`. */
  | { kind: "piggy"; accountId: string; cost: number; price: number }
  /** Model families used that week, largest first. */
  | { kind: "fan"; families: string[] };

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
  /** Token ledger days: date → who → model → counts and their API value. */
  ledgerDays: Record<string, Record<string, Record<string, LedgerCounts>>>;
  /** Token ledger quarter hours of the last days: date → who → quarter (0–95) → counts. */
  ledgerSlots?: Record<string, Record<string, Record<string, LedgerCounts>>>;
  /** When the ledger began to keep quarter hours; earlier responses of those days have none. */
  slotsSince?: number;
  accounts: Account[];
  zone: string;
  now: number;
  /** A Monday; the newest complete week when missing or out of reach. */
  weekStart?: string;
}

interface LedgerCounts {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  cost?: number;
}

const tokensIn = (c: LedgerCounts) =>
  c.input + c.output + c.cacheWrite + c.cacheRead;

/** The account a ledger `who` belongs to: `acct:<id>` or `est:<id>`. */
const ledgerAccount = (who: string) => /^(acct|est):(.+)$/.exec(who)?.[2];

/** A model id's family, as people name it: "Opus", "Sonnet", "Haiku", "Fable". */
export function modelFamily(model: string): string | undefined {
  const match = /(opus|sonnet|haiku|fable)/i.exec(model)?.[1];
  return match && match[0].toUpperCase() + match.slice(1).toLowerCase();
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

/** The rollup identity → account id map, as the statistics read it: one owner per identity. */
function identityAccounts(accounts: Account[]) {
  const map = new Map<string, string>();
  for (const [identity, account] of identityOwners(accounts))
    map.set(identity, account.id);
  return map;
}

/** Whether a stored item has what its kind needs to be told; a shelf from another version may not. */
export function validLostItem(value: unknown): value is LostItem {
  const item = value as Record<string, unknown> | null;
  if (!item || !LOST_ITEM_KINDS.includes(item.kind as LostItemKind))
    return false;
  const time = (key: string) =>
    typeof item[key] === "string" &&
    Number.isFinite(Date.parse(item[key] as string));
  const date = (key: string) =>
    typeof item[key] === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(item[key] as string);
  const count = (key: string) =>
    typeof item[key] === "number" && Number.isFinite(item[key]);
  const ids = (key: string) =>
    Array.isArray(item[key]) &&
    (item[key] as unknown[]).every((id) => typeof id === "string");
  const spend = item.spend as Record<string, unknown> | undefined;
  if (
    spend !== undefined &&
    !(
      typeof spend === "object" &&
      Number.isFinite(spend?.tokens) &&
      Number.isFinite(spend?.cost)
    )
  )
    return false;
  switch (item.kind as LostItemKind) {
    case "hourglass":
      return time("at") && count("minutes");
    case "tightrope":
      return time("at") && count("percent");
    case "lantern":
      return count("hours");
    case "hammock":
      return date("date") && count("activeDays");
    case "scales":
      return ids("accountIds") && count("low") && count("high");
    case "chest":
      return count("cost") && count("tokens") && count("times");
    case "piggy":
      return (
        typeof item.accountId === "string" && count("cost") && count("price")
      );
    case "fan":
      return ids("families");
    case "boomerang":
      return time("at") && ids("accountIds") && count("minutes");
    case "baton":
      return (
        time("at") && ids("accountIds") && count("minutes") && count("count")
      );
    case "tally":
    case "compass":
      return count("hours");
    case "trophy":
      return date("date") && count("tokens") && count("times");
    case "scroll":
    case "feather":
    case "teaglass":
      return time("at") && count("hours");
    case "scarf":
      return date("date") && ids("accountIds");
    case "clocks":
      return (
        time("at") && ids("accountIds") && count("gapMinutes") && count("count")
      );
    case "spare":
      return ids("accountIds") && count("hits");
  }
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
  // An hour bucket starts on the UTC hour; its middle decides its local day and hour, so a zone half
  // an hour off UTC puts each bucket where most of it lies.
  const middle = (hour: number) => hour + 30 * MINUTE_MS;
  const owner = identityAccounts(accounts);
  const rollups = input.rollups;

  // Active hours: UTC hour start → account id (or identity, for a former account) → points.
  const hours = new Map<number, Map<string, number>>();
  for (const [identity, byHour] of Object.entries(rollups?.hours ?? {}))
    for (const [key, hour] of Object.entries(byHour)) {
      const time = Date.parse(key);
      if (!within(middle(time)) || !(hour.points > 0)) continue;
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

  // Boomerang: A, then B for a few minutes, then A again, all within the week. Each hand-over is a
  // switch, so B starts soon after A ends: after a gap (Relay or the Claude app closed) B's stay is unknown.
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
    if (!(b.from - a.to <= BOOMERANG_MAX_MS)) continue;
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

  // Baton: an account hit a limit and the next one took over at once. The account in the Claude app
  // when the limit hit hands over to another, without a gap between them.
  let baton: Extract<LostItem, { kind: "baton" }> | undefined;
  // A switch answers one hit: a five-hour and a weekly limit seen by the same poll hand over once.
  const handOvers = new Set<number>();
  for (const hit of rollups?.hits ?? []) {
    const at = Date.parse(hit.at);
    const giver = owner.get(hit.identity);
    if (!giver || !within(at)) continue;
    const next = segments.findIndex(
      (s, i) =>
        i > 0 &&
        segments[i - 1].account === giver &&
        s.account !== undefined &&
        s.account !== giver &&
        s.from >= at - BATON_EARLY_MS &&
        s.from <= at + BATON_MAX_MS &&
        s.from - segments[i - 1].to <= BOOMERANG_MAX_MS,
    );
    if (next < 0 || handOvers.has(next)) continue;
    handOvers.add(next);
    const minutes = Math.max(
      0,
      Math.round((segments[next].from - at) / MINUTE_MS),
    );
    if (baton && minutes >= baton.minutes) continue;
    baton = {
      kind: "baton",
      at: isoAt(segments[next].from),
      accountIds: [giver, segments[next].account!],
      minutes,
      count: 0,
    };
  }
  if (baton) found.push({ ...baton, count: handOvers.size });

  // Trophy: the week's busiest token day, when it is also the busiest of the last 30 days, clearly
  // ahead of an ordinary one, compared with at least five other active days.
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
    const times = ordinary > 0 ? busiest.tokens / ordinary : 0;
    if (
      sorted.length >= TROPHY_MIN_DAYS + 1 &&
      sorted[0] === busiest.tokens &&
      times >= TROPHY_MIN_TIMES
    )
      found.push({
        kind: "trophy",
        date: busiest.date,
        tokens: busiest.tokens,
        times: Math.round(times * 10) / 10,
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
    const date = localDate(middle(time), zone);
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

  // Tally: every day of the week had active hours, one notch a day.
  if (weekDays.every((date) => byDay.has(date)))
    found.push({ kind: "tally", hours: activeHours.length });

  // Compass: a full week of work that never ran into a limit, nor started inside one.
  const blocked = (rollups?.hits ?? []).some((hit) => {
    const at = Date.parse(hit.at);
    const until = hit.until ? Date.parse(hit.until) : at;
    return within(at) || (at < from && until > from);
  });
  if (activeHours.length >= COMPASS_MIN_HOURS && !blocked)
    found.push({ kind: "compass", hours: activeHours.length });

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
  // Every pair of two accounts' resets within the gap, not only neighbours.
  const pairs: { a: (typeof resets)[number]; b: (typeof resets)[number] }[] =
    [];
  resets.forEach((a, i) => {
    for (let j = i + 1; j < resets.length; j++) {
      const b = resets[j];
      if (b.time - a.time > CLOCKS_MAX_GAP_MS) break;
      if (b.who !== a.who) pairs.push({ a, b });
    }
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

  // Spare: accounts never used while the others ran into five-hour limits. Only an account that
  // already existed when the week began, and owns its usage identity, can have sat it out.
  if (fiveHourHits.length) {
    const used = new Set(
      activeHours.flatMap((time) => [...hours.get(time)!.keys()]),
    );
    const idle = accounts
      .filter((a) => {
        const identity = historyIdentity(a);
        return (
          identity !== undefined &&
          owner.get(identity) === a.id &&
          Date.parse(a.createdAt) < from &&
          !used.has(a.id)
        );
      })
      .map((a) => a.id);
    if (idle.length && used.size)
      found.push({
        kind: "spare",
        accountIds: idle,
        hits: fiveHourHits.length,
      });
  }

  // Feather: hours after midnight; the latest is the one nearest morning.
  const nightHour = (time: number) => localHour(middle(time), zone);
  const night = activeHours.filter((time) => nightHour(time) < NIGHT_END_HOUR);
  if (night.length) {
    const latest = night.reduce((best, time) =>
      nightHour(time) >= nightHour(best) ? time : best,
    );
    found.push({ kind: "feather", at: isoAt(latest), hours: night.length });
  }

  // Tea glass: hours after the night and before eight; the earliest is the one nearest dawn.
  const morning = activeHours.filter((time) => {
    const hour = nightHour(time);
    return hour >= NIGHT_END_HOUR && hour < MORNING_END_HOUR;
  });
  if (morning.length) {
    const earliest = morning.reduce((best, time) =>
      nightHour(time) < nightHour(best) ? time : best,
    );
    found.push({
      kind: "teaglass",
      at: isoAt(earliest),
      hours: morning.length,
    });
  }

  // What the token ledger says each moment used. Days are kept whole; quarter hours only for the last days,
  // so a moment within hours is told only when every one of its quarters was kept.
  const daySpend = (date: string): LostSpend => {
    let tokens = 0;
    let cost = 0;
    for (const byModel of Object.values(input.ledgerDays[date] ?? {}))
      for (const counts of Object.values(byModel)) {
        tokens += tokensIn(counts);
        cost += counts.cost ?? 0;
      }
    return { tokens, cost };
  };
  const sumSpend = (list: LostSpend[]) =>
    list.reduce(
      (sum, spend) => ({
        tokens: sum.tokens + spend.tokens,
        cost: sum.cost + spend.cost,
      }),
      { tokens: 0, cost: 0 },
    );
  const weekSpend = (monday: string) =>
    sumSpend(Array.from({ length: 7 }, (_, i) => daySpend(addDays(monday, i))));
  const quarterSpend = (quarters: number[]): LostSpend | undefined => {
    const slots = input.ledgerSlots;
    const since = input.slotsSince;
    if (!slots || since === undefined || !quarters.length) return undefined;
    const seen = new Set<string>();
    let tokens = 0;
    let cost = 0;
    for (const time of quarters) {
      if (time < since) return undefined;
      const date = localDate(time, zone);
      const byWho = slots[date];
      // A day without kept quarters is only known when it used nothing at all.
      if (!byWho) {
        if (daySpend(date).tokens > 0) return undefined;
        continue;
      }
      const slot = String(localSlot(time, zone));
      if (seen.has(`${date}|${slot}`)) continue;
      seen.add(`${date}|${slot}`);
      for (const bySlot of Object.values(byWho)) {
        const counts = bySlot[slot];
        if (!counts) continue;
        tokens += tokensIn(counts);
        cost += counts.cost ?? 0;
      }
    }
    return { tokens, cost };
  };
  const QUARTER_MS = 15 * MINUTE_MS;
  const hourQuarters = (starts: number[]) =>
    starts.flatMap((hour) => [0, 1, 2, 3].map((q) => hour + q * QUARTER_MS));
  const spanQuarters = (fromTime: number, toTime: number) => {
    const quarters: number[] = [];
    for (
      let time = Math.floor(fromTime / QUARTER_MS) * QUARTER_MS;
      time < toTime;
      time += QUARTER_MS
    )
      quarters.push(time);
    return quarters;
  };
  const round2 = (n: number) => Math.round(n * 100) / 100;

  // Tightrope: the fullest five-hour window that never hit its limit.
  let tightrope: Extract<LostItem, { kind: "tightrope" }> | undefined;
  for (const [identity, windows] of Object.entries(rollups?.windows ?? {}))
    for (const window of windows) {
      const reset = Date.parse(window.resetAt);
      if (
        !within(reset) ||
        !(window.maxPercent >= TIGHTROPE_MIN_PERCENT) ||
        window.maxPercent >= 100
      )
        continue;
      const hit = (rollups?.hits ?? []).some(
        (h) =>
          h.identity === identity &&
          h.kind === "five-hour" &&
          h.resetAt !== undefined &&
          sameReset(h.resetAt, window.resetAt),
      );
      const percent = Math.floor(window.maxPercent);
      if (hit || (tightrope && percent <= tightrope.percent)) continue;
      const accountId = owner.get(identity);
      tightrope = {
        kind: "tightrope",
        at: isoAt(reset),
        ...(accountId ? { accountId } : {}),
        percent,
      };
    }
  if (tightrope) found.push(tightrope);

  // Lantern: active on both days of the weekend, for some hours.
  const weekend = activeHours.filter((time) => {
    const date = localDate(middle(time), zone);
    return date === weekDays[5] || date === weekDays[6];
  });
  const weekendDays = new Set(
    weekend.map((time) => localDate(middle(time), zone)),
  );
  if (weekendDays.size === 2 && weekend.length >= LANTERN_MIN_HOURS)
    found.push({ kind: "lantern", hours: weekend.length });

  // Hammock: a working day off between two active days, in a busy week.
  const active = weekDays.map((date) => byDay.has(date));
  const activeDays = active.filter(Boolean).length;
  if (activeDays >= HAMMOCK_MIN_DAYS) {
    const rest = [1, 2, 3, 4].find(
      (i) => !active[i] && active[i - 1] && active[i + 1],
    );
    if (rest !== undefined)
      found.push({ kind: "hammock", date: weekDays[rest], activeDays });
  }

  // Scales: two or more accounts carried nearly equal shares of the week.
  const shares = new Map<string, number>();
  for (const row of hours.values())
    for (const [who, points] of row)
      if (known(who)) shares.set(who, (shares.get(who) ?? 0) + points);
  const shareTotal = [...shares.values()].reduce((a, b) => a + b, 0);
  if (
    shares.size >= 2 &&
    activeHours.length >= SCALES_MIN_HOURS &&
    shareTotal > 0
  ) {
    const percents = [...shares]
      .map(([who, points]) => ({ who, percent: (points / shareTotal) * 100 }))
      .sort((a, b) => b.percent - a.percent);
    const high = Math.round(percents[0].percent);
    const low = Math.round(percents[percents.length - 1].percent);
    if (high - low <= SCALES_MAX_SPREAD)
      found.push({
        kind: "scales",
        accountIds: percents.map((p) => p.who),
        low,
        high,
      });
  }

  // Chest: the week's API value beat every earlier week in reach, clearly ahead of an ordinary one.
  const thisWeek = weekSpend(start);
  if (thisWeek.cost > 0) {
    const earlier = Array.from(
      { length: LOST_FOUND_WEEKS - 1 },
      (_, i) => weekSpend(addDays(start, -7 * (i + 1))).cost,
    ).filter((cost) => cost > 0);
    const sorted = [...earlier].sort((a, b) => a - b);
    const ordinary = sorted[Math.floor(sorted.length / 2)];
    const times = ordinary > 0 ? thisWeek.cost / ordinary : 0;
    if (
      earlier.length >= CHEST_MIN_WEEKS &&
      thisWeek.cost > Math.max(...earlier) &&
      times >= CHEST_MIN_TIMES
    )
      found.push({
        kind: "chest",
        cost: round2(thisWeek.cost),
        tokens: thisWeek.tokens,
        times: Math.round(times * 10) / 10,
      });
  }

  // Piggy bank: an account's API value that week paid for its plan's month; the best paid back is shown.
  const accountCost = new Map<string, number>();
  for (const date of weekDays)
    for (const [who, byModel] of Object.entries(input.ledgerDays[date] ?? {})) {
      const id = ledgerAccount(who);
      if (!id) continue;
      for (const counts of Object.values(byModel))
        accountCost.set(id, (accountCost.get(id) ?? 0) + (counts.cost ?? 0));
    }
  let piggy: Extract<LostItem, { kind: "piggy" }> | undefined;
  for (const [id, cost] of accountCost) {
    const plan = accounts.find((a) => a.id === id)?.planning?.plan;
    const price = plan ? PLAN_PRICES[plan] : undefined;
    if (!price || cost < price) continue;
    if (piggy && cost / price <= piggy.cost / piggy.price) continue;
    piggy = { kind: "piggy", accountId: id, cost: round2(cost), price };
  }
  if (piggy) found.push(piggy);

  // Fan: three or more model families each did a real share of the week's tokens.
  const families = new Map<string, number>();
  let weekTokens = 0;
  for (const date of weekDays)
    for (const byModel of Object.values(input.ledgerDays[date] ?? {}))
      for (const [model, counts] of Object.entries(byModel)) {
        const tokens = tokensIn(counts);
        weekTokens += tokens;
        const family = modelFamily(model);
        if (family) families.set(family, (families.get(family) ?? 0) + tokens);
      }
  const fan = [...families]
    .filter(
      ([, tokens]) => weekTokens > 0 && tokens / weekTokens >= FAN_MIN_SHARE,
    )
    .sort((a, b) => b[1] - a[1])
    .map(([family]) => family);
  if (fan.length >= 3) found.push({ kind: "fan", families: fan });

  const spendOf = (item: LostItem): LostSpend | undefined => {
    switch (item.kind) {
      case "hourglass": {
        const at = Date.parse(item.at);
        return quarterSpend(spanQuarters(at - item.minutes * MINUTE_MS, at));
      }
      case "scroll":
        return quarterSpend(
          hourQuarters(
            Array.from(
              { length: item.hours },
              (_, i) => Date.parse(item.at) + i * HOUR_MS,
            ),
          ),
        );
      case "feather":
        return quarterSpend(hourQuarters(night));
      case "teaglass":
        return quarterSpend(hourQuarters(morning));
      case "lantern":
        return sumSpend([daySpend(weekDays[5]), daySpend(weekDays[6])]);
      case "trophy":
      case "scarf":
        return daySpend(item.date);
      case "tally":
      case "compass":
      case "scales":
        return thisWeek;
      default:
        return undefined;
    }
  };
  const items = found.map((item): LostItem => {
    const spend = spendOf(item);
    return spend && spend.tokens > 0
      ? { ...item, spend: { tokens: spend.tokens, cost: round2(spend.cost) } }
      : item;
  });

  const rank = (kind: LostItemKind) => LOST_ITEM_KINDS.indexOf(kind);
  items.sort((a, b) => rank(a.kind) - rank(b.kind));
  return { start, end, latest, oldest, items };
}

/** One find: the week it was found in and what happened. */
export interface LostFind {
  /** The week's Monday. */
  start: string;
  /** Its Sunday. */
  end: string;
  item: LostItem;
}

export interface LostFoundCollection {
  /** Monday of the newest complete week. */
  latest: string;
  /** Monday of the oldest week in reach. */
  oldest: string;
  /** Each kind's finds within reach, newest first; a kind never found is missing. */
  found: Partial<Record<LostItemKind, LostFind[]>>;
}

/** What every week within reach left behind, by kind: the collection's view of the bureau. */
export function lostFoundCollection(
  input: Omit<LostFoundInput, "weekStart">,
): LostFoundCollection {
  const newest = lostFoundWeek(input);
  const found: Partial<Record<LostItemKind, LostFind[]>> = {};
  for (let start = newest.latest; start >= newest.oldest;) {
    const week =
      start === newest.start
        ? newest
        : lostFoundWeek({ ...input, weekStart: start });
    for (const item of week.items)
      (found[item.kind] ??= []).push({
        start: week.start,
        end: week.end,
        item,
      });
    start = addDays(start, -7);
  }
  return { latest: newest.latest, oldest: newest.oldest, found };
}
