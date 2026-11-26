import test from "node:test";
import assert from "node:assert/strict";
import { extensionGuide, instanceLine } from "../src/lib/extension-ui";
import { DEFAULT_EXTENSION, browserApps, type ExtensionStatus } from "../shared/browser-extension";
import type { Account } from "../shared/types";
import { testT } from "./i18n";

const t = testT("en");

test("Linux looks in the browsers with a Linux build only", () => {
  const apps = browserApps("linux");
  assert.deepEqual([...apps], ["chrome", "brave", "edge", "chromium", "vivaldi", "chrome-beta", "chrome-dev"]);
  assert.equal(browserApps("darwin").length, 11);
});

test("with no extension found on Linux, the card names Linux browsers and no Mac", () => {
  const status: ExtensionStatus = { setting: { ...DEFAULT_EXTENSION, mode: "restart" }, instances: [], saved: [] };
  const line = instanceLine(status, t, "linux");
  assert.match(line, /No Claude extension found on this computer \(Chrome, Brave, Edge, Chromium, Vivaldi, Chrome Beta and Chrome Dev\)\./);
  const guide = extensionGuide({ id: "a" } as unknown as Account, status, [], t, "en", undefined, "linux");
  assert.equal(guide.label, "No Claude extension found on this computer.");
  assert.doesNotMatch(guide.detail ?? "", /Arc|Comet|Canary|Dia/);
  // macOS keeps its words.
  assert.match(instanceLine(status, t), /on this Mac \(.*Arc.*Comet\)\./);
});
