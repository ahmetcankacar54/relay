import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hiddenRefresh, shouldPoll } from "../src/data/relay-action";

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
