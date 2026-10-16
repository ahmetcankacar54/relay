import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  StrictMode,
  act,
  createElement,
  type MouseEvent,
  type ReactElement,
} from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  NibbleCursorLayer,
  NibbleCursorView,
  nibbleController,
} from "../src/pranks/NibbleCursor";
import {
  PrankStage,
  usePrank,
  type PrankApi,
  type PrankPlay,
} from "../src/pranks/PrankStage";
import { PRANK_LAYERS } from "../src/pranks/registry";
import { I18nContext } from "../src/data/i18n";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { itemHandlers } from "../src/pages/accounts/AccountsTable";
import { Panel } from "../src/panel/Panel";
import { PanelAccounts } from "../src/panel/PanelAccounts";
import { PrankContext } from "../src/pranks/context";
import {
  DEFAULT_SETTINGS,
  type Account,
  type AccountUsage,
  type Snapshot,
} from "../shared/types";
import {
  NIBBLE_ABORT_PX,
  NIBBLE_MAX_MS,
  NIBBLE_MS,
  NIBBLE_SIZE,
  nibbleAborts,
  nibbleFrame,
  nibbleLayout,
  type NibblePhase,
  type NibbleRect,
} from "../src/pranks/timing";
import { mediaBlock } from "./css";
import { fakeDom } from "./fake-dom";

const CLASS = "prank-cursor-hidden";
const VIEWPORT = { width: 1_000, height: 800 };

// --- the view, phase by phase -----------------------------------------------

/** A click near the bottom edge (the panda stays upright), and one near the left edge (it turns 90 degrees). */
const START = { x: 500, y: 700 };
const BOTTOM = nibbleLayout(START, VIEWPORT);
const LEFT_START = { x: 30, y: 400 };
const LEFT = nibbleLayout(LEFT_START, VIEWPORT);
const POINTER = { x: 520, y: 690 };

const view = (
  phase: NibblePhase,
  bitten = false,
  extra: Partial<Parameters<typeof NibbleCursorView>[0]> = {},
) =>
  renderToStaticMarkup(
    createElement(NibbleCursorView, {
      frame: { phase, bitten },
      layout: BOTTOM,
      start: START,
      pointer: POINTER,
      ...extra,
    }),
  );

/** The opening <svg> tag of the rig, and of the drawn cursor, in some markup. */
const rigTag = (html: string) =>
  html.match(/<svg [^>]*data-pose="[^"]*"[^>]*>/)?.[0];
const cursorTag = (html: string) =>
  html.match(/<svg [^>]*data-prank-cursor="[^"]*"[^>]*>/)?.[0];
const attr = (tag: string | undefined, name: string) =>
  tag?.match(new RegExp(`${name}="([^"]*)"`))?.[1];
/** Where the drawn cursor's tip is: the translate() of its style. */
const cursorAt = (html: string) => {
  const m = cursorTag(html)?.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : undefined;
};

test("peek: a peek rig at the layout's left and top, turned by the layout's rotation, and the cursor where the click was", () => {
  const html = view("peek");
  const rig = rigTag(html);
  assert.equal(attr(rig, "data-pose"), "peek");
  assert.equal(attr(rig, "data-props"), "");
  assert.equal(attr(rig, "width"), String(NIBBLE_SIZE));
  assert.match(
    html,
    new RegExp(
      `^<div class="absolute" style="left:${BOTTOM.left}px;top:${BOTTOM.top}px;[^"]*transform:rotate\\(${BOTTOM.rotate}deg\\)"`,
    ),
  );
  assert.equal(attr(cursorTag(html), "data-prank-cursor"), "whole");
  assert.deepEqual(cursorAt(html), START);
  assert.equal(html.match(/data-pose=/g)?.length, 1);
});

test("the panda turns with the nearest edge: bottom 0, left 90, top 180, right -90", () => {
  const edges = [
    [{ x: 500, y: 790 }, 0],
    [{ x: 10, y: 400 }, 90],
    [{ x: 500, y: 10 }, 180],
    [{ x: 990, y: 400 }, -90],
  ] as const;
  for (const [point, rotate] of edges) {
    const layout = nibbleLayout(point, VIEWPORT);
    const html = view("peek", false, { layout, start: point });
    assert.equal(layout.rotate, rotate);
    assert.ok(
      html.includes(`left:${layout.left}px;top:${layout.top}px`),
      `${rotate} left/top`,
    );
    assert.ok(
      html.includes(`transform:rotate(${rotate}deg)`),
      `${rotate} turn`,
    );
  }
  assert.ok(
    view("peek", false, { layout: LEFT, start: LEFT_START }).includes(
      "rotate(90deg)",
    ),
  );
});

test("fly-in: the chewing panda holds nothing yet and the whole cursor sets off for the held point", () => {
  const html = view("fly-in");
  const rig = rigTag(html);
  assert.equal(attr(rig, "data-pose"), "chew");
  assert.equal(attr(rig, "data-props"), "");
  assert.equal(attr(cursorTag(html), "data-prank-cursor"), "whole");
  assert.equal(attr(cursorTag(html), "data-flight"), "in");
  assert.deepEqual(cursorAt(html), BOTTOM.held);
});

test("chew: the panda holds the whole cursor, then the bitten one from the third nibble, and no drawn cursor is left", () => {
  const whole = view("chew", false);
  assert.equal(attr(rigTag(whole), "data-pose"), "chew");
  assert.equal(attr(rigTag(whole), "data-props"), "cursor");
  assert.equal(cursorTag(whole), undefined);
  const bitten = view("chew", true);
  assert.equal(attr(rigTag(bitten), "data-pose"), "chew");
  assert.equal(attr(rigTag(bitten), "data-props"), "cursor-bitten");
  assert.equal(cursorTag(bitten), undefined);
  // The panda chews while it holds the cursor.
  assert.equal(attr(rigTag(whole), "data-motion"), "chew");
});

test("fly-out and withdraw: the panda holds nothing and the bitten cursor is at the pointer", () => {
  for (const phase of ["fly-out", "withdraw"] as const) {
    const html = view(phase, true);
    assert.equal(attr(rigTag(html), "data-pose"), "chew", phase);
    assert.equal(attr(rigTag(html), "data-props"), "", phase);
    assert.equal(attr(cursorTag(html), "data-prank-cursor"), "bitten", phase);
    assert.equal(attr(cursorTag(html), "data-flight"), "out", phase);
    assert.deepEqual(cursorAt(html), POINTER, phase);
    // It sets off from where the panda held it.
    assert.ok(html.includes(`--prank-from-x:${BOTTOM.held.x}px`), phase);
    assert.ok(html.includes(`--prank-from-y:${BOTTOM.held.y}px`), phase);
  }
});

test("the cursor follows the pointer it is given", () => {
  assert.deepEqual(
    cursorAt(view("withdraw", true, { pointer: { x: 111, y: 222 } })),
    { x: 111, y: 222 },
  );
  assert.deepEqual(cursorAt(view("peek", false, { start: { x: 5, y: 6 } })), {
    x: 5,
    y: 6,
  });
});

test("done draws nothing", () => {
  assert.equal(view("done"), "");
  assert.equal(view("done", true), "");
});

test("the panda slides in on its peek and out on its withdraw, and stays put in between", () => {
  const phases = ["peek", "fly-in", "chew", "fly-out", "withdraw"] as const;
  for (const phase of phases)
    assert.ok(view(phase).includes(`data-phase="${phase}"`), phase);
});

