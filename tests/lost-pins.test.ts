import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LOST_ITEM_KINDS } from "../shared/lost-found";
import { LostPin } from "../src/pages/usage/LostPins";

const draw = (props: Parameters<typeof LostPin>[0]) => renderToStaticMarkup(createElement(LostPin, props));

test("every pin is a scene with the app's own panda in it, and a shelf of them mixes four frame shapes", () => {
  const shapes = new Set<string>();
  for (const kind of LOST_ITEM_KINDS) {
    const svg = draw({ kind });
    assert.match(svg, /class="panda" data-pose="(sit|stand|curl|walk|peek|chew|head)"/, kind);
    // The rig's id token is replaced, so two pins on a page never share a clip path.
    assert.doesNotMatch(svg, /__PANDA_ID__/, kind);
    shapes.add(/data-shape="(\w+)"/.exec(svg)![1]);
  }
  assert.deepEqual([...shapes].sort(), ["circle", "hexagon", "shield", "stamp"]);
});

test("a finish is more than a colour: silver adds ribbon tails and beads, gold a star, laurel and foil", () => {
  const bronze = draw({ kind: "scroll" });
  const silver = draw({ kind: "scroll", tier: "silver" });
  const gold = draw({ kind: "scroll", tier: "gold", shine: true });
  assert.doesNotMatch(bronze, /stroke-dasharray="0.1 4.2"/);
  assert.match(silver, /stroke-dasharray="0.1 4.2"/);
  assert.doesNotMatch(silver, /lost-pin-foil/);
  assert.match(gold, /class="lost-pin-foil"/);
  assert.match(gold, /data-shine=""/);
  // A locked pin is grey and plain, whatever finish it would have.
  const locked = draw({ kind: "scroll", tier: "gold", locked: true });
  assert.match(locked, /grayscale/);
  assert.doesNotMatch(locked, /lost-pin-foil/);
});

test("a sealed secret pin hides its scene and its panda behind a parcel", () => {
  const sealed = draw({ kind: "clocks", sealed: true, locked: true });
  assert.doesNotMatch(sealed, /class="panda"/);
  assert.match(sealed, /data-shape="stamp"/);
});

test("pins with account colours wear the accounts' colours", () => {
  const svg = draw({ kind: "scarf", tints: ["var(--tone-1)", "var(--tone-2)", undefined] });
  assert.match(svg, /fill="var\(--tone-1\)"/);
  assert.match(svg, /fill="var\(--tone-2\)"/);
});
