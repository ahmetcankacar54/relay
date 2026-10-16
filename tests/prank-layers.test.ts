import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, createElement, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_SETTINGS } from "../shared/types";
import { LimitMeter, NIBBLE_BAR_HOVER_MS, NIBBLE_BAR_PERCENT, nibbleBarRest } from "../src/components/LimitMeter";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { PRANK_HISTORY_KEY } from "../src/pranks/budget";
import {
  ConfettiLayer,
  DOZE_ACTIVITY_EVENTS,
  DozeLayer,
  NIBBLE_BAR_MS,
  NibbleBarLayer,
  WHEEL_MS,
  WheelLayer,
  besideRect,
} from "../src/pranks/layers";
import { PrankStage, type PrankPlay } from "../src/pranks/PrankStage";
import { RelayPrankStage } from "../src/pranks/RelayPrankStage";
import { PRANK_LAYERS, type PrankLayer } from "../src/pranks/registry";
import { CONFETTI_KEY, CONFETTI_MS, STARTLE_MS } from "../src/pranks/timing";
import { DOZE_CHECK_MS, MainWindowPranks, confettiFalls } from "../src/pranks/useMainWindowPranks";
import { mediaBlock } from "./css";
import { fakeDom } from "./fake-dom";

/** Local noon, so the daily limit sees the same day on every time zone. */
const NOW = new Date(2026, 9, 16, 12, 0).getTime();
const MIN = 60_000;
const noop = () => {};

const rect = { left: 100, top: 20, width: 30, height: 30 };
const play = (kind: PrankPlay["kind"], extra: Partial<PrankPlay> = {}): PrankPlay => ({ id: 1, kind, ...extra });

/** The opening <svg> tag of the first rig in some markup. */
const rigTag = (html: string) => html.match(/<svg [^>]*>/)?.[0] ?? "";

test("the registry draws the wheel, the bar nibble, the doze and the confetti", () => {
  assert.equal(PRANK_LAYERS.wheel, WheelLayer);
  assert.equal(PRANK_LAYERS["nibble-bar"], NibbleBarLayer);
  assert.equal(PRANK_LAYERS.doze, DozeLayer);
  assert.equal(PRANK_LAYERS.confetti, ConfettiLayer);
  assert.equal(Object.getPrototypeOf(PRANK_LAYERS), Object.prototype);
});

test("besideRect puts the box 4 px right of the rect, centred on it, and flips left at the viewport's edge", () => {
  assert.deepEqual(besideRect({ left: 100, top: 20, width: 30, height: 30 }, 28, 1_000), { left: 134, top: 21 });
  // Exactly fitting still goes right; one pixel more crosses the edge and goes left.
  assert.deepEqual(besideRect({ left: 100, top: 20, width: 30, height: 30 }, 28, 162), { left: 134, top: 21 });
  assert.deepEqual(besideRect({ left: 100, top: 20, width: 30, height: 30 }, 28, 161), { left: 68, top: 21 });
  // The panel's refresh button sits near its right edge, in a 360 px window.
  assert.deepEqual(besideRect({ left: 316, top: 8, width: 24, height: 24 }, 28, 360), { left: 284, top: 6 });
  assert.deepEqual(besideRect({ left: 0, top: 0, width: 10, height: 10 }, 28, Infinity), { left: 14, top: -9 });
});

test("the wheel is a 28 px walking panda in its wheel, right of the button and centred on it", () => {
  const html = renderToStaticMarkup(createElement(WheelLayer, { play: play("wheel", { rect }), done: noop }));
  assert.match(html, /^<div class="absolute" style="left:134px;top:21px"><svg /);
  const tag = rigTag(html);
  for (const attribute of ['width="28"', 'height="28"', 'data-pose="walk"', 'data-props="wheel"', 'data-motion="walk"'])
    assert.ok(tag.includes(attribute), attribute);
  assert.equal(html.match(/<svg /g)?.length, 1);
});

