import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MOTION_PAUSED,
  pauseMotionWithoutAttention,
  setMotionPaused,
} from "../src/lib/motion";
import { mediaBlock } from "./css";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function fakeRoot() {
  const attributes = new Set<string>();
  return {
    attributes,
    toggleAttribute(name: string, force?: boolean) {
      if (force ?? !attributes.has(name)) attributes.add(name);
      else attributes.delete(name);
      return attributes.has(name);
    },
  };
}

function fakeTarget() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    listeners,
    addEventListener(type: string, listener: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
    fire(type: string) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    count() {
      return [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
    },
  };
}

test("setMotionPaused sets and clears the attribute on <html>", () => {
  const root = fakeRoot();
  setMotionPaused(true, root);
  assert.ok(root.attributes.has(MOTION_PAUSED));
  setMotionPaused(false, root);
  assert.ok(!root.attributes.has(MOTION_PAUSED));
});

test("the main window holds still while hidden or in the background", () => {
  const root = fakeRoot();
  const win = fakeTarget();
  const doc = Object.assign(fakeTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
    focused: true,
    hasFocus() {
      return this.focused;
    },
    documentElement: root as unknown as HTMLElement,
  });
  const stop = pauseMotionWithoutAttention(win, doc);
  assert.ok(!root.attributes.has(MOTION_PAUSED), "visible and focused moves");
  doc.focused = false;
  win.fire("blur");
  assert.ok(root.attributes.has(MOTION_PAUSED), "another app in front");
  doc.focused = true;
  win.fire("focus");
  assert.ok(!root.attributes.has(MOTION_PAUSED));
  doc.visibilityState = "hidden";
  doc.fire("visibilitychange");
  assert.ok(root.attributes.has(MOTION_PAUSED), "hidden window");
  stop();
  assert.equal(win.count() + doc.count(), 0, "cleanup removes every listener");
});

test("theme.css pauses every animation but spinners, outside any media query", () => {
  const css = read("src/styles/theme.css");
  const rule = css.match(
    /:root\[data-motion-paused\] \*:not\(\.animate-spin\):not\(\[data-spinner\]\),\s*:root\[data-motion-paused\] \*::before,\s*:root\[data-motion-paused\] \*::after \{\s*animation-play-state: paused !important;\s*\}/,
  );
  assert.ok(rule, "the paused rule");
  assert.ok(!mediaBlock(css, "(prefers-reduced-motion: reduce)").includes("data-motion-paused"));
  assert.ok(css.includes(`[${MOTION_PAUSED}]`));
});

test("the panel starts still and moves only while it is shown", () => {
  const panel = read("src/panel/main.tsx");
  assert.match(
    panel,
    /setMotionPaused\(true\);\s*api\.onPanelVisibility\(\(shown\) => setMotionPaused\(!shown\)\);/,
  );
  assert.ok(panel.indexOf("setMotionPaused(true)") < panel.indexOf("createRoot("));
});

test("the main window follows its own attention before it renders", () => {
  const main = read("src/main.tsx");
  assert.ok(main.includes("pauseMotionWithoutAttention();"));
  assert.ok(
    main.indexOf("pauseMotionWithoutAttention();") < main.indexOf("createRoot("),
  );
});
