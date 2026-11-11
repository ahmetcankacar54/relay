import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deniedBrowsers, macBrowserSystem, type BrowserSystem } from "../electron/core/browser-system";
import { extensionGuide, instanceLine } from "../src/lib/extension-ui";
import { isExternalLink, EXTERNAL_LINKS } from "../shared/external-links";
import { DEFAULT_EXTENSION, type ExtensionStatus } from "../shared/browser-extension";

const t = (tr: string, en: string) => en;
const fake = (present: string[], denied: string[]): BrowserSystem =>
  ({
    support: "/support",
    exists: (file: string) => present.some((dir) => file === path.join("/support", dir)),
    denied: (file: string) => denied.some((dir) => file === path.join("/support", dir, "Local State")),
  }) as unknown as BrowserSystem;

test("a browser macOS keeps from Relay is told apart from one that is not there", () => {
  const system = fake(["Google/Chrome", "BraveSoftware/Brave-Browser"], ["Google/Chrome"]);
  assert.deepEqual(deniedBrowsers(system), ["chrome"]);
  // A browser that is not installed, or a fake system without the check, is never "denied".
  assert.deepEqual(deniedBrowsers(fake([], ["Google/Chrome"])), []);
  assert.deepEqual(deniedBrowsers({ ...fake(["Google/Chrome"], []), denied: undefined } as BrowserSystem), []);
});

test("the real check says readable files are not denied and missing ones are not either", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-access-"));
  try {
    const file = path.join(dir, "Local State");
    fs.writeFileSync(file, "{}");
    const system = macBrowserSystem(dir);
    assert.equal(system.denied!(file), false);
    assert.equal(system.denied!(path.join(dir, "missing")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
