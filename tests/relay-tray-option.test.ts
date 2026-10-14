import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shouldConsumeTraySwitch } from "../src/data/relay-action";

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
