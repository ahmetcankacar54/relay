import test from "node:test";
import assert from "node:assert/strict";
import {
  dayTimeline,
  nextPlannedWindow,
  plannedSettings,
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
  // The comparison is the day's own plan against the even spread.
  assert.equal(view.compare?.plan.switches, 3);
  assert.equal(view.compare?.plan.unmet, 0);
  assert.equal(view.compare?.even.outageMinutes, 32);
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
  const view = dayTimeline({ settings: s, accounts, usage: {}, now: at("2026-10-14", "12:00"), tempo: presetTempo("medium") });
  assert.equal(view.lane[0].from, view.dayBegin);
  assert.equal(view.lane.at(-1)!.to, view.dayEnd);
  assert.ok(view.lane.every((x) => x.from >= view.dayBegin && x.to <= view.dayEnd && !x.live));
});
