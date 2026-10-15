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
const after = (shown: MascotFrame[], from: number) => shown.slice(from);

test("the panda starts idle and fidgets in turn every three to six minutes", () => {
  const h = harness();
  assert.deepEqual(h.shown, ["idle"]);
  h.advance(3 * 60_000 - 1);
  assert.deepEqual(h.shown, ["idle"]);
  h.advance(1);
  h.advance(1000);
  assert.deepEqual(h.shown, ["idle", "blink-0", "blink-1", "blink-0", "idle"]);
  h.advance(3 * 60_000 + 1000);
  assert.deepEqual(after(h.shown, 5), ["ear-0", "ear-1", "idle"]);
  h.advance(3 * 60_000 + 1000);
  assert.deepEqual(after(h.shown, 8), ["wash-0", "wash-1", "wash-2", "wash-1", "wash-2", "wash-0", "idle"]);
  const late = harness({ random: [1] });
  late.advance(6 * 60_000 - 1);
  assert.deepEqual(late.shown, ["idle"]);
  late.advance(1);
  assert.equal(late.shown.at(-1), "blink-0");
});

test("leaving plays the exit, then the door loops at 2 fps and rests after a minute", () => {
  const h = harness();
  h.player.update("away", "leave");
  h.advance(500);
  assert.deepEqual(after(h.shown, 1), ["exit-0", "exit-1", "exit-2", "exit-3", "away-0"]);
  h.advance(500);
  assert.equal(h.shown.at(-1), "away-1");
  h.advance(61_000);
  assert.equal(h.shown.at(-1), "away-0");
  assert.equal(h.timers.size, 0);
});

test("returning plays a disguise, never the same one twice in a row", () => {
  const h = harness({ random: [0, 0, 0, 0] });
  h.player.update("away");
  const from = h.shown.length;
  h.player.update("idle", "return");
  h.advance(2300);
  assert.deepEqual(after(h.shown, from), [
    "enter-fedora-0", "enter-fedora-1", "toss-fedora-0", "toss-fedora-1", "bow-0", "bow-1", "idle",
  ]);
  h.player.update("away");
  const second = h.shown.length;
  h.player.update("idle", "return");
  h.advance(2300);
  assert.equal(h.shown[second], "enter-shades-0");
});

test("a new cue replaces a playing one", () => {
  const h = harness();
  h.player.update("hungry", "rumble");
  h.advance(130);
  h.player.update("alert", "rise");
  h.advance(1000);
  assert.deepEqual(after(h.shown, 1), ["rumble-0", "rumble-1", "rise-0", "rise-1", "alert"]);
});

test("warming loops at 8 fps; a pose change mid-cue waits for the cue", () => {
  const h = harness();
  h.player.update("idle", "munch");
  h.advance(130);
  h.player.update("warming");
  h.advance(1100);
  assert.deepEqual(after(h.shown, 1).slice(0, 10), [
    "munch-0", "munch-1", "munch-2", "munch-3", "munch-0", "munch-1", "munch-2", "munch-3", "warm-0", "warm-1",
  ]);
});

test("without motion the panda only changes still frames", () => {
  const h = harness();
  h.setMotion(false);
  h.player.update("away", "leave");
  h.player.update("idle", "return");
  h.advance(10 * 60_000);
  assert.deepEqual(h.shown, ["idle", "away-0", "idle"]);
});

test("turning motion off stops a loop at the next frame", () => {
  const h = harness();
  h.player.update("warming");
  h.advance(250);
  h.setMotion(false);
  h.advance(125);
  assert.equal(h.shown.at(-1), "warm-0");
  assert.equal(h.timers.size, 0);
});

test("a frame that comes due long after the Mac slept drops the sequence", () => {
  const h = harness();
  h.player.update("warming");
  h.advance(125);
  const from = h.shown.length;
  h.sleep(10 * 60_000);
  h.advance(0);
  assert.deepEqual(after(h.shown, from), ["warm-0"]);
  assert.equal(h.timers.size, 0);
});

test("a failing tray stops the sequence and the next pose retries", () => {
  const h = harness();
  h.player.update("warming");
  h.setFailing(true);
  h.advance(125);
  assert.equal(h.timers.size, 0);
  h.setFailing(false);
  h.player.update("idle");
  assert.equal(h.shown.at(-1), "idle");
});

test("a pose change reschedules the fidget", () => {
  const h = harness();
  h.advance(2 * 60_000);
  h.player.update("hungry");
  h.advance(2 * 60_000);
  assert.deepEqual(h.shown, ["idle", "hungry"]);
  h.advance(60_000 + 1000);
  assert.deepEqual(after(h.shown, 2), ["rumble-0", "rumble-1", "rumble-2", "rumble-3", "hungry"]);
});

test("each pose cycles its own fidgets, wherever the other poses left off", () => {
  const h = harness();
  h.advance(3 * 60_000 + 1000);
  h.player.update("hungry");
  h.advance(3 * 60_000 + 1000);
  h.player.update("idle");
  h.advance(3 * 60_000 + 1000);
  h.advance(3 * 60_000 + 1000);
  h.advance(3 * 60_000 + 1000);
  assert.deepEqual(h.shown, [
    "idle", "blink-0", "blink-1", "blink-0", "idle",
    "hungry", "rumble-0", "rumble-1", "rumble-2", "rumble-3", "hungry",
    "idle", "ear-0", "ear-1", "idle",
    "wash-0", "wash-1", "wash-2", "wash-1", "wash-2", "wash-0", "idle",
    "tail-0", "tail-1", "tail-0", "idle",
  ]);
});

test("destroy leaves no timers and ignores later updates", () => {
  const h = harness();
  h.player.update("warming");
  h.player.destroy();
  assert.equal(h.timers.size, 0);
  h.player.update("idle", "munch");
  assert.equal(h.shown.at(-1), "warm-0");
});
