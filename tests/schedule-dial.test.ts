import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dialPoint, dialSegmentPath } from "../shared/schedule-dial";
import { DailySchedule } from "../src/DailySchedule";
import { workdayPlan } from "../shared/planning";
import {
  planningAccount,
  planningSettings,
  planningUsage,
} from "./planning-fixtures";

test("the 24-hour dial places midnight at top and six-hour quarters clockwise", () => {
  const points = [0, 360, 720, 1_080, 1_440].map((minute) => {
    const point = dialPoint(minute, 100);
    return [Math.round(point.x), Math.round(point.y)];
  });
  assert.deepEqual(points, [
    [180, 80],
    [280, 180],
    [180, 280],
    [80, 180],
    [180, 80],
  ]);
});
test("a full-day segment draws two SVG arcs instead of an invisible equal-endpoint arc", () => {
  const path = dialSegmentPath(0, 1_440, 100);
  assert.equal(path, "M 180 80 A 100 100 0 0 1 180 280 A 100 100 0 0 1 180 80");
  assert.equal((path.match(/ A /g) ?? []).length, 2);
});
test("short forecasts use the small clockwise arc and long working bands use the large arc", () => {
  assert.match(dialSegmentPath(0, 300, 100), /A 100 100 0 0 1/);
  assert.match(dialSegmentPath(0, 900, 100), /A 100 100 0 1 1/);
  assert.match(dialSegmentPath(0, 720, 100), /A 100 100 0 0 1/);
});
test("separate DST segments remain separate paths with their actual wall-clock boundaries", () => {
  const spring = [
    [0, 120],
    [180, 360],
  ].map(([start, end]) => dialSegmentPath(start, end, 100));
  assert.equal(spring.length, 2);
  assert.ok(spring.every((path) => (path.match(/ A /g) ?? []).length === 1));
  const repeated = [
    [105, 120],
    [60, 75],
  ].map(([start, end]) => dialSegmentPath(start, end, 100));
  assert.ok(repeated.every(Boolean));
  assert.notEqual(repeated[0], repeated[1]);
});
test("invalid dial segments produce no path and never wrap into another day", () => {
  for (const [start, end, radius] of [
    [-1, 300, 100],
    [0, 1_441, 100],
    [300, 300, 100],
    [300, 0, 100],
    [0, 300, 0],
    [NaN, 300, 100],
    [0, Infinity, 100],
  ])
    assert.equal(dialSegmentPath(start, end, radius), "");
});

test("an anchored full-day schedule identifies its actual clock range rather than claiming the visible calendar day is fully covered", () => {
  const now = Date.parse("2026-10-13T04:00:00Z"); // Tuesday 07:00 Istanbul
  const account = planningAccount("a");
  const usage = { a: planningUsage(account, now) };
  const workday = {
    ...planningSettings(),
    weekdays: [1],
    start: "09:00",
    end: "09:00",
  };
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
  assert.match(html, /09:00 → 09:00 \(\+1 day\)/);
  assert.doesNotMatch(html, /Full day · 00–24/);
  assert.match(html, /aria-pressed="true"[^>]*>.*Timeline/);
  assert.match(html, /24-hour clock/);
});
