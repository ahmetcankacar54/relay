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