test("the bar nibble is a 28 px chewing panda with crumbs, at the filled end and above the bar", () => {
  const fill = { left: 50, top: 200, width: 120, height: 6 };
  const html = renderToStaticMarkup(createElement(NibbleBarLayer, { play: play("nibble-bar", { rect: fill }), done: noop }));
  // Centred on the fill's right end (170 - 14), 26 px above its top.
  assert.match(html, /^<div class="absolute" style="left:156px;top:174px"><svg /);
  const tag = rigTag(html);
  for (const attribute of ['width="28"', 'height="28"', 'data-pose="chew"', 'data-props="crumbs"', 'data-motion="chew"'])
    assert.ok(tag.includes(attribute), attribute);
});

test("the doze is a 48 px curled panda with z that breathes, in the bottom left", () => {
  const html = renderToStaticMarkup(createElement(DozeLayer, { play: play("doze"), done: noop }));
  assert.match(html, /^<div class="absolute" style="left:12px;bottom:12px"><svg /);
  const tag = rigTag(html);
  for (const attribute of ['width="48"', 'height="48"', 'data-pose="curl"', 'data-props="z"', 'data-motion="breathe"'])
    assert.ok(tag.includes(attribute), attribute);
});

test("a startled doze is a standing panda with wide eyes and a bang, in the same corner", () => {
  const html = renderToStaticMarkup(createElement(DozeLayer, { play: play("doze"), done: noop, startled: true }));
  assert.match(html, /^<div class="absolute" style="left:12px;bottom:12px"><svg /);
  const tag = rigTag(html);
  for (const attribute of ['width="48"', 'data-pose="stand"', 'data-expression="wide"', 'data-props="bang"', 'data-motion=""'])
    assert.ok(tag.includes(attribute), attribute);
});

test("the confetti is 14 leaves at fixed places with fixed delays", () => {
  const html = renderToStaticMarkup(createElement(ConfettiLayer, { play: play("confetti"), done: noop }));
  const leaves = [...html.matchAll(/<div class="prank-leaf" style="([^"]*)"><\/div>/g)].map((m) => m[1]);
  assert.equal(leaves.length, 14);
  assert.equal(html.match(/prank-leaf"/g)?.length, 14);
  assert.deepEqual(
    leaves,
    [
      [0, "0.000"], [37, "0.055"], [74, "0.110"], [11, "0.165"], [48, "0.220"], [85, "0.275"], [22, "0.330"],
      [59, "0.385"], [96, "0.440"], [33, "0.495"], [70, "0.550"], [7, "0.605"], [44, "0.660"], [81, "0.715"],
    ].map(([left, delay]) => `left:${left}%;animation-delay:${delay}s`),
  );
  // The same markup every time: no randomness at render.
  assert.equal(renderToStaticMarkup(createElement(ConfettiLayer, { play: play("confetti"), done: noop })), html);
});

test("no layer takes a click: none draws pointer-events-auto", () => {
  const markup = [
    createElement(WheelLayer, { play: play("wheel", { rect }), done: noop }),
    createElement(NibbleBarLayer, { play: play("nibble-bar", { rect }), done: noop }),
    createElement(DozeLayer, { play: play("doze"), done: noop }),
    createElement(DozeLayer, { play: play("doze"), done: noop, startled: true }),
    createElement(ConfettiLayer, { play: play("confetti"), done: noop }),
  ].map((element) => renderToStaticMarkup(element));
  for (const html of markup) assert.ok(html.length > 0 && !html.includes("pointer-events-auto"));
});

test("the layer durations are the catalog's: 2.4 s wheel, 1 s nibble, 2 s confetti", () => {
  assert.equal(WHEEL_MS, 2_400);
  assert.equal(NIBBLE_BAR_MS, 1_000);
  assert.equal(CONFETTI_MS, 2_000);
  assert.deepEqual([...DOZE_ACTIVITY_EVENTS], ["pointermove", "pointerdown", "keydown", "wheel"]);
});

/** The first drawn rig's attributes in a fake DOM tree. */
interface FakeNode {
  tagName: string;
  attributes: Map<string, string>;
  childNodes: FakeNode[];
  box: { left: number; top: number; width: number; height: number };
}
function findNode(node: FakeNode, matches: (node: FakeNode) => boolean): FakeNode | undefined {
  if (matches(node)) return node;
  for (const child of node.childNodes) {
    const found = findNode(child, matches);
    if (found) return found;
  }
  return undefined;
}
function drawnRig(node: FakeNode): Map<string, string> | undefined {
  if (node.tagName === "svg") return node.attributes;
  for (const child of node.childNodes) {
    const found = drawnRig(child);
    if (found) return found;
  }
  return undefined;
}

/** Mounts something in a fake browser; the caller's `run` gets the DOM and a way to unmount. */
async function inFakeBrowser(
  element: ReactElement,
  run: (dom: ReturnType<typeof fakeDom>, root: Root) => Promise<void>,
  options: Parameters<typeof fakeDom>[0] = {},
) {
  const dom = fakeDom(options);
  dom.install();
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW });
  try {
    // Loaded after the stubs, so react-dom sees a DOM.
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () => root.render(element));
    await run(dom, root);
    await act(async () => root.unmount());
  } finally {
    mock.timers.reset();
    dom.uninstall();
  }
}
const tick = (ms: number) => act(async () => mock.timers.tick(ms));

