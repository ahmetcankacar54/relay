import test from "node:test";
import assert from "node:assert/strict";
import {
  dayTimeline,
  nextPlannedWindow,
  plannedSettings,
  switchTimes,
  windowsInDay,
} from "../src/lib/day-timeline";
import { wallTime } from "../shared/planning";
import { WINDOW_MS, dayPlan, planContext } from "../shared/day-plan";
import { presetTempo, type Tempo } from "../shared/tempo";
import { liveForecast } from "../shared/live-forecast";
import {
  DEFAULT_PLANNING,
  type KeeperSnapshot,
  type PlanningSettings,
} from "../shared/types";
import { planningAccount, planningUsage } from "./planning-fixtures";

const ZONE = "Europe/Istanbul";
const H = 3_600_000;
const at = (date: string, clock: string) => wallTime(date, clock, ZONE)!;
const settings = (patch: Partial<PlanningSettings> = {}): PlanningSettings => ({
  ...DEFAULT_PLANNING,
  autoStart: true,
  timeZone: ZONE,
  weekday: { enabled: true, start: "09:00", end: "18:00" },
  weekend: { enabled: false, start: "11:00", end: "17:00" },
  accounts: [{ id: "a" }, { id: "gone" }, { id: "b" }],
  ...patch,
});

test("deleted planned accounts are filtered before planning", () => {
  const accounts = [planningAccount("a"), planningAccount("b")];
  assert.deepEqual(plannedSettings(settings(), accounts).accounts.map((a) => a.id), ["a", "b"]);
  const view = dayTimeline({ settings: settings(), accounts, usage: {}, now: at("2026-10-13", "12:00"), tempo: presetTempo("medium") });
  assert.deepEqual(view.rows.map((r) => r.account.id), ["a", "b"]);
  assert.equal(view.intervals.length, 1);
  assert.ok(view.rows.every((r) => r.windows.length > 0));
  assert.equal(view.showNow, true);
  assert.equal(view.pct(view.dayBegin), 0);
  assert.equal(view.pct(view.dayEnd), 100);
});

test("windows are de-duplicated across neighbouring days and clipped to the day", () => {
  const begin = at("2026-10-13", "00:00");
  const end = at("2026-10-14", "00:00");
  const w = (start: number) => ({ start, end: start + WINDOW_MS });
  const out = windowsInDay([[w(begin - 2 * H), w(begin + 8 * H)], [w(begin + 8 * H), w(end + H)], [w(begin - 6 * H)]], begin, end);
  assert.deepEqual(out.map((x) => x.start), [begin - 2 * H, begin + 8 * H]);
});

test("overnight hours carry yesterday's windows into today", () => {
  const accounts = [planningAccount("a")];
  const s = settings({ weekday: { enabled: true, start: "20:00", end: "04:00" }, accounts: [{ id: "a" }] });
  const view = dayTimeline({ settings: s, accounts, usage: {}, now: at("2026-10-14", "12:00"), tempo: presetTempo("medium") });
  const starts = view.rows[0].windows.map((x) => x.start);
  assert.equal(new Set(starts).size, starts.length);
  assert.ok(starts.some((x) => x < view.dayBegin));
});

test("next window prefers the keeper's live view", () => {
  const accounts = [planningAccount("a"), planningAccount("b")];
  const now = at("2026-10-13", "12:00");
  const keeper = { enabled: true, running: true, accounts: [], attempts: [], plannedToday: 0, next: { accountId: "b", at: "2026-10-13T10:00:00.000Z" } };
  assert.deepEqual(nextPlannedWindow(settings(), accounts, keeper, now), keeper.next);
  const computed = nextPlannedWindow(settings(), accounts, undefined, now);
  assert.ok(computed && Date.parse(computed.at) > now);
  assert.ok(["a", "b"].includes(computed.accountId));
  assert.equal(nextPlannedWindow(settings({ accounts: [{ id: "gone" }] }), accounts, undefined, now), undefined);
});

