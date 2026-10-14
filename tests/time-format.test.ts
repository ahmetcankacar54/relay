import test from "node:test";
import assert from "node:assert/strict";
import { formatReset, formatRelative } from "../src/lib/time";
const NOW = Date.parse("2026-10-14T09:10:00Z"); // 12:10 Istanbul
const Z = "Europe/Istanbul";
test("reset labels show clock and remaining time", () => {
  assert.equal(formatReset("2026-10-14T11:20:00Z", NOW, "tr", Z), "14:20 · 2 sa 10 dk");
  assert.equal(formatReset("2026-10-14T11:20:00Z", NOW, "en", Z), "14:20 · 2 h 10 min");
  assert.equal(formatReset("2026-10-18T06:00:00Z", NOW, "tr", Z), "Pazar 09:00 · 4 gün");
  assert.equal(formatReset("2026-10-14T09:00:00Z", NOW, "tr", Z), "şimdi");
});
test("relative times", () => {
  assert.equal(formatRelative("2026-10-14T09:09:00Z", NOW, "tr"), "1 dk önce");
  assert.equal(formatRelative("2026-10-14T09:09:50Z", NOW, "en"), "just now");
});
test("reset label edge cases", () => {
  assert.equal(formatReset("2026-10-18T06:00:00Z", NOW, "en", Z), "Sunday 09:00 · 4 days");
  assert.equal(formatReset("2026-10-14T09:40:00Z", NOW, "en", Z), "12:40 · 30 min");
  assert.equal(formatReset("not a date", NOW, "en", Z), "");
  assert.equal(formatRelative("2026-10-14T07:05:00Z", NOW, "tr"), "2 sa önce");
  assert.equal(formatRelative("2026-10-14T07:05:00Z", NOW, "en"), "2 h ago");
});
