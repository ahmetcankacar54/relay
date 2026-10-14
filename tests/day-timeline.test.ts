import test from "node:test";
import assert from "node:assert/strict";
import {
  dayTimeline,
  nextPlannedWindow,
  plannedSettings,
  windowsInDay,
} from "../src/lib/day-timeline";
import { wallTime } from "../shared/planning";
import { WINDOW_MS } from "../shared/day-plan";
import { DEFAULT_PLANNING, type PlanningSettings } from "../shared/types";
import { planningAccount } from "./planning-fixtures";

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
  const view = dayTimeline({ settings: settings(), accounts, usage: {}, now: at("2026-10-13", "12:00") });
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
  const view = dayTimeline({ settings: s, accounts, usage: {}, now: at("2026-10-14", "12:00") });
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
