import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TimePicker } from "../src/TimePicker";
import {
  formatPickerClock,
  moveTimeGridCursor,
  parsePickerClock,
  positionTimePopover,
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

test("popover flips above near the bottom and fits a narrow window", () => {
  const position = positionTimePopover(
    { left: 240, top: 420, bottom: 464 },
    { width: 319, height: 560 },
    480,
  );
  assert.equal(position.width, 295);
  assert.equal(position.left, 12);
  assert.ok(position.top < 420);
  assert.ok(position.top >= 12);
  assert.ok(position.top + position.maxHeight <= 548);
});

test("popover stays within the viewport on both desktop and short windows", () => {
  for (const viewport of [
    { width: 720, height: 560 },
    { width: 375, height: 320 },
  ]) {
    const position = positionTimePopover(
      { left: 36, top: viewport.height / 2, bottom: viewport.height / 2 + 44 },
      viewport,
      480,
    );
    assert.ok(position.left >= 0);
    assert.ok(position.top >= 0);
    assert.ok(position.left + position.width <= viewport.width);
    assert.ok(position.top + position.maxHeight <= viewport.height);
  }
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
