import test from "node:test";
import assert from "node:assert/strict";
import { MascotPlayer } from "../electron/core/mascot-player";
import type { MascotFrame } from "../shared/mascot-frames";

function harness(options: { random?: number[] } = {}) {
  let now = 0;
  let motion = true;
  let failing = false;
  let id = 0;
  const randoms = [...(options.random ?? [])];
  const timers = new Map<number, { at: number; fn: () => void }>();
  const shown: MascotFrame[] = [];
  const player = new MascotPlayer({
    show: (frame) => {
      if (failing) throw new Error("tray destroyed");
      shown.push(frame);
    },
    motionAllowed: () => motion,
    now: () => now,
    setTimeout: (fn, ms) => {
      timers.set(++id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
    random: () => randoms.shift() ?? 0,
  });
  /** Fire due timers in order, as the event loop would. */
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
    }
    now = end;
  };
  return {
    player, shown, timers, advance,
    /** Move the clock without firing timers, as while the Mac sleeps. */
    sleep: (ms: number) => void (now += ms),
    setMotion: (m: boolean) => void (motion = m),
    setFailing: (f: boolean) => void (failing = f),
  };
}

test("the idle panda blinks for a moment every three to six minutes", () => {
  const h = harness();
  assert.deepEqual(h.shown, ["idle"]);
  h.advance(3 * 60_000 - 1);
  assert.deepEqual(h.shown, ["idle"]);
  h.advance(1);
  assert.deepEqual(h.shown, ["idle", "blink"]);
  h.advance(150);
  assert.deepEqual(h.shown, ["idle", "blink", "idle"]);
  h.advance(3 * 60_000);
  assert.deepEqual(h.shown, ["idle", "blink", "idle", "blink"]);
  const late = harness({ random: [1] });
  late.advance(6 * 60_000 - 1);
  assert.deepEqual(late.shown, ["idle"]);
  late.advance(1);
  assert.equal(late.shown.at(-1), "blink");
});

test("every pose shows its still frame, and only idle blinks", () => {
  const h = harness();
  for (const pose of ["hungry", "sleeping", "alert", "away"] as const) {
    h.player.update(pose);
    assert.equal(h.timers.size, 0, pose);
  }
  h.player.update("warming");
  assert.equal(h.timers.size, 0);
  h.player.update("idle");
  assert.deepEqual(h.shown, ["idle", "hungry", "sleep", "alert", "away", "idle"]);
  assert.equal(h.timers.size, 1);
});

test("without motion the panda does not blink", () => {
  const h = harness();
  h.setMotion(false);
  h.advance(20 * 60_000);
  assert.deepEqual(h.shown, ["idle"]);
  assert.equal(h.timers.size, 1);
  h.setMotion(true);
  h.advance(6 * 60_000);
  assert.equal(h.shown.at(-1), "idle");
  assert.ok(h.shown.includes("blink"));
});

test("a blink that comes due long after the Mac slept is skipped", () => {
  const h = harness();
  h.sleep(10 * 60_000);
  h.advance(0);
  assert.deepEqual(h.shown, ["idle"]);
  assert.equal(h.timers.size, 1);
});

test("a pose change during a blink rests on the new pose", () => {
  const h = harness();
  h.advance(3 * 60_000);
  assert.equal(h.shown.at(-1), "blink");
  h.player.update("hungry");
  h.advance(1000);
  assert.deepEqual(h.shown, ["idle", "blink", "hungry"]);
  assert.equal(h.timers.size, 0);
});

test("a refused image is retried on the next update, even for the same pose", () => {
  const h = harness();
  h.setFailing(true);
  h.player.update("hungry");
  assert.deepEqual(h.shown, ["idle"]);
  h.setFailing(false);
  h.player.update("hungry");
  assert.deepEqual(h.shown, ["idle", "hungry"]);
});

test("destroy leaves no timers and ignores later updates", () => {
  const h = harness();
  h.player.destroy();
  assert.equal(h.timers.size, 0);
  h.player.update("alert");
  assert.deepEqual(h.shown, ["idle"]);
});
