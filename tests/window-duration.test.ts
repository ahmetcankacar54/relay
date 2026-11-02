import test from "node:test";
import assert from "node:assert/strict";
import { formatDuration, windowMinutes } from "../src/lib/window-duration";

const tr = (text: string) => text;
const en = (_: string, text: string) => text;

test("a window lasts its capacity in Pro units at the tempo, to five minutes", () => {
  assert.equal(windowMinutes(1, 205), 30);
  assert.equal(windowMinutes(5, 205), 145);
  assert.equal(windowMinutes(2, 205), 60);
  assert.equal(windowMinutes(5, 50), 600);
  assert.equal(windowMinutes(1, 0), undefined);
  assert.equal(windowMinutes(1, -5), undefined);
  assert.equal(windowMinutes(1, Number.NaN), undefined);
  // Never "~0 dk": a window lasts at least five minutes.
  assert.equal(windowMinutes(1, 5000), 5);
});

test("durations read in hours and minutes", () => {
  assert.equal(formatDuration(145, tr), "~2 sa 25 dk");
  assert.equal(formatDuration(30, tr), "~30 dk");
  assert.equal(formatDuration(600, tr), "~10 sa");
  assert.equal(formatDuration(30, en), "~30 min");
  assert.equal(formatDuration(145, en), "~2 h 25 min");
  assert.equal(formatDuration(600, en), "~10 h");
});
