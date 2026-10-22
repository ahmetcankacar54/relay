import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-expect-error The standalone build script has no declaration file.
import { widgetBuild, widgetPlist } from "../scripts/build-native.mjs";

test("the widget's build number follows its source and images, so chronod re-reads its kinds", () => {
  const a = widgetBuild(Buffer.from("struct A {}"), Buffer.from("png"));
  assert.match(a, /^\d+$/);
  assert.equal(widgetBuild(Buffer.from("struct A {}"), Buffer.from("png")), a);
  assert.notEqual(widgetBuild(Buffer.from("struct B {}"), Buffer.from("png")), a);
  const plist = widgetPlist("0.12.1", a);
  assert.match(plist, /<key>CFBundleShortVersionString<\/key><string>0\.12\.1<\/string>/);
  assert.match(plist, new RegExp(`<key>CFBundleVersion</key><string>${a}</string>`));
});

test("installing restarts chronod after registering the widget, so the gallery lists the new kinds", () => {
  const install = readFileSync(new URL("../scripts/stable-signing.mjs", import.meta.url), "utf8");
  const register = install.indexOf('"/usr/bin/pluginkit"');
  const restart = install.indexOf('execFileSync("/usr/bin/killall", ["chronod"])');
  assert.ok(register > 0 && restart > register);
});
