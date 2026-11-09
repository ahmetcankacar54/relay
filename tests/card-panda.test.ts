import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, createElement, useState, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CardPanda, useCardPanda, type CardPandaInput, type CardPhase } from "../src/app/CardPanda";
import { Sidebar } from "../src/app/Sidebar";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { MascotGallery } from "../src/dev/MascotGallery";
import { setMotionPaused } from "../src/lib/motion";
import {
  AMBIENT_MAX_MS,
  ARRIVING_HOLD_MS,
  CARD_LEDGE,
  CARD_LOOKS,
  CARD_CENTER_FROM_RIGHT,
  CARD_SIZE,
  DUCK_MS,
  HOLD_MS,
  LEAVE_MS,
  LEAVING_LOOK,
  OPEN_MS,
  PHASE_MS,
  REACTIONS,
  RISE_MS,
  SHUT_MS,
  cardPlacement,
  cardState,
  cardYields,
  react,
  reactionLook,
  restage,
  resume,
  settle,
  showing,
  sightReactions,
  stageEnd,
  type CardReaction,
  type CardStage,
  type ReactionContext,
} from "../src/mascot/card-panda";
import { PANDA_RIG } from "../src/mascot/panda-rig";
import { MOTION_PARTS } from "../src/mascot/scenes";
import { trickLook } from "../src/pranks/tricks";
import type { MascotPose } from "../shared/mascot";
import { MASCOT_FRAMES, type MascotFrame } from "../shared/mascot-frames";
import { POSE_PARTS, POSE_PROPS } from "../shared/panda-poses";
import { DEFAULT_SETTINGS, type Account, type AccountUsage, type DesktopState } from "../shared/types";
import { mediaBlock } from "./css";
import { fakeDom } from "./fake-dom";

const NOW = Date.parse("2026-10-20T09:00:00Z");
const fresh = new Date(NOW - 60_000).toISOString();
const account = (id: string): Account => ({ id, name: id, kind: "personal" }) as Account;
const usage = (five: number, week = 10): AccountUsage =>
  ({
    fiveHour: { usedPercent: five, resetsAt: new Date(NOW + 3_600_000).toISOString() },
    sevenDay: { usedPercent: week, resetsAt: new Date(NOW + 86_400_000).toISOString() },
    status: "ready",
    checkedAt: fresh,
  }) as AccountUsage;
const desktop = (patch: Partial<DesktopState> = {}): DesktopState =>
  ({ available: true, running: true, activeProfileId: "a", busy: false, recoveryRequired: false, errorRevision: 0, ...patch }) as DesktopState;

// The state: the menu bar's rule, read from what the window already has.

test("the card shows the menu bar's state, and a Desktop action this window started counts as busy", () => {
  const data = { accounts: [account("a"), account("b")], usage: { a: usage(40), b: usage(20) } };
  assert.equal(cardState(undefined, undefined, "", NOW), "idle", "nothing loaded yet");
  assert.equal(cardState(data, desktop(), "", NOW), "idle");
  assert.equal(cardState({ ...data, usage: { a: usage(94), b: usage(20) } }, desktop(), "", NOW), "hungry");
  assert.equal(cardState(data, desktop({ error: "quit failed" }), "", NOW), "alert");
  assert.equal(cardState(data, desktop({ busy: true }), "", NOW), "away");
  assert.equal(cardState(data, desktop(), "desktop-action:b", NOW), "away", "the switch this window asked for");
  assert.equal(cardState(data, desktop(), "cli:a", NOW), "idle", "a usage sign-in is no Desktop action");
  assert.equal(cardState({ ...data, usage: { a: usage(100), b: usage(30, 100) } }, desktop(), "", NOW), "full");
  assert.equal(cardState(data, desktop({ running: false }), "", NOW), "sleeping", "Claude is closed");
  const attempts = [{ at: new Date(NOW - 30_000).toISOString(), status: "started" }];
  assert.equal(cardState({ ...data, planning: { attempts } } as never, desktop(), "", NOW), "warming");
});

test("each state's look uses only the props and parts its pose has, and every pose drawn has a ledge", () => {
  const looks = [...Object.values(CARD_LOOKS), LEAVING_LOOK];
  for (const look of looks) {
    for (const prop of look.props) assert.ok((POSE_PROPS[look.pose] as readonly string[]).includes(prop), `${look.pose}: ${prop}`);
    for (const motion of look.motion)
      for (const part of MOTION_PARTS[motion]) assert.ok(POSE_PARTS[look.pose].includes(part), `${look.pose}: ${motion}`);
    assert.ok(CARD_LEDGE[look.pose] !== undefined, `${look.pose} has a ledge`);
  }
  // A trick's poses too: rawr stands.
  assert.ok(CARD_LEDGE[trickLook(CARD_LOOKS.idle, "rawr").pose] !== undefined);
  // Only blink loops: the card adds no other infinite motion.
  for (const look of looks) for (const motion of look.motion) assert.equal(motion, "blink");
  assert.deepEqual(
    Object.fromEntries(Object.entries(CARD_LOOKS).map(([state, look]) => [state, `${look.pose} ${look.expression} ${look.props.join(" ")}`.trim()])),
    { idle: "peek open", hungry: "peek worried", full: "peek wide", alert: "stand wide bang", sleeping: "curl closed z", warming: "chew open bamboo" },
  );
});

