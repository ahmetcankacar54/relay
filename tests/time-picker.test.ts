import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TimePicker } from "../src/features/TimePicker";
import {
  clockFieldKey,
  formatPickerClock,
  parseLooseClock,
  parsePickerClock,
  stepClock,
} from "../shared/time-picker";

test("manual clock entry preserves every minute and canonicalizes a short hour", () => {
  assert.equal(formatPickerClock(parsePickerClock("09:17")!), "09:17");
  assert.equal(formatPickerClock(parsePickerClock("9:17")!), "09:17");
  assert.equal(formatPickerClock(parsePickerClock(" 23:59 ")!), "23:59");
  assert.equal(formatPickerClock(parsePickerClock("00:00")!), "00:00");
});

test("manual entry rejects ambiguous or out-of-range clocks", () => {
  for (const value of [
    "24:00",
    "12:60",
    "-1:00",
    "9:7",
    "123:00",
    "09",
    "",
    "09:17:00",
    "09:17am",
  ])
    assert.equal(parsePickerClock(value), null, value);
});

test("loose entry accepts hour-only, compact and dotted forms", () => {
  const cases: Array<[string, string]> = [
    ["9", "09:00"],
    ["17", "17:00"],
    ["930", "09:30"],
    ["0930", "09:30"],
    ["9.30", "09:30"],
    ["9:30", "09:30"],
    ["23:59", "23:59"],
  ];
  for (const [input, expected] of cases)
    assert.equal(formatPickerClock(parseLooseClock(input)!), expected, input);
  for (const input of ["24", "960", "12:60", "", "9:3", "12345"])
    assert.equal(parseLooseClock(input), null, JSON.stringify(input));
});

test("arrow steps snap to quarter hours and wrap at midnight", () => {
  assert.equal(stepClock("09:17", 1), "09:30");
  assert.equal(stepClock("09:17", -1), "09:15");
  assert.equal(stepClock("09:15", 1), "09:30");
  assert.equal(stepClock("23:50", 1), "00:00");
  assert.equal(stepClock("00:00", -1), "23:45");
  assert.equal(stepClock("09:00", 2), "09:30");
  assert.equal(stepClock("09:17", 1, 60), "10:00");
});

test("only arrow and page keys change the field", () => {
  assert.equal(clockFieldKey("09:17", "ArrowUp"), "09:30");
  assert.equal(clockFieldKey("09:17", "ArrowDown"), "09:15");
  assert.equal(clockFieldKey("09:17", "PageUp"), "10:00");
  assert.equal(clockFieldKey("09:17", "PageDown"), "09:00");
  assert.equal(clockFieldKey("09:17", "Enter"), null);
  assert.equal(clockFieldKey("09:17", "a"), null);
});

test("the inline field is a labelled spinbutton with no popover", () => {
  let commits = 0;
  const markup = renderToStaticMarkup(
    createElement(TimePicker, {
      id: "start",
      label: "Start",
      value: "09:17",
      disabled: true,
      onChange: () => commits++,
      t: (_tr, en) => en,
    }),
  );
  assert.match(markup, /for="start"/);
  assert.match(markup, /role="spinbutton"/);
  assert.match(markup, /aria-valuenow="557"/);
  assert.match(markup, /aria-valuetext="09:17"/);
  assert.match(markup, /value="09:17"/);
  assert.match(markup, /disabled=""/);
  assert.doesNotMatch(markup, /aria-expanded/);
  assert.doesNotMatch(markup, /Uygula|Apply/);
  assert.equal(commits, 0);
});
