import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { StrictMode, act, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Panda, PandaRig, pandaClick } from "../src/components/Panda";
import { MOTION_PARTS, PANDA_SCENES, type PandaMotion } from "../src/mascot/scenes";
import { PrankStage, type PrankApi } from "../src/pranks/PrankStage";
import { TRICK_MS, TRICK_RESET_MS, trickFor, type Trick } from "../src/pranks/tricks";
import { PANDA_EXPRESSIONS, POSE_PARTS, POSE_PROPS, RIG_ID_TOKEN } from "../shared/panda-poses";
import { mediaBlock } from "./css";
import { fakeDom } from "./fake-dom";

const css = readFileSync("src/styles/panda.css", "utf8");

test("a scene draws its pose inline with its expression, props and motion", () => {
  const html = renderToStaticMarkup(createElement(Panda, { scene: "welcome", size: 120 }));
  assert.match(html, /^<svg /);
  for (const attribute of [
    'aria-hidden="true"', 'focusable="false"', 'data-scene="welcome"', 'data-pose="sit"',
    'data-expression="happy"', 'data-props="bamboo"', 'data-motion="wave blink tail"',
    'width="120"', 'height="120"', 'viewBox="0 0 512 512"',
  ])
    assert.ok(html.includes(attribute), attribute);
  assert.match(html, /class="panda/);
  assert.match(html, /data-part="arm-left"/);
});

test("two pandas of one pose on a page keep their own ids and clip paths", () => {
  const html = renderToStaticMarkup(
    createElement("div", null, createElement(PandaRig, { pose: "sit", size: 72 }), createElement(PandaRig, { pose: "sit", size: 72 })),
  );
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 2);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!html.includes(RIG_ID_TOKEN));
  for (const svg of html.split("<svg").slice(1)) {
    const own = new Set([...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const [, ref] of svg.matchAll(/url\(#([^)]+)\)/g)) assert.ok(own.has(ref), ref);
  }
});

test("a missing pose leaves an empty box of the same size", () => {
  const html = renderToStaticMarkup(createElement(PandaRig, { pose: "sit", size: 72, rig: {} }));
  assert.equal(html, '<span aria-hidden="true" class="inline-block shrink-0" style="width:72px;height:72px"></span>');
});

test("scenes only use props and parts their pose has", () => {
  for (const [name, spec] of Object.entries(PANDA_SCENES)) {
    for (const prop of spec.props) assert.ok((POSE_PROPS[spec.pose] as readonly string[]).includes(prop), `${name}: ${prop}`);
    for (const motion of spec.motion)
      for (const part of MOTION_PARTS[motion as PandaMotion]) assert.ok(POSE_PARTS[spec.pose].includes(part), `${name}: ${motion} needs ${part}`);
  }
});

test("panda.css shows exactly the expression and props the root names", () => {
  for (const expression of PANDA_EXPRESSIONS)
    assert.ok(css.includes(`.panda[data-expression="${expression}"] [data-expression="${expression}"]`), expression);
  const props = new Set(Object.values(POSE_PROPS).flat());
  for (const prop of props) assert.ok(css.includes(`.panda[data-props~="${prop}"] [data-prop="${prop}"]`), prop);
  assert.match(css, /\.panda \[data-expression\],\s*\.panda \[data-prop\] \{\s*display: none;/);
});

test("every panda motion plays only without Reduce motion and moves the parts it names", () => {
  const motion = mediaBlock(css, "(prefers-reduced-motion: no-preference)");
  assert.ok(motion.length > 0);
  assert.doesNotMatch(css.replace(motion, ""), /animation\s*:/);
  for (const [name, parts] of Object.entries(MOTION_PARTS))
    for (const part of parts) assert.ok(motion.includes(`.panda[data-motion~="${name}"] [data-part="${part}"]`), `${name} → ${part}`);
});

test("the prank motions move what they name: chew the head and the held item, breathe the body", () => {
  assert.deepEqual(MOTION_PARTS.chew, ["head", "held"]);
  assert.deepEqual(MOTION_PARTS.breathe, ["body"]);
  for (const part of MOTION_PARTS.chew) assert.ok(POSE_PARTS.chew.includes(part), `chew pose has ${part}`);
  for (const part of MOTION_PARTS.breathe) assert.ok(POSE_PARTS.curl.includes(part), `curl pose has ${part}`);
  for (const name of ["panda-chew", "panda-gnaw", "panda-breathe"]) assert.match(css, new RegExp(`@keyframes ${name}\\s*\\{`), name);
});

// --- click tricks (a playful panda) -------------------------------------------

const stripBlockComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "");

test("a playful panda sits in a clipping box of its own size; without playful the markup is exactly the plain rig", () => {
  const rig = renderToStaticMarkup(createElement(PandaRig, { ...PANDA_SCENES.welcome, scene: "welcome", size: 120 }));
  assert.equal(renderToStaticMarkup(createElement(Panda, { scene: "welcome", size: 120 })), rig);
  assert.equal(renderToStaticMarkup(createElement(Panda, { scene: "welcome", size: 120, playful: false })), rig);
  const html = renderToStaticMarkup(createElement(Panda, { scene: "welcome", size: 120, playful: true }));
  assert.equal(
    html,
    `<span data-playful="true" class="inline-block shrink-0 overflow-hidden" style="width:120px;height:120px">${rig}</span>`,
  );
  // The wrapper takes the size it is given, whatever it is.
  assert.match(
    renderToStaticMarkup(createElement(Panda, { scene: "lookout", size: 40, playful: true })),
    /^<span data-playful="true" class="inline-block shrink-0 overflow-hidden" style="width:40px;height:40px"><svg /,
  );
  // At rest there is no trick.
  assert.doesNotMatch(html, /data-trick/);
});

test("a playful panda stays decorative: hidden from assistive tech, never focusable, mouse only", () => {
  const html = renderToStaticMarkup(createElement(Panda, { scene: "welcome", size: 120, playful: true }));
  assert.match(html, /<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
  assert.doesNotMatch(html, /tabindex|role=|onkeydown|onkeyup|onkeypress/i);
  const code = stripBlockComments(readFileSync("src/components/Panda.tsx", "utf8")).replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\b(tabIndex|role|onKeyDown|onKeyUp|onKeyPress)\b/);
});

test("the rig carries the trick that is playing as data-trick, and nothing when there is none", () => {
  const html = renderToStaticMarkup(createElement(PandaRig, { pose: "sit", size: 72, trick: "grumpy" }));
  assert.match(html, /^<svg [^>]*data-trick="grumpy"/);
  for (const trick of ["swish", "wave", "happy", "grumpy", "hide", "rawr"] as const)
    assert.match(renderToStaticMarkup(createElement(PandaRig, { pose: "sit", size: 72, trick })), new RegExp(`data-trick="${trick}"`), trick);
  assert.doesNotMatch(renderToStaticMarkup(createElement(PandaRig, { pose: "sit", size: 72 })), /data-trick/);
});

test("panda.css plays each trick for 1.2 s, and only without Reduce motion", () => {
  assert.equal(TRICK_MS, 1_200);
  const block = mediaBlock(css, "(prefers-reduced-motion: no-preference)");
  // Comments are stripped before looking, so one cannot satisfy a guard.
  const motion = stripBlockComments(block);
  const outside = stripBlockComments(css.replace(block, ""));
  for (const trick of ["swish", "wave", "grumpy", "hide", "rawr"]) {
    assert.ok(motion.includes(`.panda[data-trick="${trick}"]`), `${trick} is inside the no-preference block`);
    assert.ok(!outside.includes(`data-trick="${trick}"`), `${trick} is not outside it`);
  }
  // Happy only changes the expression: the CSS has nothing to move.
  assert.ok(!stripBlockComments(css).includes('data-trick="happy"'));
  const rule = (trick: string) => new RegExp(`\\.panda\\[data-trick="${trick}"\\][^{]*\\{([^}]*)\\}`).exec(motion)?.[1] ?? "";
  // 8 swishes of 0.15 s; the wave's 2.4 s start 1.2 s in, so its idle first half is skipped and it waves at once; one turn of 1.2 s for the rest.
  assert.match(rule("swish"), /animation:\s*panda-tail 0\.15s ease-in-out 8 alternate;/);
  assert.match(rule("wave"), /animation:\s*panda-wave 2\.4s ease-in-out -1\.2s 1;/);
  assert.match(rule("grumpy"), /animation:\s*panda-grumpy 1\.2s ease-in-out 1;/);
  assert.match(rule("hide"), /animation:\s*panda-hide 1\.2s ease-in-out 1;/);
  assert.match(rule("rawr"), /animation:\s*panda-rawr 1\.2s ease-out 1;/);
  assert.equal(Math.round(0.15 * 8 * 1_000), TRICK_MS);
  assert.equal(Math.round((2.4 - 1.2) * 1_000), TRICK_MS);
  // The swish moves the tail and the wave the arm, as their motions do; the others turn the whole puppet.
  assert.match(motion, /\.panda\[data-trick="swish"\] \[data-part="tail"\]/);
  assert.match(motion, /\.panda\[data-trick="wave"\] \[data-part="arm-left"\]/);
  for (const trick of ["grumpy", "hide", "rawr"]) assert.match(motion, new RegExp(`\\.panda\\[data-trick="${trick}"\\] \\{`), trick);
  const keyframes = (name: string) => new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(stripBlockComments(css))?.[1] ?? "";
  assert.match(keyframes("panda-grumpy"), /scaleX\(-1\)/);
  assert.match(keyframes("panda-hide"), /translateY\(78%\)/);
  assert.match(keyframes("panda-rawr"), /translateY\(-\d+(\.\d+)?%\)/);
  // A trick rule beats the plain motion it replaces on the same part: same specificity, later in the block.
  assert.ok(motion.indexOf('.panda[data-trick="swish"]') > motion.indexOf('.panda[data-motion~="tail"]'));
  assert.ok(motion.indexOf('.panda[data-trick="wave"]') > motion.indexOf('.panda[data-motion~="wave"]'));
  // Every scene that plays tricks has the tail and the arm the swish and the wave move.
  for (const scene of ["welcome", "lookout", "collecting", "trouble"] as const) {
    assert.ok(POSE_PARTS[PANDA_SCENES[scene].pose].includes("tail"), `${scene} has a tail`);
    assert.ok(POSE_PARTS[PANDA_SCENES[scene].pose].includes("arm-left"), `${scene} has a left arm`);
  }
});

// pandaClick: the pure contract (no stage, no clock, no dice).

const allow: Pick<PrankApi, "allowsTrick"> = { allowsTrick: () => true };
const refuse: Pick<PrankApi, "allowsTrick"> = { allowsTrick: () => false };

test("pandaClick counts a click and picks the trick for its count, from the injected dice", () => {
  let state: ReturnType<typeof pandaClick>["state"];
  const seen: (Trick | undefined)[] = [];
  for (let click = 1; click <= 11; click++) {
    // 0, 0.4, 0.9 pick the first, second and third of the three random tricks.
    const random = () => [0, 0.4, 0.9][(click - 1) % 3];
    const result = pandaClick(state, { detail: 1 }, allow, 1_000 * click, random);
    assert.deepEqual(result.state, { count: click === 11 ? 1 : click, at: 1_000 * click }, `click ${click}`);
    state = result.state;
    seen.push(result.trick);
  }
  // Clicks 1-3 are the random ones, 4-6 grumpy, 7-9 hide, the 10th rawr, and the 11th starts the count again.
  assert.deepEqual(seen, ["swish", "wave", "happy", "grumpy", "grumpy", "grumpy", "hide", "hide", "hide", "rawr", "wave"]);
  // The 10th click earns rawr whatever the dice say.
  assert.equal(trickFor(10, () => 0.5), "rawr");
});

test("pandaClick starts the count again after 30 s without a click", () => {
  const first = pandaClick(undefined, { detail: 1 }, allow, 0, () => 0);
  const second = pandaClick(first.state, { detail: 1 }, allow, TRICK_RESET_MS - 1, () => 0);
  assert.equal(second.state?.count, 2);
  const later = pandaClick(second.state, { detail: 1 }, allow, TRICK_RESET_MS - 1 + TRICK_RESET_MS, () => 0.4);
  assert.deepEqual(later.state, { count: 1, at: TRICK_RESET_MS - 1 + TRICK_RESET_MS });
  assert.equal(later.trick, "wave");
});

test("pandaClick refuses a keyboard click and a gated one: no trick, and the count and its clock are left alone", () => {
  const state = { count: 3, at: 5_000 };
  const random = () => assert.fail("a refused click rolls no dice");
  for (const [name, api, detail] of [
    ["detail 0", allow, 0],
    ["detail 0, gated", refuse, 0],
    ["gated", refuse, 1],
  ] as const) {
    const result = pandaClick(state, { detail }, api, 9_000, random);
    assert.equal(result.trick, undefined, name);
    assert.equal(result.state, state, `${name}: the very same count`);
    assert.deepEqual(state, { count: 3, at: 5_000 }, name);
  }
  assert.equal(pandaClick(undefined, { detail: 0 }, allow, 1, random).state, undefined);
  assert.equal(pandaClick(undefined, { detail: 1 }, refuse, 1, random).state, undefined);
  // The gate is asked about the click itself, so it can read `detail`.
  const asked: unknown[] = [];
  pandaClick(undefined, { detail: 2 }, { allowsTrick: (event) => (asked.push(event), true) }, 1, () => 0);
  assert.deepEqual(asked, [{ detail: 2 }]);
});

// A playful panda, mounted: a click plays a trick for 1.2 s.

interface FakeNode {
  tagName: string;
  attributes: Map<string, string>;
  childNodes: FakeNode[];
}
const nodes = (node: FakeNode, found: FakeNode[] = []): FakeNode[] => {
  found.push(node);
  for (const child of node.childNodes) nodes(child, found);
  return found;
};

/** Wraps the global timers (the mocked ones) to see which timers of one length are armed: set, and not yet cleared or fired. */
function trackTimers(length: number) {
  const armed = new Set<unknown>();
  const { setTimeout: set, clearTimeout: clear } = globalThis;
  globalThis.setTimeout = ((callback: () => void, ms?: number, ...rest: unknown[]) => {
    const handle = set(
      () => {
        armed.delete(handle);
        callback();
      },
      ms,
      ...rest,
    );
    if (ms === length) armed.add(handle);
    return handle;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle: Parameters<typeof clear>[0]) => {
    armed.delete(handle);
    clear(handle);
  }) as typeof clearTimeout;
  return {
    armed,
    restore() {
      globalThis.setTimeout = set;
      globalThis.clearTimeout = clear;
    },
  };
}

const stage = (children: ReactElement, props: Partial<Parameters<typeof PrankStage>[0]> = {}) =>
  createElement(PrankStage, { level: "sometimes", desktopBusy: false, errorShown: false, dialogOpen: false, children, ...props });

/** What a mounted panda lets a test do: click it, move the clocks, read its rig. */
interface Mounted {
  click(detail?: number): Promise<void>;
  /** Moves the fake clock and the mocked timers on together. */
  advance(ms: number): Promise<void>;
  /** Moves only the fake clock. */
  pause(ms: number): void;
  /** What Math.random answers from now on. */
  roll(value: number): void;
  /** What the rig says now. */
  rig(): { trick?: string; expression?: string; pose?: string; motion?: string; props?: string };
  /** The playful wrapper, when there is one. */
  box(): FakeNode | undefined;
  /** The 1.2 s clear timers that are armed. */
  timers: ReturnType<typeof trackTimers>;
  unmount(): Promise<void>;
}

/** Mounts `element` in a fake browser with a fake clock, fake dice and mocked timers. */
async function mounted(element: ReactElement, run: (env: Mounted) => Promise<void>, options: { reducedMotion?: boolean } = {}) {
  const dom = fakeDom({ reducedMotion: options.reducedMotion });
  dom.install();
  mock.timers.enable({ apis: ["setTimeout"] });
  const timers = trackTimers(TRICK_MS);
  let clock = 100_000;
  let dice = 0.99;
  let now: ReturnType<typeof mock.method> | undefined;
  let random: ReturnType<typeof mock.method> | undefined;
  try {
    // Loaded after the stubs, so react-dom sees a DOM.
    const { createRoot } = await import("react-dom/client");
    now = mock.method(Date, "now", () => clock);
    random = mock.method(Math, "random", () => dice);
    const root = createRoot(dom.container as unknown as Element);
    let live = true;
    await act(async () => root.render(element));
    const all = () => nodes(dom.container as unknown as FakeNode);
    const box = () => all().find((n) => n.attributes.has("data-playful"));
    await run({
      click: (detail = 1) => act(async () => dom.dispatch(box()!, "click", { clientX: 4, clientY: 5, detail })),
      advance: (ms) =>
        act(async () => {
          clock += ms;
          mock.timers.tick(ms);
        }),
      pause: (ms) => void (clock += ms),
      roll: (value) => void (dice = value),
      rig: () => {
        const attributes = all().find((n) => n.attributes.has("data-pose"))?.attributes;
        return {
          trick: attributes?.get("data-trick"),
          expression: attributes?.get("data-expression"),
          pose: attributes?.get("data-pose"),
          motion: attributes?.get("data-motion"),
          props: attributes?.get("data-props"),
        };
      },
      box,
      timers,
      unmount: async () => {
        live = false;
        await act(async () => root.unmount());
      },
    });
    if (live) await act(async () => root.unmount());
    assert.equal(timers.armed.size, 0, "no trick timer is left armed after the unmount");
  } finally {
    timers.restore();
    mock.timers.reset();
    now?.mock.restore();
    random?.mock.restore();
    dom.uninstall();
  }
}

const playfulLookout = createElement(Panda, { scene: "lookout", size: 72, playful: true });

test("a click on a playful panda in a stage plays a trick for 1.2 s, then the panda is as it was", async () => {
  await mounted(stage(playfulLookout), async (env) => {
    assert.deepEqual(env.rig(), { trick: undefined, expression: "open", pose: "sit", motion: "look blink tail", props: "" });
    await env.click();
    // Click 1 with the dice at 0.99 is a happy panda.
    assert.deepEqual(env.rig(), { trick: "happy", expression: "happy", pose: "sit", motion: "look blink tail", props: "" });
    assert.equal(env.timers.armed.size, 1);
    await env.advance(TRICK_MS - 1);
    assert.equal(env.rig().trick, "happy");
    await env.advance(1);
    assert.deepEqual(env.rig(), { trick: undefined, expression: "open", pose: "sit", motion: "look blink tail", props: "" });
    assert.equal(env.timers.armed.size, 0);
  });
});

test("a click while a trick plays still counts, replaces the trick and restarts the 1.2 s clock", async () => {
  await mounted(stage(playfulLookout), async (env) => {
    await env.click();
    assert.equal(env.rig().trick, "happy");
    await env.advance(1_000);
    await env.click();
    await env.click();
    assert.equal(env.rig().trick, "happy", "clicks 2 and 3");
    assert.equal(env.timers.armed.size, 1, "one clear timer, not one per click");
    await env.advance(1_000);
    // 2 s after the first click, 1 s after the last: the first click's timer would be long gone.
    assert.equal(env.rig().trick, "happy");
    await env.click();
    // The 4th click is grumpy: it replaced the happy panda that was playing.
    assert.deepEqual(env.rig(), { trick: "grumpy", expression: "worried", pose: "sit", motion: "look blink tail", props: "" });
    await env.advance(TRICK_MS - 1);
    assert.equal(env.rig().trick, "grumpy");
    await env.advance(1);
    assert.equal(env.rig().trick, undefined);
    assert.equal(env.rig().expression, "open");
  });
});

test("ten clicks run the whole sequence, and the 10th is rawr: the stand pose, wide eyes, nothing in hand", async () => {
  await mounted(stage(createElement(Panda, { scene: "welcome", size: 120, playful: true })), async (env) => {
    const seen: (string | undefined)[] = [];
    for (let click = 1; click <= 10; click++) {
      env.roll(click === 2 ? 0 : 0.99);
      await env.click();
      seen.push(env.rig().trick);
    }
    assert.deepEqual(seen, ["happy", "swish", "happy", "grumpy", "grumpy", "grumpy", "hide", "hide", "hide", "rawr"]);
    assert.deepEqual(env.rig(), { trick: "rawr", expression: "wide", pose: "stand", motion: "wave blink tail", props: "" });
    await env.advance(TRICK_MS);
    assert.equal(env.rig().pose, "sit");
    // The 11th click starts the count again.
    await env.click();
    assert.equal(env.rig().trick, "happy");
  });
});

test("the count starts again after 30 s without a click", async () => {
  await mounted(stage(playfulLookout), async (env) => {
    for (let click = 0; click < 3; click++) await env.click();
    env.pause(TRICK_RESET_MS);
    await env.advance(TRICK_MS);
    await env.click();
    // Without the pause this would be the 4th click, a grumpy one.
    assert.equal(env.rig().trick, "happy");
  });
});

test("a keyboard click plays no trick and does not count", async () => {
  await mounted(stage(playfulLookout), async (env) => {
    await env.click(0);
    assert.equal(env.rig().trick, undefined);
    assert.equal(env.timers.armed.size, 0);
    for (let click = 0; click < 3; click++) {
      await env.click();
      await env.click(0);
    }
    // Three mouse clicks counted and the keyboard ones in between did not: the next mouse click is the 4th.
    await env.click();
    assert.equal(env.rig().trick, "grumpy");
  });
});

test("the stage's gates stop the tricks: pranks off, an error shown, Desktop busy, a dialog open, Reduce motion", async () => {
  for (const [name, props, options] of [
    ["off", { level: "off" as const }, {}],
    ["error", { errorShown: true }, {}],
    ["desktop busy", { desktopBusy: true }, {}],
    ["dialog", { dialogOpen: true }, {}],
    ["reduce motion", {}, { reducedMotion: true }],
  ] as const) {
    await mounted(
      stage(playfulLookout, props),
      async (env) => {
        await env.click();
        assert.equal(env.rig().trick, undefined, name);
        assert.equal(env.timers.armed.size, 0, name);
      },
      options,
    );
  }
  // The same panda with nothing in the way does play.
  await mounted(stage(playfulLookout), async (env) => {
    await env.click();
    assert.equal(env.rig().trick, "happy");
  });
});

test("outside a stage nothing is allowed, so a click plays no trick", async () => {
  await mounted(playfulLookout, async (env) => {
    await env.click();
    assert.equal(env.rig().trick, undefined);
    assert.equal(env.timers.armed.size, 0);
  });
});

test("a panda that is not playful has no click and no wrapper", async () => {
  await mounted(stage(createElement(Panda, { scene: "lookout", size: 72 })), async (env) => {
    assert.equal(env.box(), undefined);
    assert.equal(env.rig().pose, "sit");
  });
});

test("unmounting mid-trick clears the 1.2 s timer, and StrictMode's extra mount leaves a working panda", async () => {
  await mounted(stage(playfulLookout), async (env) => {
    await env.click();
    assert.equal(env.rig().trick, "happy");
    assert.equal(env.timers.armed.size, 1);
    await env.unmount();
    assert.equal(env.timers.armed.size, 0);
    // Whatever the clock does now, nothing is left to fire.
    await env.advance(TRICK_MS * 2);
  });
  await mounted(createElement(StrictMode, null, stage(playfulLookout)), async (env) => {
    await env.click();
    assert.equal(env.rig().trick, "happy");
    assert.equal(env.timers.armed.size, 1);
    await env.advance(TRICK_MS);
    assert.equal(env.rig().trick, undefined);
  });
});