test("every pose sits at the same scale and place, its ledge line on the card's edge", () => {
  for (const pose of Object.keys(CARD_LEDGE) as (keyof typeof CARD_LEDGE)[]) {
    const place = cardPlacement(pose);
    assert.equal(place.size, CARD_SIZE);
    assert.equal(place.right + place.size / 2, CARD_CENTER_FROM_RIGHT, `${pose} is centred on one line from the card's right`);
    assert.equal(place.bottom, -((512 - CARD_LEDGE[pose]!) / 512) * CARD_SIZE, pose);
  }
  // The peek's ledge is its own: its head and paws show, its drawn ledge stays behind the card.
  assert.equal(CARD_LEDGE.peek, 400);
});

// The reaction queue.

const at = (state: MascotPose, now: number, patch: Partial<ReactionContext> = {}): ReactionContext => ({
  now,
  state,
  reducedMotion: false,
  paused: false,
  ...patch,
});

test("a reaction plays for its length and then the state's look is back", () => {
  for (const [kind, { ms }] of Object.entries(REACTIONS) as [CardReaction, { ms: number }][]) {
    const queue = react({}, kind, at("idle", 1_000));
    assert.equal(showing(queue, at("idle", 1_000)), kind);
    assert.equal(showing(queue, at("idle", 1_000 + ms - 1)), kind);
    assert.equal(showing(queue, at("idle", 1_000 + ms)), undefined, `${kind} ends after ${ms} ms`);
    assert.deepEqual(settle(queue, 1_000 + ms), { held: undefined });
    assert.equal(settle(queue, 1_000), queue, "a playing one is kept");
  }
  assert.equal(reactionLook(CARD_LOOKS.idle, "wave").expression, "happy", "the switch wave smiles");
  assert.equal(reactionLook(CARD_LOOKS.hungry, "nod"), CARD_LOOKS.hungry, "the others only move");
});

test("one at a time: equal or higher priority replaces and restarts the clock, lower is dropped", () => {
  const look = react({}, "look-up", at("idle", 0));
  const nod = react(look, "nod", at("idle", 500));
  assert.deepEqual(nod.playing, { kind: "nod", until: 500 + REACTIONS.nod.ms });
  assert.equal(react(nod, "look-down", at("idle", 600)), nod, "a lower one is dropped, nothing queues behind");
  assert.equal(react(nod, "glance", at("idle", 600)), nod);
  const again = react(nod, "check", at("idle", 700));
  assert.deepEqual(again.playing, { kind: "check", until: 700 + REACTIONS.check.ms }, "equal priority replaces");
  assert.equal(react(again, "wave", at("idle", 800)).playing?.kind, "wave");
  // Once the playing one is over, anything plays.
  assert.equal(react(nod, "glance", at("idle", 500 + REACTIONS.nod.ms)).playing?.kind, "glance");
});

test("Reduce motion and the states that do not react play nothing", () => {
  for (const kind of Object.keys(REACTIONS) as CardReaction[]) {
    assert.deepEqual(react({}, kind, at("idle", 0, { reducedMotion: true })), {}, `${kind} under Reduce motion`);
    for (const state of ["alert", "sleeping", "away"] as const) assert.deepEqual(react({}, kind, at(state, 0)), {}, `${kind} while ${state}`);
  }
  for (const state of ["idle", "hungry", "warming"] as const) assert.ok(react({}, "nod", at(state, 0)).playing, state);
  // One that plays stops showing when the state turns, or Reduce motion comes on.
  const playing = react({}, "nod", at("idle", 0));
  assert.equal(showing(playing, at("alert", 10)), undefined);
  assert.equal(showing(playing, at("idle", 10, { reducedMotion: true })), undefined);
});

test("in the background only the switch wave is kept, for up to 60 s", () => {
  for (const kind of ["check", "nod", "look-up", "glance", "chew"] as const)
    assert.deepEqual(react({}, kind, at("idle", 0, { paused: true })), {}, kind);
  const held = react({}, "wave", at("idle", 0, { paused: true }));
  assert.deepEqual(held, { held: { kind: "wave", expires: HOLD_MS } });
  assert.equal(showing(held, at("idle", 0)), undefined, "nothing shows while paused");
  // Back in view within the minute: it plays then, and is let go.
  const back = resume(held, at("idle", HOLD_MS - 1));
  assert.deepEqual(back, { playing: { kind: "wave", until: HOLD_MS - 1 + REACTIONS.wave.ms } });
  // Too late, or the panda is no longer in a state that reacts: it is let go unplayed.
  assert.deepEqual(resume(held, at("idle", HOLD_MS)), { playing: undefined });
  assert.deepEqual(resume(held, at("alert", 10)), { playing: undefined });
  assert.equal(resume({}, at("idle", 10)).playing, undefined);
});

