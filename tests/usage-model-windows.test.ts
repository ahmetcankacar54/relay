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