test("the drawn cursor is a decorative arrow in theme classes; nothing takes a click or uses a hex colour", () => {
  for (const phase of ["peek", "fly-in", "fly-out", "withdraw"] as const) {
    const html = view(phase, phase === "fly-out" || phase === "withdraw");
    const tag = cursorTag(html);
    assert.ok(tag, phase);
    assert.equal(attr(tag, "aria-hidden"), "true");
    assert.equal(attr(tag, "focusable"), "false");
    assert.equal(attr(tag, "width"), "16");
    assert.equal(attr(tag, "height"), "22");
    assert.match(attr(tag, "class") ?? "", /\bfill-neutral-950\b/);
    assert.match(attr(tag, "class") ?? "", /\bstroke-neutral-50\b/);
    assert.ok(!html.includes("pointer-events-auto"), phase);
  }
  const whole = view("peek").match(/<path d="([^"]*)"/)?.[1];
  const bitten = view("withdraw", true).match(/<path d="([^"]*)"/)?.[1];
  assert.ok(
    whole && bitten && whole !== bitten,
    "the bitten cursor is another path",
  );
  const source = readFileSync("src/pranks/NibbleCursor.tsx", "utf8");
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b|pointer-events-auto/);
});

// --- the controller: the real cursor always comes back ----------------------

/** A fake classList, a fake clock and a fake scheduler, so no test waits for real time. `rect` is the clicked control's box. */
function harness(rect?: NibbleRect) {
  const classes = new Set<string>();
  const calls = { add: 0, remove: 0, done: 0 };
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  let clock = 1_000;
  const controller = nibbleController({
    now: () => clock,
    rect,
    classList: {
      add: (name) => {
        calls.add++;
        classes.add(name);
      },
      remove: (name) => {
        calls.remove++;
        classes.delete(name);
      },
    },
    onDone: () => void calls.done++,
    setTimeout: (fn, ms) => timers.push({ fn, ms, cleared: false }) - 1,
    clearTimeout: (handle) => {
      timers[handle as number].cleared = true;
    },
  });
  return {
    controller,
    classes,
    calls,
    timers,
    hidden: () => classes.has(CLASS),
    at: (ms: number) => void (clock = 1_000 + ms),
  };
}

test("the controller hides the cursor on start, and starts a 3 s cap", () => {
  const h = harness();
  assert.equal(h.controller.cursorHidden, false);
  assert.equal(h.hidden(), false);
  h.controller.start({ x: 10, y: 20 });
  assert.equal(h.hidden(), true);
  assert.equal(h.controller.cursorHidden, true);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, NIBBLE_MAX_MS);
  assert.equal(NIBBLE_MAX_MS, 3_000);
  assert.deepEqual(h.controller.pointer, { x: 10, y: 20 });
});

test("(a) the normal timeline: the frames follow the phases and the cursor is back at 1 500 ms", () => {
  const h = harness();
  h.controller.start({ x: 10, y: 20 });
  const expected: [number, string, boolean][] = [
    [0, "peek", false],
    [249, "peek", false],
    [250, "fly-in", false],
    [450, "chew", false],
    [749, "chew", false],
    [750, "chew", true],
    [1_050, "fly-out", true],
    [1_300, "withdraw", true],
    [NIBBLE_MS - 1, "withdraw", true],
  ];
  for (const [ms, phase, bitten] of expected) {
    h.at(ms);
    assert.deepEqual(h.controller.tick(), { phase, bitten }, `${ms} ms`);
    assert.equal(h.hidden(), true, `${ms} ms: still hidden`);
    assert.equal(h.calls.done, 0, `${ms} ms: not done`);
  }
  h.at(NIBBLE_MS);
  assert.equal(h.controller.tick().phase, "done");
  assert.equal(h.controller.cursorHidden, false);
  assert.equal(h.hidden(), false);
  assert.equal(h.calls.done, 1);
  assert.equal(h.timers[0].cleared, true, "the cap is cleared");
  // Later ticks change nothing.
  h.at(NIBBLE_MS + 500);
  assert.equal(h.controller.tick().phase, "done");
  assert.equal(h.calls.done, 1);
  assert.equal(h.calls.remove, 1);
});

test("(a) a late frame still ends the nibble: ticks that arrive after 1 500 ms finish it", () => {
  const h = harness();
  h.controller.start({ x: 0, y: 0 });
  h.at(2_900);
  assert.equal(h.controller.tick().phase, "done");
  assert.equal(h.hidden(), false);
  assert.equal(h.calls.done, 1);
});

test("(b) an abort event ends it at once: a press, a key, a blur, a hidden document, a far pointer", () => {
  const aborts: Record<
    string,
    Parameters<ReturnType<typeof harness>["controller"]["event"]>[0]
  > = {
    pointerdown: { type: "pointerdown" },
    keydown: { type: "keydown" },
    blur: { type: "blur" },
    "visibilitychange hidden": { type: "visibilitychange", hidden: true },
    "pointermove 81 px": {
      type: "pointermove",
      clientX: 100 + NIBBLE_ABORT_PX + 1,
      clientY: 100,
    },
  };
  for (const [name, event] of Object.entries(aborts)) {
    const h = harness();
    h.controller.start({ x: 100, y: 100 });
    h.at(400);
    h.controller.tick();
    h.controller.event(event);
    assert.equal(h.hidden(), false, name);
    assert.equal(h.controller.cursorHidden, false, name);
    assert.equal(h.calls.done, 1, name);
    assert.equal(h.timers[0].cleared, true, `${name}: cap cleared`);
    // A second event, a tick and the cap firing anyway do not call onDone again.
    h.controller.event({ type: "pointerdown" });
    h.controller.tick();
    h.timers[0].fn();
    assert.equal(h.calls.done, 1, `${name}: once`);
  }
});

test("(b) other events do not end it: a pointer within 80 px, a visible document, a release", () => {
  const h = harness();
  h.controller.start({ x: 100, y: 100 });
  h.at(500);
  for (const event of [
    { type: "pointermove", clientX: 100 + NIBBLE_ABORT_PX, clientY: 100 },
    { type: "pointermove", clientX: 60, clientY: 60 },
    { type: "visibilitychange", hidden: false },
    { type: "pointerup" },
    { type: "focus" },
  ]) {
    h.controller.event(event);
    assert.equal(h.hidden(), true, event.type);
    assert.equal(h.calls.done, 0, event.type);
  }
});

test("the controller remembers where the pointer last was, for the bitten cursor to fly to", () => {
  const h = harness();
  h.controller.start({ x: 100, y: 100 });
  assert.deepEqual(h.controller.pointer, { x: 100, y: 100 });
  h.controller.event({ type: "pointermove", clientX: 130, clientY: 90 });
  assert.deepEqual(h.controller.pointer, { x: 130, y: 90 });
  // Events without coordinates leave it alone.
  h.controller.event({ type: "pointermove" });
  h.controller.event({ type: "visibilitychange", hidden: false });
  assert.deepEqual(h.controller.pointer, { x: 130, y: 90 });
  // The abort rule still measures from where the click was, not from the last position.
  h.controller.event({
    type: "pointermove",
    clientX: 100 + NIBBLE_ABORT_PX,
    clientY: 100,
  });
  assert.equal(h.hidden(), true);
  h.controller.event({
    type: "pointermove",
    clientX: 100,
    clientY: 100 + NIBBLE_ABORT_PX + 1,
  });
  assert.equal(h.hidden(), false);
});

// --- leaving the clicked control ends the nibble too -------------------------

/**
 * The panel row's "Geç" as laid out in the 360 px panel: about 40 x 22 px, clicked at (324, 200). The inline
 * confirmation opens right under it, so "Onayla" is some 50 px away: inside the 80 px rule, outside the button.
 */
