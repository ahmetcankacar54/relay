import test from "node:test";
import assert from "node:assert/strict";
import {
  formatLeft,
  formatPercent,
  leftWord,
  percentLeft,
} from "../shared/percent";
import * as meter from "../src/lib/meter";

test("a percentage reads %6 in Turkish and 6% in English, rounded, and a dash when unknown", () => {
  assert.equal(formatPercent(6, "tr"), "%6");
  assert.equal(formatPercent(6, "en"), "6%");
  assert.equal(formatPercent(5.6, "tr"), "%6");
  assert.equal(formatPercent(5.4, "en"), "5%");
  assert.equal(formatPercent(undefined, "tr"), "—");
  assert.equal(formatPercent(NaN, "en"), "—");
});

test("the meter module hands out the same helper", () => {
  assert.equal(meter.formatPercent, formatPercent);
});

test("what is left comes from the percent used, rounded down and kept between 0 and 100", () => {
  assert.equal(percentLeft(94), 6);
  assert.equal(percentLeft(0), 100);
  assert.equal(percentLeft(100), 0);
  // Never more than the window really has: 93.5 used leaves 6.5, shown as 6.
  assert.equal(percentLeft(93.5), 6);
  assert.equal(percentLeft(99.9), 0);
  assert.equal(percentLeft(0.2), 99);
  assert.equal(percentLeft(120), 0);
  assert.equal(percentLeft(-5), 100);
  assert.equal(percentLeft(undefined), undefined);
  assert.equal(percentLeft(NaN), undefined);
});

test("a limit percentage always carries its word: %6 kaldı, 6% left", () => {
  assert.equal(formatLeft(94, "tr"), "%6 kaldı");
  assert.equal(formatLeft(94, "en"), "6% left");
  assert.equal(formatLeft(100, "tr"), "%0 kaldı");
  assert.equal(formatLeft(0, "en"), "100% left");
  assert.equal(formatLeft(undefined, "tr"), "—");
  assert.equal(formatLeft(NaN, "en"), "—");
  assert.equal(leftWord("tr"), "kaldı");
  assert.equal(leftWord("en"), "left");
});
