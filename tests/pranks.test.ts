import test from "node:test";
import assert from "node:assert/strict";
import {
  PRANK_BUDGET, PRANK_HISTORY_KEY, PRANK_HISTORY_MS,
  PRANK_QUIET_MS, PRANK_SINCE_KEY, PRANK_SWITCHED_KEY,
  markFirstSwitch, prankDecision, quietOnDayOne, readPrankHistory, recordPrank,
  type PrankKind,
} from "../src/pranks/budget";
import { prankBlocked, type PrankGate } from "../src/pranks/gate";
import { PANDA_SCENES, type PandaSceneSpec } from "../src/mascot/scenes";
import {
  TRICK_MS, TRICK_RESET_MS, nextClick, trickFor, trickLook, type Trick,
} from "../src/pranks/tricks";
import {
  CONFETTI_KEY, CONFETTI_MS, DOZE_AFTER_MS, NIBBLE_ABORT_PX, NIBBLE_MAX_MS, NIBBLE_MS, NIBBLE_SIZE,
  STARTLE_MS, confettiDue, dozeDue, nibbleAborts, nibbleFrame, nibbleLayout,
  type Edge, type NibblePhase,
} from "../src/pranks/timing";

/** Local noon, so "earlier today" and "yesterday" are the same on every time zone. */
const NOW = new Date(2026, 9, 16, 12, 0).getTime();
const MIN = 60_000;
const HOUR = 3_600_000;
const never = () => {
  throw new Error("the random draw must not happen");
};

/** The plain { getItem, setItem } object later tasks replace with window.localStorage. */
function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

test("the budget table holds the agreed chances, gaps and daily limits", () => {
  assert.deepEqual(PRANK_BUDGET.sometimes, { chance: 1 / 8, gapMs: 30 * MIN, perDay: 4 });
  assert.deepEqual(PRANK_BUDGET.rarely, { chance: 1 / 15, gapMs: 2 * HOUR, perDay: 1 });
  assert.equal(PRANK_BUDGET.off.perDay, 0);
  assert.equal(PRANK_HISTORY_KEY, "relay-pranks");
  assert.equal(PRANK_HISTORY_MS, 48 * HOUR);
});

test("sometimes: the draw passes under 1/8 and fails from it", () => {
  const decide = (random: number) =>
    prankDecision({ level: "sometimes", history: [], now: NOW, random: () => random, chance: true });
  assert.equal(decide(0.12), true);
  assert.equal(decide(0.13), false);
  assert.equal(decide(0), true);
});

test("sometimes: a prank 29 minutes ago blocks and one 31 minutes ago does not", () => {
  const decide = (agoMs: number) =>
    prankDecision({ level: "sometimes", history: [NOW - agoMs], now: NOW, random: () => 0, chance: true });
  assert.equal(decide(29 * MIN), false);
  assert.equal(decide(31 * MIN), true);
});

test("the gap counts from the newest prank, wherever it sits in the history", () => {
  const history = [NOW - 29 * MIN, NOW - 5 * HOUR, NOW - 6 * HOUR];
  assert.equal(prankDecision({ level: "sometimes", history, now: NOW, random: () => 0, chance: false }), false);
});

test("sometimes: four pranks earlier today block, four yesterday do not", () => {
  const today = [1, 2, 3, 4].map((h) => NOW - h * HOUR);
  const yesterday = [20, 21, 22, 23].map((h) => new Date(2026, 9, 15, h).getTime());
  const decide = (history: number[]) =>
    prankDecision({ level: "sometimes", history, now: NOW, random: () => 0, chance: true });
  assert.equal(decide(today), false);
  assert.equal(decide(today.slice(1)), true, "three today leave one");
  assert.equal(decide(yesterday), true);
});

