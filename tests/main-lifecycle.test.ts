import test from "node:test";
import assert from "node:assert/strict";
import {
  pageCrashAction,
  PAGE_RELOAD_WINDOW_MS,
  SHUTDOWN_GRACE_MS,
  systemShuttingDown,
} from "../electron/main-lifecycle";

test("a crashed page reloads after 1 s, 5 s and 15 s, then Relay gives up within the minute", () => {
  let reloadsAt: number[] = [];
  const delays: number[] = [];
  for (const now of [0, 2_000, 8_000]) {
    const next = pageCrashAction("crashed", reloadsAt, now);
    assert.equal(next.action, "reload");
    if (next.action !== "reload") return;
    delays.push(next.delayMs);
    reloadsAt = next.reloadsAt;
  }
  assert.deepEqual(delays, [1_000, 5_000, 15_000]);
  assert.deepEqual(pageCrashAction("killed", reloadsAt, 30_000), { action: "give-up" });
});

test("reloads older than the window no longer count", () => {
  const next = pageCrashAction("oom", [0, 1_000, 2_000], 2_000 + PAGE_RELOAD_WINDOW_MS);
  assert.deepEqual(next, { action: "reload", delayMs: 1_000, reloadsAt: [2_000 + PAGE_RELOAD_WINDOW_MS] });
  const partly = pageCrashAction("crashed", [0, 50_000], PAGE_RELOAD_WINDOW_MS + 10_000);
  assert.deepEqual(partly, { action: "reload", delayMs: 5_000, reloadsAt: [50_000, 70_000] });
});

test("a clean exit is left alone; a page that cannot start or is damaged is never reloaded", () => {
  assert.deepEqual(pageCrashAction("clean-exit", [], 0), { action: "ignore" });
  assert.deepEqual(pageCrashAction("launch-failed", [], 0), { action: "give-up" });
  assert.deepEqual(pageCrashAction("integrity-failure", [], 0), { action: "give-up" });
});

test("a shutdown signal lifts the quit safeguards for 30 s only", () => {
  assert.equal(systemShuttingDown(undefined, 0), false);
  assert.equal(systemShuttingDown(1_000, 1_000), true);
  assert.equal(systemShuttingDown(1_000, 1_000 + SHUTDOWN_GRACE_MS - 1), true);
  // A logout or shutdown the user cancelled does not let a later quit skip the safeguards.
  assert.equal(systemShuttingDown(1_000, 1_000 + SHUTDOWN_GRACE_MS), false);
  // A clock set back does not count as shutting down.
  assert.equal(systemShuttingDown(10_000, 5_000), false);
});
