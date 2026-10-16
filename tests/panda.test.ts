import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Panda, PandaRig } from "../src/components/Panda";
import { MOTION_PARTS, PANDA_SCENES, type PandaMotion } from "../src/mascot/scenes";
import { PANDA_EXPRESSIONS, POSE_PARTS, POSE_PROPS, RIG_ID_TOKEN } from "../shared/panda-poses";
import { mediaBlock } from "./css";

const css = readFileSync("src/styles/panda.css", "utf8");

test("a scene draws its pose inline with its expression, props and motion", () => {
  const html = renderToStaticMarkup(createElement(Panda, { scene: "welcome", size: 120 }));
  assert.match(html, /^<svg /);
  for (const attribute of [
    'aria-hidden="true"', 'focusable="false"', 'data-scene="welcome"', 'data-pose="sit"',
    'data-expression="happy"', 'data-props="bamboo"', 'data-motion="wave blink tail"',
    'width="120"', 'height="120"', 'viewBox="0 0 512 512"',
  ])
    assert.ok(html.includes(attribute), attribute);
  assert.match(html, /class="panda/);
  assert.match(html, /data-part="arm-left"/);
});

test("two pandas of one pose on a page keep their own ids and clip paths", () => {
  const html = renderToStaticMarkup(
    createElement("div", null, createElement(PandaRig, { pose: "sit", size: 72 }), createElement(PandaRig, { pose: "sit", size: 72 })),
  );
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 2);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!html.includes(RIG_ID_TOKEN));
  for (const svg of html.split("<svg").slice(1)) {
    const own = new Set([...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const [, ref] of svg.matchAll(/url\(#([^)]+)\)/g)) assert.ok(own.has(ref), ref);
  }
});

test("a missing pose leaves an empty box of the same size", () => {
  const html = renderToStaticMarkup(createElement(PandaRig, { pose: "sit", size: 72, rig: {} }));
  assert.equal(html, '<span aria-hidden="true" class="inline-block shrink-0" style="width:72px;height:72px"></span>');
});

test("scenes only use props and parts their pose has", () => {
  for (const [name, spec] of Object.entries(PANDA_SCENES)) {
    for (const prop of spec.props) assert.ok((POSE_PROPS[spec.pose] as readonly string[]).includes(prop), `${name}: ${prop}`);
    for (const motion of spec.motion)
      for (const part of MOTION_PARTS[motion as PandaMotion]) assert.ok(POSE_PARTS[spec.pose].includes(part), `${name}: ${motion} needs ${part}`);
  }
});

test("panda.css shows exactly the expression and props the root names", () => {
  for (const expression of PANDA_EXPRESSIONS)
    assert.ok(css.includes(`.panda[data-expression="${expression}"] [data-expression="${expression}"]`), expression);
  const props = new Set(Object.values(POSE_PROPS).flat());
  for (const prop of props) assert.ok(css.includes(`.panda[data-props~="${prop}"] [data-prop="${prop}"]`), prop);
  assert.match(css, /\.panda \[data-expression\],\s*\.panda \[data-prop\] \{\s*display: none;/);
});

test("every panda motion plays only without Reduce motion and moves the parts it names", () => {
  const motion = mediaBlock(css, "(prefers-reduced-motion: no-preference)");
  assert.ok(motion.length > 0);
  assert.doesNotMatch(css.replace(motion, ""), /animation\s*:/);
  for (const [name, parts] of Object.entries(MOTION_PARTS))
    for (const part of parts) assert.ok(motion.includes(`.panda[data-motion~="${name}"] [data-part="${part}"]`), `${name} → ${part}`);
});

test("the prank motions move what they name: chew the head and the held item, breathe the body", () => {
  assert.deepEqual(MOTION_PARTS.chew, ["head", "held"]);
  assert.deepEqual(MOTION_PARTS.breathe, ["body"]);
  for (const part of MOTION_PARTS.chew) assert.ok(POSE_PARTS.chew.includes(part), `chew pose has ${part}`);
  for (const part of MOTION_PARTS.breathe) assert.ok(POSE_PARTS.curl.includes(part), `curl pose has ${part}`);
  for (const name of ["panda-chew", "panda-gnaw", "panda-breathe"]) assert.match(css, new RegExp(`@keyframes ${name}\\s*\\{`), name);
});