test("without the chance, the draw is skipped and the gap and the daily limit still hold", () => {
  const decide = (history: number[], random: () => number) =>
    prankDecision({ level: "sometimes", history, now: NOW, random, chance: false });
  assert.equal(decide([], () => 0.99), true);
  assert.equal(decide([], never), true, "no draw at all");
  assert.equal(decide([NOW - 10 * MIN], never), false);
  assert.equal(decide([1, 2, 3, 4].map((h) => NOW - h * HOUR), never), false);
});

test("rarely: the draw passes under 1/15 and fails from it", () => {
  const decide = (random: number) =>
    prankDecision({ level: "rarely", history: [], now: NOW, random: () => random, chance: true });
  assert.equal(decide(0.06), true);
  assert.equal(decide(0.07), false);
});

test("rarely: a prank 1 h 59 min ago blocks, and one earlier today blocks", () => {
  const decide = (history: number[]) =>
    prankDecision({ level: "rarely", history, now: NOW, random: () => 0, chance: true });
  assert.equal(decide([NOW - (2 * HOUR - MIN)]), false);
  assert.equal(decide([NOW - 3 * HOUR]), false, "the gap is over, the day is used up");
  assert.equal(decide([new Date(2026, 9, 15, 23).getTime()]), true, "yesterday does not count");
});

test("rarely: the 2 h gap holds on its own just after midnight", () => {
  const night = new Date(2026, 9, 16, 0, 30).getTime();
  const lateYesterday = (agoMs: number) => [night - agoMs];
  const decide = (history: number[]) =>
    prankDecision({ level: "rarely", history, now: night, random: () => 0, chance: true });
  assert.equal(decide(lateYesterday(90 * MIN)), false);
  assert.equal(decide(lateYesterday(2 * HOUR + MIN)), true);
});

test("off never passes", () => {
  for (const chance of [true, false]) {
    for (const random of [0, 0.5, 0.99]) {
      assert.equal(prankDecision({ level: "off", history: [], now: NOW, random: () => random, chance }), false);
    }
  }
});

test("readPrankHistory drops entries older than 48 hours", () => {
  const fresh = [NOW - 47 * HOUR, NOW - HOUR];
  const storage = memoryStorage({
    [PRANK_HISTORY_KEY]: JSON.stringify([NOW - 49 * HOUR, NOW - 100 * HOUR, ...fresh]),
  });
  assert.deepEqual(readPrankHistory(storage, NOW), fresh);
});

test("readPrankHistory answers [] for a missing or malformed record", () => {
  assert.deepEqual(readPrankHistory(memoryStorage(), NOW), []);
  for (const raw of ["{not json", "", "null", "42", "\"text\"", "{\"a\":1}"]) {
    assert.deepEqual(readPrankHistory(memoryStorage({ [PRANK_HISTORY_KEY]: raw }), NOW), [], raw);
  }
});

test("readPrankHistory keeps only real times from a half-broken list", () => {
  const raw = JSON.stringify([NOW - HOUR, "x", null, {}, NOW - 2 * HOUR]);
  assert.deepEqual(readPrankHistory(memoryStorage({ [PRANK_HISTORY_KEY]: raw }), NOW), [NOW - HOUR, NOW - 2 * HOUR]);
});

test("readPrankHistory ignores times in the future, which would block the gap for good", () => {
  const raw = JSON.stringify([NOW + 10 * HOUR, 9e15, NOW - HOUR]);
  assert.deepEqual(readPrankHistory(memoryStorage({ [PRANK_HISTORY_KEY]: raw }), NOW), [NOW - HOUR]);
});

test("readPrankHistory answers undefined when getItem throws", () => {
  const storage = { getItem: () => { throw new Error("denied"); } };
  assert.equal(readPrankHistory(storage, NOW), undefined);
});

test("recordPrank stores the history plus now, pruned to 48 hours", () => {
  const storage = memoryStorage();
  const history = [NOW - 60 * HOUR, NOW - 3 * HOUR];
  assert.equal(recordPrank(storage, history, NOW), true);
  assert.deepEqual(JSON.parse(storage.getItem(PRANK_HISTORY_KEY) ?? "null"), [NOW - 3 * HOUR, NOW]);
  assert.deepEqual(readPrankHistory(storage, NOW), [NOW - 3 * HOUR, NOW]);
});