const GEC_RECT: NibbleRect = { left: 304, top: 189, width: 40, height: 22 };
const GEC_CLICK = { x: 324, y: 200 };
const moveTo = (clientX: number, clientY: number) => ({
  type: "pointermove",
  clientX,
  clientY,
});

test("a move that stays inside the clicked control's box grown by 8 px, and within 80 px, does not abort", () => {
  // The grown box is x 296..352, y 181..219; its edges still count as inside.
  for (const [x, y] of [
    [324, 200],
    [330, 215],
    [296, 181],
    [352, 219],
    [352, 181],
    [296, 219],
  ])
    assert.equal(
      nibbleAborts(GEC_CLICK, moveTo(x, y), GEC_RECT),
      false,
      `${x},${y}`,
    );
});

test("a move 1 px outside the grown box aborts, even though it is well within 80 px", () => {
  for (const [x, y] of [
    [295, 200],
    [353, 200],
    [324, 180],
    [324, 220],
  ])
    assert.equal(
      nibbleAborts(GEC_CLICK, moveTo(x, y), GEC_RECT),
      true,
      `${x},${y}`,
    );
  // The panel's geometry: straight down toward "Onayla", about 55 px from the click.
  const toConfirm = moveTo(300, 250);
  assert.ok(
    Math.hypot(300 - GEC_CLICK.x, 250 - GEC_CLICK.y) < NIBBLE_ABORT_PX,
  );
  assert.equal(
    nibbleAborts(GEC_CLICK, toConfirm),
    false,
    "the 80 px rule alone lets it go on",
  );
  assert.equal(nibbleAborts(GEC_CLICK, toConfirm, GEC_RECT), true);
});

test("a move beyond 80 px still aborts, whatever the box", () => {
  const wide: NibbleRect = { left: 0, top: 0, width: 1_000, height: 800 };
  assert.equal(
    nibbleAborts(GEC_CLICK, moveTo(324 + NIBBLE_ABORT_PX, 200), wide),
    false,
  );
  assert.equal(
    nibbleAborts(GEC_CLICK, moveTo(324 + NIBBLE_ABORT_PX + 1, 200), wide),
    true,
  );
  assert.equal(
    nibbleAborts(GEC_CLICK, moveTo(324 + NIBBLE_ABORT_PX + 1, 200), GEC_RECT),
    true,
  );
});

test("with no box, only the 80 px rule applies", () => {
  assert.equal(nibbleAborts(GEC_CLICK, moveTo(300, 250)), false);
  assert.equal(nibbleAborts(GEC_CLICK, moveTo(300, 250), undefined), false);
  assert.equal(
    nibbleAborts(GEC_CLICK, moveTo(324, 200 + NIBBLE_ABORT_PX + 1)),
    true,
  );
});

test("the box rule is only for moves: a release, a focus and a visible document leave the nibble alone", () => {
  for (const type of ["pointerup", "focus"])
    assert.equal(
      nibbleAborts(GEC_CLICK, { type, clientX: 0, clientY: 0 }, GEC_RECT),
      false,
      type,
    );
  assert.equal(
    nibbleAborts(
      GEC_CLICK,
      { type: "visibilitychange", hidden: false },
      GEC_RECT,
    ),
    false,
  );
  // A move without coordinates says nothing about where the pointer is.
  assert.equal(
    nibbleAborts(GEC_CLICK, { type: "pointermove" }, GEC_RECT),
    false,
  );
});

test("the controller ends the nibble the moment the pointer leaves the box: cursor back, done once, cap cleared", () => {
  const h = harness(GEC_RECT);
  h.controller.start(GEC_CLICK);
  h.at(400);
  h.controller.tick();
  // Moving about inside the button goes on.
  h.controller.event(moveTo(330, 214));
  assert.equal(h.hidden(), true);
  assert.equal(h.calls.done, 0);
  // Down toward "Onayla": out of the box, within 80 px of the click.
  h.controller.event(moveTo(300, 250));
  assert.equal(h.hidden(), false);
  assert.equal(h.controller.cursorHidden, false);
  assert.equal(h.calls.done, 1);
  assert.equal(h.calls.remove, 1);
  assert.equal(h.timers[0].cleared, true, "the 3 s cap is cleared");
  // Nothing is left to end twice.
  h.controller.event(moveTo(300, 260));
  h.controller.tick();
  h.timers[0].fn();
  assert.equal(h.calls.done, 1);
  assert.equal(h.calls.remove, 1);
});

test("a controller made without a box ends only by the 80 px rule", () => {
  const h = harness();
  h.controller.start(GEC_CLICK);
  h.controller.event(moveTo(300, 250));
  assert.equal(h.hidden(), true);
  assert.equal(h.calls.done, 0);
  h.controller.event(moveTo(324, 200 + NIBBLE_ABORT_PX + 1));
  assert.equal(h.hidden(), false);
  assert.equal(h.calls.done, 1);
});

test("(c) if no frame ever runs, the 3 s cap still brings the cursor back", () => {
  const h = harness();
  h.controller.start({ x: 5, y: 5 });
  assert.equal(h.hidden(), true);
  // No tick, no event: only the timer.
  h.timers[0].fn();
  assert.equal(h.hidden(), false);
  assert.equal(h.controller.cursorHidden, false);
  assert.equal(h.calls.done, 1);
});

test("(d) stop() restores the cursor without waiting, and a second stop does nothing", () => {
  const h = harness();
  h.controller.start({ x: 5, y: 5 });
  h.at(100);
  h.controller.stop();
  assert.equal(h.hidden(), false);
  assert.equal(h.controller.cursorHidden, false);
  assert.equal(h.calls.done, 1);
  assert.equal(h.timers[0].cleared, true);
  h.controller.stop();
  assert.equal(h.calls.done, 1);
  assert.equal(h.calls.remove, 1);
});

test("a finished controller stays finished: it never hides the cursor again", () => {
  const h = harness();
  h.controller.start({ x: 5, y: 5 });
  h.controller.stop();
  h.controller.start({ x: 9, y: 9 });
  assert.equal(h.hidden(), false);
  assert.equal(h.calls.add, 1);
  assert.equal(h.timers.length, 1);
});

test("stop() before start() never hides anything and still reports done once", () => {
  const h = harness();
  h.controller.stop();
  assert.equal(h.calls.add, 0);
  assert.equal(h.hidden(), false);
  assert.equal(h.calls.done, 1);
  h.controller.start({ x: 1, y: 1 });
  assert.equal(h.calls.add, 0);
});

test("a second start() does not restart the clock or stack a second cap", () => {
  const h = harness();
  h.controller.start({ x: 1, y: 1 });
  h.at(700);
  h.controller.start({ x: 50, y: 50 });
  assert.equal(h.timers.length, 1);
  assert.equal(h.calls.add, 1);
  assert.deepEqual(h.controller.tick(), nibbleFrame(700));
});

test("the controller's default timers are the global ones: the cap fires at 3 s", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const classes = new Set<string>();
    let done = 0;
    const controller = nibbleController({
      now: () => 0,
      classList: {
        add: (n) => void classes.add(n),
        remove: (n) => void classes.delete(n),
      },
      onDone: () => void done++,
    });
    controller.start({ x: 1, y: 1 });
    mock.timers.tick(NIBBLE_MAX_MS - 1);
    assert.equal(classes.has(CLASS), true);
    mock.timers.tick(1);
    assert.equal(classes.has(CLASS), false);
    assert.equal(done, 1);
  } finally {
    mock.timers.reset();
  }
});

// --- the layer, mounted ------------------------------------------------------