test("the wheel, the bar nibble and the confetti call done at their durations, and not after an unmount", async () => {
  const layers = [
    ["wheel", WheelLayer, play("wheel", { rect }), WHEEL_MS],
    ["bar nibble", NibbleBarLayer, play("nibble-bar", { rect }), NIBBLE_BAR_MS],
    ["confetti", ConfettiLayer, play("confetti"), CONFETTI_MS],
  ] as const;
  for (const [name, Layer, current, ms] of layers) {
    let done = 0;
    await inFakeBrowser(createElement(Layer, { play: current, done: () => done++ }), async () => {
      await tick(ms - 1);
      assert.equal(done, 0, `${name} at ${ms - 1} ms`);
      await tick(1);
      assert.equal(done, 1, `${name} at ${ms} ms`);
      await tick(10 * ms);
      assert.equal(done, 1, `${name} ends once`);
    });
    // Unmounted before the end: the timer goes with it.
    let early = 0;
    await inFakeBrowser(createElement(Layer, { play: current, done: () => early++ }), async (_dom, root) => {
      await tick(ms - 1);
      await act(async () => root.unmount());
      await tick(ms);
      assert.equal(early, 0, `${name} after an unmount`);
    });
  }
});

test("a wheel or a nibble with no anchor has nothing to draw and ends at once", async () => {
  for (const [Layer, kind] of [[WheelLayer, "wheel"], [NibbleBarLayer, "nibble-bar"]] as const) {
    assert.equal(renderToStaticMarkup(createElement(Layer, { play: play(kind), done: noop })), "");
    let done = 0;
    await inFakeBrowser(createElement(Layer, { play: play(kind), done: () => done++ }), async () => {
      assert.equal(done, 1, kind);
    });
  }
});

test("the doze waits for the first activity, then startles for 0.6 s and leaves", async () => {
  for (const event of DOZE_ACTIVITY_EVENTS) {
    let done = 0;
    await inFakeBrowser(createElement(DozeLayer, { play: play("doze"), done: () => done++ }), async (dom) => {
      const rig = () => drawnRig(dom.container as unknown as FakeNode);
      assert.equal(rig()?.get("data-pose"), "curl");
      // Time passing alone does not wake it.
      await tick(60 * MIN);
      assert.equal(done, 0);
      assert.equal(rig()?.get("data-pose"), "curl");
      for (const type of DOZE_ACTIVITY_EVENTS) assert.equal(dom.windowListeners(type), 1, type);

      await act(async () => dom.emit(event));
      assert.equal(rig()?.get("data-pose"), "stand", event);
      assert.equal(rig()?.get("data-expression"), "wide");
      assert.equal(rig()?.get("data-props"), "bang");
      // The startle lasts STARTLE_MS, whatever else happens meanwhile.
      await act(async () => dom.emit("pointermove"));
      await tick(STARTLE_MS - 1);
      assert.equal(done, 0);
      await tick(1);
      assert.equal(done, 1, event);
      // It stopped listening once it was startled.
      for (const type of DOZE_ACTIVITY_EVENTS) assert.equal(dom.windowListeners(type), 0, type);
    });
  }
});

