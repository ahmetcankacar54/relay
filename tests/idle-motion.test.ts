import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { PandaRig } from "../src/components/Panda";
import { setMotionPaused } from "../src/lib/motion";
import { OCCASIONAL, restMs, runIdleMotion } from "../src/mascot/idle-motion";
import { MOTION_PARTS, type PandaMotion } from "../src/mascot/scenes";
import { mediaBlock } from "./css";
import { fakeDom } from "./fake-dom";

const css = mediaBlock(
  readFileSync("src/styles/panda.css", "utf8"),
  "(prefers-reduced-motion: no-preference)",
);
const occasional = Object.keys(OCCASIONAL) as PandaMotion[];
const seconds = (text: string) => Number(text.replace("s", "")) * 1000;

test("an idle motion plays as long as its clock gives it, ends at rest and never loops", () => {
  for (const name of occasional) {
    const part = MOTION_PARTS[name][0];
    const rule = new RegExp(
      `\\.panda\\[data-motion~="${name}"\\] \\[data-part="${part}"\\] \\{\\s*animation: ([\\w-]+) ([\\d.]+s)(?: [\\w-]+)? (\\d+);`,
    ).exec(css);
    assert.ok(rule, `${name} has a finite rule`);
    const [, keyframes, duration, count] = rule;
    assert.equal(
      seconds(duration) * Number(count),
      OCCASIONAL[name]!.ms,
      `${name} plays for its clock's ms`,
    );
    // From rest and back to it: a play that ends leaves the part where the rest holds it.
    const frames = new RegExp(
      `@keyframes ${keyframes} \\{([\\s\\S]*?)\\n\\}`,
    ).exec(readFileSync("src/styles/panda.css", "utf8"))![1];
    assert.match(
      frames,
      /0%, (?:[\d.]+%, )*100% \{ transform: (?:scaleY\(1\)|rotate\(0deg\)); \}/,
      `${keyframes} starts and ends at rest`,
    );
    assert.match(
      css,
      new RegExp(
        `\\.panda\\[data-resting~="${name}"\\] \\[data-part="${part}"\\]`,
      ),
      `${name} rests still`,
    );
  }
  // Only the prank and switch scenes' motions loop, while their scene lasts.
  const loops = [
    ...css.matchAll(/data-motion~="(\w+)"[^{]*\{[^}]*\binfinite\b/g),
  ].map((m) => m[1]);
  assert.deepEqual([...new Set(loops)].sort(), ["breathe", "chew", "walk"]);
});

test("the blink comes on its own; the other motions play together, each resting when its play ends", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    const changes: string[] = [];
    const tick = (ms: number) => mock.timers.tick(ms);
    const stop = runIdleMotion(
      ["wave", "blink", "tail", "walk"],
      new Set(),
      (name, rests) =>
        changes.push(`${Date.now()} ${name} ${rests ? "rests" : "plays"}`),
      () => 0,
    );
    tick(OCCASIONAL.wave!.ms);
    tick(OCCASIONAL.tail!.ms - OCCASIONAL.wave!.ms);
    // The routine: the waves end first, the tail with the longest play.
    assert.deepEqual(
      changes.filter((c) => !c.includes("blink")),
      [
        `${OCCASIONAL.wave!.ms} wave rests`,
        `${OCCASIONAL.tail!.ms} tail rests`,
      ],
    );
    // The blink: its play, then a rest, then its play again.
    const blinks: boolean[] = [];
    const stopBlink = runIdleMotion(
      ["blink"],
      new Set(),
      (_name, rests) => blinks.push(rests),
      () => 0,
    );
    tick(OCCASIONAL.blink!.ms);
    assert.deepEqual(blinks, [true]);
    tick(restMs("blink", 0) - 1);
    assert.deepEqual(blinks, [true]);
    tick(1);
    assert.deepEqual(blinks, [true, false]);
    stopBlink();
    // After the routine's rest both play again, at the same moment.
    changes.length = 0;
    // So far: the routine's play and the blink's play and rest.
    tick(restMs("wave", 0) - OCCASIONAL.blink!.ms - restMs("blink", 0) - 1);
    assert.deepEqual(
      changes.filter((c) => !c.includes("blink")),
      [],
    );
    tick(1);
    assert.deepEqual(
      changes
        .filter((c) => !c.includes("blink"))
        .map((c) => c.split(" ").slice(1).join(" ")),
      ["wave plays", "tail plays"],
    );
    // A motion that already rests waits first.
    const later: string[] = [];
    const stopLater = runIdleMotion(
      ["tail"],
      new Set(["tail"]),
      (name, rests) => later.push(`${name} ${rests}`),
      () => 0.5,
    );
    tick(restMs("tail", 0.5) - 1);
    assert.deepEqual(later, []);
    tick(1);
    assert.deepEqual(later, ["tail false"]);
    stop();
    stopLater();
    const count = changes.length;
    tick(600_000);
    assert.equal(changes.length, count);
    assert.equal(later.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test("the rests are uneven and long: the parts move for well under a tenth of the time", () => {
  assert.equal(restMs("blink", 0), 8_000);
  assert.equal(restMs("blink", 0.999), 13_994);
  assert.equal(restMs("tail", 0), 90_000);
  assert.equal(restMs("walk", 0.5), 0);
  const blink =
    OCCASIONAL.blink!.ms / (OCCASIONAL.blink!.ms + restMs("blink", 0.5));
  const longest = Math.max(
    ...occasional
      .filter((name) => name !== "blink")
      .map((name) => OCCASIONAL[name]!.ms),
  );
  const routine = longest / (longest + restMs("tail", 0.5));
  assert.ok(blink + routine < 0.1, `${blink + routine}`);
});

interface FakeNode {
  attributes: Map<string, string>;
  childNodes: FakeNode[];
}
const svgOf = (node: FakeNode): FakeNode | undefined =>
  node.attributes?.has("data-motion")
    ? node
    : node.childNodes.map(svgOf).find(Boolean);

async function mountRig(
  reducedMotion: boolean,
  run: (
    resting: () => string | undefined,
    tick: (ms: number) => Promise<void>,
  ) => Promise<void>,
) {
  const dom = fakeDom({ reducedMotion });
  dom.install();
  mock.timers.enable({ apis: ["setTimeout"] });
  const random = mock.method(Math, "random", () => 0);
  try {
    // Loaded after the stubs, so react-dom sees a DOM (as tests/panda.test.ts does).
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () =>
      root.render(
        createElement(PandaRig, {
          pose: "sit",
          size: 72,
          motion: ["wave", "blink", "tail"],
          rig: { sit: "<g/>" },
        }),
      ),
    );
    await run(
      () =>
        svgOf(dom.container as unknown as FakeNode)?.attributes.get(
          "data-resting",
        ),
      (ms) => act(async () => void mock.timers.tick(ms)),
    );
    await act(async () => root.unmount());
  } finally {
    random.mock.restore();
    mock.timers.reset();
    setMotionPaused(false, { toggleAttribute() {} } as unknown as Element);
    dom.uninstall();
  }
}

test("a drawn panda names its resting motions, and its clock stops while the window is not seen", async () => {
  await mountRig(false, async (resting, tick) => {
    assert.equal(
      resting(),
      undefined,
      "everything plays when the panda appears",
    );
    await tick(OCCASIONAL.blink!.ms);
    assert.equal(resting(), "blink");
    await tick(OCCASIONAL.wave!.ms - OCCASIONAL.blink!.ms);
    assert.equal(
      resting(),
      "wave blink",
      "the waves are done and the blink waits for its next",
    );
    // Hidden or behind another app: nothing changes however long it waits.
    await act(async () =>
      setMotionPaused(true, { toggleAttribute() {} } as unknown as Element),
    );
    const held = resting();
    await tick(300_000);
    assert.equal(resting(), held);
    // Seen again: the clock goes on.
    await act(async () =>
      setMotionPaused(false, { toggleAttribute() {} } as unknown as Element),
    );
    await tick(OCCASIONAL.tail!.ms);
    assert.match(resting() ?? "", /tail/);
  });
});

test("with Reduce motion a panda runs no clock", async () => {
  await mountRig(true, async (resting, tick) => {
    await tick(300_000);
    assert.equal(resting(), undefined);
  });
});
