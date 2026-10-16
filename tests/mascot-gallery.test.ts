import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MascotGallery, PrankSheet } from "../src/dev/MascotGallery";
import { MASCOT_FRAMES, type MascotFrame } from "../shared/mascot-frames";
import { PANDA_SCENES } from "../src/mascot/scenes";
import { NIBBLE_BAR_MS, WHEEL_MS } from "../src/pranks/layers";
import { CONFETTI_MS, STARTLE_MS } from "../src/pranks/timing";
import { fakeDom } from "./fake-dom";

const frames = Object.fromEntries(
  MASCOT_FRAMES.map((f) => [f, [1, 2, 3].map((scaleFactor) => ({ scaleFactor, png: "AAAA" }))]),
) as Record<MascotFrame, { scaleFactor: number; png: string }[]>;

test("the gallery lists every frame and the blink on light and dark bars", () => {
  const html = renderToStaticMarkup(createElement(MascotGallery, { frames }));
  for (const frame of MASCOT_FRAMES) assert.match(html, new RegExp(`(^|[^-\\w])${frame}([^-\\w]|$)`), frame);
  assert.match(html, /göz kırpma/);
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

test("the gallery shows every in-app scene on light and dark grounds", () => {
  const html = renderToStaticMarkup(createElement(MascotGallery, { frames }));
  for (const scene of Object.keys(PANDA_SCENES)) assert.match(html, new RegExp(`data-scene="${scene}"`), scene);
  assert.match(html, /data-tone="light"/);
  assert.match(html, /data-tone="dark"/);
});

test("the gallery offers a switch window demo for every outcome", () => {
  const html = renderToStaticMarkup(createElement(MascotGallery, { frames }));
  for (const label of ["Geçiş · fedora", "Geçiş · sunglasses", "Geçiş · deerstalker", "Yeniden açıldı", "Başarısız", "60 sn sınırı"])
    assert.match(html, new RegExp(`>${label}<`), label);
  assert.match(html, /data-switch-preview/);
  assert.match(html, /Hareket/);
});

test("the gallery has a button for every prank and a playful panda to click", () => {
  const html = renderToStaticMarkup(createElement(MascotGallery, { frames }));
  for (const label of ["İmleç kemirme", "Çark", "Çubuğu kemirme", "Uyuklama", "Konfeti"]) assert.match(html, new RegExp(`>${label}<`), label);
  assert.match(html, />Şakalar</);
  assert.match(html, />Tıkla: numaralar</);
  // The scenes above it are not playful: the only playful panda is the one in the prank section.
  const section = html.slice(html.indexOf(">Şakalar<"));
  assert.match(section, /<span data-playful="true"[^>]*><svg[^>]*data-scene="welcome"/);
  assert.equal(html.match(/data-playful/g)?.length, 1);
  // The prank section has its own stage, and it is the only one on the page.
  assert.equal(html.match(/data-prank-stage/g)?.length, 1);
});

interface FakeNode {
  tagName: string;
  attributes: Map<string, string>;
  childNodes: FakeNode[];
}
const nodes = (node: FakeNode, found: FakeNode[] = []): FakeNode[] => {
  found.push(node);
  for (const child of node.childNodes) nodes(child, found);
  return found;
};

/** Wraps the (mocked) global timers to see which are armed: set, and neither cleared nor fired. */
function trackTimers() {
  const armed = new Set<unknown>();
  const { setTimeout: set, clearTimeout: clear } = globalThis;
  globalThis.setTimeout = ((callback: () => void, ms?: number, ...rest: unknown[]) => {
    const handle = set(
      () => {
        armed.delete(handle);
        callback();
      },
      ms,
      ...rest,
    );
    armed.add(handle);
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

test("a click on a prank button plays that prank in the section's stage at once, and the panda does a trick", async () => {
  const dom = fakeDom();
  dom.install();
  mock.timers.enable({ apis: ["setTimeout"] });
  const timers = trackTimers();
  // The nibble draws from requestAnimationFrame. The frames never run here (tests/prank-nibble.test.ts turns that crank),
  // so a nibble plays until something ends it: a press, the 3 s cap or the unmount.
  const frames = new Set<number>();
  let nextFrame = 1;
  Object.assign(globalThis, {
    requestAnimationFrame: () => (frames.add(nextFrame), nextFrame++),
    cancelAnimationFrame: (id: number) => void frames.delete(id),
  });
  try {
    // Loaded after the stubs, so react-dom sees a DOM.
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () => root.render(createElement(PrankSheet)));
    const all = () => nodes(dom.container as unknown as FakeNode);
    // The fake DOM drops an element's single text child, so a button is found by its place: the labels' order in the markup.
    const labels = [...renderToStaticMarkup(createElement(PrankSheet)).matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
    assert.deepEqual(labels, ["İmleç kemirme", "Çark", "Çubuğu kemirme", "Uyuklama", "Konfeti"]);
    const button = (label: string) => all().filter((n) => n.tagName === "button")[labels.indexOf(label)];
    const stage = () => all().find((n) => n.attributes.has("data-prank-stage"));
    const rig = () => all().find((n) => n.attributes.has("data-pose"));
    const drawn = () => stage()?.childNodes.length;
    const click = (label: string) => act(async () => dom.dispatch(button(label)!, "click", { clientX: 10, clientY: 20, detail: 1 }));
    const wait = (ms: number) => act(async () => mock.timers.tick(ms));
    assert.equal(drawn(), 0, "nothing plays before a click");

    // The stage ignores the budget and the gates (no storage here, so a budgeted prank would not play): a mouse click always plays.
    // The nibble hides the real cursor while it plays, and a press ends it with the cursor back.
    await click("İmleç kemirme");
    assert.ok((drawn() ?? 0) > 0, "the panda and the drawn cursor are in the stage");
    assert.equal(dom.cursorHidden(), true, "the real cursor is hidden while it plays");
    await act(async () => dom.emit("pointerdown"));
    assert.equal(drawn(), 0);
    assert.equal(dom.cursorHidden(), false);
    assert.equal(frames.size, 0, "no frame is left waiting");

    await click("Çark");
    assert.equal(drawn(), 1, "the wheel is drawn beside the button");
    await wait(WHEEL_MS);
    assert.equal(drawn(), 0, "and ends by itself");

    await click("Çubuğu kemirme");
    assert.equal(drawn(), 1, "the panda nibbling at the bar is drawn at the button");
    await wait(NIBBLE_BAR_MS);
    assert.equal(drawn(), 0, "and ends by itself");

    // The doze plays right away, without ten idle minutes, and leaves when the first activity has startled it.
    await click("Uyuklama");
    assert.equal(drawn(), 1, "the dozing panda is drawn");
    assert.equal(dom.windowListeners("pointermove"), 1, "and waits for activity");
    await act(async () => dom.emit("pointermove"));
    await wait(STARTLE_MS);
    assert.equal(drawn(), 0);
    assert.equal(dom.windowListeners("pointermove"), 0);

    await click("Konfeti");
    assert.ok((drawn() ?? 0) > 0, "the confetti is drawn in the stage");
    await wait(CONFETTI_MS);
    assert.equal(drawn(), 0);

    // The panda in the section is playful: a mouse click on it does a trick.
    assert.equal(rig()?.attributes.get("data-trick"), undefined);
    const panda = all().find((n) => n.attributes.has("data-playful"))!;
    await act(async () => dom.dispatch(panda, "click", { clientX: 4, clientY: 5, detail: 1 }));
    assert.ok(rig()?.attributes.get("data-trick"), "the panda plays a trick");

    // Leaving the page mid-nibble: the cursor is hidden until the unmount brings it back, and nothing is left running.
    await click("İmleç kemirme");
    assert.equal(dom.cursorHidden(), true, "the cursor is hidden mid-nibble");
    assert.equal(frames.size, 1);
    await act(async () => root.unmount());
    assert.equal(dom.cursorHidden(), false);
    assert.equal(frames.size, 0, "no frame is left waiting after the unmount");
    assert.equal(timers.armed.size, 0, "no timer is left armed after the unmount");
    for (const type of ["pointermove", "pointerdown", "keydown", "blur"]) assert.equal(dom.windowListeners(type), 0, type);
  } finally {
    timers.restore();
    mock.timers.reset();
    Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
    dom.uninstall();
  }
});