test("the keeper's tempo plans the next window and the timeline", () => {
  const busyHours: Record<number, number> = { 9: 220, 10: 242, 11: 242, 12: 110, 13: 198, 14: 242, 15: 242, 16: 220, 17: 154 };
  const tempo: Tempo = {
    source: "learned",
    weekday: Array.from({ length: 24 }, (_, hour) => busyHours[hour] ?? 205),
    weekend: Array.from({ length: 24 }, () => 205),
    rate: { weekday: 205, weekend: 205 },
    days: { weekday: 15, weekend: 2 },
  };
  const team = planningAccount("vertex", "team");
  team.planning!.capacityWeight = 2;
  const accounts = [planningAccount("max", "max5"), team, planningAccount("pro")];
  const s = settings({ accounts: accounts.map(({ id }) => ({ id })) });
  const now = at("2026-10-13", "22:00");
  const keeper: KeeperSnapshot = { enabled: true, running: false, accounts: [], attempts: [], plannedToday: 0, tempo };
  const plan = dayPlan("2026-10-14", s, planContext(accounts, tempo));
  const first = plan.accounts.reduce((a, b) => (b.firstStart < a.firstStart ? b : a));
  assert.deepEqual(nextPlannedWindow(s, accounts, keeper, now), {
    accountId: first.accountId,
    at: new Date(first.firstStart).toISOString(),
  });
  // Without the keeper's tempo the default one plans other times.
  assert.notDeepEqual(nextPlannedWindow(s, accounts, undefined, now), nextPlannedWindow(s, accounts, keeper, now));
  const view = dayTimeline({ settings: s, accounts, usage: {}, now, offset: 1, tempo });
  for (const [index, row] of view.rows.entries())
    assert.equal(row.windows[0].start, plan.accounts[index].firstStart);
});

// The capacity scenario of the day plan: Max 5×, Team (weight 2) and Pro on a
// busy Wednesday, 09:00–18:00 in Istanbul.
const WEDNESDAY = "2026-10-14";
const scenarioHours: Record<number, number> = { 9: 220, 10: 242, 11: 242, 12: 110, 13: 198, 14: 242, 15: 242, 16: 220, 17: 154 };
const busyTempo: Tempo = {
  source: "learned",
  weekday: Array.from({ length: 24 }, (_, hour) => scenarioHours[hour] ?? 205),
  weekend: Array.from({ length: 24 }, () => 205),
  rate: { weekday: 205, weekend: 205 },
  days: { weekday: 15, weekend: 2 },
};
const scenarioTeam = planningAccount("vertex", "team");
scenarioTeam.planning!.capacityWeight = 2;
const scenarioAccounts = [planningAccount("max", "max5"), scenarioTeam, planningAccount("pro")];
const scenario = (patch: Partial<PlanningSettings> = {}) =>
  settings({ accounts: scenarioAccounts.map(({ id }) => ({ id })), ...patch });
const noon = at(WEDNESDAY, "12:00");
const clockOf = (time: number) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(time);
/** Fresh usage read at noon: no window open on any account. */
const freshUsage = Object.fromEntries(scenarioAccounts.map((a) => [a.id, planningUsage(a, noon)]));
const plain = (lane: { accountId?: string; from: number; to: number }[]) =>
  lane.map(({ accountId, from, to }) => ({ ...(accountId ? { accountId } : {}), from, to }));
/** Segments clipped to [from, to). */
const clipped = (segments: { accountId?: string; from: number; to: number }[], from: number, to: number) =>
  plain(segments.filter((s) => s.to > from && s.from < to).map((s) => ({ ...s, from: Math.max(s.from, from), to: Math.min(s.to, to) })));

test("today's usage lane is the plan before now and the live forecast from now", () => {
  const s = scenario();
  const view = dayTimeline({ settings: s, accounts: scenarioAccounts, usage: freshUsage, now: noon, tempo: busyTempo, activeId: "max" });
  const context = planContext(scenarioAccounts, busyTempo);
  const plan = dayPlan(WEDNESDAY, s, context);
  const before = view.lane.filter((x) => x.from < noon);
  const after = view.lane.filter((x) => x.from >= noon);
  assert.ok(before.length && after.length);
  assert.ok(before.every((x) => !x.live && x.to <= noon));
  assert.ok(after.every((x) => x.live));
  assert.deepEqual(plain(before), clipped(plan.forecast!.segments, view.dayBegin, noon));
  const live = liveForecast({ plan, settings: s, context, usage: freshUsage, activeId: "max", now: noon })!;
  assert.deepEqual(plain(after), plain(live.segments));
  assert.equal(after[0].accountId, "max");
  assert.equal(after.at(-1)!.to, at(WEDNESDAY, "18:00"));
  // The comparison is the day's own plan against the even spread, with the
  // automatic accounts' warm-ups in planned order.
  assert.equal(view.compare?.plan.switches, 3);
  assert.equal(view.compare?.plan.unmet, 0);
  assert.equal(view.compare?.even.outageMinutes, 32);
  assert.deepEqual(view.compare?.warmUps.plan.map(clockOf), ["06:15", "08:15", "06:30"]);
  assert.deepEqual(view.compare?.warmUps.even.map(clockOf), ["04:50", "06:30", "08:10"]);
  // The seam at now (vertex → max) is not a switch: max → pro → vertex by
  // plan, then the live forecast's own switches; its windows open at noon, so
  // after the gap max is back at 17:00.
  assert.deepEqual(switchTimes(view.lane).map(clockOf), ["11:09", "11:55", "14:48", "15:37", "17:00"]);
});

