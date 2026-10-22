import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SwitchStage } from "../src/switch/SwitchStage";
import type { SwitchSceneView } from "../shared/switch-scene";
import { mediaBlock } from "./css";

const view = (extra: Partial<SwitchSceneView> = {}): SwitchSceneView => ({
  visible: true, stage: "leaving", story: 1, line: "Vertex hesabına geçiliyor", motion: true, ...extra,
});
const draw = (v: SwitchSceneView) => renderToStaticMarkup(createElement(SwitchStage, { view: v }));
const poses = (html: string) => [...html.matchAll(/data-pose="([^"]+)"/g)].map((m) => m[1]);
const rig = (html: string, pose: string) => new RegExp(`<svg[^>]*data-pose="${pose}"[^>]*>`).exec(html)?.[0] ?? "";

test("leaving walks the panda with its bamboo to the door", () => {
  const html = draw(view());
  assert.deepEqual(poses(html), ["door", "walk"]);
  assert.match(html, /data-switch-stage="leaving"/);
  assert.match(rig(html, "walk"), /data-props="bamboo"/);
  assert.match(rig(html, "walk"), /data-motion="walk"/);
  assert.match(html, />Vertex hesabına geçiliyor</);
  assert.doesNotMatch(html, /data-still/);
});

test("waiting shows only the closed door", () => {
  assert.deepEqual(poses(draw(view({ stage: "waiting" }))), ["door"]);
});

test("the return dresses the panda for its outcome", () => {
  const switched = draw(view({ stage: "returning", outcome: "switched", disguise: "deerstalker" }));
  assert.match(rig(switched, "stand"), /data-expression="open"/);
  assert.match(rig(switched, "stand"), /data-props="deerstalker coat"/);
  assert.match(switched, /data-outcome="switched"/);
  const back = draw(view({ stage: "returning", outcome: "back" }));
  assert.match(rig(back, "stand"), /data-expression="happy"/);
  assert.match(rig(back, "stand"), /data-props=""/);
  const failed = draw(view({ stage: "closing", outcome: "failed" }));
  assert.match(rig(failed, "stand"), /data-expression="wide"/);
  assert.match(rig(failed, "stand"), /data-props="bang"/);
});

test("with motion off every stage is one still image", () => {
  const leaving = draw(view({ motion: false }));
  assert.match(leaving, /data-still=""/);
  assert.deepEqual(poses(leaving), ["door"]);
  const back = draw(view({ motion: false, stage: "returning", outcome: "back" }));
  assert.match(back, /data-still=""/);
  assert.match(rig(back, "stand"), /data-motion=""/);
});

test("a hidden or stalled story draws nothing", () => {
  assert.equal(draw(view({ visible: false, stage: "stalled", line: "" })), "");
});

test("a long line wraps to at most two lines without pushing the scene", () => {
  const line = `${"Çok uzun bir hesap adı ".repeat(6)}hesabına geçiliyor`;
  const html = draw(view({ line }));
  assert.match(html, /<p class="switch-line[^"]*line-clamp-2[^"]*" title="Çok uzun/);
  assert.match(/<div class="switch-stage[^"]*"/.exec(html)?.[0] ?? "", /grid-rows-\[102px_30px\]/);
});

test("stage animations run only with motion on, never under Reduce motion, and last through the fade", () => {
  const css = readFileSync("src/styles/switch-stage.css", "utf8");
  const motion = mediaBlock(css, "(prefers-reduced-motion: no-preference)");
  assert.ok(motion.length > 0);
  assert.doesNotMatch(css.replace(motion, ""), /animation\s*:/);
  for (const [, selector] of motion.matchAll(/([^{}]+)\{[^{}]*animation\s*:/g))
    assert.match(selector, /:not\(\[data-still\]\)/, selector.trim());
  // Tossed props must stay gone while the window fades.
  assert.match(motion, /:is\(\[data-switch-stage="returning"\], \[data-switch-stage="closing"\]\)\[data-outcome="switched"\] \.switch-panda :is\(\[data-prop="fedora"\]/);
});

test("a switch shows the from → to row with each account's five-hour ring, and the scene makes room", () => {
  const html = draw(view({
    accounts: { from: { name: "Kişisel · Max", percent: 94 }, to: { name: "Vertex", percent: 22 } },
  }));
  const row = /<div data-slot="switch-accounts"[\s\S]*$/.exec(html)?.[0] ?? "";
  assert.match(row, /Kişisel · Max[\s\S]*%94[\s\S]*Vertex[\s\S]*%22/);
  assert.match(row, /aria-label="Kişisel · Max %94"/);
  assert.match(row, /aria-label="Vertex %22"/);
  assert.match(/<div class="switch-stage[^"]*"/.exec(html)?.[0] ?? "", /grid-rows-\[82px_18px_20px\]/);
  assert.match(html, /<p class="switch-line[^"]*line-clamp-1/);
  assert.match(rig(html, "door"), /width="80"/);
  // Only the target known: the row keeps its place for the source empty.
  const target = draw(view({ accounts: { to: { name: "Vertex" } } }));
  assert.match(target, /data-slot="switch-accounts"/);
  assert.doesNotMatch(target, /%22/);
});