test("while the panda rises, ducks or blinks, what is asked for waits for it; a higher priority wins the wait", () => {
  const chew = react({}, "chew", at("warming", 0, { arriving: true }));
  assert.deepEqual(chew, { held: { kind: "chew", expires: ARRIVING_HOLD_MS } }, "any reaction waits, not only the wave");
  assert.equal(showing(chew, at("warming", 0)), undefined);
  const wave = react(chew, "wave", at("idle", 10, { arriving: true }));
  assert.deepEqual(wave.held, { kind: "wave", expires: 10 + HOLD_MS }, "the switch wave waits as long as in the background");
  assert.equal(react(wave, "glance", at("idle", 20, { arriving: true })), wave, "a lower one does not push it out");
  assert.deepEqual(resume(wave, at("idle", 600)), { playing: { kind: "wave", until: 600 + REACTIONS.wave.ms } });
  assert.deepEqual(resume(chew, at("warming", ARRIVING_HOLD_MS)), { playing: undefined }, "stale, let go");
  assert.deepEqual(react({}, "nod", at("alert", 0, { arriving: true })), {}, "a state that does not react keeps nothing");
});

// The stage.

const stage = (phase: CardStage["phase"], shown: MascotPose = "idle"): CardStage => ({ phase, shown });

test("the stage: a walk off, a duck to step aside or into a new pose, a blink into a new face, a rise back", () => {
  assert.deepEqual(restage(stage("here"), "away", false, false), stage("leaving"), "Desktop busy: it walks off");
  assert.deepEqual(restage(stage("here"), "idle", true, false), stage("ducking"), "Overview: it ducks out");
  assert.deepEqual(restage(stage("here"), "alert", false, false), stage("ducking"), "another pose: it ducks first");
  assert.deepEqual(restage(stage("here"), "hungry", false, false), stage("shutting"), "another face: it blinks first");
  assert.deepEqual(restage(stage("here"), "idle", false, false), stage("here"));
  assert.deepEqual(restage(stage("gone"), "warming", false, false), stage("rising", "warming"));
  assert.deepEqual(restage(stage("leaving"), "idle", false, false), stage("rising"), "back before it was gone");
  for (const phase of ["rising", "ducking", "shutting", "opening"] as const)
    assert.deepEqual(restage(stage(phase), "alert", false, false), stage(phase), `a change waits for ${phase} to end`);
  // Each passing phase ends with the state of that moment.
  assert.deepEqual(stageEnd(stage("ducking"), "alert", false, false), stage("rising", "alert"));
  assert.deepEqual(stageEnd(stage("ducking"), "idle", true, false), stage("gone"));
  assert.deepEqual(stageEnd(stage("shutting"), "hungry", false, false), stage("opening", "hungry"));
  assert.deepEqual(stageEnd(stage("shutting"), "sleeping", false, false), stage("ducking"), "a new pose meanwhile: a duck");
  assert.deepEqual(stageEnd(stage("opening", "hungry"), "hungry", false, false), stage("here", "hungry"));
  assert.deepEqual(stageEnd(stage("rising"), "alert", false, false), stage("ducking"), "the change it waited for");
  assert.deepEqual(stageEnd(stage("rising"), "away", false, false), stage("leaving"));
  assert.deepEqual(stageEnd(stage("leaving"), "away", false, false), stage("gone"));
  // Reduce motion, or a window nobody sees: at once.
  assert.deepEqual(restage(stage("here"), "away", false, true), stage("gone"));
  assert.deepEqual(restage(stage("here"), "alert", false, true), stage("here", "alert"));
  assert.deepEqual(restage(stage("ducking"), "alert", false, true), stage("here", "alert"));
  assert.deepEqual(restage(stage("gone"), "idle", false, true), stage("here"));
  assert.deepEqual(PHASE_MS, { rising: RISE_MS, ducking: DUCK_MS, shutting: SHUT_MS, opening: OPEN_MS, leaving: LEAVE_MS });
});

