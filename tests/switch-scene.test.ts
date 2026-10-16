import test from "node:test";
import assert from "node:assert/strict";
import {
  CLOSING_MS, DISGUISES, INITIAL_SCENE, LEAVING_MS, RETURNING_MS, WAITING_LIMIT_MS,
  SwitchStory, pickDisguise, sceneDeadline, sceneLine, sceneView, switchScene, switchWindowVisible,
  type Disguise, type SwitchSceneEvent, type SwitchSceneState,
} from "../shared/switch-scene";

const start: SwitchSceneEvent = { phase: "start", kind: "switch", profileId: "b" };
const ended = (ok = true): SwitchSceneEvent => ({ phase: "end", kind: "switch", profileId: "b", ok });
const merged: SwitchSceneEvent = { phase: "end", kind: "merge", ok: true };
const tick: SwitchSceneEvent = { phase: "tick" };
const fedora = () => "fedora" as Disguise;
/** Each event at its time, from the initial state; every state along the way. */
function run(steps: [number, SwitchSceneEvent][]): SwitchSceneState[] {
  let state = INITIAL_SCENE;
  return steps.map(([at, event]) => (state = switchScene(state, event, at, fedora)));
}

test("a switch leaves, waits, returns in disguise, fades and hides", () => {
  const back = 5_000;
  const states = run([
    [0, start], [LEAVING_MS, tick], [back, ended()],
    [back + RETURNING_MS.switched, tick], [back + RETURNING_MS.switched + CLOSING_MS, tick],
  ]);
  assert.deepEqual(states.map((s) => s.stage), ["leaving", "waiting", "returning", "closing", "hidden"]);
  assert.equal(states[0].story, 1);
  assert.equal(states[2].outcome, "switched");
  assert.equal(states[2].disguise, "fedora");
  assert.equal(states[2].since, back);
});

test("each outcome returns for its own time, in disguise only after a switch", () => {
  const cases: [SwitchSceneEvent, keyof typeof RETURNING_MS][] = [[ended(false), "failed"], [merged, "back"], [ended(), "switched"]];
  for (const [event, outcome] of cases) {
    const [, , returning, before] = run([[0, start], [LEAVING_MS, tick], [2_000, event], [2_000 + RETURNING_MS[outcome] - 1, tick]]);
    assert.equal(returning.outcome, outcome);
    assert.equal(before.stage, "returning", outcome);
    assert.equal(sceneDeadline(before), 2_000 + RETURNING_MS[outcome]);
    assert.equal(returning.disguise, outcome === "switched" ? "fedora" : undefined);
  }
});

test("an operation that ends while the panda still walks returns once the walk is over", () => {
  const [, held, returning] = run([[0, start], [400, ended()], [LEAVING_MS, tick]]);
  assert.equal(held.stage, "leaving");
  assert.equal(held.outcome, "switched");
  assert.equal(returning.stage, "returning");
  assert.equal(returning.since, LEAVING_MS);
});

test("after a minute of waiting the window hides, and a late end still plays the return", () => {
  const [, waiting, stalled, returning] = run([
    [0, start], [LEAVING_MS, tick], [LEAVING_MS + WAITING_LIMIT_MS, tick], [90_000, ended()],
  ]);
  assert.equal(waiting.stage, "waiting");
  assert.equal(stalled.stage, "stalled");
  assert.equal(sceneDeadline(stalled), undefined);
  assert.equal(returning.stage, "returning");
  assert.equal(returning.since, 90_000);
});

test("a new operation during the return starts the story over", () => {
  const again = run([[0, start], [LEAVING_MS, tick], [2_000, ended()], [2_500, { phase: "start", kind: "merge" }]])[3];
  assert.equal(again.stage, "leaving");
  assert.equal(again.story, 2);
  assert.equal(again.kind, "merge");
  assert.equal(again.profileId, undefined);
  assert.equal(again.outcome, undefined);
  assert.equal(again.disguise, undefined);
  assert.equal(again.lastDisguise, "fedora");
});

test("a timer that fires late after sleep skips the stages it slept through", () => {
  assert.equal(run([[0, start], [500, ended()], [100_000, tick]])[2].stage, "hidden");
});

test("an end without its start changes nothing", () => {
  assert.equal(switchScene(INITIAL_SCENE, ended(), 10, fedora), INITIAL_SCENE);
});

test("a disguise is random but never the previous one", () => {
  const all = Object.keys(DISGUISES) as Disguise[];
  for (const previous of all)
    for (const r of [0, 0.49, 0.5, 0.999]) assert.notEqual(pickDisguise(previous, () => r), previous);
  assert.deepEqual(new Set([0, 0.4, 0.8].map((r) => pickDisguise(undefined, () => r))), new Set(all));
});