test("recordPrank answers false when setItem throws", () => {
  const storage = { setItem: () => { throw new Error("quota"); } };
  assert.equal(recordPrank(storage, [], NOW), false);
});

test("two windows over one storage share one budget", () => {
  const storage = memoryStorage();
  const decideIn = (now: number) => {
    const history = readPrankHistory(storage, now);
    assert.ok(history, "storage is readable");
    return { history, ok: prankDecision({ level: "sometimes", history, now, random: () => 0, chance: true }) };
  };

  const panel = decideIn(NOW);
  assert.equal(panel.ok, true);
  assert.equal(recordPrank(storage, panel.history, NOW), true);

  const main = decideIn(NOW + 5 * MIN);
  assert.equal(main.ok, false, "the main window is blocked by the panel's prank");

  const later = decideIn(NOW + 31 * MIN);
  assert.equal(later.ok, true, "the gap is over");
  assert.equal(later.history.length, 1);
});

const clear: PrankGate = {
  reducedMotion: false,
  level: "sometimes",
  desktopBusy: false,
  errorShown: false,
  windowVisible: true,
  keyboard: false,
  dialogOpen: false,
};
/** Each gate field set on its own, with the rest clear. */
const blockers: Record<string, PrankGate> = {
  reducedMotion: { ...clear, reducedMotion: true },
  "level off": { ...clear, level: "off" },
  desktopBusy: { ...clear, desktopBusy: true },
  errorShown: { ...clear, errorShown: true },
  "window hidden": { ...clear, windowVisible: false },
  keyboard: { ...clear, keyboard: true },
  dialogOpen: { ...clear, dialogOpen: true },
  "day one": { ...clear, dayOne: true },
};
const KINDS: (PrankKind | "trick")[] = ["nibble-cursor", "wheel", "nibble-bar", "doze", "confetti", "trick"];

test("pranks stay quiet for the first 24 hours after Relay first runs", () => {
  assert.equal(PRANK_QUIET_MS, 24 * HOUR);
  const storage = memoryStorage();
  // The first ask stores the first-run time, and is quiet.
  assert.equal(quietOnDayOne(storage, NOW), true);
  assert.equal(storage.getItem(PRANK_SINCE_KEY), String(NOW));
  assert.equal(quietOnDayOne(storage, NOW + 23 * HOUR), true);
  assert.equal(quietOnDayOne(storage, NOW + 24 * HOUR), false);
  // The first-run time is kept, not moved forward.
  assert.equal(storage.getItem(PRANK_SINCE_KEY), String(NOW));
  // A time in the future (a clock set back) starts the day again.
  const ahead = memoryStorage({ [PRANK_SINCE_KEY]: String(NOW + HOUR) });
  assert.equal(quietOnDayOne(ahead, NOW), true);
  assert.equal(ahead.getItem(PRANK_SINCE_KEY), String(NOW));
});

test("the first successful switch ends the quiet day early", () => {
  const storage = memoryStorage({ [PRANK_SINCE_KEY]: String(NOW) });
  assert.equal(quietOnDayOne(storage, NOW + HOUR), true);
  markFirstSwitch(storage);
  assert.equal(storage.getItem(PRANK_SWITCHED_KEY), "1");
  assert.equal(quietOnDayOne(storage, NOW + HOUR), false);
});

test("a storage that throws keeps the pranks quiet", () => {
  const broken = {
    getItem: () => {
      throw new Error("no storage");
    },
    setItem: () => {
      throw new Error("no storage");
    },
  };
  assert.equal(quietOnDayOne(broken, NOW), true);
  assert.doesNotThrow(() => markFirstSwitch(broken));
});