test("a hidden window ends the doze at once, asleep or startled, and one that starts hidden never shows", async () => {
  let done = 0;
  await inFakeBrowser(createElement(DozeLayer, { play: play("doze"), done: () => done++ }), async (dom) => {
    dom.setVisibility("hidden");
    assert.equal(done, 1);
  });
  done = 0;
  await inFakeBrowser(createElement(DozeLayer, { play: play("doze"), done: () => done++, startled: true }), async (dom) => {
    assert.equal(done, 0);
    dom.setVisibility("hidden");
    assert.equal(done, 1);
  });
  done = 0;
  const dom = fakeDom();
  dom.install();
  dom.setVisibility("hidden");
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () => root.render(createElement(DozeLayer, { play: play("doze"), done: () => done++ })));
    assert.equal(done, 1);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("an unmounted doze lets go of every listener and timer", async () => {
  let done = 0;
  await inFakeBrowser(createElement(DozeLayer, { play: play("doze"), done: () => done++ }), async (dom, root) => {
    assert.equal(dom.documentListeners("visibilitychange"), 1);
    await act(async () => root.unmount());
    for (const type of DOZE_ACTIVITY_EVENTS) assert.equal(dom.windowListeners(type), 0, type);
    assert.equal(dom.documentListeners("visibilitychange"), 0);
    await act(async () => dom.emit("keydown"));
    await tick(10 * MIN);
    assert.equal(done, 0);
  });
});

/** The relay the main window's hooks read, with `count` accounts and its data loaded or not. */
function relayWith(count: number, loaded: boolean): Relay {
  return {
    settings: DEFAULT_SETTINGS,
    error: "",
    desktopBusy: false,
    desktop: undefined,
    desktopRequest: undefined,
    accounts: Array.from({ length: count }, (_, i) => ({ id: `a${i}` })),
    data: loaded ? {} : undefined,
  } as unknown as Relay;
}
const mainWindow = (count: number, loaded: boolean) =>
  createElement(RelayContext.Provider, { value: relayWith(count, loaded) }, createElement(RelayPrankStage, null, createElement(MainWindowPranks)));

/** Swaps layers for ones that only record that they were drawn, for the length of `run`. */
async function withSpyLayers(
  kinds: PrankPlay["kind"][],
  run: (drawn: PrankPlay["kind"][], finish: () => void, plays: PrankPlay[]) => Promise<void>,
) {
  const original = { ...PRANK_LAYERS };
  const drawn: PrankPlay["kind"][] = [];
  const plays: PrankPlay[] = [];
  let finish = noop;
  const spy: PrankLayer = ({ play: current, done }) => {
    drawn.push(current.kind);
    plays.push(current);
    finish = done;
    return null;
  };
  for (const kind of kinds) PRANK_LAYERS[kind] = spy;
  try {
    await run(drawn, () => finish(), plays);
  } finally {
    for (const kind of kinds) {
      if (original[kind]) PRANK_LAYERS[kind] = original[kind];
      else delete PRANK_LAYERS[kind];
    }
  }
}

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return { map, getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value) };
}

test("the main window dozes off after 10 idle visible minutes, and never twice within the gap", async () => {
  const storage = memoryStorage();
  await withSpyLayers(["doze"], async (drawn, finish) => {
    await inFakeBrowser(
      mainWindow(1, true),
      async (dom) => {
        await tick(10 * MIN - DOZE_CHECK_MS);
        assert.deepEqual(drawn, []);
        // Activity starts the 10 minutes over.
        await act(async () => dom.emit("pointermove"));
        await tick(10 * MIN - DOZE_CHECK_MS);
        assert.deepEqual(drawn, []);
        await tick(DOZE_CHECK_MS);
        assert.deepEqual(drawn, ["doze"]);
        assert.deepEqual(JSON.parse(storage.map.get(PRANK_HISTORY_KEY) ?? "[]").length, 1);
        // The budget's 30 minute gap holds it back afterwards; the checks go on without drawing again.
        await act(async () => finish());
        await tick(20 * MIN);
        assert.deepEqual(drawn, ["doze"]);
        // Past the gap, still idle: the next check dozes again.
        await tick(15 * MIN);
        assert.deepEqual(drawn, ["doze", "doze"]);
      },
      { localStorage: () => storage },
    );
  });
});