/** What the drawn tree says, read from the fake DOM. */
interface FakeNode {
  tagName: string;
  attributes: Map<string, string>;
  childNodes: FakeNode[];
  style: Record<string, string>;
}
const nodes = (node: FakeNode, found: FakeNode[] = []): FakeNode[] => {
  found.push(node);
  for (const child of node.childNodes) nodes(child, found);
  return found;
};
const drawn = (dom: ReturnType<typeof fakeDom>) => {
  const all = nodes(dom.container as unknown as FakeNode);
  return {
    pose: all
      .find((n) => n.attributes.has("data-pose"))
      ?.attributes.get("data-pose"),
    props: all
      .find((n) => n.attributes.has("data-pose"))
      ?.attributes.get("data-props"),
    cursor: all
      .find((n) => n.attributes.has("data-prank-cursor"))
      ?.attributes.get("data-prank-cursor"),
  };
};

/** requestAnimationFrame on a hand-turned crank, installed on the global like the browser's. */
function fakeFrames() {
  let next = 1;
  const queue = new Map<number, () => void>();
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: () => void) => {
      queue.set(next, callback);
      return next++;
    },
    cancelAnimationFrame: (id: number) => void queue.delete(id),
  });
  return {
    pending: () => queue.size,
    /** Runs the frames that are waiting now; ones they ask for wait for the next call. */
    run: () => {
      const batch = [...queue.values()];
      queue.clear();
      for (const callback of batch) callback();
    },
    restore: () => {
      Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
    },
  };
}

const PLAY: PrankPlay = { id: 1, kind: "nibble-cursor", point: START };

/**
 * Wraps the global timers (the mocked ones, so call it after `mock.timers.enable`) to see which 3 s
 * caps are armed: set and not yet cleared or fired. `restore` before `mock.timers.reset`.
 */
function trackCaps() {
  const armed = new Set<unknown>();
  const { setTimeout: set, clearTimeout: clear } = globalThis;
  globalThis.setTimeout = ((
    callback: () => void,
    ms?: number,
    ...rest: unknown[]
  ) => {
    const handle = set(
      () => {
        armed.delete(handle);
        callback();
      },
      ms,
      ...rest,
    );
    if (ms === NIBBLE_MAX_MS) armed.add(handle);
    return handle;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle: Parameters<typeof clear>[0]) => {
    armed.delete(handle);
    clear(handle);
  }) as typeof clearTimeout;
  return {
    armed,
    restore() {
      globalThis.setTimeout = set;
      globalThis.clearTimeout = clear;
    },
  };
}

/** Mounts something in a fake browser with a fake frame clock; `run` gets the DOM, the crank, the clock, the root and the armed caps. */
async function inFakeBrowser(
  element: ReactElement,
  run: (env: {
    dom: ReturnType<typeof fakeDom>;
    frames: ReturnType<typeof fakeFrames>;
    root: Root;
    at: (ms: number) => void;
    /** How many 3 s caps are armed right now. */
    caps: () => number;
  }) => Promise<void>,
) {
  const dom = fakeDom();
  dom.install();
  const frames = fakeFrames();
  let clock = 5_000;
  const now = mock.method(performance, "now", () => clock);
  mock.timers.enable({ apis: ["setTimeout"] });
  const caps = trackCaps();
  try {
    // Loaded after the stubs, so react-dom sees a DOM.
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () => root.render(element));
    await run({
      dom,
      frames,
      root,
      at: (ms) => void (clock = 5_000 + ms),
      caps: () => caps.armed.size,
    });
    await act(async () => root.unmount());
    assert.equal(caps.armed.size, 0, "no cap is left armed after the unmount");
    // However the test went, an unmounted layer leaves the cursor, the listeners and the frames behind it clean.
    assert.equal(
      dom.cursorHidden(),
      false,
      "the cursor is back after the unmount",
    );
    assert.equal(frames.pending(), 0, "no frame is left waiting");
    for (const type of ["pointermove", "pointerdown", "keydown", "blur"])
      assert.equal(dom.windowListeners(type), 0, type);
    assert.equal(dom.documentListeners("visibilitychange"), 0);
  } finally {
    caps.restore();
    mock.timers.reset();
    now.mock.restore();
    frames.restore();
    dom.uninstall();
  }
}

const frame = (env: { frames: ReturnType<typeof fakeFrames> }) =>
  act(async () => env.frames.run());

test("the layer hides the cursor before paint and draws the peeking panda and the cursor at the click", async () => {
  let done = 0;
  await inFakeBrowser(
    createElement(NibbleCursorLayer, { play: PLAY, done: () => done++ }),
    async ({ dom, frames }) => {
      // Right after the mount, before any frame: the layout effect has already hidden the cursor.
      assert.equal(dom.cursorHidden(), true);
      assert.deepEqual(drawn(dom), {
        pose: "peek",
        props: "",
        cursor: "whole",
      });
      assert.equal(frames.pending(), 1);
      assert.equal(done, 0);
      for (const type of ["pointermove", "pointerdown", "keydown", "blur"])
        assert.equal(dom.windowListeners(type), 1, type);
      assert.equal(dom.documentListeners("visibilitychange"), 1);
    },
  );
});

test("a press and a key end the nibble even when a handler stops them: those two listen on the capture phase", async () => {
  await inFakeBrowser(
    createElement(NibbleCursorLayer, { play: PLAY, done() {} }),
    async ({ dom }) => {
      assert.equal(dom.windowCaptureListeners("pointerdown"), 1);
      assert.equal(dom.windowCaptureListeners("keydown"), 1);
      // The other two have no use for it: a move is only tracked, a blur happens to the window itself.
      assert.equal(dom.windowCaptureListeners("pointermove"), 0);
      assert.equal(dom.windowCaptureListeners("blur"), 0);
      assert.equal(
        dom.windowListeners("pointerdown"),
        1,
        "not also in the bubble phase",
      );
      assert.equal(
        dom.windowListeners("keydown"),
        1,
        "not also in the bubble phase",
      );
    },
  );
});

test("the layer plays the whole sequence from its frames and calls done once, at 1 500 ms, with the cursor back", async () => {
  let done = 0;
  await inFakeBrowser(
    createElement(NibbleCursorLayer, { play: PLAY, done: () => done++ }),
    async (env) => {
      const { dom, at } = env;
      const seen: [number, ReturnType<typeof drawn>][] = [
        [100, { pose: "peek", props: "", cursor: "whole" }],
        [300, { pose: "chew", props: "", cursor: "whole" }],
        [600, { pose: "chew", props: "cursor", cursor: undefined }],
        [800, { pose: "chew", props: "cursor-bitten", cursor: undefined }],
        [1_100, { pose: "chew", props: "", cursor: "bitten" }],
        [1_400, { pose: "chew", props: "", cursor: "bitten" }],
      ];
      for (const [ms, expected] of seen) {
        at(ms);
        await frame(env);
        assert.deepEqual(drawn(dom), expected, `${ms} ms`);
        assert.equal(dom.cursorHidden(), true, `${ms} ms`);
        assert.equal(done, 0, `${ms} ms`);
      }
      at(NIBBLE_MS);
      await frame(env);
      assert.equal(done, 1);
      assert.equal(dom.cursorHidden(), false);
      // No more frames are asked for once it is over.
      assert.equal(env.frames.pending(), 0);
    },
  );
  assert.equal(done, 1, "the unmount does not call done again");
});