test("every gate field blocks a wheel and a trick on its own", () => {
  for (const [name, gate] of Object.entries(blockers)) {
    assert.equal(prankBlocked("wheel", gate), true, `wheel, ${name}`);
    assert.equal(prankBlocked("trick", gate), true, `trick, ${name}`);
  }
});

test("every prank except confetti is blocked by every gate field", () => {
  for (const kind of KINDS.filter((k) => k !== "confetti")) {
    for (const [name, gate] of Object.entries(blockers)) {
      assert.equal(prankBlocked(kind, gate), true, `${kind}, ${name}`);
    }
  }
});

test("with every gate clear nothing is blocked", () => {
  for (const kind of KINDS) {
    assert.equal(prankBlocked(kind, clear), false, kind);
    assert.equal(prankBlocked(kind, { ...clear, level: "rarely" }), false, `${kind}, rarely`);
  }
});

test("confetti is blocked only by reduced motion and off", () => {
  assert.equal(prankBlocked("confetti", blockers.reducedMotion), true);
  assert.equal(prankBlocked("confetti", blockers["level off"]), true);
  for (const name of ["desktopBusy", "errorShown", "window hidden", "keyboard", "dialogOpen"]) {
    assert.equal(prankBlocked("confetti", blockers[name]), false, name);
  }
  const everythingElse: PrankGate = {
    ...clear, desktopBusy: true, errorShown: true, windowVisible: false, keyboard: true, dialogOpen: true,
  };
  assert.equal(prankBlocked("confetti", everythingElse), false);
});

test("the trick and timing constants hold the agreed values", () => {
  assert.equal(TRICK_MS, 1_200);
  assert.equal(TRICK_RESET_MS, 30_000);
  assert.equal(DOZE_AFTER_MS, 600_000);
  assert.equal(STARTLE_MS, 600);
  assert.equal(CONFETTI_KEY, "relay-confetti-done");
  assert.equal(CONFETTI_MS, 2_000);
  assert.equal(NIBBLE_MS, 1_500);
  assert.equal(NIBBLE_ABORT_PX, 80);
  assert.equal(NIBBLE_MAX_MS, 3_000);
  assert.equal(NIBBLE_SIZE, 88);
});

// --- click counting ---------------------------------------------------------

test("nextClick starts at 1, counts on within 30 s, and resets after it", () => {
  assert.deepEqual(nextClick(undefined, 0), { count: 1, at: 0 });
  assert.deepEqual(nextClick({ count: 1, at: 0 }, 29_000), { count: 2, at: 29_000 });
  assert.deepEqual(nextClick({ count: 5, at: 0 }, 31_000), { count: 1, at: 31_000 });
});

test("nextClick resets once 30 s have passed, and not a millisecond before", () => {
  assert.equal(nextClick({ count: 3, at: 0 }, TRICK_RESET_MS - 1).count, 4);
  assert.equal(nextClick({ count: 3, at: 0 }, TRICK_RESET_MS).count, 1);
});

test("the click after the 10th starts again at 1", () => {
  assert.deepEqual(nextClick({ count: 9, at: 100 }, 200), { count: 10, at: 200 });
  assert.deepEqual(nextClick({ count: 10, at: 200 }, 300), { count: 1, at: 300 });
});

test("ten quick clicks count 1 to 10 and the eleventh is a 1 again", () => {
  let state: { count: number; at: number } | undefined;
  const seen: number[] = [];
  for (let i = 0; i < 11; i += 1) {
    state = nextClick(state, i * 1_000);
    seen.push(state.count);
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1]);
});

test("nextClick does not touch the previous record", () => {
  const previous = Object.freeze({ count: 2, at: 5 });
  assert.deepEqual(nextClick(previous, 6), { count: 3, at: 6 });
  assert.deepEqual(previous, { count: 2, at: 5 });
});

// --- which trick ------------------------------------------------------------

