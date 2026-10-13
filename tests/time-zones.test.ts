import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TimeZonePicker } from "../src/TimeZonePicker";
import {
  COMMON_TIME_ZONES,
  buildTimeZoneCatalog,
  filterTimeZones,
  foldTimeZoneSearch,
  timeZoneCity,
  timeZoneOffset,
  timeZoneOptions,
  validTimeZone,
} from "../shared/time-zones";

const WINTER = Date.parse("2026-01-15T12:00:00Z");
const SUMMER = Date.parse("2026-07-15T12:00:00Z");

test("catalog pins common zones and locally falls back without supportedValuesOf", () => {
  const fallback = buildTimeZoneCatalog();
  assert.deepEqual(fallback.slice(0, 8), COMMON_TIME_ZONES);
  assert.equal(new Set(fallback).size, fallback.length);
  assert.ok(fallback.includes("Asia/Kathmandu"));
  assert.ok(fallback.includes("Australia/Adelaide"));
  const supplied = buildTimeZoneCatalog([
    "Europe/Paris",
    "invalid/zone",
    "UTC",
  ]);
  assert.ok(supplied.includes("Europe/Paris"));
  assert.ok(!supplied.includes("invalid/zone"));
});

test("offsets are date-aware and support fractional-hour zones and malformed inputs", () => {
  assert.equal(timeZoneOffset("Europe/London", WINTER), "UTC+00:00");
  assert.equal(timeZoneOffset("Europe/London", SUMMER), "UTC+01:00");
  assert.equal(timeZoneOffset("America/New_York", WINTER), "UTC-05:00");
  assert.equal(timeZoneOffset("America/New_York", SUMMER), "UTC-04:00");
  assert.equal(timeZoneOffset("Asia/Kathmandu", SUMMER), "UTC+05:45");
  assert.equal(timeZoneOffset("Europe/Istanbul", WINTER), "UTC+03:00");
  assert.equal(timeZoneOffset("not-a-zone", WINTER), "—");
  assert.equal(timeZoneOffset("UTC", NaN), "—");
  assert.equal(timeZoneOffset("UTC", 1e30), "—");
  assert.equal(timeZoneCity("not-a-zone"), "—");
});

test("search treats Turkish I forms and accented/underscored city names consistently", () => {
  assert.equal(foldTimeZoneSearch("İSTANBUL"), "istanbul");
  assert.equal(foldTimeZoneSearch("ıstanbul"), "istanbul");
  assert.equal(foldTimeZoneSearch("São_Paulo"), "sao paulo");
  const options = timeZoneOptions("Europe/Istanbul", SUMMER, [
    "Europe/Istanbul",
    "America/Sao_Paulo",
    "Asia/Kathmandu",
  ]);
  assert.equal(
    filterTimeZones(options, "İSTANBUL", SUMMER)[0].zone,
    "Europe/Istanbul",
  );
  assert.equal(
    filterTimeZones(options, "sao paulo", SUMMER)[0].zone,
    "America/Sao_Paulo",
  );
  assert.equal(
    filterTimeZones(options, "GMT+3", SUMMER)[0].zone,
    "Europe/Istanbul",
  );
  assert.equal(
    filterTimeZones(options, "+05:45", SUMMER)[0].zone,
    "Asia/Kathmandu",
  );
});

test("valid persisted and exact searched IANA aliases remain explicitly selectable", () => {
  const options = timeZoneOptions("US/Eastern", WINTER, [
    "UTC",
    "Europe/Istanbul",
  ]);
  assert.equal(options[0].zone, "US/Eastern");
  assert.equal(options[0].offset, "UTC-05:00");
  assert.equal(
    filterTimeZones(options, "Asia/Calcutta", WINTER)[0].zone,
    "Asia/Calcutta",
  );
  assert.deepEqual(filterTimeZones(options, "Asia/Calcut", WINTER), []);
  assert.equal(validTimeZone(" Europe/London "), false);
  assert.equal(validTimeZone("+05:45"), false);
  assert.equal(validTimeZone("Asia/DefinitelyNotAZone"), false);
  assert.equal(
    new Set(timeZoneOptions("UTC", WINTER).map((option) => option.zone)).size,
    timeZoneOptions("UTC", WINTER).length,
  );
});

test("closed picker exposes labelled current identity and dated offset without backend action", () => {
  let updates = 0;
  const html = renderToStaticMarkup(
    createElement(TimeZonePicker, {
      id: "zone",
      label: "Time zone",
      value: "Europe/London",
      disabled: true,
      onChange: () => updates++,
      t: (_tr, en) => en,
      now: SUMMER,
    }),
  );
  assert.match(html, /aria-labelledby="zone-label zone-value"/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /Europe\/London/);
  assert.match(html, /UTC\+01:00/);
  assert.match(html, /disabled=""/);
  assert.equal(updates, 0);
  assert.doesNotMatch(html, /role="listbox"/);
});