test("a window shown again after hours hidden starts its 10 minutes over", async () => {
  await withSpyLayers(["doze"], async (drawn) => {
    await inFakeBrowser(
      mainWindow(1, true),
      async (dom) => {
        dom.setVisibility("hidden");
        await tick(5 * 60 * MIN);
        assert.deepEqual(drawn, []);
        dom.setVisibility("visible");
        // Reopened after hours: no doze at the next check, nor until 10 visible minutes have passed.
        await tick(DOZE_CHECK_MS);
        assert.deepEqual(drawn, []);
        await tick(10 * MIN - 2 * DOZE_CHECK_MS);
        assert.deepEqual(drawn, []);
        await tick(DOZE_CHECK_MS);
        assert.deepEqual(drawn, ["doze"]);
      },
      { localStorage: () => memoryStorage() },
    );
  });
});

test("the doze check does not ask while the window is hidden, whatever the stage would say", async () => {
  // A stage that ignores its gates, so only the hook's own check can keep a hidden window from dozing.
  const open = { level: "sometimes", desktopBusy: false, errorShown: false, dialogOpen: false, ignoreLimits: true } as const;
  const tree = createElement(RelayContext.Provider, { value: relayWith(1, true) }, createElement(PrankStage, { ...open, children: createElement(MainWindowPranks) }));
  await withSpyLayers(["doze"], async (drawn) => {
    await inFakeBrowser(tree, async (dom) => {
      dom.setVisibility("hidden");
      await tick(11 * MIN);
      assert.deepEqual(drawn, []);
      dom.setVisibility("visible");
      await tick(10 * MIN - DOZE_CHECK_MS);
      assert.deepEqual(drawn, []);
      await tick(DOZE_CHECK_MS);
      assert.deepEqual(drawn, ["doze"]);
    });
  });
});

test("the main window stops checking for the doze when it closes", async () => {
  await withSpyLayers(["doze"], async (drawn) => {
    await inFakeBrowser(
      mainWindow(1, true),
      async (dom, root) => {
        for (const type of DOZE_ACTIVITY_EVENTS) assert.equal(dom.windowListeners(type), 1, type);
        assert.equal(dom.documentListeners("visibilitychange"), 1);
        await act(async () => root.unmount());
        for (const type of DOZE_ACTIVITY_EVENTS) assert.equal(dom.windowListeners(type), 0, type);
        assert.equal(dom.documentListeners("visibilitychange"), 0);
        await tick(60 * MIN);
        assert.deepEqual(drawn, []);
      },
      { localStorage: () => memoryStorage() },
    );
  });
});

test("confetti falls once when the account count goes from 0 to 1, and stores the done flag", async () => {
  const storage = memoryStorage();
  await withSpyLayers(["confetti"], async (drawn, finish) => {
    await inFakeBrowser(
      mainWindow(0, false),
      async (_dom, root) => {
        // The data is not loaded yet: nothing is known, nothing falls.
        await act(async () => root.render(mainWindow(0, false)));
        assert.deepEqual(drawn, []);
        await act(async () => root.render(mainWindow(0, true)));
        assert.deepEqual(drawn, []);
        assert.equal(storage.map.has(CONFETTI_KEY), false);
        await act(async () => root.render(mainWindow(1, true)));
        assert.deepEqual(drawn, ["confetti"]);
        assert.ok(storage.map.has(CONFETTI_KEY));
        // Leaving and coming back to 1 in the same session does not fall again.
        await act(async () => finish());
        await act(async () => root.render(mainWindow(0, true)));
        await act(async () => root.render(mainWindow(1, true)));
        assert.deepEqual(drawn, ["confetti"]);
      },
      { localStorage: () => storage },
    );
  });
});

