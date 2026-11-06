import test from "node:test";
import assert from "node:assert/strict";
import { SIDEBAR, clampSidebarWidth, dragSidebar, readSidebarSize } from "../src/app/useSidebarSize";

test("a drag sets the width inside its limits", () => {
  assert.deepEqual(dragSidebar(232, 40, 232), { width: 272, collapsed: false });
  assert.deepEqual(dragSidebar(232, 400, 232), { width: SIDEBAR.max, collapsed: false });
  assert.deepEqual(dragSidebar(232, -60, 232), { width: SIDEBAR.min, collapsed: false });
});

test("a drag past the fold point folds the sidebar and keeps the width it had", () => {
  assert.deepEqual(dragSidebar(300, -200, 300), { width: 300, collapsed: true });
  // From the rail, a drag out past the fold point opens it again.
  assert.deepEqual(dragSidebar(SIDEBAR.rail, 140, 300), { width: 224, collapsed: false });
  assert.deepEqual(dragSidebar(SIDEBAR.rail, 20, 300), { width: 300, collapsed: true });
});

test("the saved size is read back, and anything else gives the initial size", () => {
  assert.deepEqual(readSidebarSize('{"width":280,"collapsed":true}'), { width: 280, collapsed: true });
  assert.deepEqual(readSidebarSize('{"width":9999}'), { width: SIDEBAR.max, collapsed: false });
  for (const raw of [null, "", "not json", "{}", '{"width":"wide"}'])
    assert.deepEqual(readSidebarSize(raw), { width: SIDEBAR.initial, collapsed: false }, String(raw));
  assert.equal(clampSidebarWidth(201.6), 202);
});

test("the rail is wide enough for the traffic lights", () => {
  // macOS draws three 12 px buttons 20 px apart from the given x (electron/main.ts uses 16).
  const lightsEnd = 16 + 12 + 2 * 20;
  assert.ok(SIDEBAR.rail - lightsEnd >= 16, "a 16 px margin after the last button");
});