test("the layer ends at once on a press, a key, a blur, a hidden window or a far pointer, and not on a near one", async () => {
  const aborts: [string, (dom: ReturnType<typeof fakeDom>) => void][] = [
    ["pointerdown", (dom) => dom.emit("pointerdown")],
    ["keydown", (dom) => dom.emit("keydown")],
    ["blur", (dom) => dom.emit("blur")],
    ["hidden", (dom) => dom.setVisibility("hidden")],
    [
      "far pointer",
      () =>
        void window.dispatchEvent(
          Object.assign(new Event("pointermove"), {
            clientX: START.x + 81,
            clientY: START.y,
          }),
        ),
    ],
  ];
  for (const [name, abort] of aborts) {
    let done = 0;
    await inFakeBrowser(
      createElement(NibbleCursorLayer, { play: PLAY, done: () => done++ }),
      async (env) => {
        env.at(300);
        await frame(env);
        assert.equal(env.dom.cursorHidden(), true, `${name}: playing`);
        await act(async () => abort(env.dom));
        assert.equal(env.dom.cursorHidden(), false, name);
        assert.equal(done, 1, name);
      },
    );
    assert.equal(done, 1, `${name}: once`);
  }
  let stayed = 0;
  await inFakeBrowser(
    createElement(NibbleCursorLayer, { play: PLAY, done: () => stayed++ }),
    async (env) => {
      await act(async () => {
        window.dispatchEvent(
          Object.assign(new Event("pointermove"), {
            clientX: START.x + 80,
            clientY: START.y,
          }),
        );
        env.dom.setVisibility("visible");
      });
      assert.equal(env.dom.cursorHidden(), true);
      assert.equal(stayed, 0);
    },
  );
});

test("the bitten cursor flies to where the pointer has moved to", async () => {
  await inFakeBrowser(
    createElement(NibbleCursorLayer, { play: PLAY, done() {} }),
    async (env) => {
      await act(async () =>
        window.dispatchEvent(
          Object.assign(new Event("pointermove"), {
            clientX: START.x + 30,
            clientY: START.y - 20,
          }),
        ),
      );
      env.at(1_100);
      await frame(env);
      const cursor = nodes(env.dom.container as unknown as FakeNode).find((n) =>
        n.attributes.has("data-prank-cursor"),
      );
      assert.equal(cursor?.attributes.get("data-prank-cursor"), "bitten");
      // Its tip is where the pointer now is (the flight starts from the held point, in a custom property).
      assert.equal(
        cursor?.style.transform,
        `translate(${START.x + 30}px, ${START.y - 20}px)`,
      );
      assert.equal(
        cursor?.style["--prank-from-x"],
        `${nibbleLayout(START, { width: 1_000, height: 800 }).held.x}px`,
      );
    },
  );
});

test("if no frame ever runs, the 3 s cap still restores the cursor and ends the play", async () => {
  let done = 0;
  await inFakeBrowser(
    createElement(NibbleCursorLayer, { play: PLAY, done: () => done++ }),
    async ({ dom }) => {
      assert.equal(dom.cursorHidden(), true);
      await act(async () => mock.timers.tick(NIBBLE_MAX_MS - 1));
      assert.equal(dom.cursorHidden(), true);
      await act(async () => mock.timers.tick(1));
      assert.equal(dom.cursorHidden(), false);
      assert.equal(done, 1);
    },
  );
});

test("an unmount mid-play restores the cursor, lets go of everything and does not call done", async () => {
  let done = 0;
  await inFakeBrowser(
    createElement(NibbleCursorLayer, { play: PLAY, done: () => done++ }),
    async (env) => {
      env.at(600);
      await frame(env);
      assert.equal(env.dom.cursorHidden(), true);
      assert.equal(env.frames.pending(), 1);
      assert.equal(env.caps(), 1, "the 3 s cap is armed while it plays");
      await act(async () => env.root.unmount());
      assert.equal(env.dom.cursorHidden(), false);
      assert.equal(env.frames.pending(), 0);
      assert.equal(done, 0);
      // The cap went with it: one left armed would fire a finished controller's timer for nothing.
      assert.equal(env.caps(), 0, "the cap is cleared by the unmount");
    },
  );
});

test("a play with no point (no event) ends at once and never hides the cursor", async () => {
  let done = 0;
  const play: PrankPlay = { id: 1, kind: "nibble-cursor" };
  await inFakeBrowser(
    createElement(NibbleCursorLayer, { play, done: () => done++ }),
    async ({ dom, frames }) => {
      assert.equal(done, 1);
      assert.equal(dom.cursorHidden(), false);
      assert.deepEqual(drawn(dom), {
        pose: undefined,
        props: undefined,
        cursor: undefined,
      });
      assert.equal(frames.pending(), 0);
      for (const type of ["pointermove", "pointerdown", "keydown", "blur"])
        assert.equal(dom.windowListeners(type), 0, type);
    },
  );
});

test("StrictMode's mount, unmount and mount again leaves one play with the cursor hidden, and does not end it", async () => {
  let done = 0;
  await inFakeBrowser(
    createElement(
      StrictMode,
      null,
      createElement(NibbleCursorLayer, { play: PLAY, done: () => done++ }),
    ),
    async ({ dom, frames }) => {
      assert.equal(done, 0, "the throwaway first mount did not end the play");
      assert.equal(dom.cursorHidden(), true);
      assert.equal(frames.pending(), 1);
      for (const type of ["pointermove", "pointerdown", "keydown", "blur"])
        assert.equal(dom.windowListeners(type), 1, type);
      assert.equal(dom.documentListeners("visibilitychange"), 1);
    },
  );
});

test("a layer that is handed a new done does not restart the nibble", async () => {
  const dones: number[] = [];
  const first = createElement(NibbleCursorLayer, {
    play: PLAY,
    done: () => dones.push(1),
  });
  const second = createElement(NibbleCursorLayer, {
    play: PLAY,
    done: () => dones.push(2),
  });
  await inFakeBrowser(first, async (env) => {
    env.at(800);
    await frame(env);
    await act(async () => env.root.render(second));
    assert.equal(env.dom.cursorHidden(), true);
    assert.equal(env.dom.windowListeners("keydown"), 1);
    // Still the same nibble, 800 ms in: it is bitten, not peeking again.
    assert.equal(drawn(env.dom).props, "cursor-bitten");
    env.at(NIBBLE_MS);
    await frame(env);
    assert.deepEqual(dones, [2], "the newest done is the one called");
  });
});