test("before work today's lane is live from the work start", () => {
  const s = scenario();
  const now = at(WEDNESDAY, "08:00");
  const usage = Object.fromEntries(scenarioAccounts.map((a) => [a.id, planningUsage(a, now)]));
  const view = dayTimeline({ settings: s, accounts: scenarioAccounts, usage, now, tempo: busyTempo, activeId: "max" });
  const context = planContext(scenarioAccounts, busyTempo);
  const plan = dayPlan(WEDNESDAY, s, context);
  assert.ok(view.lane.length);
  assert.ok(view.lane.every((x) => x.live));
  assert.equal(view.lane[0].from, at(WEDNESDAY, "09:00"));
  const live = liveForecast({ plan, settings: s, context, usage, activeId: "max", now })!;
  assert.deepEqual(plain(view.lane), plain(live.segments));
});

test("a now between whole minutes leaves no overlap, gap or switch at the seam", () => {
  const s = scenario();
  for (const seconds of [20, 30]) {
    const now = noon + seconds * 1000;
    const usage = Object.fromEntries(scenarioAccounts.map((a) => [a.id, planningUsage(a, now)]));
    const view = dayTimeline({ settings: s, accounts: scenarioAccounts, usage, now, tempo: busyTempo, activeId: "max" });
    const seam = view.lane.findIndex((x) => x.live);
    assert.equal(view.lane[seam - 1].to, now, `${seconds}s`);
    assert.equal(view.lane[seam].from, now, `${seconds}s`);
    // Today's work interval is one contiguous stretch.
    for (let i = 1; i < view.lane.length; i++) assert.equal(view.lane[i].from, view.lane[i - 1].to);
    assert.ok(!switchTimes(view.lane).includes(now));
    assert.equal(new Set(view.lane.map((x) => `${x.live}-${x.from}`)).size, view.lane.length);
  }
});

test("a manual account is left out of the warm-ups the comparison lists", () => {
  const s = scenario({ accounts: [{ id: "max", firstStart: "07:10" }, { id: "vertex" }, { id: "pro" }] });
  const view = dayTimeline({ settings: s, accounts: scenarioAccounts, usage: {}, now: noon, offset: 1, tempo: busyTempo });
  const plan = dayPlan("2026-10-15", s, planContext(scenarioAccounts, busyTempo));
  assert.deepEqual(view.compare?.warmUps, {
    accountIds: ["vertex", "pro"],
    plan: plan.accounts.slice(1).map((a) => a.firstStart),
    even: plan.accounts.slice(1).map((a) => a.evenStart),
  });
});

test("another day's lane is its plan only; an all-manual plan has nothing to compare", () => {
  const s = scenario();
  const tomorrow = dayTimeline({ settings: s, accounts: scenarioAccounts, usage: freshUsage, now: noon, offset: 1, tempo: busyTempo, activeId: "max" });
  const plan = dayPlan("2026-10-15", s, planContext(scenarioAccounts, busyTempo));
  assert.ok(tomorrow.lane.length);
  assert.ok(tomorrow.lane.every((x) => !x.live));
  assert.deepEqual(plain(tomorrow.lane), plain(plan.forecast!.segments));
  assert.ok(tomorrow.compare);
  const manual = scenario({ accounts: [{ id: "max", firstStart: "06:15" }, { id: "vertex", firstStart: "08:15" }, { id: "pro", firstStart: "06:30" }] });
  const fixed = dayTimeline({ settings: manual, accounts: scenarioAccounts, usage: freshUsage, now: noon, offset: 1, tempo: busyTempo });
  assert.ok(fixed.lane.length);
  assert.equal(fixed.compare, undefined);
  // Saturday is a day off: nothing to forecast or compare.
  const saturday = dayTimeline({ settings: s, accounts: scenarioAccounts, usage: freshUsage, now: noon, offset: 3, tempo: busyTempo });
  assert.equal(saturday.date, "2026-10-17");
  assert.deepEqual(saturday.lane, []);
  assert.equal(saturday.compare, undefined);
});

