import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TimePicker } from "../src/features/TimePicker";
import {
  clockFieldKey,
  clockStart,
  formatPickerClock,
  leaveClockField,
  parseLooseClock,
  parsePickerClock,
  shouldResyncDraft,
  stepClock,
  timeFieldAccess,
  wheelSteps,
  type WheelState,
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

test("a disabled picker that is not focused is a real disabled input", () => {
  const html = (disabled: boolean) =>
    renderToStaticMarkup(
      createElement(TimePicker, {
        id: "end",
        label: "End",
        value: "18:00",
        disabled,
        onChange: () => {},
        t: (_tr, en) => en,
      }),
    );
  assert.match(html(true), /\sdisabled=""/);
  assert.match(html(true), /\saria-disabled="true"/);
  assert.doesNotMatch(html(true), /\sreadOnly=""/);
  assert.doesNotMatch(
    html(false),
    /\sdisabled=""|\saria-disabled=|\sreadOnly=/,
  );
});

test("a busy field keeps focus read-only instead of turning disabled", () => {
  assert.deepEqual(timeFieldAccess(false, false), {
    disabled: false,
    readOnly: false,
  });
  assert.deepEqual(timeFieldAccess(false, true), {
    disabled: false,
    readOnly: false,
  });
  assert.deepEqual(timeFieldAccess(true, false), {
    disabled: true,
    readOnly: false,
  });
  assert.deepEqual(timeFieldAccess(true, true), {
    disabled: false,
    readOnly: true,
  });
});

test("the draft follows the saved value only while the field is idle", () => {
  assert.equal(shouldResyncDraft(false, false), true);
  assert.equal(shouldResyncDraft(true, false), false);
  assert.equal(shouldResyncDraft(false, true), false);
  assert.equal(shouldResyncDraft(true, true), false);
});

test("leaving the field saves only a draft the user edited", () => {
  // Untouched: the saved value may have changed while the field had focus
  // (the automatic first start, say), so it is shown and nothing is written.
  assert.deepEqual(leaveClockField("09:00", "09:30", false), {
    draft: "09:30",
  });
  // Edited: the canonical clock is saved when it differs.
  assert.deepEqual(leaveClockField("9", "09:30", true), {
    draft: "09:00",
    save: "09:00",
  });
  assert.deepEqual(leaveClockField("9.30", "09:30", true), { draft: "09:30" });
  // An edited draft that is not a time reverts.
  assert.deepEqual(leaveClockField("ab", "09:30", true), { draft: "09:30" });
});

test("steps start from a valid typed draft, else from the saved value", () => {
  assert.equal(clockStart("9:30", "18:00"), "09:30");
  assert.equal(clockStart("17", "18:00"), "17:00");
  assert.equal(clockStart("ab", "18:00"), "18:00");
  assert.equal(clockStart("", "18:00"), "18:00");
});

test("wheel gives at most one step per event and forgets idle scrolling", () => {
  const fresh: WheelState = { total: 0, at: -Infinity };
  // A 100 px notch is one step, in the direction of deltaY.
  const notch = wheelSteps(fresh, 100, 1000);
  assert.equal(notch.steps, 1);
  assert.equal(wheelSteps(fresh, -100, 1000).steps, -1);
  // A huge delta is still one step.
  assert.equal(wheelSteps(fresh, 4000, 1000).steps, 1);
  // The remainder is dropped, so back-to-back notches stay one step each.
  assert.equal(wheelSteps(notch.state, 100, 1050).steps, 1);
  // Two small events close together add up to one step...
  const first = wheelSteps(fresh, 30, 1000);
  assert.equal(first.steps, 0);
  assert.equal(wheelSteps(first.state, 30, 1150).steps, 1);
  // ...but not when the first one is more than 200 ms old.
  assert.equal(wheelSteps(first.state, 30, 1250).steps, 0);
  // Reversing direction starts over.
  assert.equal(wheelSteps(first.state, -30, 1100).steps, 0);
  assert.equal(
    wheelSteps(wheelSteps(first.state, -30, 1100).state, -30, 1150).steps,
    -1,
  );
});