test("inside the stage the nibble plays, ends at 1 500 ms and the stage takes the layer away with the cursor back", async () => {
  const dom = fakeDom();
  dom.install();
  const frames = fakeFrames();
  let clock = 0;
  const now = mock.method(performance, "now", () => clock);
  mock.timers.enable({ apis: ["setTimeout"] });
  const caps = trackCaps();
  try {
    const { createRoot } = await import("react-dom/client");
    let api: PrankApi | undefined;
    const Probe = () => {
      api = usePrank();
      return null;
    };
    const root = createRoot(dom.container as unknown as Element);
    await act(async () =>
      root.render(
        createElement(PrankStage, {
          level: "sometimes",
          desktopBusy: false,
          errorShown: false,
          dialogOpen: false,
          ignoreLimits: true,
          children: createElement(Probe),
        }),
      ),
    );
    const stageIsEmpty = () =>
      dom.container.childNodes[0]?.childNodes.length === 0;
    assert.ok(api);
    assert.equal(PRANK_LAYERS["nibble-cursor"], NibbleCursorLayer);

    await act(async () =>
      api!.offer("nibble-cursor", null, {
        clientX: 500,
        clientY: 700,
        detail: 1,
      }),
    );
    assert.equal(dom.cursorHidden(), true);
    assert.equal(stageIsEmpty(), false);
    assert.equal(drawn(dom).pose, "peek");
    assert.equal(caps.armed.size, 1);

    clock = NIBBLE_MS;
    await act(async () => frames.run());
    assert.equal(dom.cursorHidden(), false);
    assert.equal(stageIsEmpty(), true);
    assert.equal(frames.pending(), 0);
    assert.equal(
      caps.armed.size,
      0,
      "the cap is cleared when the timeline ends",
    );

    // A press mid-play ends it too, through the stage.
    clock = 0;
    await act(async () =>
      api!.offer("nibble-cursor", null, {
        clientX: 500,
        clientY: 700,
        detail: 1,
      }),
    );
    assert.equal(dom.cursorHidden(), true);
    await act(async () => dom.emit("pointerdown"));
    assert.equal(dom.cursorHidden(), false);
    assert.equal(stageIsEmpty(), true);
    assert.equal(caps.armed.size, 0, "the cap is cleared when a press ends it");

    // A nibble offered without a point (no event) is over at once.
    await act(async () => api!.offer("nibble-cursor", null));
    assert.equal(dom.cursorHidden(), false);
    assert.equal(stageIsEmpty(), true);

    // The stage going away mid-play brings the cursor back too.
    await act(async () =>
      api!.offer("nibble-cursor", null, {
        clientX: 500,
        clientY: 700,
        detail: 1,
      }),
    );
    assert.equal(dom.cursorHidden(), true);
    await act(async () => root.unmount());
    assert.equal(dom.cursorHidden(), false);
    assert.equal(frames.pending(), 0);
    assert.equal(
      caps.armed.size,
      0,
      "the cap is cleared when the stage goes away",
    );
  } finally {
    caps.restore();
    mock.timers.reset();
    now.mock.restore();
    frames.restore();
    dom.uninstall();
  }
});

test("inside the stage, a pointer that leaves the clicked button ends the nibble at once: the cursor class is gone and the stage is empty", async () => {
  const dom = fakeDom();
  dom.install();
  const frames = fakeFrames();
  const now = mock.method(performance, "now", () => 0);
  mock.timers.enable({ apis: ["setTimeout"] });
  const caps = trackCaps();
  try {
    const { createRoot } = await import("react-dom/client");
    let api: PrankApi | undefined;
    const Probe = () => {
      api = usePrank();
      return null;
    };
    const root = createRoot(dom.container as unknown as Element);
    await act(async () =>
      root.render(
        createElement(PrankStage, {
          level: "sometimes",
          desktopBusy: false,
          errorShown: false,
          dialogOpen: false,
          ignoreLimits: true,
          children: createElement(Probe),
        }),
      ),
    );
    const stageIsEmpty = () =>
      dom.container.childNodes[0]?.childNodes.length === 0;
    // The row's Geç: the stage reads its box at offer time, as the click is made.
    const button = {
      getBoundingClientRect: () => ({ ...GEC_RECT }),
    } as unknown as Element;
    const move = (x: number, y: number) =>
      act(async () =>
        window.dispatchEvent(
          Object.assign(new Event("pointermove"), { clientX: x, clientY: y }),
        ),
      );
    const offer = () =>
      act(async () =>
        api!.offer("nibble-cursor", button, {
          clientX: GEC_CLICK.x,
          clientY: GEC_CLICK.y,
          detail: 1,
        }),
      );

    await offer();
    assert.equal(dom.cursorHidden(), true);
    assert.equal(stageIsEmpty(), false);
    // Moving about on the button, and a little off it (within its grown box), goes on.
    await move(330, 214);
    await move(300, 215);
    assert.equal(dom.cursorHidden(), true);
    assert.equal(stageIsEmpty(), false);
    // Down toward "Onayla": 1 px past the grown box, 55 px from the click.
    await move(300, 220);
    assert.equal(dom.cursorHidden(), false, "the real cursor is back at once");
    assert.equal(stageIsEmpty(), true, "the layer is gone");
    assert.equal(frames.pending(), 0);
    assert.equal(caps.armed.size, 0, "the 3 s cap is cleared");
    for (const type of ["pointermove", "pointerdown", "keydown", "blur"])
      assert.equal(dom.windowListeners(type), 0, type);
    assert.equal(dom.documentListeners("visibilitychange"), 0);

    // The next play starts fresh, with its own box.
    await offer();
    assert.equal(dom.cursorHidden(), true);
    await move(324, 200 + NIBBLE_ABORT_PX + 1);
    assert.equal(dom.cursorHidden(), false);
    assert.equal(stageIsEmpty(), true);

    // A play with no anchor has no box: moving 55 px from the click does not end it.
    await act(async () =>
      api!.offer("nibble-cursor", null, {
        clientX: GEC_CLICK.x,
        clientY: GEC_CLICK.y,
        detail: 1,
      }),
    );
    await move(300, 250);
    assert.equal(dom.cursorHidden(), true);
    assert.equal(stageIsEmpty(), false);
    await act(async () => root.unmount());
    assert.equal(dom.cursorHidden(), false);
  } finally {
    caps.restore();
    mock.timers.reset();
    now.mock.restore();
    frames.restore();
    dom.uninstall();
  }
});

test("the layer hides the cursor in a layout effect, so it is hidden before the first paint", () => {
  const source = readFileSync("src/pranks/NibbleCursor.tsx", "utf8");
  assert.match(source, /useLayoutEffect\(\(\) => \{\s*\/\/ Nothing to nibble/);
  assert.doesNotMatch(source, /\buseEffect\b/);
});

test("the registry draws the nibble with its layer, and the registry is still a plain object", () => {
  assert.equal(PRANK_LAYERS["nibble-cursor"], NibbleCursorLayer);
  assert.equal(Object.getPrototypeOf(PRANK_LAYERS), Object.prototype);
});

// --- the stylesheet ---------------------------------------------------------

test("the nibble's slides, flight and transition animate only with motion on", () => {
  const css = readFileSync("src/styles/pranks.css", "utf8");
  const motion = mediaBlock(css, "(prefers-reduced-motion: no-preference)");
  assert.match(
    motion,
    /\.prank-nibble-panda\[data-phase="peek"\]\s*\{[^}]*animation-name:\s*prank-nibble-peek/,
  );
  assert.match(
    motion,
    /\.prank-nibble-panda\[data-phase="withdraw"\]\s*\{[^}]*animation-name:\s*prank-nibble-withdraw/,
  );
  assert.match(
    motion,
    /\.prank-cursor\[data-flight="in"\]\s*\{[^}]*transition-property:\s*transform/,
  );
  assert.match(
    motion,
    /\.prank-cursor\[data-flight="out"\]\s*\{[^}]*animation-name:\s*prank-cursor-fly-out/,
  );
  // Three bites fit the chew phase's 600 ms only at 200 ms a cycle, not the plain motion's 0.33 s; the extra class
  // beats the plain rule's shorthand.
  assert.match(
    motion,
    /\.prank-nibble-panda \.panda\[data-motion~="chew"\] \[data-part="head"\],\s*\.prank-nibble-panda \.panda\[data-motion~="chew"\] \[data-part="held"\]\s*\{[^}]*animation-duration:\s*200ms/,
  );
  assert.equal(nibbleFrame(449).phase, "fly-in");
  assert.equal(nibbleFrame(450).phase, "chew");
  assert.equal(nibbleFrame(1_049).phase, "chew");
  assert.equal(nibbleFrame(1_050).phase, "fly-out");
  // The bites that fit: the chew phase's length in the timeline, over the bite's duration read from the stylesheet.
  const chewMs = Array.from({ length: NIBBLE_MS }, (_, ms) => nibbleFrame(ms).phase).filter((phase) => phase === "chew").length;
  const biteMs = Number(/\[data-part="held"\]\s*\{[^}]*animation-duration:\s*(\d+)ms/.exec(motion)?.[1]);
  assert.ok(Number.isFinite(biteMs) && biteMs > 0, "the bite's duration is in the stylesheet");
  assert.equal(chewMs / biteMs, 3);
  for (const name of [
    "prank-nibble-peek",
    "prank-nibble-withdraw",
    "prank-cursor-fly-out",
  ])
    assert.match(css, new RegExp(`@keyframes ${name}\\s*\\{`), name);
  // Not one animation or transition property, longhands included, outside the no-preference block.
  assert.doesNotMatch(
    css.replace(motion, ""),
    /(animation|transition)[\w-]*\s*:/,
  );
  // The cursor-hiding rule is the stage's, and still there.
  assert.match(
    css,
    /\.prank-cursor-hidden,\s*\.prank-cursor-hidden \* \{\s*cursor: none !important;\s*\}/,
  );
});

// --- the triggers -----------------------------------------------------------

test("every nibble trigger goes through offerAfter, so the button's own action runs first", () => {
  const files = [
    "src/panel/PanelAccounts.tsx",
    "src/panel/Panel.tsx",
    "src/pages/overview/AccountsCard.tsx",
    "src/pages/Overview.tsx",
    "src/pages/accounts/AccountsTable.tsx",
  ];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.ok(source.includes('offerAfter(prank, "nibble-cursor"'), file);
    assert.match(
      source,
      /import \{[^}]*\bofferAfter\b[^}]*\} from "@\/pranks\/PrankStage"/,
      `${file} imports offerAfter`,
    );
    assert.match(source, /usePrank\(\)/, `${file} reads the stage`);
  }
});