test("an overnight lane keeps yesterday's tail and today's start, clipped to the day", () => {
  const accounts = [planningAccount("a")];
  const s = settings({ weekday: { enabled: true, start: "20:00", end: "04:00" }, accounts: [{ id: "a" }] });
  const now = at("2026-10-14", "12:00");
  const view = dayTimeline({ settings: s, accounts, usage: {}, now, tempo: presetTempo("medium") });
  assert.equal(view.lane[0].from, view.dayBegin);
  assert.equal(view.lane.at(-1)!.to, view.dayEnd);
  assert.ok(view.lane.every((x) => x.from >= view.dayBegin && x.to <= view.dayEnd));
  // Yesterday's tail is over; tonight's interval is the next one, forecast live.
  assert.ok(view.lane.filter((x) => x.from < now).every((x) => !x.live && x.to <= at("2026-10-14", "04:00")));
  const tonight = view.lane.filter((x) => x.from >= now);
  assert.equal(tonight[0].from, at("2026-10-14", "20:00"));
  assert.ok(tonight.every((x) => x.live));
});

test("inside yesterday's overnight interval the live part comes from yesterday's plan", () => {
  const accounts = [planningAccount("a"), planningAccount("b")];
  const s = settings({ weekday: { enabled: true, start: "22:00", end: "06:00" }, accounts: [{ id: "a" }, { id: "b" }] });
  const now = at("2026-10-14", "02:00");
  const tempo = presetTempo("medium");
  const view = dayTimeline({ settings: s, accounts, usage: {}, now, tempo, activeId: "b" });
  const context = planContext(accounts, tempo);
  const yesterday = dayPlan("2026-10-13", s, context);
  const before = view.lane.filter((x) => x.from < now);
  assert.equal(before[0].from, view.dayBegin);
  assert.ok(before.every((x) => !x.live && x.to <= now));
  assert.deepEqual(plain(before), clipped(yesterday.forecast!.segments, view.dayBegin, now));
  const live = view.lane.filter((x) => x.live);
  const rest = liveForecast({ plan: yesterday, settings: s, context, usage: {}, activeId: "b", now })!;
  assert.deepEqual(plain(live), plain(rest.segments));
  assert.equal(live[0].accountId, "b");
  assert.equal(live.at(-1)!.to, at("2026-10-14", "06:00"));
  // Tonight's interval is still the plan.
  const tonight = view.lane.filter((x) => x.from >= at("2026-10-14", "22:00"));
  assert.ok(tonight.length && tonight.every((x) => !x.live));
});

test("a hole after a gap inside one forecast hides no switch; breaks and the seam at now start afresh", () => {
  const t = (clock: string) => at(WEDNESDAY, clock);
  const piece = (first: boolean, live: boolean, accountId: string | undefined, from: string, to: string) => ({
    ...(accountId ? { accountId } : {}),
    from: t(from),
    to: t(to),
    live,
    ...(first ? { first } : {}),
  });
  // No demand from 12:20, b refills at 12:40: the forecast counts max → b.
  assert.deepEqual(
    switchTimes([piece(true, false, "max", "09:00", "12:10"), piece(false, false, undefined, "12:10", "12:20"), piece(false, false, "b", "12:40", "18:00")]).map(clockOf),
    ["12:40"],
  );
  // Tonight's interval and the live part from now begin their own forecasts.
  assert.deepEqual(switchTimes([piece(true, false, "max", "09:00", "18:00"), piece(true, false, "b", "20:00", "23:00")]), []);
  assert.deepEqual(switchTimes([piece(true, false, "max", "09:00", "12:00"), piece(true, true, "b", "12:00", "18:00")]), []);
});

test("during lunch after a gap the live part starts when demand resumes, not at now or at the refill", () => {
  // Nothing in the lunch hour; a ran dry and refills at 12:40.
  const lunch: Tempo = { ...busyTempo, weekday: Array.from({ length: 24 }, (_, hour) => (hour === 12 ? 0 : 60)) };
  const accounts = [planningAccount("a")];
  const s = settings({ accounts: [{ id: "a" }] });
  const now = at(WEDNESDAY, "12:25");
  const usage = { a: { ...planningUsage(accounts[0], now), fiveHour: { usedPercent: 100, resetsAt: new Date(at(WEDNESDAY, "12:40")).toISOString() } } };
  const view = dayTimeline({ settings: s, accounts, usage, now, tempo: lunch, activeId: "a" });
  const live = view.lane.filter((x) => x.live);
  assert.equal(live[0].from, at(WEDNESDAY, "13:00"));
  assert.equal(live[0].accountId, "a");
  assert.ok(view.lane.every((x) => x.to <= now || x.from >= at(WEDNESDAY, "13:00")));
});

