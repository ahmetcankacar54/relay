import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  INITIAL_PANEL_LOAD,
  ToggleGuard,
  panelLoadState,
  trayClickAction,
  type PanelLoadEvent,
  type PanelLoadState,
} from "../shared/tray-panel";

test("a tray click right after a blur-hide does not reopen the panel", () => {
  const guard = new ToggleGuard();
  assert.equal(guard.shouldOpen(1000), true);
  guard.hidden(1000);
  assert.equal(guard.shouldOpen(1250), false);
  // A slow (long-press) click still lands inside the 400 ms window.
  assert.equal(guard.shouldOpen(1400), false);
  assert.equal(guard.shouldOpen(1401), true);
});

test("a tray click falls back to the native menu until the panel has loaded", () => {
  assert.equal(trayClickAction(true), "toggle");
  assert.equal(trayClickAction(false), "menu");
});

const run = (events: PanelLoadEvent[], from: PanelLoadState = INITIAL_PANEL_LOAD) =>
  events.reduce(panelLoadState, from);

test("the panel is ready only after its renderer reported a size", () => {
  assert.equal(run([]).phase, "loading");
  assert.equal(run(["start"]).phase, "loading");
  assert.equal(run(["start", "finish"]).phase, "loading");
  assert.equal(run(["start", "finish", "painted"]).phase, "ready");
  // The first layout can arrive before did-finish-load.
  assert.equal(run(["start", "painted", "finish"]).phase, "ready");
  assert.equal(run(["start", "painted", "painted"]).phase, "ready");
});

test("a failed main-frame load makes the panel unusable until the next load", () => {
  assert.equal(run(["start", "fail", "finish"]).phase, "failed");
  assert.equal(run(["start", "fail", "painted"]).phase, "failed");
  assert.equal(run(["start", "painted", "fail"]).phase, "failed");
  assert.equal(run(["start", "fail", "start", "painted"]).phase, "ready");
});

test("the panel reloads after one renderer crash; a second crash is final", () => {
  const first = run(["start", "painted", "gone"]);
  assert.deepEqual(first, { phase: "reloading", crashes: 1 });
  const recovered = run(["start", "painted"], first);
  assert.deepEqual(recovered, { phase: "ready", crashes: 1 });
  const second = run(["gone"], recovered);
  assert.deepEqual(second, { phase: "failed", crashes: 2 });
  // Nothing brings it back for the rest of the session.
  assert.equal(run(["start", "finish", "painted"], second).phase, "failed");
});

test("the panel window never activates Relay", () => {
  const source = readFileSync(new URL("../electron/tray-panel.ts", import.meta.url), "utf8");
  assert.match(source, /type: "panel"/);
  assert.match(source, /showInactive\(\)/);
  assert.doesNotMatch(source, /win\.show\(\)/);
  assert.doesNotMatch(source, /^\s*app\.hide\(/m);
  assert.match(source, /visibleOnFullScreen: true/);
  assert.match(source, /skipTransformProcessType: true/);
});
