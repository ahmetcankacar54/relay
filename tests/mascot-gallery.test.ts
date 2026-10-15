import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MascotGallery } from "../src/dev/MascotGallery";
import { DISGUISES, MASCOT_FRAMES, type MascotFrame } from "../shared/mascot-frames";

const frames = Object.fromEntries(
  MASCOT_FRAMES.map((f) => [f, [1, 2, 3].map((scaleFactor) => ({ scaleFactor, png: "AAAA" }))]),
) as Record<MascotFrame, { scaleFactor: number; png: string }[]>;

test("the gallery lists every frame on light and dark bars", () => {
  const html = renderToStaticMarkup(createElement(MascotGallery, { frames }));
  for (const frame of MASCOT_FRAMES) assert.match(html, new RegExp(`(^|[^-\\w])${frame}([^-\\w]|$)`), frame);
  for (const disguise of DISGUISES) assert.match(html, new RegExp(`dönüş \\(${disguise}\\)`), disguise);
  assert.match(html, /data-bar="light"/);
  assert.match(html, /data-bar="dark"/);
  assert.match(html, /image-rendering:pixelated/);
});

test("the gallery draws every frame from its alpha only, as the menu bar does", () => {
  const html = renderToStaticMarkup(createElement(MascotGallery, { frames }));
  const classes = (tag: string) => (/class="([^"]*)"/.exec(tag)?.[1] ?? "").split(" ");
  const onBar = (bar: string) =>
    [...html.matchAll(new RegExp(`data-bar="${bar}"[^>]*>(<img[^>]*>)`, "g"))].map((m) => classes(m[1]));
  const light = onBar("light");
  const dark = onBar("dark");
  const zoomed = [...html.matchAll(/<img[^>]*image-rendering:pixelated[^>]*>/g)].map((m) => classes(m[0]));
  assert.ok(light.length > 0);
  assert.equal(dark.length, light.length);
  assert.equal(zoomed.length, light.length);
  // macOS ignores a template image's colours: black on light bars, white on dark ones.
  for (const c of light) assert.ok(c.includes("brightness-0") && !c.some((x) => x.includes("invert")), c.join(" "));
  for (const c of dark) assert.ok(c.includes("brightness-0") && c.includes("invert"), c.join(" "));
  for (const c of zoomed) assert.ok(c.includes("brightness-0") && c.includes("dark:invert"), c.join(" "));
});