test("clicks 1 to 3 pick swish, wave or happy by the draw", () => {
  for (const count of [1, 2, 3]) {
    assert.equal(trickFor(count, () => 0), "swish", `count ${count}`);
    assert.equal(trickFor(count, () => 0.5), "wave", `count ${count}`);
    assert.equal(trickFor(count, () => 0.99), "happy", `count ${count}`);
  }
});

test("the three random tricks split the draw in thirds", () => {
  assert.equal(trickFor(1, () => 0.33), "swish");
  assert.equal(trickFor(1, () => 0.34), "wave");
  assert.equal(trickFor(1, () => 0.66), "wave");
  assert.equal(trickFor(1, () => 0.67), "happy");
});

test("clicks 4 to 6 are grumpy, 7 to 9 hide, and the 10th is rawr", () => {
  const draws = [() => 0, () => 0.5, () => 0.99];
  for (const random of draws) {
    for (const count of [4, 5, 6]) assert.equal(trickFor(count, random), "grumpy", `count ${count}`);
    for (const count of [7, 8, 9]) assert.equal(trickFor(count, random), "hide", `count ${count}`);
    assert.equal(trickFor(10, random), "rawr");
  }
});

test("only clicks 1 to 3 draw", () => {
  for (const count of [4, 5, 6, 7, 8, 9, 10]) assert.doesNotThrow(() => trickFor(count, never), `count ${count}`);
});

// --- how a trick looks ------------------------------------------------------

const welcome: PandaSceneSpec = PANDA_SCENES.welcome;

test("trickLook with no trick returns the spec unchanged", () => {
  assert.equal(trickLook(welcome, undefined), welcome);
  assert.equal("trick" in trickLook(welcome, undefined), false);
});

test("happy sets the happy expression and the trick", () => {
  assert.deepEqual(trickLook(welcome, "happy"), { ...welcome, expression: "happy", trick: "happy" });
  const open: PandaSceneSpec = { pose: "sit", expression: "open", props: [], motion: ["blink"] };
  assert.deepEqual(trickLook(open, "happy"), { ...open, expression: "happy", trick: "happy" });
});

test("grumpy sets the worried expression and the trick", () => {
  const look = trickLook(welcome, "grumpy");
  assert.equal(look.expression, "worried");
  assert.equal(look.trick, "grumpy");
  assert.equal(look.pose, welcome.pose);
  assert.deepEqual(look.props, welcome.props);
  assert.deepEqual(look.motion, welcome.motion);
});

test("rawr stands up wide-eyed, with no props", () => {
  const look = trickLook(welcome, "rawr");
  assert.equal(look.pose, "stand");
  assert.equal(look.expression, "wide");
  assert.deepEqual(look.props, []);
  assert.equal(look.trick, "rawr");
  // wave (arm-left), blink (eyes) and tail (tail) all have a part in the stand pose.
  assert.deepEqual(look.motion, ["wave", "blink", "tail"]);
});

test("rawr drops a motion the stand pose has no part for, and keeps the rest", () => {
  const walking: PandaSceneSpec = { pose: "walk", expression: "open", props: ["bamboo"], motion: ["walk", "look", "blink"] };
  assert.deepEqual(trickLook(walking, "rawr").motion, ["look", "blink"], "walk needs legs, which stand does not have");
  const sitting: PandaSceneSpec = { pose: "sit", expression: "open", props: [], motion: ["look", "nod", "tail"] };
  assert.deepEqual(trickLook(sitting, "rawr").motion, ["look", "nod", "tail"], "look and nod move the head, which stand has");
});

test("wave adds wave to the motion, once", () => {
  const without: PandaSceneSpec = { pose: "sit", expression: "open", props: [], motion: ["blink", "tail"] };
  const added = trickLook(without, "wave");
  assert.deepEqual(added.motion, ["blink", "tail", "wave"]);
  assert.equal(added.trick, "wave");
  assert.equal(added.pose, "sit");
  assert.equal(added.expression, "open");
  assert.deepEqual(trickLook(welcome, "wave").motion, ["wave", "blink", "tail"], "welcome already waves");
});