test("each trigger still runs its own action, and the Accounts menu's items keep theirs", () => {
  const panelAccounts = readFileSync("src/panel/PanelAccounts.tsx", "utf8");
  // Opening the confirmation is the switch request and offers; closing it is a cancel and does not.
  assert.match(
    panelAccounts,
    /open\s*\?\s*setConfirmId\(undefined\)\s*:\s*offerAfter\(prank, "nibble-cursor", e, \(\) =>\s*setConfirmId\(account\.id\),?\s*\)/,
  );
  const panel = readFileSync("src/panel/Panel.tsx", "utf8");
  // The suggestion's Geç only offers when this click opens the confirmation (the mounted Panel test below drives it).
  assert.match(
    panel,
    /if \(confirmId !== suggestion\.id\)\s*offerAfter\(prank, "nibble-cursor", e, \(\) =>\s*setConfirmId\(suggestion\.id\),?\s*\)/,
  );
  const card = readFileSync("src/pages/overview/AccountsCard.tsx", "utf8");
  assert.match(
    card,
    /offerAfter\(prank, "nibble-cursor", e, \(\) =>\s*relay\.requestDesktop\(account, "switch"\),?\s*\)/,
  );
  const overview = readFileSync("src/pages/Overview.tsx", "utf8");
  assert.match(
    overview,
    /offerAfter\(prank, "nibble-cursor", e, \(\) =>\s*relay\.requestDesktop\(suggestion, "switch"\),?\s*\)/,
  );
  // The menu's items take their handlers from itemHandlers: the switch item switches from its click, through
  // offerAfter, and every other item keeps onSelect. No item has a bare `onSelect={run}` any more.
  const table = readFileSync("src/pages/accounts/AccountsTable.tsx", "utf8");
  assert.match(
    table,
    /\{\.\.\.itemHandlers\(\{ key, disabled, run \}, prank\)\}/,
  );
  assert.doesNotMatch(table, /onSelect=\{run\}/);
  // A disabled switch item gets no handler at all, so there is nothing to run and nothing to offer.
  assert.match(table, /if \(disabled\) return \{\};/);
  assert.match(
    table,
    /onClick: \(e\) => offerAfter\(prank, "nibble-cursor", e, run\)/,
  );
  assert.match(table, /if \(key !== "switch"\) return \{ onSelect: run \};/);
});

/** A fake click for a handler to take: the element it was on, where, and `detail` (0 for a keyboard click). */
const clickOn = (detail: number) =>
  ({
    currentTarget: {
      getBoundingClientRect: () => ({ left: 1, top: 2, width: 3, height: 4 }),
    },
    clientX: 5,
    clientY: 6,
    detail,
  }) as unknown as MouseEvent<Element>;

test("the Accounts menu's switch item runs once and before the offer, whether the click is a mouse's or a keyboard's", () => {
  for (const detail of [1, 0]) {
    const log: string[] = [];
    const prank: PrankApi = {
      offer: (kind, _anchor, event) =>
        void log.push(`offer ${kind} ${event?.detail}`),
      allowsTrick: () => false,
    };
    const { onSelect, onClick } = itemHandlers(
      { key: "switch", disabled: false, run: () => void log.push("run") },
      prank,
    );
    // Radix sends a mouse click, Enter, Space and a release over the item all through its click: no onSelect to run twice.
    assert.equal(onSelect, undefined);
    assert.ok(onClick);
    onClick(clickOn(detail));
    assert.deepEqual(
      log,
      ["run", `offer nibble-cursor ${detail}`],
      `detail ${detail}`,
    );
  }
});

test("a disabled switch item does nothing: no run and no offer; every other item keeps onSelect and never offers", () => {
  let runs = 0;
  const prank: PrankApi = {
    offer: () => assert.fail("only an enabled switch item offers"),
    allowsTrick: () => false,
  };
  // A disabled switch item has no handler at all: its click neither switches (Radix would not select it either) nor offers.
  const disabled = itemHandlers(
    { key: "switch", disabled: true, run: () => void runs++ },
    prank,
  );
  assert.deepEqual(Object.keys(disabled), []);
  assert.equal(runs, 0);
  for (const key of [
    "open",
    "cli",
    "desktop-reconnect",
    "desktop-link",
    "refresh",
  ] as const) {
    const { onSelect, onClick } = itemHandlers(
      { key, disabled: false, run: () => void runs++ },
      prank,
    );
    assert.equal(onClick, undefined, key);
    onSelect?.();
  }
  assert.equal(runs, 5);
});

/** Swaps the nibble's layer for one that only records that a play was drawn, for the length of `run`. */
async function withSpyLayer(
  log: string[],
  run: (plays: Set<number>) => Promise<void>,
) {
  const original = PRANK_LAYERS["nibble-cursor"];
  const plays = new Set<number>();
  PRANK_LAYERS["nibble-cursor"] = ({ play }) => {
    if (!plays.has(play.id)) log.push("play");
    plays.add(play.id);
    return null;
  };
  try {
    await run(plays);
  } finally {
    PRANK_LAYERS["nibble-cursor"] = original;
  }
}

/** A stage with the real gates and a budget that always says yes, so only the gates decide. */
const stageOf = (children: ReactElement) => {
  const map = new Map<string, string>();
  return createElement(PrankStage, {
    level: "sometimes",
    desktopBusy: false,
    errorShown: false,
    dialogOpen: false,
    storage: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
    },
    random: () => 0,
    children,
  });
};

