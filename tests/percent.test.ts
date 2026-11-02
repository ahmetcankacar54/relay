import test from "node:test";
import assert from "node:assert/strict";
import {
  formatPercent,
  formatUsed,
  percentUsed,
  usedWord,
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

test("the meter module hands out the same helpers", () => {
  assert.equal(meter.formatPercent, formatPercent);
  assert.equal(meter.formatUsed, formatUsed);
  assert.equal(meter.percentUsed, percentUsed);
  assert.equal(meter.usedWord, usedWord);
});

test("the percent used is rounded down and kept between 0 and 100", () => {
  assert.equal(percentUsed(94), 94);
  assert.equal(percentUsed(0), 0);
  assert.equal(percentUsed(100), 100);
  // Only a full window reads 100: 99.9 used shows 99.
  assert.equal(percentUsed(93.5), 93);
  assert.equal(percentUsed(99.9), 99);
  assert.equal(percentUsed(0.2), 0);
  assert.equal(percentUsed(150), 100);
  assert.equal(percentUsed(-5), 0);
  assert.equal(percentUsed(undefined), undefined);
  assert.equal(percentUsed(NaN), undefined);
  assert.equal(percentUsed(Infinity), undefined);
});

test("a limit percentage always carries its word: %94 kullanıldı, 94% used", () => {
  assert.equal(formatUsed(94, "tr"), "%94 kullanıldı");
  assert.equal(formatUsed(94, "en"), "94% used");
  assert.equal(formatUsed(93.5, "tr"), "%93 kullanıldı");
  assert.equal(formatUsed(99.9, "tr"), "%99 kullanıldı");
  assert.equal(formatUsed(99.9, "en"), "99% used");
  assert.equal(formatUsed(100, "tr"), "%100 kullanıldı");
  assert.equal(formatUsed(100, "en"), "100% used");
  assert.equal(formatUsed(-5, "tr"), "%0 kullanıldı");
  assert.equal(formatUsed(0, "en"), "0% used");
  assert.equal(formatUsed(150, "tr"), "%100 kullanıldı");
  assert.equal(formatUsed(undefined, "tr"), "—");
  assert.equal(formatUsed(NaN, "en"), "—");
  assert.equal(usedWord("tr"), "kullanıldı");
  assert.equal(usedWord("en"), "used");
});
