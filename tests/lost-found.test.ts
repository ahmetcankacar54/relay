import test from "node:test";
import assert from "node:assert/strict";
import {
  LOST_ITEM_KINDS,
  lostFoundCollection,
  lostFoundWeek,
  mondayOf,
  addDays,
  nextTier,
  tierOf,
  validLostItem,
  type LostFoundInput,
} from "../shared/lost-found";
import type { Account } from "../shared/types";
import type { UsageRollups } from "../shared/usage-rollups";

// Monday 19 October 2026, 13:00 in Istanbul (UTC+3): the newest complete week is 12–18 October,
// which runs from 11 October 21:00 UTC to 18 October 21:00 UTC.
const NOW = Date.parse("2026-10-19T10:00:00Z");
const ZONE = "Europe/Istanbul";
const H = 3_600_000;
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
/** UTC time on a day of October 2026. */
const oct = (day: number, hour: number, minute = 0) => Date.UTC(2026, 9, day, hour, minute);

const account = (id: string, n: number): Account => ({
  id,
  name: id.toUpperCase(),
  kind: "personal",
  group: "personal",
  color: "olive",
  createdAt: "2026-09-01T00:00:00.000Z",
  auth: { loggedIn: true, accountUuid: `uuid-${n}`, orgId: `org-${n}` },
  desktop: { accountUuid: `uuid-${n}`, orgId: `org-${n}`, savedAt: iso(NOW) },
} as Account);
const A = account("a", 1);
const B = account("b", 2);
const C = account("c", 3);
const accounts = [A, B, C];
const identity = (n: number) => JSON.stringify(["uuid", `uuid-${n}`, `org-${n}`]);

function rollups(parts: Partial<UsageRollups> = {}): UsageRollups {
  return { version: 2, hours: {}, windows: {}, hits: [], last: {}, ...parts };
}
/** Active hours for account `n`, each with one point. */
const active = (n: number, ...hours: number[]) => ({
  [identity(n)]: Object.fromEntries(hours.map((t) => [iso(t), { points: 1, windows: 1, coveredMinutes: 60 }])),
});
const input = (parts: Partial<LostFoundInput> = {}): LostFoundInput => ({
  rollups: rollups(),
  segments: [],
  ledgerDays: {},
  accounts,
  zone: ZONE,
  now: NOW,
  ...parts,
});
const kinds = (week: ReturnType<typeof lostFoundWeek>) => week.items.map((item) => item.kind);
const itemOf = <K extends string>(week: ReturnType<typeof lostFoundWeek>, kind: K) =>
  week.items.find((item) => item.kind === kind) as Extract<ReturnType<typeof lostFoundWeek>["items"][number], { kind: K }> | undefined;

test("Mondays and day arithmetic", () => {
  assert.equal(mondayOf("2026-10-14"), "2026-10-12");
  assert.equal(mondayOf("2026-10-12"), "2026-10-12");
  assert.equal(mondayOf("2026-10-18"), "2026-10-12");
  assert.equal(addDays("2026-10-30", 3), "2026-11-02");
});

test("the bureau opens the newest complete week, any Monday of the last twelve weeks, and nothing else", () => {
  const week = lostFoundWeek(input());
  assert.deepEqual(
    { start: week.start, end: week.end, latest: week.latest, oldest: week.oldest },
    { start: "2026-10-12", end: "2026-10-18", latest: "2026-10-12", oldest: "2026-07-27" },
  );
  assert.equal(lostFoundWeek(input({ weekStart: "2026-10-14" })).start, "2026-10-12");
  assert.equal(lostFoundWeek(input({ weekStart: "2026-10-05" })).start, "2026-10-05");
  assert.equal(lostFoundWeek(input({ weekStart: "2026-07-27" })).start, "2026-07-27");
  // The running week is not complete, and older weeks are out of reach: both open the newest.
  assert.equal(lostFoundWeek(input({ weekStart: "2026-10-19" })).start, "2026-10-12");
  assert.equal(lostFoundWeek(input({ weekStart: "2026-07-20" })).start, "2026-10-12");
  assert.deepEqual(week.items, []);
});

