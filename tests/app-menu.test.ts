import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { MenuItemConstructorOptions } from "electron";
import { appMenuTemplate, bugReportUrl, DOCUMENTATION_URL } from "../electron/app-menu";
import "./i18n";

const calls: string[] = [];
const actions = {
  closeToTray: () => void calls.push("closeToTray"),
  quit: () => void calls.push("quit"),
  closeWindow: () => void calls.push("closeWindow"),
  openDocumentation: () => void calls.push("openDocumentation"),
  reportBug: () => void calls.push("reportBug"),
  exportDiagnostics: () => void calls.push("exportDiagnostics"),
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

test("the app menu speaks Turkish", () => {
  assert.deepEqual(labels(appMenuTemplate("tr", actions, "darwin")), [
    ["Relay", ["Relay hakkında", "Relay’i gizle", "Relay penceresini kapat", "Relay’den çık"]],
    ["Düzen", ["Geri al", "Yinele", "Kes", "Kopyala", "Yapıştır", "Tümünü seç"]],
    ["Görüntü", ["Gerçek boyut", "Yakınlaştır", "Uzaklaştır", "Tam ekran"]],
    ["Pencere", ["Küçült", "Büyüt", "Pencereyi kapat"]],
    ["Yardım", ["Belgeler", "Hata bildir", "Tanılamayı dışa aktar…"]],
  ]);
});

test("the app menu speaks English", () => {
  assert.deepEqual(labels(appMenuTemplate("en", actions, "darwin")), [
    ["Relay", ["About Relay", "Hide Relay", "Close Relay window", "Quit Relay"]],
    ["Edit", ["Undo", "Redo", "Cut", "Copy", "Paste", "Select All"]],
    ["View", ["Actual Size", "Zoom In", "Zoom Out", "Toggle Full Screen"]],
    ["Window", ["Minimize", "Zoom", "Close Window"]],
    ["Help", ["Documentation", "Report a Bug", "Export Diagnostics…"]],
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

test("other platforms have no Relay app menu but keep Edit, View, Window and Help", () => {
  assert.deepEqual(
    appMenuTemplate("en", actions, "win32").map((x) => x.label),
    ["Edit", "View", "Window", "Help"],
  );
});

test("Help opens the documentation and the bug form, and exports the diagnostics", () => {
  const help = appMenuTemplate("en", actions, "win32").at(-1)!;
  assert.equal(help.role, "help");
  calls.length = 0;
  for (const item of submenu(help).filter((x) => x.type !== "separator")) click(item);
  assert.deepEqual(calls, ["openDocumentation", "reportBug", "exportDiagnostics"]);
  assert.equal(DOCUMENTATION_URL, "https://github.com/ahmetcankacar54/relay#readme");
});

test("the bug report link fills the issue form's version, platform and system fields", () => {
  const url = new URL(bugReportUrl("0.28.0", "darwin", "15.5"));
  assert.equal(url.origin + url.pathname, "https://github.com/ahmetcankacar54/relay/issues/new");
  assert.equal(url.searchParams.get("template"), "bug_report.yml");
  assert.equal(url.searchParams.get("version"), "0.28.0");
  assert.equal(url.searchParams.get("platform"), "macOS");
  assert.equal(url.searchParams.get("os"), "macOS 15.5");
  assert.equal(new URL(bugReportUrl("0.28.0", "freebsd", "14")).searchParams.has("platform"), false);
  // The ids and options are the form's own.
  const form = readFileSync(new URL("../.github/ISSUE_TEMPLATE/bug_report.yml", import.meta.url), "utf8");
  for (const id of ["version", "platform", "os"]) assert.match(form, new RegExp(`\\n    id: ${id}\\n`));
  for (const name of ["macOS", "Windows", "Linux"]) assert.match(form, new RegExp(`\\n        - ${name}\\n`));
});