test("swish and hide change nothing but the trick", () => {
  for (const trick of ["swish", "hide"] as const) {
    assert.deepEqual(trickLook(welcome, trick), { ...welcome, trick });
  }
});

test("trickLook never mutates its input", () => {
  const spec: PandaSceneSpec = Object.freeze({
    pose: "sit",
    expression: "open",
    props: Object.freeze(["bamboo"] as const),
    motion: Object.freeze(["walk", "blink"] as const),
  });
  const before = JSON.stringify(spec);
  const tricks: Trick[] = ["swish", "wave", "happy", "grumpy", "hide", "rawr"];
  for (const trick of tricks) {
    assert.doesNotThrow(() => trickLook(spec, trick), trick);
    assert.equal(JSON.stringify(spec), before, trick);
  }
  const withWave = trickLook(spec, "wave");
  assert.notEqual(withWave.motion, spec.motion);
  assert.deepEqual(spec.motion, ["walk", "blink"]);
});

// --- doze and confetti ------------------------------------------------------

test("dozeDue is true at exactly 10 minutes of inactivity and false a millisecond before", () => {
  assert.equal(dozeDue(0, DOZE_AFTER_MS), true);
  assert.equal(dozeDue(0, DOZE_AFTER_MS - 1), false);
  assert.equal(dozeDue(5_000, 5_000 + DOZE_AFTER_MS), true);
  assert.equal(dozeDue(5_000, 5_000 + DOZE_AFTER_MS + 1), true);
  assert.equal(dozeDue(5_000, 5_000), false);
});

test("confetti is due only on an observed 0 to 1, and only once", () => {
  assert.equal(confettiDue(0, 1, false), true);
  assert.equal(confettiDue(undefined, 1, false), false, "the first load of a returning user");
  assert.equal(confettiDue(1, 2, false), false);
  assert.equal(confettiDue(0, 1, true), false, "the flag says it already fell");
  assert.equal(confettiDue(1, 1, false), false);
  assert.equal(confettiDue(2, 1, false), false);
  assert.equal(confettiDue(0, 0, false), false);
});

// --- the nibble sequence ----------------------------------------------------

test("nibbleFrame follows the agreed phases to the millisecond", () => {
  const expected: [number, NibblePhase, boolean][] = [
    [0, "peek", false],
    [249, "peek", false],
    [250, "fly-in", false],
    [449, "fly-in", false],
    [450, "chew", false],
    [749, "chew", false],
    [750, "chew", true],
    [1049, "chew", true],
    [1050, "fly-out", true],
    [1299, "fly-out", true],
    [1300, "withdraw", true],
    [1499, "withdraw", true],
    [1500, "done", true],
  ];
  for (const [elapsed, phase, bitten] of expected) {
    assert.deepEqual(nibbleFrame(elapsed), { phase, bitten }, `${elapsed} ms`);
  }
});

test("nibbleFrame stays done past the end and peeks before the start", () => {
  assert.deepEqual(nibbleFrame(NIBBLE_MS + 5_000), { phase: "done", bitten: true });
  assert.deepEqual(nibbleFrame(-1), { phase: "peek", bitten: false });
});

test("nibbleAborts: the pointer moving 80 px or less from the start does not abort", () => {
  const start = { x: 100, y: 100 };
  assert.equal(nibbleAborts(start, { type: "pointermove", clientX: 179, clientY: 100 }), false);
  assert.equal(nibbleAborts(start, { type: "pointermove", clientX: 100, clientY: 21 }), false);
  assert.equal(nibbleAborts(start, { type: "pointermove", clientX: 180, clientY: 100 }), false, "exactly 80 px");
  assert.equal(nibbleAborts(start, { type: "pointermove", clientX: 100, clientY: 100 }), false);
});

