import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WINDOW_RELEASE_MS, WindowRelease } from "../electron/window-release";

function harness(state: { hidden: boolean; busy: boolean }) {
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  let released = 0;
  const release = new WindowRelease({
    hidden: () => state.hidden,
    busy: () => state.busy,
    release: () => void released++,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  });
  const pending = () => timers.filter((t) => !t.cleared);
  const fire = () => {
    const timer = pending().at(-1)!;
    timer.cleared = true;
    timer.fn();
  };
  return { release, pending, fire, released: () => released };
}

test("a window still hidden after the delay is released", () => {
  const h = harness({ hidden: true, busy: false });
  h.release.arm();
  assert.equal(h.pending().length, 1);
  assert.equal(h.pending()[0].ms, WINDOW_RELEASE_MS);
  h.fire();
  assert.equal(h.released(), 1);
});

test("showing the window again cancels the release", () => {
  const h = harness({ hidden: true, busy: false });
  h.release.arm();
  h.release.cancel();
  assert.equal(h.pending().length, 0);
  assert.equal(h.released(), 0);
});

test("a window shown by the time the timer fires is kept", () => {
  const state = { hidden: true, busy: false };
  const h = harness(state);
  h.release.arm();
  state.hidden = false;
  h.fire();
  assert.equal(h.released(), 0);
  assert.equal(h.pending().length, 0);
});

test("a busy window waits another round, then goes once idle", () => {
  const state = { hidden: true, busy: true };
  const h = harness(state);
  h.release.arm();
  h.fire();
  assert.equal(h.released(), 0);
  assert.equal(h.pending().length, 1, "re-armed");
  state.busy = false;
  h.fire();
  assert.equal(h.released(), 1);
});

test("arming twice keeps one timer", () => {
  const h = harness({ hidden: true, busy: false });
  h.release.arm();
  h.release.arm();
  assert.equal(h.pending().length, 1);
});

test("main arms the release on hide, cancels it on show and when the window closes", () => {
  const main = readFileSync(
    new URL("../electron/main.ts", import.meta.url),
    "utf8",
  );
  assert.match(main, /window\.on\("hide", \(\) => windowRelease\.arm\(\)\);/);
  assert.match(main, /window\.on\("show", \(\) => windowRelease\.cancel\(\)\);/);
  assert.match(
    main,
    /window\.on\("closed", \(\) => \{\s*windowRelease\.cancel\(\);\s*window = null;/,
  );
  // A sign-in or a Desktop operation keeps the window; release destroys it.
  const block = main.slice(
    main.indexOf("const windowRelease = new WindowRelease("),
    main.indexOf("});", main.indexOf("const windowRelease = new WindowRelease(")),
  );
  assert.match(block, /desktop\.isBusy/);
  assert.match(block, /desktopLock\.busy/);
  assert.match(block, /pendingProfileId/);
  assert.match(block, /service\.auth/);
  assert.match(block, /release: \(\) => window\?\.destroy\(\)/);
});