test("the line names the target and the result, in Turkish and English", () => {
  const name = (id: string) => (id === "b" ? "Vertex" : undefined);
  const lines = (language: "tr" | "en", steps: [number, SwitchSceneEvent][]) =>
    run(steps).map((s) => sceneLine(s, language, name));
  assert.deepEqual(lines("tr", [[0, start], [LEAVING_MS, tick], [2_000, ended()]]), [
    "Vertex hesabına geçiliyor", "Vertex hesabına geçiliyor", "Vertex hesabındasın",
  ]);
  assert.deepEqual(lines("en", [[0, start], [500, ended(false)], [LEAVING_MS, tick]]), [
    "Switching to Vertex", "Switching to Vertex", "Couldn’t finish · details in Relay",
  ]);
  assert.deepEqual(lines("tr", [[0, { phase: "start", kind: "merge" }], [LEAVING_MS, tick], [2_000, merged]]), [
    "Claude yeniden başlatılıyor…", "Claude yeniden başlatılıyor…", "Claude yeniden açıldı",
  ]);
  assert.equal(sceneLine(run([[0, start], [500, ended(false)], [LEAVING_MS, tick]])[2], "tr", name), "İşlem tamamlanamadı · ayrıntılar Relay’de");
  assert.equal(sceneLine(run([[0, start], [500, ended()], [LEAVING_MS, tick]])[2], "en", name), "You’re on Vertex");
  assert.equal(sceneLine(run([[0, { phase: "start", kind: "merge" }], [500, merged], [LEAVING_MS, tick]])[2], "en", name), "Claude reopened");
});

test("an account deleted during the story falls back to the general lines", () => {
  const states = run([[0, start], [LEAVING_MS, tick], [2_000, ended()]]);
  assert.deepEqual(states.map((s) => sceneLine(s, "tr", () => undefined)), [
    "Claude yeniden başlatılıyor…", "Claude yeniden başlatılıyor…", "Claude yeniden açıldı",
  ]);
});

test("the view is on screen only for drawn stages, with the outcome once returning", () => {
  const context = { language: "tr" as const, name: () => "Vertex", motion: false };
  const states = run([[0, start], [400, ended()], [LEAVING_MS, tick]]);
  assert.deepEqual(
    states.map((s) => sceneView(s, context)).map((v) => [v.stage, v.visible, v.outcome, v.motion]),
    [["leaving", true, undefined, false], ["leaving", true, undefined, false], ["returning", true, "switched", false]],
  );
  assert.equal(sceneView(INITIAL_SCENE, context).visible, false);
  const stalled = run([[0, start], [LEAVING_MS, tick], [LEAVING_MS + WAITING_LIMIT_MS, tick]])[2];
  assert.equal(sceneView(stalled, context).visible, false);
});

test("the switch window shows only with the setting on, its page ready and the panel closed", () => {
  const on = { loaded: true, enabled: true, panelOpen: false };
  assert.equal(switchWindowVisible({ visible: true }, on), true);
  assert.equal(switchWindowVisible({ visible: true }, { ...on, enabled: false }), false);
  assert.equal(switchWindowVisible({ visible: true }, { ...on, loaded: false }), false);
  assert.equal(switchWindowVisible({ visible: true }, { ...on, panelOpen: true }), false);
  assert.equal(switchWindowVisible({ visible: false }, on), false);
  assert.equal(switchWindowVisible(undefined, on), false);
});

function clock() {
  let now = 0;
  const timers: { fn: () => void; at: number }[] = [];
  return {
    timers,
    now: () => now,
    set: (ms: number) => void (now = ms),
    setTimeout: (fn: () => void, ms: number) => {
      const timer = { fn, at: now + ms };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle: unknown) => {
      const i = timers.indexOf(handle as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
    fire() {
      const timer = timers.shift()!;
      now = timer.at;
      timer.fn();
    },
  };
}

test("the story times its stages and publishes each change", () => {
  const c = clock();
  const shown: string[] = [];
  const story = new SwitchStory({ ...c, pick: () => "sunglasses", show: (state) => void shown.push(state.stage) });
  story.report({ phase: "start", kind: "switch", profileId: "b" });
  assert.deepEqual(c.timers.map((t) => t.at), [LEAVING_MS]);
  c.fire();
  c.set(3_000);
  story.report({ phase: "end", kind: "switch", profileId: "b", ok: true });
  assert.equal(story.current.disguise, "sunglasses");
  assert.deepEqual(c.timers.map((t) => t.at), [3_000 + RETURNING_MS.switched]);
  c.fire();
  c.fire();
  assert.deepEqual(shown, ["leaving", "waiting", "returning", "closing", "hidden"]);
  assert.equal(c.timers.length, 0);
});

test("a failing view never stops the story, and destroy clears its timer", () => {
  const c = clock();
  const story = new SwitchStory({ ...c, show: () => { throw new Error("window gone"); } });
  story.report({ phase: "start", kind: "switch", profileId: "b" });
  assert.equal(story.current.stage, "leaving");
  assert.equal(c.timers.length, 1);
  story.destroy();
  assert.equal(c.timers.length, 0);
});