test("nibbleAborts: the pointer moving more than 80 px from the start aborts, in any direction", () => {
  const start = { x: 100, y: 100 };
  assert.equal(nibbleAborts(start, { type: "pointermove", clientX: 181, clientY: 100 }), true);
  assert.equal(nibbleAborts(start, { type: "pointermove", clientX: 19, clientY: 100 }), true);
  assert.equal(nibbleAborts(start, { type: "pointermove", clientX: 100, clientY: 181 }), true);
  assert.equal(nibbleAborts(start, { type: "pointermove", clientX: 100, clientY: 19 }), true);
  // 57 px on each axis is 80.6 px away, 56 px on each axis is 79.2 px.
  assert.equal(nibbleAborts(start, { type: "pointermove", clientX: 157, clientY: 157 }), true);
  assert.equal(nibbleAborts(start, { type: "pointermove", clientX: 156, clientY: 156 }), false);
});

test("nibbleAborts: a pointermove without coordinates does not abort", () => {
  assert.equal(nibbleAborts({ x: 0, y: 0 }, { type: "pointermove" }), false);
});

test("nibbleAborts: any pointer or key press and a blur abort", () => {
  const start = { x: 100, y: 100 };
  assert.equal(nibbleAborts(start, { type: "pointerdown" }), true);
  assert.equal(nibbleAborts(start, { type: "keydown" }), true);
  assert.equal(nibbleAborts(start, { type: "blur" }), true);
});

test("nibbleAborts: visibilitychange aborts only when the document became hidden", () => {
  const start = { x: 100, y: 100 };
  assert.equal(nibbleAborts(start, { type: "visibilitychange", hidden: true }), true);
  assert.equal(nibbleAborts(start, { type: "visibilitychange", hidden: false }), false);
  assert.equal(nibbleAborts(start, { type: "visibilitychange" }), false);
});

test("nibbleAborts: events that are not part of the rules do not abort", () => {
  const start = { x: 100, y: 100 };
  for (const type of ["pointerup", "pointerenter", "focus", "scroll", "click"]) {
    assert.equal(nibbleAborts(start, { type, clientX: 500, clientY: 500 }), false, type);
  }
});

// --- where the nibbling panda sits -------------------------------------------

const VIEWPORT = { width: 800, height: 600 };
const near = (actual: number, expected: number, message: string) =>
  assert.ok(Math.abs(actual - expected) < 0.01, `${message}: ${actual} is not ${expected}`);

test("nibbleLayout: a point near the bottom puts the panda on the bottom edge", () => {
  const layout = nibbleLayout({ x: 400, y: 590 }, VIEWPORT, 88);
  assert.equal(layout.edge, "bottom");
  assert.equal(layout.rotate, 0);
  assert.equal(layout.left, 356);
  assert.equal(layout.top, 531.25);
  near(layout.held.x, 400, "held x");
  near(layout.held.y, 581.27, "held y");
});

test("nibbleLayout: the size defaults to 88", () => {
  assert.deepEqual(nibbleLayout({ x: 400, y: 590 }, VIEWPORT), nibbleLayout({ x: 400, y: 590 }, VIEWPORT, NIBBLE_SIZE));
});

test("nibbleLayout: the panda turns to the nearest edge", () => {
  const cases: [string, { x: number; y: number }, Edge, number][] = [
    ["bottom", { x: 400, y: 590 }, "bottom", 0],
    ["left", { x: 5, y: 300 }, "left", 90],
    ["top", { x: 400, y: 4 }, "top", 180],
    ["right", { x: 796, y: 300 }, "right", -90],
  ];
  for (const [name, point, edge, rotate] of cases) {
    const layout = nibbleLayout(point, VIEWPORT, 88);
    assert.equal(layout.edge, edge, name);
    assert.equal(layout.rotate, rotate, name);
  }
});

