import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TimePicker } from "../src/features/TimePicker";
import {
  formatPickerClock,
  moveTimeGridCursor,
  parsePickerClock,
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

test("keyboard grid navigation moves between rows and clamps at edges", () => {
  assert.equal(moveTimeGridCursor(6, "ArrowUp", 24), 0);
  assert.equal(moveTimeGridCursor(0, "ArrowLeft", 24), 0);
  assert.equal(moveTimeGridCursor(23, "ArrowDown", 24), 23);
  assert.equal(moveTimeGridCursor(23, "Home", 24), 0);
  assert.equal(moveTimeGridCursor(0, "End", 12), 11);
  assert.equal(moveTimeGridCursor(4, "ArrowRight", 24), 5);
  assert.equal(moveTimeGridCursor(4, "Enter", 24), null);
});

test("closed picker exposes a labelled disabled-aware 24h trigger without committing", () => {
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
  assert.match(markup, /aria-label="Start, 09:17, 24-hour"/);
  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, /disabled=""/);
  assert.equal(commits, 0);
});
