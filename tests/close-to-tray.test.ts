import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// main.ts imports Electron, so these read its source, as the other main tests do.
const main = readFileSync(
  new URL("../electron/main.ts", import.meta.url),
  "utf8",
);
/** One top-level function, from its signature to the closing brace at column 0. */
function topLevel(name: string) {
  const start = main.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return main.slice(start, main.indexOf("\n}\n", start));
}

test("the app menu has no stock quit role, so Cmd+Q cannot quit Relay by itself", () => {
  assert.doesNotMatch(main, /role:\s*"quit"/);
});

test("Cmd+Q closes the window to the menu bar and Alt+Cmd+Q quits Relay", () => {
  // The template itself is tested in tests/app-menu.test.ts; main hands it these actions.
  assert.match(
    main,
    /appMenuTemplate\(trayLanguage, \{\s*closeToTray: \(\) => closeToTray\(\),\s*quit: \(\) => app\.quit\(\),\s*closeWindow: \(\) => closeFocusedWindow\(\),\s*\}\)/,
  );
});

test("the menu is rebuilt when the language changes", () => {
  const handler = main.slice(main.indexOf('handle("tray-language"'));
  assert.match(handler, /if \(changed\) applyAppMenu\(\);/);
  assert.ok(handler.indexOf("applyAppMenu()") < handler.indexOf("\n  });"));
});

test("Cmd+W hides the main window as its close button does, and hides the panel", () => {
  const body = topLevel("closeFocusedWindow");
  assert.match(body, /if \(focused === window\) focused\.close\(\);/);
  assert.match(body, /trayPanel\?\.hide\(\)/);
  // The main window's close is what hides it while the menu bar keeps Relay running.
  assert.match(main, /window\.on\("close", \(event\) => \{\s*if \(!quitting && tray\) \{\s*event\.preventDefault\(\);\s*window\?\.hide\(\);/);
});

test("closeToTray quits without a tray; otherwise it hides the window, the panel and the dock", () => {
  const body = topLevel("closeToTray");
  assert.match(body, /if \(!tray\) \{\s*app\.quit\(\);\s*return;\s*\}/);
  assert.match(body, /window\?\.hide\(\);/);
  assert.match(body, /trayPanel\?\.hide\(\);/);
  assert.match(
    body,
    /if \(process\.platform === "darwin"\) app\.dock\?\.hide\(\);/,
  );
  // The quit branch comes first, and the switch window is left alone.
  assert.ok(body.indexOf("app.quit()") < body.indexOf("window?.hide()"));
  assert.doesNotMatch(body, /switchWindow/);
});

test("showWindow brings a hidden dock icon back before it shows the window", () => {
  const body = topLevel("showWindow");
  assert.match(
    body,
    /if \(process\.platform === "darwin" && app\.dock && !app\.dock\.isVisible\(\)\)\s+void app\.dock\.show\(\);/,
  );
  assert.ok(body.indexOf("app.dock.show()") < body.indexOf("window.show()"));
});

test("the tray and panel quit, the dock quit and before-quit stay as they were", () => {
  assert.match(main, /quit: \(\) => app\.quit\(\),/);
  assert.match(
    main,
    /handle\("quit", \(\) => \{\s*trayPanel\?\.hide\(\);\s*app\.quit\(\);\s*\}\);/,
  );
  assert.match(main, /app\.on\("before-quit", \(event\) => \{/);
});
