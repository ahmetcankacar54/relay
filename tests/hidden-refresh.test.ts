import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hiddenRefresh, reportedVisibility, shouldPoll } from "../src/data/relay-action";

test("a hidden window only remembers a change and refreshes once when it is shown", () => {
  let visibility: DocumentVisibilityState = "visible";
  let refreshes = 0;
  const gate = hiddenRefresh(() => visibility, () => void refreshes++);
  gate.changed();
  assert.equal(refreshes, 1);
  // Shown again with nothing new: no refresh.
  gate.shown();
  assert.equal(refreshes, 1);
  visibility = "hidden";
  gate.changed();
  gate.changed();
  gate.changed();
  assert.equal(refreshes, 1);
  // Still hidden: the visibility event is not a show.
  gate.shown();
  assert.equal(refreshes, 1);
  visibility = "visible";
  gate.shown();
  assert.equal(refreshes, 2);
  gate.shown();
  assert.equal(refreshes, 2);
});

test("a poll skipped while hidden refreshes once the window is shown", () => {
  let visibility: DocumentVisibilityState = "hidden";
  let refreshes = 0;
  const gate = hiddenRefresh(() => visibility, () => void refreshes++);
  // The poll hands its turn to the gate when shouldPoll says no.
  assert.equal(shouldPoll({ pollWhenHidden: false }, visibility), false);
  gate.changed();
  assert.equal(refreshes, 0);
  visibility = "visible";
  gate.shown();
  assert.equal(refreshes, 1);
});

test("the panel counts as hidden until main reports it shown, then follows the reports", () => {
  // Created hidden, the panel's document reads "visible" until it is first shown.
  const reported = reportedVisibility();
  let refreshes = 0;
  const gate = hiddenRefresh(reported.visibility, () => void refreshes++);
  assert.equal(shouldPoll({ pollWhenHidden: false }, reported.visibility()), false);
  gate.changed();
  gate.changed();
  assert.equal(refreshes, 0);
  reported.report(true);
  gate.shown();
  assert.equal(refreshes, 1);
  assert.equal(shouldPoll({ pollWhenHidden: false }, reported.visibility()), true);
  gate.changed();
  assert.equal(refreshes, 2);
  reported.report(false);
  gate.shown();
  assert.equal(shouldPoll({ pollWhenHidden: false }, reported.visibility()), false);
  gate.changed();
  assert.equal(refreshes, 2);
  reported.report(true);
  gate.shown();
  assert.equal(refreshes, 3);
});

test("main reports the panel's shown and hidden state, and only the panel follows it", () => {
  const panelWindow = readFileSync(new URL("../electron/tray-panel.ts", import.meta.url), "utf8");
  const toggle = panelWindow.slice(panelWindow.indexOf("toggle("), panelWindow.indexOf("  hide("));
  const hide = panelWindow.slice(panelWindow.indexOf("  hide("), panelWindow.indexOf("isOpen()"));
  assert.match(toggle, /this\.reportVisibility\(win, true\)/);
  assert.match(hide, /this\.reportVisibility\(win, false\)/);
  assert.match(panelWindow, /webContents\.send\("relay:panel-visibility", shown\)/);
  const preload = readFileSync(new URL("../electron/preload.ts", import.meta.url), "utf8");
  assert.match(preload, /ipcRenderer\.on\("relay:panel-visibility", listener\)/);
  const panel = readFileSync(new URL("../src/panel/main.tsx", import.meta.url), "utf8");
  assert.match(panel, /<RelayProvider[^>]*reportsVisibility/);
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /reportsVisibility/);
});

test("neither window polls while hidden, and broadcasts go through the gate", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /<RelayProvider pollWhenHidden=\{false\}>/);
  const panel = readFileSync(new URL("../src/panel/main.tsx", import.meta.url), "utf8");
  assert.match(panel, /<RelayProvider[^>]*pollWhenHidden=\{false\}/);
  const hook = readFileSync(new URL("../src/data/useRelay.ts", import.meta.url), "utf8");
  assert.match(hook, /api\.onChanged\(\(\) => gate\.changed\(\)\)/);
  assert.match(hook, /api\.onAuth\(\(\) => gate\.changed\(\)\)/);
  assert.match(hook, /"visibilitychange", gate\.shown\)/);
});