test("what changes between two sights asks for the reactions", () => {
  const base = { busy: false, refreshing: false, state: "idle" as MascotPose };
  let { reactions, seen } = sightReactions({ refreshing: false }, { ...base, active: "a", settings: "{1}" });
  assert.deepEqual(reactions, [], "the first sight asks for nothing");
  // A switch: Desktop busy, then free with another account.
  ({ reactions, seen } = sightReactions(seen, { ...base, busy: true, state: "away", active: "b", settings: "{1}" }));
  assert.deepEqual(reactions, [], "nothing while Desktop is busy, even when the active account already reads as the new one");
  ({ reactions, seen } = sightReactions(seen, { ...base, active: "b", settings: "{1}" }));
  assert.deepEqual(reactions, ["wave"]);
  ({ reactions, seen } = sightReactions(seen, { ...base, active: "b", settings: "{1}" }));
  assert.deepEqual(reactions, []);
  // No active account in between is no switch.
  ({ reactions, seen } = sightReactions(seen, { ...base, settings: "{1}" }));
  ({ reactions, seen } = sightReactions(seen, { ...base, active: "b", settings: "{1}" }));
  assert.deepEqual(reactions, []);
  // A refresh this window ran.
  ({ reactions, seen } = sightReactions(seen, { ...base, active: "b", settings: "{1}", refreshing: true }));
  assert.deepEqual(reactions, []);
  ({ reactions, seen } = sightReactions(seen, { ...base, active: "b", settings: "{1}" }));
  assert.deepEqual(reactions, ["check"]);
  // A setting.
  ({ reactions, seen } = sightReactions(seen, { ...base, active: "b", settings: "{2}" }));
  assert.deepEqual(reactions, ["nod"]);
  ({ reactions, seen } = sightReactions(seen, { ...base, active: "b" }));
  assert.deepEqual(reactions, [], "settings not read yet are no change");
  // Warming starts.
  ({ reactions, seen } = sightReactions(seen, { ...base, active: "b", settings: "{2}", state: "warming" }));
  assert.deepEqual(reactions, ["chew"]);
  ({ reactions } = sightReactions(seen, { ...base, active: "b", settings: "{2}", state: "warming" }));
  assert.deepEqual(reactions, []);
});

test("on Overview the card panda steps aside while the Today card shows its lookout", () => {
  const linked = [{ ...account("a"), desktop: { email: "a@x" } } as Account];
  const planning = { ...DEFAULT_SETTINGS.planning, autoStart: true, accounts: [] };
  assert.equal(cardYields("genel", linked, planning), true);
  assert.equal(cardYields("kullanim", linked, planning), false, "only on Overview");
  assert.equal(cardYields("genel", linked, { ...planning, autoStart: false }), false);
  assert.equal(cardYields("genel", linked, { ...planning, accounts: [{ id: "a" }] } as never), false, "something is planned");
  assert.equal(cardYields("genel", [account("a")], planning), false, "no connected account: no Today card");
});

// Drawing.

const draw = (state: MascotPose, phase: CardPhase = "here", reaction?: CardReaction) =>
  renderToStaticMarkup(createElement(CardPanda, { view: { state, phase, reaction } }));

test("the card panda draws each state's look in a clip box on the card's edge, and nothing while away", () => {
  for (const [state, look] of Object.entries(CARD_LOOKS)) {
    const html = draw(state as MascotPose);
    assert.match(html, new RegExp(`data-pose="${look.pose}"`), state);
    assert.match(html, new RegExp(`data-expression="${look.expression}"`), state);
    assert.match(html, new RegExp(`data-props="${look.props.join(" ")}"`), state);
    assert.match(html, new RegExp(`data-card-panda="${state}"`));
    assert.match(html, /^<span aria-hidden="true" data-slot="card-panda" class="[^"]*overflow-hidden/);
  }
  assert.equal(draw("away", "gone"), "");
  assert.equal(draw("idle", "gone"), "", "stepped aside");
  assert.match(draw("away", "leaving"), /data-leave=""[^>]*>.*data-pose="walk"/);
  assert.match(draw("idle", "rising"), /data-rise=""/);
  assert.doesNotMatch(draw("idle"), /data-rise|data-leave|data-reaction/);
  assert.match(draw("idle", "here", "wave"), /data-reaction="wave"[^>]*>.*data-expression="happy"/);
});

test("the card panda stays decorative: hidden from assistive tech, never focusable, mouse only", () => {
  const html = draw("idle");
  assert.match(html, /<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
  assert.doesNotMatch(html, /tabindex|role=/i);
  const code = readFileSync("src/app/CardPanda.tsx", "utf8").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\b(tabIndex|role|onKeyDown|onKeyUp|onKeyPress)\b/);
});

// Styles.

const css = readFileSync("src/styles/card-panda.css", "utf8");

/** The animations a rule's `animation` lists, split on the commas outside parentheses. */
const animations = (rule: string) =>
  (/animation:\s*([^;]*);/.exec(rule)?.[1] ?? "").split(/,(?![^(]*\))/).map((one) => one.trim()).filter(Boolean);

/** Each @keyframes block by name: its keyframes as offsets (0–100) and declarations. */
function keyframes(source: string) {
  const blocks = new Map<string, { offsets: number[]; body: string }[]>();
  for (const [, name, inner] of source.matchAll(/@keyframes ([\w-]+) \{([\s\S]*?)\n\}/g))
    blocks.set(
      name,
      [...inner.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([\d.%,\s]+)\{([^}]*)\}/g)].map(([, offsets, body]) => ({
        offsets: offsets.split(",").map((o) => Number(o.trim().replace("%", ""))),
        body,
      })),
    );
  return blocks;
}