test("confetti never falls for a returning user: a first load that already has accounts is only a baseline", async () => {
  for (const first of [1, 3]) {
    const storage = memoryStorage();
    await withSpyLayers(["confetti"], async (drawn) => {
      await inFakeBrowser(
        mainWindow(first, false),
        async (_dom, root) => {
          await act(async () => root.render(mainWindow(first, true)));
          await act(async () => root.render(mainWindow(first + 1, true)));
          assert.deepEqual(drawn, [], `first load with ${first}`);
          assert.equal(storage.map.size, 0);
        },
        { localStorage: () => storage },
      );
    });
  }
});

test("confetti stays away when the flag is already stored, or when the storage cannot be read", async () => {
  const unreadable = () => {
    throw new Error("SecurityError");
  };
  const cases: [string, () => unknown][] = [
    ["flag set", () => memoryStorage({ [CONFETTI_KEY]: "1" })],
    ["storage throws", unreadable],
    ["reads throw", () => ({ getItem: unreadable, setItem: unreadable })],
  ];
  for (const [name, localStorage] of cases) {
    await withSpyLayers(["confetti"], async (drawn) => {
      await inFakeBrowser(
        mainWindow(0, true),
        async (_dom, root) => {
          await act(async () => root.render(mainWindow(1, true)));
          assert.deepEqual(drawn, [], name);
        },
        { localStorage },
      );
    });
  }
});

test("confetti still falls once when the done flag cannot be written", () => {
  const unwritable = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } };
  assert.equal(confettiFalls(0, 1, () => unwritable), true);
  assert.equal(confettiFalls(undefined, 1, () => unwritable), false);
  assert.equal(confettiFalls(1, 2, () => unwritable), false);
  const flags = memoryStorage();
  assert.equal(confettiFalls(0, 1, () => flags), true);
  assert.equal(flags.map.get(CONFETTI_KEY), "1");
  assert.equal(confettiFalls(0, 1, () => flags), false);
});

test("confetti obeys Reduce motion and Off: the stage refuses, the layer never draws", async () => {
  for (const [name, relay, options] of [
    ["reduced motion", relayWith(1, true), { reducedMotion: true }],
    ["off", { ...relayWith(1, true), settings: { ...DEFAULT_SETTINGS, pranks: "off" } } as Relay, {}],
  ] as const) {
    await withSpyLayers(["confetti"], async (drawn) => {
      const tree = (count: number) =>
        createElement(
          RelayContext.Provider,
          { value: { ...relay, accounts: relayWith(count, true).accounts } },
          createElement(RelayPrankStage, null, createElement(MainWindowPranks)),
        );
      await inFakeBrowser(
        tree(0),
        async (_dom, root) => {
          await act(async () => root.render(tree(1)));
          assert.deepEqual(drawn, [], name);
        },
        { localStorage: () => memoryStorage(), ...options },
      );
    });
  }
});

test("a meter rests on its bar for 0.6 s only above 90%, and leaving cancels the wait", () => {
  assert.equal(NIBBLE_BAR_PERCENT, 90);
  assert.equal(NIBBLE_BAR_HOVER_MS, 600);
  const calls: { ms: number; cancelled: boolean }[] = [];
  const schedule = (_run: () => void, ms: number) => {
    const call = { ms, cancelled: false };
    calls.push(call);
    return () => {
      call.cancelled = true;
    };
  };
  for (const below of [undefined, 0, 50, 89.9, 90]) assert.equal(nibbleBarRest(below, noop, schedule), undefined, String(below));
  assert.deepEqual(calls, []);
  let fired = 0;
  const cancel = nibbleBarRest(90.1, () => fired++, schedule);
  assert.deepEqual(calls, [{ ms: 600, cancelled: false }]);
  cancel?.();
  assert.deepEqual(calls, [{ ms: 600, cancelled: true }]);
  assert.equal(fired, 0);
  // With the default timer, the wait runs the callback once the time is up.
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    nibbleBarRest(100, () => fired++);
    mock.timers.tick(599);
    assert.equal(fired, 0);
    mock.timers.tick(1);
    assert.equal(fired, 1);
    nibbleBarRest(100, () => fired++)?.();
    mock.timers.tick(600);
    assert.equal(fired, 1);
  } finally {
    mock.timers.reset();
  }
});

