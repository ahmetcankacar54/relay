import test from "node:test";
import assert from "node:assert/strict";
import { TempoTracker } from "../electron/core/tempo-tracker";
import { tempoAt } from "../shared/tempo";
import { wallTime } from "../shared/planning";
import { emptyRollups } from "../shared/usage-rollups";
import {
  DEFAULT_PLANNING,
  type Account,
  type PlanningSettings,
} from "../shared/types";
import { planningAccount } from "./planning-fixtures";

const ZONE = "Europe/Istanbul";

function setup() {
  const state = {
    now: wallTime("2026-10-14", "10:00", ZONE)!,
    available: true,
    calls: 0,
    accounts: [planningAccount("a", "pro")] as Account[],
    settings: {
      ...DEFAULT_PLANNING,
      timeZone: ZONE,
      weekday: { enabled: true, start: "09:00", end: "18:00" },
      weekend: { enabled: false, start: "11:00", end: "17:00" },
    } as PlanningSettings,
  };
  const tracker = new TempoTracker({
    available: () => state.available,
    rollups: () => {
      state.calls++;
      return emptyRollups();
    },
    accounts: () => state.accounts,
    settings: () => state.settings,
    now: () => state.now,
  });
  return { state, tracker };
}

test("the rollups are read once for repeated calls on the same day", () => {
  const { state, tracker } = setup();
  const first = tracker.current();
  assert.equal(state.calls, 1);
  state.now = wallTime("2026-10-14", "23:30", ZONE)!;
  assert.equal(tracker.current(), first);
  assert.equal(tracker.current(), first);
  assert.equal(state.calls, 1);
});

test("the tempo is learned again when the local date changes", () => {
  const { state, tracker } = setup();
  tracker.current();
  state.now = wallTime("2026-10-15", "00:05", ZONE)!;
  tracker.current();
  assert.equal(state.calls, 2);
});

test("the tempo is learned again when the tempo choice, zone or hours change", () => {
  const { state, tracker } = setup();
  tracker.current();
  state.settings = { ...state.settings, tempo: "heavy" };
  assert.equal(tracker.current().source, "preset");
  assert.equal(tracker.current().rate.weekday, 120);
  state.settings = { ...state.settings, tempo: "auto" };
  assert.equal(tracker.current().source, "default");
  const before = state.calls;
  state.settings = { ...state.settings, timeZone: "UTC" };
  tracker.current();
  state.settings = {
    ...state.settings,
    weekday: { enabled: true, start: "08:00", end: "18:00" },
  };
  tracker.current();
  state.settings = {
    ...state.settings,
    weekend: { enabled: true, start: "11:00", end: "17:00" },
  };
  tracker.current();
  assert.equal(state.calls, before + 3);
});

test("the tempo is learned again when an account's plan, sign-in or identity changes", () => {
  const { state, tracker } = setup();
  tracker.current();
  const [a] = state.accounts;
  state.accounts = [{ ...a, planning: { plan: "max5", capacityWeight: 5 } }];
  tracker.current();
  assert.equal(state.calls, 2);
  state.accounts = [
    { ...state.accounts[0], auth: { ...a.auth!, loggedIn: false } },
  ];
  tracker.current();
  assert.equal(state.calls, 3);
  state.accounts = [
    {
      ...state.accounts[0],
      auth: { ...a.auth!, loggedIn: false, orgId: "org-other" },
    },
  ];
  tracker.current();
  assert.equal(state.calls, 4);
  // Unrelated edits (a rename, the planned list) keep the learned tempo.
  state.accounts = [{ ...state.accounts[0], name: "Renamed" }];
  state.settings = {
    ...state.settings,
    accounts: [{ id: "a" }],
    autoStart: true,
  };
  tracker.current();
  assert.equal(state.calls, 4);
});

test("the tempo is learned again when the rollups become available or unavailable", () => {
  const { state, tracker } = setup();
  tracker.current();
  assert.equal(state.calls, 1);
  state.available = false;
  tracker.current();
  // Unavailable rollups are never read.
  assert.equal(state.calls, 1);
  assert.equal(tracker.current().source, "default");
  state.available = true;
  tracker.current();
  assert.equal(state.calls, 2);
});

test("rateAt reads the current tempo at a time, defaulting to now", () => {
  const { state, tracker } = setup();
  state.settings = { ...state.settings, tempo: "light" };
  const noon = wallTime("2026-10-14", "12:00", ZONE)!;
  assert.equal(
    tracker.rateAt(noon),
    tempoAt(tracker.current(), state.settings, noon),
  );
  assert.equal(tracker.rateAt(noon), 20);
  assert.equal(tracker.rateAt(), 20);
});