test("hourglass: the five-hour window that ran out soonest after it began, within two and a half hours", () => {
  const hit = (n: number, startedAt: number, minutes: number, kind: "five-hour" | "weekly" = "five-hour") => ({
    identity: identity(n),
    kind,
    at: iso(startedAt + minutes * MIN),
    resetAt: iso(startedAt + 5 * H),
  });
  const week = lostFoundWeek(input({
    rollups: rollups({
      hits: [
        hit(1, oct(13, 6), 120),
        hit(2, oct(14, 6), 66),
        hit(3, oct(15, 6), 30, "weekly"),
        hit(3, oct(16, 6), 151),
        // Outside the week.
        hit(1, oct(10, 6), 10),
      ],
    }),
  }));
  assert.deepEqual(itemOf(week, "hourglass"), {
    kind: "hourglass",
    at: iso(oct(14, 6) + 66 * MIN),
    accountId: "b",
    minutes: 66,
  });
  assert.equal(lostFoundWeek(input({ rollups: rollups({ hits: [hit(1, oct(13, 6), 151)] }) })).items.length, 0);
});

test("boomerang: off to another account and back within fifteen minutes", () => {
  const seg = (n: number, from: number, to?: number) => ({
    accountUuid: `uuid-${n}`,
    orgId: `org-${n}`,
    from: iso(from),
    ...(to === undefined ? {} : { to: iso(to) }),
  });
  const segments = [
    seg(1, oct(14, 9), oct(14, 11, 10)),
    seg(2, oct(14, 11, 10), oct(14, 11, 18)),
    seg(1, oct(14, 11, 18), oct(14, 18)),
  ];
  assert.deepEqual(itemOf(lostFoundWeek(input({ segments })), "boomerang"), {
    kind: "boomerang",
    at: iso(oct(14, 11, 10)),
    accountIds: ["a", "b"],
    minutes: 8,
  });
  const long = [segments[0], seg(2, oct(14, 11, 10), oct(14, 11, 26)), seg(1, oct(14, 11, 26))];
  assert.equal(itemOf(lostFoundWeek(input({ segments: long })), "boomerang"), undefined);
  // An account Relay does not know cannot be the place you went.
  const unknown = [segments[0], { ...segments[1], accountUuid: "uuid-9" }, segments[2]];
  assert.equal(itemOf(lostFoundWeek(input({ segments: unknown })), "boomerang"), undefined);
  // After a gap (Relay or the Claude app closed), how long B lasted is unknown: no boomerang.
  const gap = [seg(1, oct(1, 9), oct(1, 10)), seg(2, oct(14, 11, 10), oct(14, 11, 15)), seg(1, oct(14, 11, 16))];
  assert.equal(itemOf(lostFoundWeek(input({ segments: gap })), "boomerang"), undefined);
});

test("trophy: the week's busiest token day, when it is also the busiest of the last 30 days", () => {
  const day = (tokens: number) => ({ "acct:a": { model: { input: tokens, output: 0, cacheWrite: 0, cacheRead: 0 } } });
  const ledgerDays: LostFoundInput["ledgerDays"] = {};
  for (let i = 1; i <= 9; i++) ledgerDays[addDays("2026-10-14", -i)] = day(100);
  ledgerDays["2026-10-14"] = day(430);
  ledgerDays["2026-10-15"] = day(200);
  assert.deepEqual(itemOf(lostFoundWeek(input({ ledgerDays })), "trophy"), {
    kind: "trophy",
    date: "2026-10-14",
    tokens: 430,
    times: 4.3,
  });
  // A busier day within the 30 days takes the record away.
  ledgerDays["2026-09-20"] = day(500);
  assert.equal(itemOf(lostFoundWeek(input({ ledgerDays })), "trophy"), undefined);
  // So does having fewer than five other active days to compare with…
  const few: LostFoundInput["ledgerDays"] = { "2026-10-14": day(430) };
  for (let i = 1; i <= 4; i++) few[addDays("2026-10-14", -i)] = day(100);
  assert.equal(itemOf(lostFoundWeek(input({ ledgerDays: few })), "trophy"), undefined);
  // …and a day barely ahead of an ordinary one.
  const close: LostFoundInput["ledgerDays"] = { "2026-10-14": day(140) };
  for (let i = 1; i <= 9; i++) close[addDays("2026-10-14", -i)] = day(100);
  assert.equal(itemOf(lostFoundWeek(input({ ledgerDays: close })), "trophy"), undefined);
});

test("scroll: eight active hours in a row, any account; seven are not enough", () => {
  const eight = Array.from({ length: 8 }, (_, i) => oct(16, 8 + i));
  const week = lostFoundWeek(input({
    rollups: rollups({ hours: { ...active(1, ...eight.slice(0, 4)), ...active(2, ...eight.slice(4)) } }),
  }));
  assert.deepEqual(itemOf(week, "scroll"), { kind: "scroll", at: iso(oct(16, 8)), hours: 8 });
  const seven = lostFoundWeek(input({ rollups: rollups({ hours: active(1, ...eight.slice(1)) }) }));
  assert.equal(itemOf(seven, "scroll"), undefined);
});

