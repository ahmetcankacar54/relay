import test from "node:test";
import assert from "node:assert/strict";
import { extensionGuide, instanceLine } from "../src/lib/extension-ui";
import { isExternalLink, EXTERNAL_LINKS } from "../shared/external-links";
import { DEFAULT_EXTENSION, type ExtensionStatus } from "../shared/browser-extension";
import { testT } from "./i18n";

const t = testT("en");

test("with no extension found because macOS blocks the browser, the card says how to allow it", () => {
  const status: ExtensionStatus = { setting: { ...DEFAULT_EXTENSION, mode: "restart" }, instances: [], saved: [], denied: ["chrome"] };
  assert.match(instanceLine(status, t), /macOS does not let Relay read the data of Chrome\. Turn on Relay in System Settings › Privacy & Security › Full Disk Access/);
  assert.doesNotMatch(instanceLine(status, t), /No Claude extension found/);
  const guide = extensionGuide({ id: "a" } as any, status, [], t, "en");
  assert.equal(guide.tone, "warn");
  assert.equal(guide.label, "macOS blocks access");
  // Without a denied browser the old message stays.
  assert.match(instanceLine({ ...status, denied: undefined }, t), /No Claude extension found/);
  // The settings pane opens through the allow-list.
  assert.ok(isExternalLink(EXTERNAL_LINKS.fullDiskAccess));
});