/** What a hover test drives: a LimitMeter in a stage with the real gates and a budget it can read, and the plays it drew. */
interface MeterRig {
  /** The coloured fill: the element the nibble must anchor on. */
  fill: FakeNode;
  plays: PrankPlay[];
  /** How many offers the stage accepted, counted in its budget history, so a meter that is gone is still seen offering. */
  offers(): number;
  enter(): Promise<void>;
  leave(): Promise<void>;
  /** The pointer moves from the bar onto the label, still inside the meter. */
  moveWithin(): Promise<void>;
  unmount(): Promise<void>;
}
const FILL_BOX = { left: 40, top: 100, width: 190, height: 6 };

/** Mounts a meter, sets a recognisable box on its fill, and lets the test hover it through React's own pointer events. */
async function withMeter(percent: number | undefined, run: (meter: MeterRig) => Promise<void>) {
  const storage = memoryStorage();
  const stage = { level: "sometimes", desktopBusy: false, errorShown: false, dialogOpen: false, storage, random: () => 0 } as const;
  const tree = createElement(PrankStage, { ...stage, children: createElement(LimitMeter, { label: "5 saat", percent }) });
  await withSpyLayers(["nibble-bar"], async (_drawn, _finish, plays) => {
    await inFakeBrowser(tree, async (dom, root) => {
      const top = dom.container as unknown as FakeNode;
      const track = findNode(top, (n) => n.attributes.get("role") === "meter");
      const fill = findNode(top, (n) => (n.attributes.get("class") ?? "").includes("h-full"));
      const label = findNode(top, (n) => n.tagName === "span");
      assert.ok(track && fill && label, "the meter's bar, fill and label are drawn");
      fill.box = FILL_BOX;
      await run({
        fill,
        plays,
        offers: () => (JSON.parse(storage.map.get(PRANK_HISTORY_KEY) ?? "[]") as number[]).length,
        enter: () => act(async () => dom.dispatch(track, "pointerover")),
        leave: () => act(async () => dom.dispatch(track, "pointerout")),
        moveWithin: async () => {
          await act(async () => dom.dispatch(track, "pointerout", { relatedTarget: label }));
          await act(async () => dom.dispatch(label, "pointerover", { relatedTarget: track }));
        },
        unmount: () => act(async () => root.unmount()),
      });
    });
  });
}

test("a mouse that rests 0.6 s on a meter above 90% offers the nibble, anchored on the coloured fill", async () => {
  await withMeter(95, async (meter) => {
    await meter.enter();
    await tick(NIBBLE_BAR_HOVER_MS - 1);
    assert.equal(meter.offers(), 0);
    await tick(1);
    assert.equal(meter.offers(), 1);
    assert.equal(meter.plays[0].kind, "nibble-bar");
    // The rect is the fill's, not the meter's or the bar's (those answer all zeros here).
    assert.deepEqual(meter.plays[0].rect, FILL_BOX);
    assert.equal(meter.plays[0].point, undefined);
  });
});

test("a pointer that leaves before 0.6 s cancels the nibble, and coming back starts the wait again", async () => {
  await withMeter(100, async (meter) => {
    await meter.enter();
    await tick(300);
    await meter.leave();
    await tick(2_000);
    assert.equal(meter.offers(), 0);
    await meter.enter();
    await tick(NIBBLE_BAR_HOVER_MS - 1);
    assert.equal(meter.offers(), 0);
    await tick(1);
    assert.equal(meter.offers(), 1);
  });
});

test("entering a meter again while a wait is running restarts it instead of stacking a second", async () => {
  await withMeter(95, async (meter) => {
    await meter.enter();
    await tick(300);
    await meter.enter();
    await tick(NIBBLE_BAR_HOVER_MS - 1);
    assert.equal(meter.offers(), 0);
    await tick(1);
    assert.equal(meter.offers(), 1);
  });
});