test("through a real stage, the switch item runs once before the nibble starts; a keyboard click still switches and the gate refuses its nibble", async () => {
  for (const [detail, played] of [
    [1, 1],
    [0, 0],
  ] as const) {
    const log: string[] = [];
    await withSpyLayer(log, async (plays) => {
      let api: PrankApi | undefined;
      const Probe = () => {
        api = usePrank();
        return null;
      };
      await inFakeBrowser(stageOf(createElement(Probe)), async () => {
        const { onClick } = itemHandlers(
          { key: "switch", disabled: false, run: () => void log.push("run") },
          api!,
        );
        await act(async () => onClick!(clickOn(detail)));
        assert.deepEqual(
          log,
          played ? ["run", "play"] : ["run"],
          `detail ${detail}`,
        );
        assert.equal(plays.size, played, `detail ${detail}`);
      });
    });
  }
});

// --- the panel row's "Geç": opening the confirmation nibbles, closing it does not ---

const NOW = Date.parse("2026-10-14T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const linkedAccount = (id: string, name: string): Account => ({
  id,
  name,
  kind: "personal",
  group: "personal",
  color: "olive",
  createdAt: iso(NOW),
  planning: { plan: "pro", capacityWeight: 1 },
  desktop: {
    accountUuid: "00000000-0000-4000-8000-000000000001",
    orgId: "00000000-0000-4000-8000-000000000002",
    savedAt: iso(NOW),
    email: `${id}@example.com`,
  },
});
const readyUsage = (id: string): AccountUsage => ({
  accountId: id,
  status: "ready",
  stale: false,
  checkedAt: iso(NOW - 60_000),
  fiveHour: { usedPercent: 12 },
  sevenDay: { usedPercent: 31, resetsAt: iso(NOW + 4 * 86_400_000) },
});

/** The panel's relay: an active account and one more that can be switched to, `extra` laid over it. */
function panelRelay(extra: Partial<Relay> = {}): Relay {
  const active = linkedAccount("active", "Kişisel");
  const vertex = linkedAccount("vertex", "Vertex");
  const accounts = [active, vertex];
  const usage = { active: readyUsage("active"), vertex: readyUsage("vertex") };
  return {
    api: {},
    preview: false,
    error: "",
    notice: "",
    accounts,
    active,
    settings: DEFAULT_SETTINGS,
    busy: "",
    usageBusy: new Set<string>(),
    desktopBusy: false,
    hasUnclaimedDesktop: false,
    desktop: {
      available: true,
      running: true,
      organizations: [],
      busy: false,
      recoveryRequired: false,
      errorRevision: 0,
      activeProfileId: "active",
    },
    data: {
      settings: DEFAULT_SETTINGS,
      usage,
      accounts,
      authFlows: [],
    } as unknown as Snapshot,
    requestDesktop() {},
    setSetupId() {},
    refreshUsage: async () => {},
    action: async () => {},
    ...extra,
  } as unknown as Relay;
}

test("the panel row's Geç offers the nibble when it opens the confirmation and not when it closes it", async () => {
  const relay = panelRelay();
  const tree = createElement(
    I18nContext.Provider,
    { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
    createElement(
      RelayContext.Provider,
      { value: relay },
      stageOf(
        createElement(PanelAccounts, { now: NOW, initialConfirm: "vertex" }),
      ),
    ),
  );
  const log: string[] = [];
  await withSpyLayer(log, async (plays) => {
    await inFakeBrowser(tree, async ({ dom }) => {
      const button = nodes(dom.container as unknown as FakeNode).find((n) =>
        n.attributes.has("aria-expanded"),
      );
      assert.ok(button, "the row's Geç button is drawn");
      assert.equal(
        button.attributes.get("aria-expanded"),
        "true",
        "it starts open",
      );
      const click = (detail: number) =>
        act(async () =>
          dom.dispatch(button, "click", { clientX: 10, clientY: 20, detail }),
        );
      // Closing the open confirmation is a cancel: it closes, and nothing is offered.
      await click(1);
      assert.equal(button.attributes.get("aria-expanded"), "false");
      assert.equal(plays.size, 0);
      // Opening it is the switch request: it opens, and the nibble plays.
      await click(1);
      assert.equal(button.attributes.get("aria-expanded"), "true");
      assert.equal(plays.size, 1);
    });
  });
});

test("the suggestion's Geç offers the nibble when it opens the confirmation and not when it is already open", async () => {
  const vertex = panelRelay().accounts[1];
  const relay = panelRelay({
    suggestion: vertex,
    api: { setPanelHeight() {}, closePanel() {} } as unknown as Relay["api"],
  });
  // A recording stage: a real one would refuse a second offer while the first nibble plays, hiding a wrong offer.
  const offered: (string | undefined)[] = [];
  const spy: PrankApi = {
    offer: (kind, _anchor, event) => void offered.push(`${kind} ${event?.detail}`),
    allowsTrick: () => false,
  };
  const tree = createElement(
    I18nContext.Provider,
    { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
    createElement(
      RelayContext.Provider,
      { value: relay },
      createElement(
        PrankContext.Provider,
        { value: spy },
        createElement(Panel, { now: NOW }),
      ),
    ),
  );
  Object.assign(globalThis, {
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  });
  try {
    await inFakeBrowser(tree, async ({ dom }) => {
      const all = () => nodes(dom.container as unknown as FakeNode);
      // The row's Geç shows the state; the suggestion's is the unlabelled button before it.
      const row = all().find((n) => n.attributes.has("aria-expanded"));
      assert.ok(row, "the row's Geç button is drawn");
      const suggestion = all().filter(
        (n) =>
          n.tagName === "button" &&
          !n.attributes.has("aria-label") &&
          !n.attributes.has("aria-expanded"),
      )[0];
      assert.ok(suggestion, "the suggestion's Geç button is drawn");
      const click = (button: FakeNode) =>
        act(async () =>
          dom.dispatch(button, "click", { clientX: 10, clientY: 20, detail: 1 }),
        );
      assert.equal(row.attributes.get("aria-expanded"), "false");
      // Opening the confirmation is the switch request: it opens, and the nibble is offered.
      await click(suggestion);
      assert.equal(row.attributes.get("aria-expanded"), "true");
      assert.deepEqual(offered, ["nibble-cursor 1"]);
      // Pressed again with the confirmation already open, it asks for nothing and the confirmation stays.
      await click(suggestion);
      assert.equal(row.attributes.get("aria-expanded"), "true");
      assert.deepEqual(offered, ["nibble-cursor 1"]);
      // The row's Geç closes it (a cancel), and the suggestion's opens it again with an offer.
      await click(row);
      assert.equal(row.attributes.get("aria-expanded"), "false");
      assert.deepEqual(offered, ["nibble-cursor 1"]);
      await click(suggestion);
      assert.equal(row.attributes.get("aria-expanded"), "true");
      assert.deepEqual(offered, ["nibble-cursor 1", "nibble-cursor 1"]);
    });
  } finally {
    Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
});

test("only a switch request nibbles: no confirmation button offers it", () => {
  const panelAccounts = readFileSync("src/panel/PanelAccounts.tsx", "utf8");
  // The confirmation's own button (the one that calls confirmSwitch) is not a trigger.
  const call = panelAccounts.indexOf("confirmSwitch(relay, account.id");
  assert.ok(call > 0, "the confirmation button is still where this test looks");
  assert.ok(!panelAccounts.slice(call - 300, call + 300).includes("nibble"));
  assert.equal(panelAccounts.match(/"nibble-cursor"/g)?.length, 1);
  for (const file of [
    "src/panel/Panel.tsx",
    "src/pages/overview/AccountsCard.tsx",
    "src/pages/Overview.tsx",
    "src/pages/accounts/AccountsTable.tsx",
  ])
    assert.equal(
      readFileSync(file, "utf8").match(/"nibble-cursor"/g)?.length,
      1,
      file,
    );
});