test("scarf: three accounts on one local day, busiest first; a local day starts at 21:00 UTC", () => {
  const hours = {
    // 13 October 21:00 UTC is 14 October 00:00 in Istanbul.
    ...active(1, oct(13, 21)),
    [identity(2)]: {
      [iso(oct(14, 9))]: { points: 3, windows: 1, coveredMinutes: 60 },
    },
    ...active(3, oct(14, 12)),
  };
  assert.deepEqual(itemOf(lostFoundWeek(input({ rollups: rollups({ hours }) })), "scarf"), {
    kind: "scarf",
    date: "2026-10-14",
    accountIds: ["b", "a", "c"],
  });
  const two = { ...active(1, oct(14, 9)), ...active(2, oct(14, 10)) };
  assert.equal(itemOf(lostFoundWeek(input({ rollups: rollups({ hours: two }) })), "scarf"), undefined);
});

test("clocks: two accounts' windows resetting within ten minutes; the closest pair is shown, all are counted", () => {
  const window = (time: number) => ({ resetAt: iso(time), maxPercent: 50 });
  const week = lostFoundWeek(input({
    rollups: rollups({
      windows: {
        [identity(1)]: [window(oct(14, 14, 10)), window(oct(16, 9))],
        [identity(2)]: [window(oct(14, 14, 15)), window(oct(16, 9))],
        // Eleven minutes apart: not a pair.
        [identity(3)]: [window(oct(15, 8)), window(oct(15, 8, 11))],
      },
    }),
  }));
  assert.deepEqual(itemOf(week, "clocks"), {
    kind: "clocks",
    at: iso(oct(16, 9)),
    accountIds: ["a", "b"],
    gapMinutes: 0,
    count: 2,
  });
});

test("spare: an account never used while others ran into five-hour limits", () => {
  const hit = { identity: identity(1), kind: "five-hour" as const, at: iso(oct(14, 9)), resetAt: iso(oct(14, 12)) };
  const hours = { ...active(1, oct(14, 6)), ...active(2, oct(14, 7)) };
  assert.deepEqual(itemOf(lostFoundWeek(input({ rollups: rollups({ hours, hits: [hit] }) })), "spare"), {
    kind: "spare",
    accountIds: ["c"],
    hits: 1,
  });
  assert.equal(itemOf(lostFoundWeek(input({ rollups: rollups({ hours }) })), "spare"), undefined);
  // An account added after the week began, or one sharing another's usage identity, sat nothing out.
  const late = { ...account("d", 4), createdAt: "2026-10-17T00:00:00.000Z" };
  const twin = { ...account("e", 1), id: "e" };
  const week = lostFoundWeek(input({ accounts: [A, B, C, late, twin], rollups: rollups({ hours, hits: [hit] }) }));
  assert.deepEqual(itemOf(week, "spare")?.accountIds, ["c"]);
});

test("clocks count every pair of accounts within the gap, not only neighbours", () => {
  const window = (time: number) => ({ resetAt: iso(time), maxPercent: 50 });
  const week = lostFoundWeek(input({
    rollups: rollups({
      windows: {
        [identity(1)]: [window(oct(14, 10))],
        [identity(2)]: [window(oct(14, 10, 4))],
        [identity(3)]: [window(oct(14, 10, 8))],
      },
    }),
  }));
  assert.equal(itemOf(week, "clocks")?.count, 3);
  assert.equal(itemOf(week, "clocks")?.gapMinutes, 4);
});

test("in a zone half an hour off UTC an hour bucket counts where most of it lies", () => {
  // Asia/Kolkata is UTC+5:30: the 22:00 UTC bucket is 03:30–04:30 there, a night hour; the 23:00 one,
  // 04:30–05:30, is mostly morning.
  const hours = active(1, oct(14, 22), oct(14, 23));
  const week = lostFoundWeek(input({ zone: "Asia/Kolkata", rollups: rollups({ hours }) }));
  assert.deepEqual(itemOf(week, "feather"), { kind: "feather", at: iso(oct(14, 22)), hours: 1 });
});

