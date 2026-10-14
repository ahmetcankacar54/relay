import test from "node:test";
import assert from "node:assert/strict";
import { forecastSummary } from "../src/lib/forecast-text";
import type { Forecast } from "../shared/capacity-plan";

const H = 3_600_000;
const M = 60_000;
const at = (hour: number, minute = 0) => hour * H + minute * M;
/** "14:18" for a time counted from midnight. */
const clock = (time: number) =>
  `${String(Math.floor(time / H)).padStart(2, "0")}:${String(Math.floor((time % H) / M)).padStart(2, "0")}`;
const tr = (text: string) => text;
const en = (_: string, text: string) => text;

/** A day from 09:00 to 18:00 with the given outages (no account) in between. */
function forecast(
  switches: number,
  outages: [number, number][] = [],
): Forecast {
  const segments: Forecast["segments"] = [];
  let cursor = at(9);
  for (const [from, to] of outages) {
    segments.push({ accountId: "a", from: cursor, to: from }, { from, to });
    cursor = to;
  }
  segments.push({ accountId: "b", from: cursor, to: at(18) });
  return {
    segments,
    unmet: outages.length * 50,
    outageMinutes: outages.reduce((n, [from, to]) => n + (to - from) / M, 0),
    switches,
    exhaustedAt: {},
  };
}
const gap: [number, number] = [at(14, 18), at(14, 50)];
const later: [number, number] = [at(16, 2), at(16, 15)];

test("a day without gaps counts its switches", () => {
  assert.equal(forecastSummary(forecast(3), tr, clock), "Kesintisiz · 3 geçiş");
  assert.equal(forecastSummary(forecast(1), tr, clock), "Kesintisiz · 1 geçiş");
  assert.equal(
    forecastSummary(forecast(0), tr, clock),
    "Kesintisiz · geçiş yok",
  );
  assert.equal(forecastSummary(forecast(3), en, clock), "No gaps · 3 switches");
  assert.equal(forecastSummary(forecast(1), en, clock), "No gaps · 1 switch");
  assert.equal(
    forecastSummary(forecast(0), en, clock),
    "No gaps · no switches",
  );
});

test("a gap names its time; several gaps name the first", () => {
  assert.equal(
    forecastSummary(forecast(5, [gap]), tr, clock),
    "14:18–14:50 kotasız · 5 geçiş",
  );
  assert.equal(
    forecastSummary(forecast(5, [gap]), en, clock),
    "No quota 14:18–14:50 · 5 switches",
  );
  assert.equal(
    forecastSummary(forecast(5, [gap, later]), tr, clock),
    "2 kotasız aralık, ilk 14:18–14:50 · 5 geçiş",
  );
  assert.equal(
    forecastSummary(forecast(5, [gap, later]), en, clock),
    "2 no-quota gaps, first 14:18–14:50 · 5 switches",
  );
});