// Today's adaptation: a faster pace and b's next start moved later.
test("an adapted day forecasts the rest at today's pace with the adopted starts", () => {
  const accounts = [planningAccount("a"), planningAccount("b")];
  const s = settings();
  const tempo = presetTempo("medium");
  const now = at("2026-10-13", "12:00");
  // Fresh usage read at noon: no window open on either account.
  const usage = Object.fromEntries(accounts.map((x) => [x.id, planningUsage(x, now)]));
  const startAt = at("2026-10-13", "14:30");
  const adaptation = { factor: 2, schedule: { b: startAt } };
  const view = dayTimeline({ settings: s, accounts, usage, now, tempo, activeId: "a", adaptation });
  const unadapted = dayTimeline({ settings: s, accounts, usage, now, tempo, activeId: "a" });
  const context = planContext(accounts, tempo);
  const plan = dayPlan("2026-10-13", plannedSettings(s, accounts), context);
  const live = liveForecast({ plan, settings: plannedSettings(s, accounts), context, usage, activeId: "a", now, factor: 2, schedule: { b: startAt } })!;
  assert.deepEqual(plain(view.lane.filter((x) => x.live)), plain(live.segments));
  assert.deepEqual(view.live?.forecast, live);
  assert.notDeepEqual(plain(view.lane), plain(unadapted.lane));
  // The part before now is still the plan's.
  assert.deepEqual(plain(view.lane.filter((x) => !x.live)), plain(unadapted.lane.filter((x) => !x.live)));
  // b's row: its closed planned window and the rest of the chain give way to
  // a chain from 14:30; a's row is the plan's.
  const windows = (v: typeof view, id: string) =>
    v.rows.find((r) => r.account.id === id)!.windows.map((w) => `${clockOf(w.start)}–${clockOf(w.end)}`);
  assert.deepEqual(windows(unadapted, "b"), ["08:00–13:00", "13:00–18:00"]);
  assert.deepEqual(windows(view, "b"), ["14:30–19:30"]);
  const b = view.rows.find((r) => r.account.id === "b")!.windows;
  assert.ok(b.every((w) => w.end <= now || w.start >= startAt));
  assert.deepEqual(windows(view, "a"), windows(unadapted, "a"));
  // Another day is the plan only.
  const tomorrow = dayTimeline({ settings: s, accounts, usage, now, offset: 1, tempo, activeId: "a", adaptation });
  const tomorrowPlain = dayTimeline({ settings: s, accounts, usage, now, offset: 1, tempo, activeId: "a" });
  assert.deepEqual(tomorrow.rows, tomorrowPlain.rows);
  assert.deepEqual(tomorrow.lane, tomorrowPlain.lane);
});

test("a held restart keeps the open window and starts the next one at the adopted time", () => {
  const accounts = [planningAccount("a"), planningAccount("b")];
  const s = settings();
  const tempo = presetTempo("medium");
  const now = at("2026-10-13", "12:00");
  const usage = {
    a: planningUsage(accounts[0], now),
    b: { ...planningUsage(accounts[1], now), fiveHour: { usedPercent: 40, resetsAt: new Date(at("2026-10-13", "13:00")).toISOString() } },
  };
  const view = dayTimeline({ settings: s, accounts, usage, now, tempo, activeId: "a", adaptation: { factor: 1, schedule: { b: at("2026-10-13", "14:00") } } });
  const b = view.rows.find((r) => r.account.id === "b")!.windows;
  // Nothing between its reset at 13:00 and 14:00; the chain stops at the work end.
  assert.deepEqual(b.map((w) => `${clockOf(w.start)}–${clockOf(w.end)}`), ["08:00–13:00", "14:00–19:00"]);
  // Without fresh usage the plan's window counts as open, as in the live forecast.
  const stale = dayTimeline({ settings: s, accounts, usage: {}, now, tempo, activeId: "a", adaptation: { factor: 1, schedule: { b: at("2026-10-13", "13:30") } } });
  assert.deepEqual(
    stale.rows.find((r) => r.account.id === "b")!.windows.map((w) => `${clockOf(w.start)}–${clockOf(w.end)}`),
    ["08:00–13:00", "13:30–18:30"],
  );
});