test("a kept item is told only when it has what its kind needs", () => {
  assert.equal(validLostItem({ kind: "hourglass", at: "2026-10-14T06:56:00Z", minutes: 66 }), true);
  assert.equal(validLostItem({ kind: "scarf", date: "2026-10-14", accountIds: ["a", "b", "c"] }), true);
  assert.equal(validLostItem({ kind: "hourglass", at: "yesterday", minutes: 66 }), false);
  assert.equal(validLostItem({ kind: "trophy", date: "2026-10-14", tokens: 5 }), false);
  assert.equal(validLostItem({ kind: "unicorn" }), false);
  assert.equal(validLostItem(null), false);
});

test("feather: hours after local midnight; the latest is the one nearest morning", () => {
  // 01:00 and 04:00 in Istanbul.
  const hours = active(1, oct(14, 22), oct(15, 1), oct(15, 9));
  assert.deepEqual(itemOf(lostFoundWeek(input({ rollups: rollups({ hours }) })), "feather"), {
    kind: "feather",
    at: iso(oct(15, 1)),
    hours: 2,
  });
});

test("the items come most striking first, so the first is the week's featured one", () => {
  const eight = Array.from({ length: 9 }, (_, i) => oct(14, 20 + i));
  const week = lostFoundWeek(input({
    rollups: rollups({
      hours: { ...active(1, ...eight), ...active(2, oct(14, 9)) },
      windows: {
        [identity(1)]: [{ resetAt: iso(oct(16, 9)), maxPercent: 10 }],
        [identity(2)]: [{ resetAt: iso(oct(16, 9, 5)), maxPercent: 10 }],
      },
      hits: [{ identity: identity(1), kind: "five-hour", at: iso(oct(14, 7)), resetAt: iso(oct(14, 11)) }],
    }),
  }));
  const found = kinds(week);
  assert.deepEqual(found, LOST_ITEM_KINDS.filter((kind) => found.includes(kind)));
  assert.equal(found[0], "hourglass");
});

const seg = (n: number, from: number, to?: number) => ({
  accountUuid: `uuid-${n}`,
  orgId: `org-${n}`,
  from: iso(from),
  ...(to === undefined ? {} : { to: iso(to) }),
});

test("baton: the account in the Claude app hits a limit and another takes over at once; the quickest is shown, all are counted", () => {
  const hit = (n: number, at: number, kind: "five-hour" | "weekly" = "five-hour") => ({
    identity: identity(n),
    kind,
    at: iso(at),
    resetAt: iso(at + 2 * H),
  });
  const segments = [
    seg(1, oct(14, 9), oct(14, 11, 4)),
    seg(2, oct(14, 11, 4), oct(15, 9, 1)),
    // The poll saw the limit a minute after Relay had already switched.
    seg(3, oct(15, 9, 1), oct(15, 12)),
  ];
  const hits = [
    hit(1, oct(14, 11)),
    hit(2, oct(15, 9, 2)),
    // The same poll saw the weekly limit too: still one hand-over.
    hit(2, oct(15, 9, 2), "weekly"),
  ];
  assert.deepEqual(itemOf(lostFoundWeek(input({ segments, rollups: rollups({ hits }) })), "baton"), {
    kind: "baton",
    at: iso(oct(15, 9, 1)),
    accountIds: ["b", "c"],
    minutes: 0,
    count: 2,
  });
  // A switch long after the hit is not a hand-over, nor is a hit on an account not in the Claude app.
  const late = [seg(1, oct(14, 9), oct(14, 11, 40)), seg(2, oct(14, 11, 40))];
  assert.equal(itemOf(lostFoundWeek(input({ segments: late, rollups: rollups({ hits: [hit(1, oct(14, 11))] }) })), "baton"), undefined);
  const elsewhere = [seg(1, oct(14, 9), oct(14, 11, 4)), seg(2, oct(14, 11, 4))];
  assert.equal(itemOf(lostFoundWeek(input({ segments: elsewhere, rollups: rollups({ hits: [hit(3, oct(14, 11))] }) })), "baton"), undefined);
  // After a gap the Claude app was closed: nobody handed anything over.
  const gap = [seg(1, oct(14, 9), oct(14, 10)), seg(2, oct(14, 11, 4))];
  assert.equal(itemOf(lostFoundWeek(input({ segments: gap, rollups: rollups({ hits: [hit(1, oct(14, 11))] }) })), "baton"), undefined);
});

test("tally: active hours on every local day of the week; six days are not enough", () => {
  // Noon in Istanbul, Monday 12 to Sunday 18 October.
  const days = Array.from({ length: 7 }, (_, i) => oct(12 + i, 9));
  assert.deepEqual(itemOf(lostFoundWeek(input({ rollups: rollups({ hours: active(1, ...days, oct(14, 10)) }) })), "tally"), {
    kind: "tally",
    hours: 8,
  });
  assert.equal(itemOf(lostFoundWeek(input({ rollups: rollups({ hours: active(1, ...days.slice(1)) }) })), "tally"), undefined);
});

