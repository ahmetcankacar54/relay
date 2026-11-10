import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  INITIAL_PANEL_LOAD,
  pointerOnTray,
  ToggleGuard,
  panelLoadState,
  panelRevival,
  PANEL_REVIVE_GAP_MS,
  PANEL_STUCK_MS,
  trayClickAction,
  type PanelLoadEvent,
  type PanelLoadState,
} from "../shared/tray-panel";

test("a tray click right after a blur-hide does not reopen the panel", () => {
  const guard = new ToggleGuard();
  assert.equal(guard.shouldOpen(1000), true);
  guard.hidden(1000, true);
  assert.equal(guard.shouldOpen(1250), false);
  // A slow (long-press) click still lands inside the 400 ms window.
  assert.equal(guard.shouldOpen(1400), false);
  assert.equal(guard.shouldOpen(1401), true);
});

test("a blur from a click elsewhere never swallows the next tray click", () => {
  const guard = new ToggleGuard();
  guard.hidden(1000, false);
  assert.equal(guard.shouldOpen(1050), true);
  guard.hidden(2000, true);
  guard.hidden(2100, false);
  assert.equal(guard.shouldOpen(2150), true);
});

test("the pointer counts as on the tray icon only inside its bounds", () => {
  const tray = { x: 1400, y: 0, width: 40, height: 24 };
  assert.equal(pointerOnTray(tray, { x: 1420, y: 12 }), true);
  assert.equal(pointerOnTray(tray, { x: 1442, y: 26 }), true);
  assert.equal(pointerOnTray(tray, { x: 900, y: 400 }), false);
  assert.equal(pointerOnTray(undefined, { x: 900, y: 400 }), true);
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

test("a tray click brings an unusable panel back for the next click", () => {
  const base = { alive: true, pageLoading: false, unreadyFor: 60_000, sinceRevival: Infinity };
  // Nothing to do for a panel that works, or one that is still loading its page.
  assert.equal(panelRevival({ ...base, phase: "ready" }), undefined);
  assert.equal(panelRevival({ ...base, phase: "loading", pageLoading: true }), undefined);
  assert.equal(panelRevival({ ...base, phase: "loading", unreadyFor: PANEL_STUCK_MS - 1 }), undefined);
  // A page that never painted, failed to load or crashed out is loaded again.
  assert.equal(panelRevival({ ...base, phase: "loading", unreadyFor: PANEL_STUCK_MS }), "reload");
  assert.equal(panelRevival({ ...base, phase: "reloading" }), "reload");
  assert.equal(panelRevival({ ...base, phase: "failed", unreadyFor: 0 }), "reload");
  // A window that is gone is made again.
  assert.equal(panelRevival({ ...base, phase: "ready", alive: false }), "recreate");
  // Never on every click.
  assert.equal(panelRevival({ ...base, phase: "failed", sinceRevival: PANEL_REVIVE_GAP_MS - 1 }), undefined);
  assert.equal(panelRevival({ ...base, phase: "failed", alive: false, sinceRevival: 0 }), undefined);
});

test("only a new document makes the panel wait for a paint, and every tray click counts", () => {
  // did-start-loading also fires for an address change inside the page and for a navigation
  // Relay refuses; the page then never reports a size again and the panel stayed unusable.
  for (const file of ["../electron/tray-panel.ts", "../electron/switch-window.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /on\(\s*"did-start-loading"/, file);
    assert.match(source, /on\("did-navigate", \(\) => this\.dispatch\("start"\)\)/, file);
  }
  const tray = readFileSync(new URL("../electron/tray.ts", import.meta.url), "utf8");
  // A second click within the double-click time is still a click.
  assert.match(tray, /setIgnoreDoubleClickEvents\(true\)/);
  assert.match(tray, /panel\.revive\?\.\(\)/);
});
