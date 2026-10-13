import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DailySchedule } from "../src/DailySchedule";
import { dailySchedule, projectDayInterval } from "../shared/schedule-visual";
import { workdayPlan } from "../shared/planning";
import type { AccountUsage, WorkdaySettings } from "../shared/types";
import {
  planningAccount,
  planningSettings,
  planningUsage,
} from "./planning-fixtures";

const NOW = Date.parse("2026-10-13T09:00:00Z");
function build(settings: WorkdaySettings, now = NOW) {
  const account = planningAccount("a");
  const usage = { a: planningUsage(account, now) };
  return dailySchedule(
    [account],
    usage,
    settings,
    workdayPlan([account], usage, settings, now),
    now,
  );
}
function spans(day: ReturnType<typeof dailySchedule>) {
  return day.working.map((s) => [s.startMinute, s.endMinute]);
}
test("equal midnight clocks display a full wall-clock day even with routines off", () => {
  const settings = {
    ...planningSettings(),
    start: "00:00",
    end: "00:00",
    routineEnabled: false,
  };
  const day = build(settings);
  assert.equal(day.date, "2026-10-13");
  assert.equal(day.elapsedHours, 24);
  assert.deepEqual(spans(day), [[0, 1_440]]);
  assert.equal(day.nowMinute, 720);
  assert.deepEqual(
    day.lanes[0].proposal?.segments.map((s) => [s.startMinute, s.endMinute]),
    [[0, 300]],
  );
  assert.equal(day.lanes[0].actualReset, undefined);
});
test("a full day anchored yesterday remains on today's axis and retains dated proposal text", () => {
  const now = Date.parse("2026-10-12T23:00:00Z"); // 02:00 in Istanbul
  const day = build(
    { ...planningSettings(), start: "09:00", end: "09:00" },
    now,
  );
  assert.equal(day.date, "2026-10-13");
  assert.deepEqual(spans(day), [
    [0, 540],
    [540, 1_440],
  ]);
  assert.equal(day.lanes[0].proposal?.start.dayOffset, -1);
  assert.equal(day.lanes[0].proposal?.reset.dayOffset, -1);
  assert.deepEqual(day.lanes[0].proposal?.segments, []);
  assert.equal(day.nowMinute, 120);
});
test("overnight working ranges split on midnight and clip an earlier anchored slot onto today", () => {
  const now = Date.parse("2026-10-12T23:00:00Z");
  const day = build(
    { ...planningSettings(), start: "22:00", end: "06:00" },
    now,
  );
  assert.equal(day.date, "2026-10-13");
  assert.deepEqual(spans(day), [
    [0, 360],
    [1_320, 1_440],
  ]);
  const proposal = day.lanes[0].proposal!;
  assert.equal(proposal.start.clock, "22:00");
  assert.equal(proposal.start.dayOffset, -1);
  assert.equal(proposal.reset.clock, "03:00");
  assert.equal(proposal.reset.dayOffset, 0);
  assert.deepEqual(
    proposal.segments.map((s) => [s.startMinute, s.endMinute]),
    [[0, 180]],
  );
});
test("warm-up before a future anchor day keeps previous-day offsets and no phantom visible bar", () => {
  const now = Date.parse("2026-10-13T15:00:00Z");
  const settings = {
    ...planningSettings(),
    start: "00:00",
    end: "09:00",
    warmupLeadMinutes: 300,
  };
  const day = build(settings, now);
  assert.equal(day.date, "2026-10-14");
  assert.equal(day.isToday, false);
  assert.equal(day.nowMinute, undefined);
  assert.equal(day.lanes[0].proposal?.start.clock, "19:00");
  assert.equal(day.lanes[0].proposal?.start.dayOffset, -1);
  assert.equal(day.lanes[0].proposal?.reset.dayOffset, 0);
  assert.deepEqual(day.lanes[0].proposal?.segments, []);
});
test("working band is useful without selected accounts, respects weekday anchors, and uses chosen timezone", () => {
  const settings = {
    ...planningSettings([]),
    timeZone: "Asia/Tokyo",
    start: "22:00",
    end: "06:00",
    weekdays: [2],
  };
  const day = build(settings, Date.parse("2026-10-13T18:00:00Z")); // Wednesday 03:00
  assert.equal(day.date, "2026-10-14");
  assert.deepEqual(spans(day), [[0, 360]]); // Only Tuesday's overnight shift.
  assert.equal(day.nowMinute, 180);
  assert.deepEqual(day.lanes, []);
});
test("an upcoming selected weekday reveals that calendar day without today's marker", () => {
  const day = build({ ...planningSettings(), weekdays: [1] });
  assert.equal(day.date, "2026-10-19");
  assert.deepEqual(spans(day), [[540, 1_080]]);
  assert.equal(day.nowMinute, undefined);
});
test("spring DST keeps five elapsed hours, omits the missing hour and identifies the 23-hour day", () => {
  const settings = {
    ...planningSettings(),
    timeZone: "America/New_York",
    start: "00:00",
    end: "00:00",
  };
  const now = Date.parse("2026-03-08T05:01:00Z");
  const day = build(settings, now);
  assert.equal(day.date, "2026-03-08");
  assert.equal(day.elapsedHours, 23);
  const proposal = day.lanes[0].proposal!;
  assert.equal(
    Date.parse(proposal.reset.at) - Date.parse(proposal.start.at),
    5 * 3_600_000,
  );
  assert.equal(proposal.reset.clock, "06:00");
  assert.deepEqual(
    proposal.segments.map((s) => [s.startMinute, s.endMinute]),
    [
      [0, 120],
      [180, 360],
    ],
  );
  assert.deepEqual(spans(day), [
    [0, 120],
    [180, 1_440],
  ]);
});
test("fall DST repeats the hour without reversing intervals and identifies the 25-hour day", () => {
  const settings = {
    ...planningSettings(),
    timeZone: "America/New_York",
    start: "00:00",
    end: "00:00",
  };
  const day = build(settings, Date.parse("2026-11-01T04:01:00Z"));
  assert.equal(day.elapsedHours, 25);
  assert.equal(day.lanes[0].proposal?.reset.clock, "04:00");
  assert.deepEqual(
    day.lanes[0].proposal?.segments.map((s) => [s.startMinute, s.endMinute]),
    [
      [0, 120],
      [60, 240],
    ],
  );
  const repeated = projectDayInterval(
    Date.parse("2026-11-01T05:45:00Z"),
    Date.parse("2026-11-01T06:15:00Z"),
    "2026-11-01",
    "America/New_York",
  );
  assert.deepEqual(
    repeated.map((s) => [s.startMinute, s.endMinute]),
    [
      [105, 120],
      [60, 75],
    ],
  );
});
test("intervals ending exactly at a DST jump use the preceding clock offset", () => {
  const spring = projectDayInterval(
    Date.parse("2026-03-08T05:00:00Z"),
    Date.parse("2026-03-08T07:00:00Z"),
    "2026-03-08",
    "America/New_York",
  );
  assert.deepEqual(
    spring.map((s) => [s.startMinute, s.endMinute]),
    [[0, 120]],
  );
  const fall = projectDayInterval(
    Date.parse("2026-11-01T05:45:00Z"),
    Date.parse("2026-11-01T06:00:00Z"),
    "2026-11-01",
    "America/New_York",
  );
  assert.deepEqual(
    fall.map((s) => [s.startMinute, s.endMinute]),
    [[105, 120]],
  );
});
test("only fresh matching quota data creates a server reset marker and no actual start is inferred", () => {
  const account = planningAccount("a");
  const settings = planningSettings();
  const ready = planningUsage(account, NOW);
  ready.fiveHour = {
    usedPercent: 20,
    resetsAt: new Date(NOW + 2 * 3_600_000).toISOString(),
  };
  const plan = workdayPlan([account], { a: ready }, settings, NOW);
  const day = dailySchedule([account], { a: ready }, settings, plan, NOW);
  assert.equal(day.lanes[0].actualReset?.clock, "14:00");
  assert.equal(day.lanes[0].actualReset?.minute, 840);
  assert.equal("start" in day.lanes[0].actualReset!, false);
  const rejected: Partial<AccountUsage>[] = [
    { stale: true },
    { issue: "identity-mismatch" },
    { accountId: "different" },
    { status: "error" },
    { checkedAt: new Date(NOW - 5 * 60_000).toISOString() },
    { checkedAt: new Date(NOW + 1).toISOString() },
    { fiveHour: { usedPercent: 20, resetsAt: new Date(NOW).toISOString() } },
    { fiveHour: { usedPercent: NaN, resetsAt: ready.fiveHour.resetsAt } },
  ];
  for (const patch of rejected)
    assert.equal(
      dailySchedule(
        [account],
        { a: { ...ready, ...patch } },
        settings,
        plan,
        NOW,
      ).lanes[0].actualReset,
      undefined,
    );
  account.desktop = {
    accountUuid: "different",
    orgId: "different",
    savedAt: new Date(NOW).toISOString(),
  };
  assert.equal(
    dailySchedule([account], { a: ready }, settings, plan, NOW).lanes[0]
      .actualReset,
    undefined,
  );
});
test("a real reset on tomorrow's date stays in dated text and is not plotted on today's axis", () => {
  const now = Date.parse("2026-10-13T20:00:00Z"); // 23:00
  const account = planningAccount("a");
  const settings = { ...planningSettings(), start: "00:00", end: "00:00" };
  const usage = planningUsage(account, now);
  usage.fiveHour = {
    usedPercent: 20,
    resetsAt: new Date(now + 3 * 3_600_000).toISOString(),
  };
  const day = dailySchedule(
    [account],
    { a: usage },
    settings,
    workdayPlan([account], { a: usage }, settings, now),
    now,
  );
  assert.equal(day.date, "2026-10-13");
  assert.equal(day.lanes[0].actualReset?.clock, "02:00");
  assert.equal(day.lanes[0].actualReset?.dayOffset, 1);
  assert.equal(day.lanes[0].actualReset?.minute, undefined);
});
test("invalid timezone, time, date or interval are safe empty results", () => {
  for (const patch of [
    { timeZone: "Invalid/Zone" },
    { start: "24:00" },
    { end: "" },
  ])
    assert.equal(build({ ...planningSettings(), ...patch }).valid, false);
  assert.deepEqual(
    projectDayInterval(NOW, NOW + 3_600_000, "2026-02-30", "Europe/Istanbul"),
    [],
  );
  assert.deepEqual(
    projectDayInterval(NOW, NOW + 3_600_000, "2026-10-13", "Invalid/Zone"),
    [],
  );
  assert.deepEqual(
    projectDayInterval(NOW, NOW, "2026-10-13", "Europe/Istanbul"),
    [],
  );
  assert.deepEqual(
    projectDayInterval(NaN, NOW, "2026-10-13", "Europe/Istanbul"),
    [],
  );
});
test("clearing all selected weekdays renders a safe empty day rather than a valid blank schedule", () => {
  const day = build({ ...planningSettings(), weekdays: [] });
  assert.equal(day.valid, false);
  assert.equal(day.date, undefined);
  assert.deepEqual(day.working, []);
  assert.deepEqual(day.lanes, []);
});
test("a clipped overnight tail is labeled an estimate and explains which calendar day is visible", () => {
  const now = Date.parse("2026-10-12T23:00:00Z");
  const account = planningAccount("a");
  const usage = { a: planningUsage(account, now) };
  const workday = { ...planningSettings(), start: "22:00", end: "06:00" };
  const html = renderToStaticMarkup(
    createElement(DailySchedule, {
      accounts: [account],
      usage,
      workday,
      plan: workdayPlan([account], usage, workday, now),
      now,
      t: (_tr: string, en: string) => en,
    }),
  );
  assert.match(html, /22:00 \(-1 day\)/);
  assert.match(html, /± day labels refer to other calendar days/);
  assert.match(html, /<span>Estimate<\/span>/);
  assert.doesNotMatch(html, /<span>5 h<\/span>/);
});
test("the figure preserves visible and accessible blocked-slot reasons rather than relying on faded color", () => {
  const account = planningAccount("a");
  const usage = { a: planningUsage(account, NOW) };
  const workday = planningSettings();
  const plan = workdayPlan([account], usage, workday, NOW);
  for (const [reason, label] of [
    ["already-active", "Window already active"],
    ["outside-workday", "Outside working hours"],
  ] as const) {
    plan.slots[0].reason = reason;
    const html = renderToStaticMarkup(
      createElement(DailySchedule, {
        accounts: [account],
        usage,
        workday,
        plan,
        now: NOW,
        t: (_tr: string, en: string) => en,
      }),
    );
    assert.ok(
      html.includes(`class="day-schedule-slot-status">${label}</span>`),
    );
    assert.ok(html.includes(`; ${label}"`));
  }
});
test("choosing the next calendar day reveals midnight-crossing proposals without creating a new plan", () => {
  const now = Date.parse("2026-10-13T18:00:00Z"); // 21:00 in Istanbul
  const accounts = [
    planningAccount("a"),
    planningAccount("b"),
    planningAccount("c"),
  ];
  const usage = Object.fromEntries(
    accounts.map((a) => [a.id, planningUsage(a, now)]),
  );
  const workday = {
    ...planningSettings(accounts.map((a) => a.id)),
    start: "22:00",
    end: "06:00",
  };
  const plan = workdayPlan(accounts, usage, workday, now);
  const firstDay = dailySchedule(accounts, usage, workday, plan, now);
  assert.equal(firstDay.date, "2026-10-13");
  assert.deepEqual(firstDay.lanes[2].proposal?.segments, []);
  const nextDay = dailySchedule(
    accounts,
    usage,
    workday,
    plan,
    now,
    "2026-10-14",
  );
  assert.equal(nextDay.date, "2026-10-14");
  assert.equal(nextDay.nowMinute, undefined);
  assert.deepEqual(
    nextDay.lanes.map((lane) =>
      lane.proposal?.segments.map((segment) => [
        segment.startMinute,
        segment.endMinute,
      ]),
    ),
    [[[0, 180]], [[0, 240]], [[0, 300]]],
  );
  assert.equal(nextDay.lanes[0].proposal?.start.dayOffset, -1);
  assert.equal(nextDay.lanes[2].proposal?.start.dayOffset, 0);
  assert.deepEqual(
    nextDay.lanes.map((lane) => lane.proposal?.start.at),
    firstDay.lanes.map((lane) => lane.proposal?.start.at),
  );
  const laterDay = dailySchedule(
    accounts,
    usage,
    workday,
    plan,
    now,
    "2026-10-15",
  );
  assert.ok(
    laterDay.lanes.every((lane) => lane.proposal?.segments.length === 0),
  );
  assert.equal(laterDay.nowMinute, undefined);
});
test("a requested calendar day requires a real civil date and valid timezone", () => {
  const account = planningAccount("a");
  const usage = { a: planningUsage(account, NOW) };
  const workday = planningSettings();
  const plan = workdayPlan([account], usage, workday, NOW);
  for (const date of ["", "2026-02-30", "2026-10-1", "2026-13-01", "tomorrow"])
    assert.equal(
      dailySchedule([account], usage, workday, plan, NOW, date).valid,
      false,
    );
  assert.equal(
    dailySchedule(
      [account],
      usage,
      { ...workday, timeZone: "Invalid/Zone" },
      plan,
      NOW,
      "2026-10-14",
    ).valid,
    false,
  );
});
