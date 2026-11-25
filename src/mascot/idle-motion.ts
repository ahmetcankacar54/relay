import type { PandaMotion } from "./scenes";

/**
 * The panda's idle motions play now and then instead of looping. A moving SVG part repaints the window
 * every frame, and in a focused window one moving panda costs about a quarter of a core however small
 * it is, so the parts move for well under a tenth of the time. Each occasional motion plays for `ms`
 * (as long as its rule in src/styles/panda.css runs, so it ends at rest). The blink comes on its own,
 * every 8 to 14 s; the others play together as one routine (a swing of the tail each way, two waves, a
 * look round, two nods) every 1.5 to 2.5 min. Motions not named here (the prank and switch walk, chew
 * and breathe) loop while their scene lasts.
 */
export const OCCASIONAL: Partial<Record<PandaMotion, { ms: number }>> = {
  blink: { ms: 400 },
  tail: { ms: 6_400 },
  wave: { ms: 3_600 },
  look: { ms: 4_900 },
  nod: { ms: 1_800 },
};
const BLINK_REST = [8_000, 14_000] as const;
const ROUTINE_REST = [90_000, 150_000] as const;

/** How long `motion` rests before it plays again, for a `random` in [0, 1); 0 for a motion that loops. */
export function restMs(motion: PandaMotion, random: number): number {
  if (!OCCASIONAL[motion]) return 0;
  const [min, max] = motion === "blink" ? BLINK_REST : ROUTINE_REST;
  return min + Math.floor(random * (max - min));
}

/**
 * Runs the occasional motions of `motion`: what is not resting plays first (a panda that appears greets),
 * then each rests and plays again in turn. `setResting` hears each change; the returned function stops every
 * timer. The caller stops it while the window is hidden or out of focus, and with Reduce motion.
 */
export function runIdleMotion(
  motion: readonly PandaMotion[],
  resting: ReadonlySet<PandaMotion>,
  setResting: (motion: PandaMotion, resting: boolean) => void,
  random: () => number = Math.random,
): () => void {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const after = (ms: number, run: () => void) => {
    const id = setTimeout(() => {
      timers.delete(id);
      run();
    }, ms);
    timers.add(id);
  };
  const names = [...new Set(motion)].filter((name) => OCCASIONAL[name]);
  const routine = names.filter((name) => name !== "blink");

  if (names.includes("blink")) {
    const blink = (rests: boolean) =>
      after(rests ? restMs("blink", random()) : OCCASIONAL.blink!.ms, () => {
        setResting("blink", !rests);
        blink(!rests);
      });
    blink(resting.has("blink"));
  }

  if (routine.length) {
    // One play: every motion of the routine starts together and rests when its own play ends.
    const play = (playing: readonly PandaMotion[]) => {
      for (const name of playing)
        after(OCCASIONAL[name]!.ms, () => setResting(name, true));
      const longest = Math.max(
        0,
        ...playing.map((name) => OCCASIONAL[name]!.ms),
      );
      after(longest + restMs(routine[0], random()), () => {
        for (const name of routine) setResting(name, false);
        play(routine);
      });
    };
    play(routine.filter((name) => !resting.has(name)));
  }

  return () => {
    for (const id of timers) clearTimeout(id);
    timers.clear();
  };
}
