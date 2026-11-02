import test from "node:test";
import assert from "node:assert/strict";
import { parseUsage } from "../electron/core/usage";

test("model-specific windows are exposed with readable labels", () => {
  const reset = "2026-10-18T06:00:00.000Z";
  const usage = parseUsage({
    five_hour: { utilization: 10, resets_at: reset },
    seven_day: { utilization: 53, resets_at: reset },
    seven_day_opus: { utilization: 7, resets_at: reset },
    seven_day_claude_design: { utilization: 100, resets_at: reset },
    seven_day_sonnet: null,
  });
  assert.deepEqual(usage.modelWindows, [
    { key: "seven_day_claude_design", label: "Claude Design", usedPercent: 100, resetsAt: reset },
    { key: "seven_day_opus", label: "Opus", usedPercent: 7, resetsAt: reset },
  ]);
  assert.equal(usage.otherLimitReached, true);
  assert.equal(parseUsage({ five_hour: { utilization: 1 } }).modelWindows, undefined);
});

test("malformed model windows are skipped without failing the usage read", () => {
  const usage = parseUsage({
    five_hour: { utilization: 10 },
    seven_day: { utilization: 20 },
    seven_day_x: { utilization: 105 },
    seven_day_y: "bad",
    seven_day_z: { utilization: 5, resets_at: "nope" },
    seven_day_ok: { utilization: 3 },
  });
  assert.equal(usage.fiveHour?.usedPercent, 10);
  assert.equal(usage.sevenDay?.usedPercent, 20);
  assert.deepEqual(usage.modelWindows, [{ key: "seven_day_ok", label: "Ok", usedPercent: 3 }]);
  assert.equal("resetsAt" in usage.modelWindows![0], false);
});