test("compass: twenty active hours and no limit hit, nor one still holding when the week began", () => {
  const twenty = Array.from({ length: 20 }, (_, i) => oct(13, 6) + i * 2 * H);
  const hours = active(1, ...twenty);
  assert.deepEqual(itemOf(lostFoundWeek(input({ rollups: rollups({ hours }) })), "compass"), { kind: "compass", hours: 20 });
  assert.equal(itemOf(lostFoundWeek(input({ rollups: rollups({ hours: active(1, ...twenty.slice(1)) }) })), "compass"), undefined);
  const inside = { identity: identity(2), kind: "five-hour" as const, at: iso(oct(15, 9)) };
  assert.equal(itemOf(lostFoundWeek(input({ rollups: rollups({ hours, hits: [inside] }) })), "compass"), undefined);
  const holding = { identity: identity(2), kind: "weekly" as const, at: iso(oct(10, 9)), until: iso(oct(13, 9)) };
  assert.equal(itemOf(lostFoundWeek(input({ rollups: rollups({ hours, hits: [holding] }) })), "compass"), undefined);
  const over = { ...holding, until: iso(oct(11, 9)) };
  assert.equal(itemOf(lostFoundWeek(input({ rollups: rollups({ hours, hits: [over] }) })), "compass")?.hours, 20);
});

test("tea glass: hours from five to eight in the morning; the earliest is the one nearest dawn", () => {
  // 05:00, 07:00 and 08:00 in Istanbul; eight is no longer morning.
  const hours = active(1, oct(14, 4), oct(15, 2), oct(15, 5));
  assert.deepEqual(itemOf(lostFoundWeek(input({ rollups: rollups({ hours }) })), "teaglass"), {
    kind: "teaglass",
    at: iso(oct(15, 2)),
    hours: 2,
  });
  assert.equal(itemOf(lostFoundWeek(input({ rollups: rollups({ hours: active(1, oct(15, 5)) }) })), "teaglass"), undefined);
});

test("the new kinds are told only when they have what they need", () => {
  assert.equal(validLostItem({ kind: "baton", at: "2026-10-14T08:04:00Z", accountIds: ["a", "b"], minutes: 4, count: 1 }), true);
  assert.equal(validLostItem({ kind: "baton", at: "2026-10-14T08:04:00Z", accountIds: ["a", "b"], minutes: 4 }), false);
  assert.equal(validLostItem({ kind: "tally", hours: 30 }), true);
  assert.equal(validLostItem({ kind: "compass" }), false);
  assert.equal(validLostItem({ kind: "teaglass", at: "2026-10-15T02:00:00Z", hours: 2 }), true);
});

test("the collection lists each kind's weeks within reach, newest first", () => {
  // Night hours in the newest week and three weeks before it; a morning hour two weeks before.
  const hours = active(1, oct(14, 22), oct(1, 22), oct(1, 23), oct(2, 3), Date.UTC(2026, 8, 23, 22));
  const collection = lostFoundCollection({ ...input({ rollups: rollups({ hours }) }) });
  assert.equal(collection.latest, "2026-10-12");
  assert.equal(collection.oldest, "2026-07-27");
  const weeks = (finds: { start: string; end: string }[] = []) => finds.map((find) => `${find.start}…${find.end}`);
  assert.deepEqual(weeks(collection.found.feather), [
    "2026-10-12…2026-10-18",
    "2026-09-28…2026-10-04",
    "2026-09-21…2026-09-27",
  ]);
  assert.deepEqual(weeks(collection.found.teaglass), ["2026-09-28…2026-10-04"]);
  // Each find tells its own week's story.
  assert.deepEqual(collection.found.feather?.[1].item, { kind: "feather", at: iso(oct(1, 23)), hours: 2 });
});

test("a pin's finish: bronze on the first week, silver on the third, gold on the sixth", () => {
  assert.equal(tierOf(0), undefined);
  assert.equal(tierOf(1), "bronze");
  assert.equal(tierOf(2), "bronze");
  assert.equal(tierOf(3), "silver");
  assert.equal(tierOf(6), "gold");
  assert.equal(tierOf(40), "gold");
  assert.deepEqual(nextTier(1), { tier: "silver", weeks: 3 });
  assert.equal(nextTier(6), undefined);
});
