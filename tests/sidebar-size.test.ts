import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SIDEBAR, clampSidebarWidth, dragSidebar, keySidebar, readSidebarSize } from "../src/app/useSidebarSize";

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

test("arrow keys on the edge unfold the rail and fold it from the narrowest width", () => {
  // → opens the rail at the width it kept; ← on the rail does nothing.
  assert.deepEqual(keySidebar({ width: 280, collapsed: true }, 1, 16), { width: 280, collapsed: false });
  assert.deepEqual(keySidebar({ width: 280, collapsed: true }, -1, 16), { width: 280, collapsed: true });
  // ← moves the edge down to the narrowest width, and one more press folds it.
  assert.deepEqual(keySidebar({ width: 232, collapsed: false }, -1, 16), { width: 216, collapsed: false });
  assert.deepEqual(keySidebar({ width: 210, collapsed: false }, -1, 48), { width: SIDEBAR.min, collapsed: false });
  assert.deepEqual(keySidebar({ width: SIDEBAR.min, collapsed: false }, -1, 16), { width: SIDEBAR.min, collapsed: true });
  assert.deepEqual(keySidebar({ width: 350, collapsed: false }, 1, 48), { width: SIDEBAR.max, collapsed: false });
});

test("the sidebar shortcut changes nothing while a narrow window forces the rail", () => {
  const shell = readFileSync(new URL("../src/app/Shell.tsx", import.meta.url), "utf8");
  assert.match(shell, /if \(!forced\) setSidebar\(\{ \.\.\.current, collapsed: !current\.collapsed \}\);/);
  assert.match(shell, /onToggle=\{narrow \? undefined : toggleSidebar\}/);
});

test("overlays and toolbar badges are outside the window's drag region", () => {
  const read = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  // A dialog or sheet covers the window with a no-drag overlay, so the toolbar's drag region under
  // it takes no clicks; menus, selects and popovers that open over the toolbar are no-drag too.
  for (const file of ["components/ui/dialog.tsx", "components/ui/sheet.tsx"])
    assert.equal(read(file).match(/\[-webkit-app-region:no-drag\]/g)?.length, 2, file);
  for (const file of ["components/ui/popover.tsx", "components/ui/dropdown-menu.tsx", "components/ui/select.tsx"])
    assert.match(read(file), /\[-webkit-app-region:no-drag\]/, file);
  assert.match(read("app/PageHeader.tsx"), /\[-webkit-app-region:no-drag\]">\{badge\}/);
});
