import test from "node:test";
import assert from "node:assert/strict";
import type { MenuItemConstructorOptions } from "electron";
import { appMenuTemplate } from "../electron/app-menu";
import { pick } from "../electron/language";

const calls: string[] = [];
const actions = {
  closeToTray: () => void calls.push("closeToTray"),
  quit: () => void calls.push("quit"),
  closeWindow: () => void calls.push("closeWindow"),
};
const submenu = (item: MenuItemConstructorOptions) =>
  item.submenu as MenuItemConstructorOptions[];
const labels = (menu: MenuItemConstructorOptions[]) =>
  menu.map((item) => [
    item.label,
    submenu(item)
      .filter((x) => x.type !== "separator")
      .map((x) => x.label),
  ]);
const click = (item: MenuItemConstructorOptions | undefined) =>
  (item?.click as unknown as () => void)();

test("pick returns the copy for the app's language", () => {
  assert.equal(pick("tr")("Aç", "Open"), "Aç");
  assert.equal(pick("en")("Aç", "Open"), "Open");
});

test("the app menu speaks Turkish", () => {
  assert.deepEqual(labels(appMenuTemplate("tr", actions, "darwin")), [
    ["Relay", ["Relay hakkında", "Relay’i gizle", "Relay penceresini kapat", "Relay’den çık"]],
    ["Düzen", ["Geri al", "Yinele", "Kes", "Kopyala", "Yapıştır", "Tümünü seç"]],
    ["Görüntü", ["Gerçek boyut", "Yakınlaştır", "Uzaklaştır", "Tam ekran"]],
    ["Pencere", ["Küçült", "Büyüt", "Pencereyi kapat"]],
  ]);
});

test("the app menu speaks English", () => {
  assert.deepEqual(labels(appMenuTemplate("en", actions, "darwin")), [
    ["Relay", ["About Relay", "Hide Relay", "Close Relay window", "Quit Relay"]],
    ["Edit", ["Undo", "Redo", "Cut", "Copy", "Paste", "Select All"]],
    ["View", ["Actual Size", "Zoom In", "Zoom Out", "Toggle Full Screen"]],
    ["Window", ["Minimize", "Zoom", "Close Window"]],
  ]);
});

test("Cmd+Q closes to the menu bar, Alt+Cmd+Q quits, Cmd+W closes the focused window", () => {
  for (const language of ["tr", "en"] as const) {
    const [app, , , win] = appMenuTemplate(language, actions, "darwin");
    const close = submenu(app).find((x) => x.accelerator === "CmdOrCtrl+Q");
    const quit = submenu(app).find((x) => x.accelerator === "Alt+CmdOrCtrl+Q");
    const closeWindow = submenu(win).find((x) => x.accelerator === "CmdOrCtrl+W");
    calls.length = 0;
    click(close);
    click(quit);
    click(closeWindow);
    assert.deepEqual(calls, ["closeToTray", "quit", "closeWindow"], language);
    // The macOS Window menu, with no stock quit role anywhere.
    assert.equal(win.role, "window");
    assert.doesNotMatch(JSON.stringify(appMenuTemplate(language, actions, "darwin")), /"role":"quit"/);
  }
});

test("other platforms have no Relay app menu but keep Edit, View and Window", () => {
  assert.deepEqual(
    appMenuTemplate("en", actions, "win32").map((x) => x.label),
    ["Edit", "View", "Window"],
  );
});
