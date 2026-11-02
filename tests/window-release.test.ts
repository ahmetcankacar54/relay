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

test("only closing to the menu bar arms the release; showing the window clears it", () => {
  const main = readFileSync(
    new URL("../electron/main.ts", import.meta.url),
    "utf8",
  );
  // Cmd+H, minimize and occlusion also emit "hide" on macOS, so no hide listener arms it.
  assert.doesNotMatch(main, /\.on\("hide", \(\) => windowRelease\.arm\(\)\)/);
  assert.match(
    main,
    /function closeWindowToTray\(\) \{\s*closedToTray = true;\s*windowRelease\.arm\(\);\s*\}/,
  );
  assert.match(main, /own\.hide\(\);\s*closeWindowToTray\(\);/);
  assert.match(main, /window\?\.hide\(\);\s*if \(window\) closeWindowToTray\(\);/);
  assert.match(
    main,
    /own\.on\("show", \(\) => \{\s*closedToTray = false;\s*windowRelease\.cancel\(\);\s*\}\);/,
  );
  assert.match(
    main,
    /own\.on\("closed", \(\) => \{\s*if \(window !== own\) return;\s*windowRelease\.cancel\(\);\s*window = null;/,
  );
  const block = main.slice(
    main.indexOf("const windowRelease = new WindowRelease("),
    main.indexOf("\n});", main.indexOf("const windowRelease = new WindowRelease(")),
  );
  // Released only while closed to the menu bar, not minimized, and not busy.
  assert.match(block, /closedToTray &&/);
  assert.match(block, /!window\.isMinimized\(\)/);
  assert.match(block, /desktop\.isBusy/);
  assert.match(block, /desktopLock\.busy/);
  assert.match(block, /pendingProfileId/);
  assert.match(block, /service\.auth/);
  // The variable is cleared before the window is destroyed.
  assert.match(block, /const released = window;\s*window = null;\s*released\?\.destroy\(\);/);
});

test("a page opened from the panel on a freed window loads on that page", () => {
  const main = readFileSync(
    new URL("../electron/main.ts", import.meta.url),
    "utf8",
  );
  const start = main.indexOf('handle("open-page",');
  const handler = main.slice(start, main.indexOf('handle("quit"', start));
  assert.match(handler, /const fresh = !window;\s*showWindow\(intentHash\(target, want\)\);/);
  assert.match(handler, /if \(contents && !fresh\) \{/);
  assert.match(main, /function showWindow\(hash\?: string\) \{[\s\S]*?createWindow\(hash\);/);
  assert.match(main, /loadPage\(window, "index\.html", hash\);/);
  assert.match(main, /hash \? \{ hash: hash\.replace\(\/\^#\/, ""\) \} : undefined/);
});
