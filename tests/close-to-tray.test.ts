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
  assert.match(
    main,
    /\{\s*label: "Relay penceresini kapat",\s*accelerator: "CmdOrCtrl\+Q",\s*click: \(\) => closeToTray\(\),\s*\}/,
  );
  assert.match(
    main,
    /\{\s*label: "Relay’den çık",\s*accelerator: "Alt\+CmdOrCtrl\+Q",\s*click: \(\) => app\.quit\(\),\s*\}/,
  );
  // The two items sit in the macOS app menu, next to the other Relay items.
  const menu = main.slice(main.indexOf('label: "Relay",'));
  assert.ok(
    menu.indexOf("closeToTray()") > 0 &&
      menu.indexOf("closeToTray()") < menu.indexOf('label: "Düzenle"'),
  );
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

test("showWindow brings the dock icon back before it shows the window", () => {
  const body = topLevel("showWindow");
  assert.match(
    body,
    /if \(process\.platform === "darwin"\) void app\.dock\?\.show\(\);/,
  );
  assert.ok(body.indexOf("app.dock?.show()") < body.indexOf("window.show()"));
});

test("the tray and panel quit, the dock quit and before-quit stay as they were", () => {
  assert.match(main, /quit: \(\) => app\.quit\(\),/);
  assert.match(
    main,
    /handle\("quit", \(\) => \{\s*trayPanel\?\.hide\(\);\s*app\.quit\(\);\s*\}\);/,
  );
  assert.match(main, /app\.on\("before-quit", \(event\) => \{/);
});