test("a pointer moving between a meter's own parts keeps resting, so the wait is not restarted or cancelled", async () => {
  await withMeter(95, async (meter) => {
    await meter.enter();
    await tick(300);
    await meter.moveWithin();
    await tick(300);
    assert.equal(meter.offers(), 1);
  });
});

test("a meter that goes away while the mouse rests on it offers nothing", async () => {
  await withMeter(95, async (meter) => {
    await meter.enter();
    await tick(300);
    await meter.unmount();
    await tick(2_000);
    assert.equal(meter.offers(), 0);
  });
});

test("a meter at 90% or below, or without a value, never offers", async () => {
  for (const percent of [90, 89.9, 50, 0, undefined]) {
    await withMeter(percent, async (meter) => {
      await meter.enter();
      await tick(5_000);
      assert.equal(meter.offers(), 0, String(percent));
    });
  }
  await withMeter(90.1, async (meter) => {
    await meter.enter();
    await tick(NIBBLE_BAR_HOVER_MS);
    assert.equal(meter.offers(), 1);
  });
});

test("the stylesheet drops leaves with motion on, draws them still and unseen without, and lands every leaf in time", () => {
  const css = readFileSync("src/styles/pranks.css", "utf8");
  const motion = mediaBlock(css, "(prefers-reduced-motion: no-preference)");
  assert.match(motion, /\.prank-leaf\s*\{/);
  // Every animation property, longhands included, sits inside the no-preference block.
  assert.doesNotMatch(css.replace(motion, ""), /animation[\w-]*\s*:/);
  assert.match(motion, /\.prank-leaf\s*\{[^}]*animation-name:\s*prank-leaf-fall/);
  assert.match(css, /@keyframes prank-leaf-fall\s*\{/);
  assert.match(css, /\.prank-leaf\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /\.prank-leaf\s*\{[^}]*opacity:\s*0/);
  // The last leaf starts at its delay and falls for the animation's duration: both fit in the layer's time.
  const fall = Number(/animation-duration:\s*([\d.]+)s/.exec(motion)?.[1]);
  const html = renderToStaticMarkup(createElement(ConfettiLayer, { play: play("confetti"), done: noop }));
  const delays = [...html.matchAll(/animation-delay:([\d.]+)s/g)].map((m) => Number(m[1]));
  assert.equal(delays.length, 14);
  assert.ok(Number.isFinite(fall) && fall > 0);
  assert.ok(Math.max(...delays) + fall <= CONFETTI_MS / 1000, `${Math.max(...delays)} s + ${fall} s`);
});

test("mediaBlock ignores a comment that names the query or holds a brace, and returns the block as written", () => {
  const css = '/* @media (prefers-reduced-motion: no-preference) { */\n.a { animation: x 1s; }\n@media (prefers-reduced-motion: no-preference) {\n  /* a } brace */\n  .b { animation: y 1s; }\n}\n.c { color: red; }';
  const block = mediaBlock(css, "(prefers-reduced-motion: no-preference)");
  assert.match(block, /\.b \{ animation: y 1s; \}/);
  assert.ok(block.includes("/* a } brace */"));
  assert.doesNotMatch(block, /\.a|\.c/);
  assert.doesNotMatch(css.replace(block, ""), /animation: y/);
  assert.match(css.replace(block, ""), /animation: x/);
  assert.equal(mediaBlock("/* @media (min-width: 1px) { .a { color: red } } */ .b {}", "(min-width: 1px)"), "");
});

test("the main window mounts its doze and confetti hooks inside the stage, and the refresh buttons offer the wheel after their action", () => {
  const shell = readFileSync("src/app/Shell.tsx", "utf8");
  assert.match(shell, /<RelayPrankStage>\s*<MainWindowPranks \/>/);
  for (const file of ["src/panel/Panel.tsx", "src/pages/Overview.tsx"]) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /offerAfter\(prank, "wheel", e, \(\) => \{\s*for \(const a of accounts\) void relay\.refreshUsage\(a\);\s*\}\)/, file);
  }
});
