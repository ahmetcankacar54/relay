import test from "node:test";
import assert from "node:assert/strict";
import {
  PRANK_BUDGET, PRANK_HISTORY_KEY, PRANK_HISTORY_MS,
  prankDecision, readPrankHistory, recordPrank,
  type PrankKind,
} from "../src/pranks/budget";
import { prankBlocked, type PrankGate } from "../src/pranks/gate";

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
};
const KINDS: (PrankKind | "trick")[] = ["nibble-cursor", "wheel", "nibble-bar", "doze", "confetti", "trick"];

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
