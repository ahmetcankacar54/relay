import test from "node:test";
import assert from "node:assert/strict";
import {
  bundlePath,
  bundlePlace,
  clearOwnQuarantine,
  forgetsApproval,
} from "../electron/core/install-location";

test("the bundle is found around Contents/MacOS, and nothing outside an .app", () => {
  assert.equal(bundlePath("/Applications/Relay.app/Contents/MacOS/Relay"), "/Applications/Relay.app");
  assert.equal(bundlePath("/Volumes/Relay 0.13.3/Relay.app/Contents/MacOS/Relay"), "/Volumes/Relay 0.13.3/Relay.app");
  assert.equal(bundlePath("/usr/local/lib/node_modules/electron/dist/electron"), undefined);
  assert.equal(bundlePath("/tmp/Contents/MacOS/Relay"), undefined);
});

test("a disk image or a translocated copy forgets the approval; Applications and other folders keep it", () => {
  const translocated =
    "/private/var/folders/x1/abc/T/AppTranslocation/0D2F-11AA/d/Relay.app";
  assert.equal(bundlePlace(translocated, false), "translocated");
  assert.equal(bundlePlace("/Volumes/Relay 0.13.3/Relay.app", false), "disk-image");
  assert.equal(bundlePlace("/Applications/Relay.app", true), "applications");
  assert.equal(bundlePlace("/Users/me/Desktop/Relay.app", false), "elsewhere");
  assert.ok(forgetsApproval("translocated") && forgetsApproval("disk-image"));
  assert.ok(!forgetsApproval("applications") && !forgetsApproval("elsewhere"));
});

test("the quarantine is cleared from the whole bundle with the system's xattr, and a failure is only reported", async () => {
  const calls: [string, string[]][] = [];
  assert.equal(
    await clearOwnQuarantine("/Applications/Relay.app", async (file, args) => {
      calls.push([file, args]);
    }),
    true,
  );
  assert.deepEqual(calls, [
    ["/usr/bin/xattr", ["-dr", "com.apple.quarantine", "/Applications/Relay.app"]],
  ]);
  assert.equal(
    await clearOwnQuarantine("/Applications/Relay.app", async () => {
      throw new Error("Operation not permitted");
    }),
    false,
  );
});