test("card-panda.css moves only without Reduce motion, runs every reaction once and loops only the idle breath and blink", () => {
  const motion = mediaBlock(css, "(prefers-reduced-motion: no-preference)");
  assert.ok(motion.length > 0);
  const outside = css.replace(motion, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(outside, /animation\s*:|transition\s*:|:hover/);
  const loops = [...motion.matchAll(/\{([^}]*)\}/g)].flatMap(([, rule]) => animations(rule)).filter((one) => /\binfinite\b/.test(one));
  assert.deepEqual(loops.map((one) => one.split(" ")[0]).sort(), ["card-panda-blink", "card-panda-breathe"]);
  // Every reaction's and every change's animations last as long as the clock in card-panda.ts gives them.
  const timed: [string, string, number][] = [
    ...Object.entries(REACTIONS).map(([kind, { ms }]): [string, string, number] => [kind, `[data-reaction="${kind}"]`, ms]),
    ["rise", "[data-rise]", RISE_MS],
    ["duck", "[data-duck]", DUCK_MS],
    ["leave", "[data-leave]", LEAVE_MS],
    ["shut", '[data-blink="out"]', SHUT_MS],
    ["open", '[data-blink="in"]', OPEN_MS],
  ];
  for (const [name, attribute, ms] of timed) {
    const selector = `.card-panda${attribute}`.replace(/[.[\]"=]/g, "\\$&");
    const rules = [...motion.matchAll(new RegExp(`${selector}[^{]*\\{([^}]*)\\}`, "g"))].map((m) => m[1]);
    assert.ok(rules.length > 0, `${name} has a rule`);
    for (const rule of rules)
      for (const one of animations(rule)) {
        const [, length, count] = /^[\w-]+ ([\d.]+)s [\w-]+(?:\([^)]*\))? (\d+|forwards|backwards)$/.exec(one) ?? [];
        assert.ok(length, `${name}: ${one}`);
        assert.equal(Math.round(Number(length) * (Number(count) || 1) * 1000), ms, `${name} runs ${ms} ms`);
      }
  }
  // The duck and the walk off end out of sight and stay there until the panda is gone; the rest end at rest.
  assert.match(motion, /\.card-panda\[data-duck\] \{\s*animation: card-panda-duck [^;]* forwards;/);
  assert.match(motion, /\.card-panda\[data-leave\] \{\s*animation: card-panda-leave [^;]* forwards;/);
  // The hover lift moves the head only, and only of the poses whose paws or hands stay on the edge.
  assert.match(motion, /\[data-slot="account-card"\]:hover \.card-panda:not\(\[data-leave\]\) \.panda:is\(\[data-pose="peek"\], \[data-pose="chew"\]\) \[data-part="head"\]/);
  assert.match(readFileSync("src/styles/theme.css", "utf8"), /@import "\.\/card-panda\.css";/);
});

test("every reaction starts and ends each part at rest; only the wave's eyes start and end shut", () => {
  const motion = mediaBlock(css, "(prefers-reduced-motion: no-preference)");
  const blocks = keyframes(css);
  const rest = /^(?:\s*(?:translate: 0 0|rotate: 0deg|scale: 1 1|animation-timing-function: [^;]+);)+\s*$/;
  for (const kind of Object.keys(REACTIONS)) {
    const names = [...motion.matchAll(new RegExp(`\\.card-panda\\[data-reaction="${kind}"\\][^{]*\\{([^}]*)\\}`, "g"))]
      .flatMap(([, rule]) => animations(rule))
      .map((one) => one.split(" ")[0]);
    assert.ok(names.length > 1, `${kind} moves more than one part`);
    for (const name of names) {
      if (name === "card-panda-wave-eyes") continue;
      const frames = blocks.get(name);
      assert.ok(frames, name);
      for (const offset of [0, 100]) {
        const body = frames.filter((f) => f.offsets.includes(offset)).map((f) => f.body).join(";");
        assert.match(body, rest, `${name} at ${offset}%`);
      }
    }
  }
});

test("the wave leads with the paw, the head settles after it and the ears last, each part back at rest", () => {
  const blocks = keyframes(css);
  const at = (name: string, offset: number) => {
    const frames = blocks.get(name);
    assert.ok(frames, name);
    return frames.filter((f) => f.offsets.includes(offset)).map((f) => f.body).join(";");
  };
  const rest = /^(?:\s*(?:translate: 0 0|rotate: 0deg|scale: 1 1|animation-timing-function: [^;]+);)+\s*$/;
  const parts = ["paw-lift", "paw-turn", "paw-squash", "paw-brace", "head-bob", "head-tilt", "ear-left", "ear-right"];
  for (const part of parts)
    for (const offset of [0, 100]) assert.match(at(`card-panda-wave-${part}`, offset), rest, `${part} at ${offset}%`);
  // The eyes open into the smile and close out of it, so the face changes behind a blink.
  assert.match(at("card-panda-wave-eyes", 0), /scale: 1 0\.15/);
  assert.match(at("card-panda-wave-eyes", 100), /scale: 1 0\.15/);
  // Where each part is still from on.
  const settled = (part: string) => {
    const frames = blocks.get(`card-panda-wave-${part}`)!.flatMap((f) => f.offsets.map((offset) => ({ offset, body: f.body })));
    const moving = frames.filter((f) => !rest.test(f.body)).map((f) => f.offset);
    return Math.min(...frames.map((f) => f.offset).filter((offset) => offset > Math.max(...moving)));
  };
  const last = (names: string[]) => Math.max(...names.map(settled));
  const first = (names: string[]) => Math.min(...names.map(settled));
  assert.ok(last(["paw-lift", "paw-turn", "paw-squash"]) < first(["head-bob", "head-tilt"]), "the head settles after the paw");
  assert.ok(last(["head-bob", "head-tilt"]) < first(["ear-left", "ear-right"]), "the ears settle after the head");
});

test("the peek's paws turn about elbows the card hides, so a lifted paw shows its forearm", () => {
  const peek = PANDA_RIG.peek;
  for (const paw of ["paw-left", "paw-right"]) {
    const [, y] = new RegExp(`data-part="${paw}" data-pivot="\\d+ (\\d+)"`).exec(peek) ?? [];
    assert.ok(Number(y) > CARD_LEDGE.peek!, `${paw} pivots below the card's edge`);
    assert.match(peek, new RegExp(`data-part="${paw}"[^>]*><g [^>]*><path [^>]*data-model="forearm"`), `${paw} has a forearm`);
  }
});

test("on the peek the swish flicks the ears and the wave lifts a paw, without Reduce motion only", () => {
  const panda = readFileSync("src/styles/panda.css", "utf8");
  const motion = mediaBlock(panda, "(prefers-reduced-motion: no-preference)");
  for (const selector of [
    '.panda[data-pose="peek"][data-trick="swish"] [data-part="ear-left"]',
    '.panda[data-pose="peek"][data-trick="swish"] [data-part="ear-right"]',
    '.panda[data-pose="peek"][data-trick="wave"] [data-part="paw-right"]',
  ])
    assert.ok(motion.includes(selector), selector);
  for (const name of ["panda-ear-flick-left", "panda-ear-flick-right", "panda-paw-wave"])
    assert.match(panda, new RegExp(`@keyframes ${name}\\s*\\{\\s*0%,[^{]*100%\\s*\\{[^}]*\\(0`), `${name} starts and ends at rest`);
});

// The sidebar.

const sidebar = (compact: boolean, extra: Record<string, unknown> = {}) =>
  createElement(Sidebar, {
    page: "genel",
    go: () => {},
    t: (tr: string) => tr,
    compact,
    status: { accounts: 2, planning: false, switching: false },
    summary: { name: "Kişisel · Max", running: true, fiveHour: 38 },
    panda: createElement("i", { "data-test-panda": "" }),
    ...extra,
  });

test("the panda sits in the account card, which leaves room above it; the compact rail shows none", () => {
  const html = renderToStaticMarkup(sidebar(false));
  assert.match(html, /<div data-slot="account-card" class="relative mt-8 [^"]*"><i data-test-panda=""><\/i><button/);
  assert.equal(html.match(/<button/g)?.length, 10, "the panda adds no control");
  // The rail's tooltips need the shell's provider.
  assert.doesNotMatch(renderToStaticMarkup(createElement(TooltipProvider, null, sidebar(true))), /data-test-panda|account-card/);
});

// Mounted: the clock.

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

type Props = CardPandaInput;
let setProps: (patch: Partial<Props>) => void = () => {};
function Harness({ initial }: { initial: Props }) {
  const [props, set] = useState(initial);
  setProps = (patch) => set((p) => ({ ...p, ...patch }));
  const panda = useCardPanda(props);
  return createElement(CardPanda, { view: panda.view });
}

async function mounted(
  run: (env: {
    update(patch: Partial<Props>): Promise<void>;
    advance(ms: number): Promise<void>;
    panda():
      | { state?: string; reaction?: string; pose?: string; expression?: string; rise: boolean; leave: boolean; duck?: boolean; blink?: string }
      | undefined;
    pause(paused: boolean): Promise<void>;
  }) => Promise<void>,
  options: { reducedMotion?: boolean; initial?: Partial<Props> } = {},
) {
  const dom = fakeDom({ reducedMotion: options.reducedMotion });
  dom.install();
  mock.timers.enable({ apis: ["setTimeout"] });
  let clock = NOW;
  const now = mock.method(Date, "now", () => clock);
  const random = mock.method(Math, "random", () => 0.5);
  const root = { toggleAttribute: () => true };
  try {
    const { createRoot } = await import("react-dom/client");
    const container = createRoot(dom.container as unknown as Element);
    const initial: Props = { state: "idle", active: "a", busy: false, settings: "{}", refreshing: false, yields: false, ...options.initial };
    await act(async () => container.render(createElement(Harness, { initial }) as ReactElement));
    const all = () => nodes(dom.container as unknown as FakeNode);
    await run({
      update: (patch) => act(async () => setProps(patch)),
      advance: (ms) =>
        act(async () => {
          clock += ms;
          mock.timers.tick(ms);
        }),
      panda: () => {
        const box = all().find((n) => n.attributes.has("data-card-panda"));
        if (!box) return undefined;
        const svg = all().find((n) => n.attributes.has("data-pose"));
        return {
          state: box.attributes.get("data-card-panda"),
          reaction: box.attributes.get("data-reaction"),
          pose: svg?.attributes.get("data-pose"),
          expression: svg?.attributes.get("data-expression"),
          rise: box.attributes.has("data-rise"),
          leave: box.attributes.has("data-leave"),
          ...(box.attributes.has("data-duck") && { duck: true }),
          ...(box.attributes.has("data-blink") && { blink: box.attributes.get("data-blink") }),
        };
      },
      pause: (paused) => act(async () => setMotionPaused(paused, root)),
    });
    await act(async () => container.unmount());
  } finally {
    setMotionPaused(false, root);
    mock.timers.reset();
    now.mock.restore();
    random.mock.restore();
    dom.uninstall();
  }
}

test("a switch: the panda walks off while Desktop is busy, rises back, then waves once it is on the card", async () => {
  await mounted(async (env) => {
    assert.deepEqual(env.panda(), { state: "idle", reaction: undefined, pose: "peek", expression: "open", rise: false, leave: false });
    await env.update({ state: "away", busy: true });
    assert.equal(env.panda()?.pose, "walk");
    assert.equal(env.panda()?.leave, true);
    await env.advance(LEAVE_MS);
    assert.equal(env.panda(), undefined, "gone while Desktop is busy");
    await env.update({ state: "idle", busy: false, active: "b" });
    assert.deepEqual(env.panda(), { state: "idle", reaction: undefined, pose: "peek", expression: "open", rise: true, leave: false });
    await env.advance(RISE_MS);
    assert.deepEqual(env.panda(), { state: "idle", reaction: "wave", pose: "peek", expression: "happy", rise: false, leave: false });
    await env.advance(REACTIONS.wave.ms);
    assert.equal(env.panda()?.reaction, undefined);
    assert.equal(env.panda()?.expression, "open", "back to the state's look");
  });
});

test("a refresh, a setting and a click each play their reaction once; the sidebar tells above from below", async () => {
  await mounted(async (env) => {
    await env.update({ refreshing: true });
    await env.update({ refreshing: false });
    assert.equal(env.panda()?.reaction, "check");
    await env.advance(REACTIONS.check.ms);
    await env.update({ settings: '{"x":1}' });
    assert.equal(env.panda()?.reaction, "nod");
    await env.advance(REACTIONS.nod.ms);
    assert.equal(env.panda()?.reaction, undefined);
  });
  // The sidebar's own clicks.
  const dom = fakeDom();
  dom.install();
  try {
    const { createRoot } = await import("react-dom/client");
    const pokes: string[] = [];
    const went: string[] = [];
    const root = createRoot(dom.container as unknown as Element);
    await act(async () =>
      root.render(sidebar(false, { onPoke: (where: string) => pokes.push(where), go: (page: string) => went.push(page) })),
    );
    const buttons = nodes(dom.container as unknown as FakeNode).filter((n) => n.tagName === "button");
    assert.equal(buttons.length, 10);
    for (const button of buttons) await act(async () => dom.dispatch(button, "click", { detail: 1 }));
    // Eight pages above the card, then the card itself, then Settings below it.
    assert.deepEqual(went, ["genel", "hesaplar", "gecis", "planlama", "kullanim", "tokenlar", "rozetler", "proxy", "genel", "ayarlar"]);
    assert.deepEqual(pokes, ["above", "above", "above", "above", "above", "above", "above", "above", "below", "below"]);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("Reduce motion: the still look only, no reactions, no walk off", async () => {
  await mounted(
    async (env) => {
      await env.update({ settings: '{"x":1}' });
      assert.equal(env.panda()?.reaction, undefined);
      await env.update({ state: "away", busy: true });
      assert.equal(env.panda(), undefined, "away is simply not there");
      await env.update({ state: "idle", busy: false, active: "b" });
      assert.equal(env.panda()?.reaction, undefined);
      assert.equal(env.panda()?.expression, "open");
      await env.advance(AMBIENT_MAX_MS);
      assert.equal(env.panda()?.reaction, undefined, "no glance either");
    },
    { reducedMotion: true },
  );
});

test("paused: reactions are dropped and the now-and-then glance stops; a switch's wave waits for the window", async () => {
  await mounted(async (env) => {
    await env.advance(AMBIENT_MAX_MS);
    assert.equal(env.panda()?.reaction, "glance", "now and then while in view");
    await env.advance(REACTIONS.glance.ms);
    await env.pause(true);
    await env.advance(AMBIENT_MAX_MS * 2);
    assert.equal(env.panda()?.reaction, undefined, "no glance while paused");
    await env.update({ settings: '{"x":1}' });
    assert.equal(env.panda()?.reaction, undefined, "a setting's nod is dropped");
    await env.update({ state: "away", busy: true });
    await env.advance(LEAVE_MS);
    await env.update({ state: "idle", busy: false, active: "b" });
    assert.equal(env.panda()?.reaction, undefined, "the wave waits");
    await env.advance(10_000);
    await env.pause(false);
    assert.equal(env.panda()?.reaction, "wave", "and plays when the window is back");
    assert.equal(env.panda()?.expression, "happy");
  });
});

test("on Overview it ducks aside without walking, and rises back after", async () => {
  await mounted(async (env) => {
    await env.update({ yields: true });
    assert.equal(env.panda()?.duck, true);
    assert.equal(env.panda()?.pose, "peek");
    await env.advance(DUCK_MS);
    assert.equal(env.panda(), undefined);
    await env.update({ yields: false });
    assert.equal(env.panda()?.rise, true);
  });
});

test("a new pose ducks and rises in it, a new face blinks into it, and what is asked for meanwhile waits", async () => {
  await mounted(async (env) => {
    // Warming: the peek ducks, the chew pose rises, and the warming chew plays once it is on the card.
    await env.update({ state: "warming" });
    assert.deepEqual(env.panda(), { state: "idle", reaction: undefined, pose: "peek", expression: "open", rise: false, leave: false, duck: true });
    await env.advance(DUCK_MS);
    assert.deepEqual(env.panda(), { state: "warming", reaction: undefined, pose: "chew", expression: "open", rise: true, leave: false });
    await env.advance(RISE_MS);
    assert.equal(env.panda()?.reaction, "chew");
    await env.advance(REACTIONS.chew.ms);
    // Hungry, from idle: the same pose, so the eyes shut on the old face and open on the new one.
    await env.update({ state: "idle" });
    await env.advance(DUCK_MS);
    await env.advance(RISE_MS);
    assert.equal(env.panda()?.pose, "peek");
    await env.update({ state: "hungry" });
    assert.deepEqual(env.panda(), { state: "idle", reaction: undefined, pose: "peek", expression: "open", rise: false, leave: false, blink: "out" });
    await env.update({ settings: '{"x":1}' });
    await env.advance(SHUT_MS);
    assert.deepEqual(env.panda(), { state: "hungry", reaction: undefined, pose: "peek", expression: "worried", rise: false, leave: false, blink: "in" });
    await env.advance(OPEN_MS);
    assert.equal(env.panda()?.reaction, "nod", "the setting's nod waited for the blink");
    assert.equal(env.panda()?.blink, undefined);
  });
});

test("Reduce motion changes the look at once, with no duck, blink or rise", async () => {
  await mounted(
    async (env) => {
      await env.update({ state: "alert" });
      assert.deepEqual(env.panda(), { state: "alert", reaction: undefined, pose: "stand", expression: "wide", rise: false, leave: false });
      await env.update({ state: "hungry" });
      assert.deepEqual(env.panda(), { state: "hungry", reaction: undefined, pose: "peek", expression: "worried", rise: false, leave: false });
      await env.update({ yields: true });
      assert.equal(env.panda(), undefined);
      await env.update({ yields: false });
      assert.equal(env.panda()?.rise, false);
    },
    { reducedMotion: true },
  );
});

// The gallery.

test("the gallery shows the card panda in every state on light and dark cards, with a demo", () => {
  const frames = Object.fromEntries(
    MASCOT_FRAMES.map((f) => [f, [1, 2, 3].map((scaleFactor) => ({ scaleFactor, png: "AAAA" }))]),
  ) as Record<MascotFrame, { scaleFactor: number; png: string }[]>;
  const html = renderToStaticMarkup(createElement(MascotGallery, { frames }));
  assert.match(html, />Kenar çubuğu kartı</);
  for (const state of ["idle", "hungry", "alert", "sleeping", "warming", "away"]) {
    const cell = new RegExp(`data-card-state="${state}"[\\s\\S]*?data-tone="light"[\\s\\S]*?data-tone="dark"`);
    assert.match(html, cell, state);
    if (state !== "away") assert.match(html, new RegExp(`data-card-panda="${state}"`), state);
  }
  for (const kind of Object.keys(REACTIONS)) assert.match(html, new RegExp(`>${kind}</button>`), kind);
  assert.match(html, />Geçiş \(git, dön, el salla\)</);
});
