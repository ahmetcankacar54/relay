import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  errorAfterRefresh,
  shouldConsumeTraySwitch,
  shouldPoll,
} from "../src/data/relay-action";
import { languageFromStorage } from "../src/data/language";

test("the tray switch request is consumed unless the caller opts out", () => {
  assert.equal(shouldConsumeTraySwitch({}), true);
  assert.equal(shouldConsumeTraySwitch({ consumeTraySwitch: true }), true);
  assert.equal(shouldConsumeTraySwitch({ consumeTraySwitch: false }), false);
});

test("vite builds both the main window and the menu bar panel", () => {
  const config = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(config, /index\.html/);
  assert.match(config, /panel\.html/);
});

test("the panel stops polling while hidden; the main window always polls", () => {
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
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  const lock = main.slice(main.indexOf("async function withDesktopLock"), main.indexOf("function manualDesktopLock"));
  assert.match(lock, /try \{(?:\s*\/\/[^\n]*)*\s*void tray\?\.update\(\);[\s\S]*?\} finally \{[\s\S]*?desktopTransactionActive = false;[\s\S]*?void tray\?\.update\(\);[\s\S]*?\}/);
  assert.doesNotMatch(lock.slice(0, lock.indexOf("try {")), /tray\?\.update/);
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
