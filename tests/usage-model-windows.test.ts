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
    { key: "seven_day_opus", label: "Opus", model: "opus", usedPercent: 7, resetsAt: reset },
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

test("a weekly limit scoped to one model comes from the answer's limits list (Fable, 2026-11-14)", () => {
  const reset = "2026-11-15T05:00:00.042595+00:00";
  // The shape the usage endpoint answered with on 2026-11-14; the old fields carry no Fable key.
  const usage = parseUsage({
    five_hour: { utilization: 20, resets_at: "2026-11-14T01:00:00+00:00" },
    seven_day: { utilization: 80, resets_at: reset },
    seven_day_opus: null,
    limits: [
      { kind: "session", group: "session", percent: 20, resets_at: "2026-11-14T01:00:00+00:00", scope: null },
      { kind: "weekly_all", group: "weekly", percent: 80, resets_at: reset, scope: null },
      { kind: "weekly_scoped", group: "weekly", percent: 100, severity: "critical", resets_at: reset, scope: { model: { id: null, display_name: "Fable" }, surface: null } },
      { kind: "weekly_scoped", group: "weekly", percent: "bad", scope: { model: { display_name: "Broken" } } },
    ],
    weekly_scoped_shares: [{ limit_index: 2, used_percent_of_weekly: 50, allowance_percent_of_weekly: 50 }],
  });
  assert.deepEqual(usage.modelWindows, [
    { key: "seven_day_fable", label: "Fable", model: "fable", usedPercent: 100, resetsAt: "2026-11-15T05:00:00.042Z", weeklyShare: 50 },
  ]);
  assert.equal(usage.otherLimitReached, true, "a spent Fable week stops Fable work");
  assert.equal(usage.sevenDay?.usedPercent, 80);

  const roomy = parseUsage({
    five_hour: { utilization: 0, resets_at: null },
    seven_day: { utilization: 27, resets_at: reset },
    limits: [{ kind: "weekly_scoped", group: "weekly", percent: 12, resets_at: reset, scope: { model: { display_name: "Fable" } } }],
  });
  assert.equal(roomy.modelWindows?.[0]?.usedPercent, 12);
  assert.equal(roomy.otherLimitReached, undefined);
});
