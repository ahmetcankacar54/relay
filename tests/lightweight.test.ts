import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("node-pty loads with the first terminal, not with Relay", () => {
  const runner = read("electron/core/runner.ts");
  assert.doesNotMatch(runner, /^import \* as \w+ from "node-pty";/m);
  assert.match(runner, /^import type \* as Pty from "node-pty";/m);
  assert.match(runner, /ptyModule \?\?= require\("node-pty"\) as typeof Pty;/);
  assert.match(runner, /proc = loadPty\(\)\.spawn\(/);
});

test("the main process bundle is minified and keeps its names", () => {
  const build = read("scripts/build.mjs");
  assert.match(build, /minify: true,\s*keepNames: true,/);
  // node-pty stays outside the bundle, loaded from the app's unpacked node_modules.
  assert.match(build, /external: \["electron", "node-pty"\]/);
});
