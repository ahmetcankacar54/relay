import test from "node:test";
import assert from "node:assert/strict";
import { meterTone } from "../src/lib/meter";

test("meter tone follows the 75/90 thresholds", () => {
  assert.equal(meterTone(undefined), "none");
  assert.equal(meterTone(0), "ok");
  assert.equal(meterTone(74.9), "ok");
  assert.equal(meterTone(75), "warn");
  assert.equal(meterTone(89.9), "warn");
  assert.equal(meterTone(90), "crit");
  assert.equal(meterTone(100), "crit");
});
