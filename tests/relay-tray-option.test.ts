import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { errorAfterRefresh, shouldPoll } from "../src/data/relay-action";
import { languageFromStorage } from "../src/data/language";

test("the never-sent tray switch request is gone end to end", () => {
  // The menu bar switches through its own confirmation (traySwitch in main); nothing queues a
  // request for a renderer to take.
  for (const file of [
    "../electron/main.ts",
    "../electron/preload.ts",
    "../shared/types.ts",
    "../src/data/useRelay.ts",
    "../src/data/relay-action.ts",
    "../src/panel/main.tsx",
    "../src/preview.ts",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /consumeTraySwitch|consume-tray-switch|traySwitchRequest|onTraySwitch|relay:tray-switch/, file);
  }
});

test("vite builds both the main window and the menu bar panel", () => {
  const config = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(config, /index\.html/);
  assert.match(config, /panel\.html/);
});

test("a window skips its poll while hidden only when it opts out", () => {
  assert.equal(shouldPoll({}, "hidden"), true);
  assert.equal(shouldPoll({ pollWhenHidden: true }, "hidden"), true);
  assert.equal(shouldPoll({ pollWhenHidden: false }, "visible"), true);
  assert.equal(shouldPoll({ pollWhenHidden: false }, "hidden"), false);
});

test("a language change in another Relay window is picked up", () => {
  assert.equal(languageFromStorage({ key: "relay-language", newValue: "en" }), "en");
  assert.equal(languageFromStorage({ key: "relay-language", newValue: "tr" }), "tr");
  assert.equal(languageFromStorage({ key: "relay-language", newValue: null }), "tr");
  assert.equal(languageFromStorage({ key: "other", newValue: "en" }), undefined);
});

test("both windows refresh when main broadcasts relay:changed", () => {
  const preview = readFileSync(new URL("../src/preview.ts", import.meta.url), "utf8");
  assert.match(preview, /onChanged: \(\) => \(\) => \{\}/);
  const preload = readFileSync(new URL("../electron/preload.ts", import.meta.url), "utf8");
  assert.match(preload, /onChanged:[\s\S]*?"relay:changed"/);
  const hook = readFileSync(new URL("../src/data/useRelay.ts", import.meta.url), "utf8");
  assert.match(hook, /api\.onChanged\(/);
});

test("the panel entry does not add an unused root class", () => {
  const entry = readFileSync(new URL("../src/panel/main.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(entry, /classList\.add\("panel"\)/);
});

test("every Desktop operation refreshes the tray inside the lock when it begins and when it ends", () => {
  // The lock tells its listener inside the lock, at each begin and end
  // (tests/desktop-lock.test.ts); main's listener is the tray.
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  assert.match(main, /const desktopLock = new DesktopLock\(\(\) => void tray\?\.update\(\), \{/);
  const lock = readFileSync(new URL("../electron/core/desktop-lock.ts", import.meta.url), "utf8");
  const hold = lock.slice(lock.indexOf("private async hold"));
  // The shared file lock is taken first: the tray hears of a holder only once it holds both.
  assert.match(hold, /await before;[\s\S]*?this\.fileLock\?\.acquire\(kind\);[\s\S]*?this\.tell\(\);\s*return await action\(\);\s*\} finally \{[\s\S]*?this\.holder = undefined;[\s\S]*?release\(\);\s*this\.tell\(\);/);
  assert.doesNotMatch(hold.slice(0, hold.indexOf("await before;")), /this\.tell\(\)/);
});

test("an error from a background refresh clears once a refresh succeeds; other errors stay", () => {
  assert.equal(errorAfterRefresh("Command failed: /bin/ps", "Command failed: /bin/ps"), "");
  // An action's error that replaced the refresh error is not the refresh's to clear.
  assert.equal(errorAfterRefresh("Switch failed", "Command failed: /bin/ps"), "Switch failed");
  assert.equal(errorAfterRefresh("Switch failed", undefined), "Switch failed");
  assert.equal(errorAfterRefresh("", undefined), "");
});

test("background refreshes report through the self-clearing refresh error", () => {
  const hook = readFileSync(new URL("../src/data/useRelay.ts", import.meta.url), "utf8");
  assert.doesNotMatch(hook, /refresh\(\)\.catch\(showError\)/);
  assert.match(hook, /refresh\(\)\.catch\(showRefreshError\)/);
  assert.match(hook, /errorAfterRefresh\(/);
});