test("nibbleLayout: the ledge line lies on the chosen edge", () => {
  const ledge = (88 * 400) / 512; // 68.75 px below the box's top, before any turn
  const bottom = nibbleLayout({ x: 400, y: 590 }, VIEWPORT, 88);
  assert.equal(bottom.top + ledge, VIEWPORT.height);
  // Turned 180 or 90 degrees, the ledge sits 68.75 px from the box's bottom or right side instead.
  const top = nibbleLayout({ x: 400, y: 4 }, VIEWPORT, 88);
  assert.equal(top.top + 88 - ledge, 0);
  const left = nibbleLayout({ x: 5, y: 300 }, VIEWPORT, 88);
  assert.equal(left.left + 88 - ledge, 0);
  const right = nibbleLayout({ x: 796, y: 300 }, VIEWPORT, 88);
  assert.equal(right.left + ledge, VIEWPORT.width);
});

test("nibbleLayout: the box follows the point along the edge", () => {
  assert.equal(nibbleLayout({ x: 5, y: 300 }, VIEWPORT, 88).top, 256);
  assert.equal(nibbleLayout({ x: 796, y: 300 }, VIEWPORT, 88).top, 256);
  assert.equal(nibbleLayout({ x: 400, y: 4 }, VIEWPORT, 88).left, 356);
});

test("nibbleLayout: held turns with the panda, about the box centre", () => {
  const d = (88 * 35) / 512; // the held pivot sits 35 canvas px below the canvas centre
  const left = nibbleLayout({ x: 5, y: 300 }, VIEWPORT, 88);
  near(left.held.x, left.left + 44 - d, "left held x");
  near(left.held.y, left.top + 44, "left held y");
  const top = nibbleLayout({ x: 400, y: 4 }, VIEWPORT, 88);
  near(top.held.x, top.left + 44, "top held x");
  near(top.held.y, top.top + 44 - d, "top held y");
  const right = nibbleLayout({ x: 796, y: 300 }, VIEWPORT, 88);
  near(right.held.x, right.left + 44 + d, "right held x");
  near(right.held.y, right.top + 44, "right held y");
});

test("nibbleLayout: left and top keep the box inside the viewport along the edge", () => {
  const points: { x: number; y: number }[] = [
    { x: 400, y: 599 }, { x: 3, y: 599 }, { x: 797, y: 599 }, { x: 400, y: 0 }, { x: 2, y: 1 }, { x: 798, y: 1 },
    { x: 0, y: 300 }, { x: 0, y: 0 }, { x: 800, y: 600 }, { x: 799, y: 2 }, { x: 1, y: 598 },
  ];
  for (const point of points) {
    const layout = nibbleLayout(point, VIEWPORT, 88);
    const horizontal = layout.edge === "top" || layout.edge === "bottom";
    const along = horizontal ? layout.left : layout.top;
    const extent = horizontal ? VIEWPORT.width : VIEWPORT.height;
    assert.ok(along >= 0 && along + 88 <= extent, `${JSON.stringify(point)} on ${layout.edge}: ${along}`);
  }
  const clamped = nibbleLayout({ x: 3, y: 599 }, VIEWPORT, 88);
  assert.equal(clamped.edge, "bottom");
  assert.equal(clamped.left, 0);
  assert.equal(nibbleLayout({ x: 797, y: 599 }, VIEWPORT, 88).left, 712);
  assert.equal(nibbleLayout({ x: 0, y: 300 }, VIEWPORT, 88).edge, "left");
  assert.equal(nibbleLayout({ x: 1, y: 598 }, VIEWPORT, 88).top, 512);
});

test("nibbleLayout: a viewport smaller than the box pins it to 0 along the edge", () => {
  const layout = nibbleLayout({ x: 30, y: 59 }, { width: 60, height: 60 }, 88);
  assert.equal(layout.edge, "bottom");
  assert.equal(layout.left, 0);
});

test("nibbleLayout: the size scales the box and the ledge", () => {
  const layout = nibbleLayout({ x: 400, y: 590 }, VIEWPORT, 64);
  assert.equal(layout.left, 368);
  assert.equal(layout.top, 600 - 50, "the ledge sits 64 * 400 / 512 = 50 px below the top");
});
