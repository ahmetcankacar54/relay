import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { PandaRig, pandaClick, type PandaClicks } from "@/components/Panda";
import { motionPaused, onMotionPaused } from "@/lib/motion";
import {
  AMBIENT,
  CARD_LOOKS,
  CARD_SIZE,
  LEAVING_LOOK,
  PHASE_MS,
  ambientDelay,
  arriving,
  cardPlacement,
  react,
  reactionLook,
  restage,
  resume,
  showing,
  sightReactions,
  stageEnd,
  type CardPhase,
  type CardReaction,
  type CardSeen,
  type CardSight,
  type CardStage,
  type ReactionQueue,
} from "@/mascot/card-panda";
import { usePrank } from "@/pranks/context";
import { TRICK_MS, trickLook, type Trick } from "@/pranks/tricks";
import type { MascotPose } from "../../shared/mascot";

/** Read when it matters, as the prank stage does: a change takes effect at the next reaction. */
const reducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export type { CardPhase };

export interface CardPandaView {
  /** The state drawn, which lags the state while the panda ducks or blinks into a new one. */
  state: MascotPose;
  phase: CardPhase;
  reaction?: CardReaction;
}

export interface CardPandaInput extends CardSight {
  /** The page draws a panda of its own, so this one steps aside. */
  yields: boolean;
}

/**
 * The card panda's clock: its state, its comings and goings, and the reactions asked for by what changes
 * between two renders (sightReactions) or by `poke`, one at a time.
 */
export function useCardPanda(input: CardPandaInput): {
  view: CardPandaView;
  poke(where: "above" | "below"): void;
  /** Asks for one reaction directly; the dev gallery's buttons use it. */
  react(kind: CardReaction): void;
} {
  const { state, active, busy, settings, refreshing, yields } = input;
  const paused = useSyncExternalStore(onMotionPaused, motionPaused, () => false);
  const [queue, setQueue] = useState<ReactionQueue>({});

  // Where the panda is. A new state or step-aside restages it at once (a walk off, a duck, a blink, a rise); each
  // passing phase ends on its timer, with the state of that moment.
  const hidden = state === "away" || yields;
  const [stage, setStage] = useState<CardStage>({ phase: hidden ? "gone" : "here", shown: state });
  const [staged, setStaged] = useState({ state, yields });
  if (staged.state !== state || staged.yields !== yields) {
    setStaged({ state, yields });
    const next = restage(stage, state, yields, paused || reducedMotion());
    if (next !== stage) {
      setStage(next);
      // Whatever was playing stops as the panda walks off, ducks or blinks.
      if (next.phase === "leaving" || next.phase === "ducking" || next.phase === "shutting")
        setQueue((q) => ({ held: q.held }));
    }
  }

  // The reaction effects and timers below read the state of this render; this effect runs first.
  const latest = useRef({ state, yields, paused, phase: stage.phase });
  useEffect(() => {
    latest.current = { state, yields, paused, phase: stage.phase };
  });
  const push = useCallback((kind: CardReaction) => {
    const { state, paused, phase } = latest.current;
    setQueue((q) =>
      react(q, kind, { now: Date.now(), state, paused, reducedMotion: reducedMotion(), arriving: arriving(phase) }),
    );
  }, []);

  useEffect(() => {
    const ms = PHASE_MS[stage.phase];
    if (ms === undefined) return;
    const id = setTimeout(() => {
      const { state, yields, paused } = latest.current;
      setStage((s) => (s === stage ? stageEnd(s, state, yields, paused || reducedMotion()) : s));
    }, ms);
    return () => clearTimeout(id);
  }, [stage]);

  const seen = useRef<CardSeen>({ refreshing: false });
  useEffect(() => {
    const next = sightReactions(seen.current, { active, busy, settings, refreshing, state });
    seen.current = next.seen;
    for (const kind of next.reactions) push(kind);
  }, [active, busy, settings, refreshing, state, push]);

  // What waited plays once the window is in view and the panda back on the card.
  const here = stage.phase === "here";
  useEffect(() => {
    if (!paused && here)
      setQueue((q) => resume(q, { now: Date.now(), state: latest.current.state, reducedMotion: reducedMotion() }));
  }, [paused, here]);

  const playing = queue.playing;
  useEffect(() => {
    if (!playing) return;
    const id = setTimeout(
      () => setQueue((q) => (q.playing === playing ? { held: q.held } : q)),
      Math.max(0, playing.until - Date.now()),
    );
    return () => clearTimeout(id);
  }, [playing]);

  // Now and then, only while it is drawn and seen.
  const ambient = AMBIENT[state];
  const present = stage.phase !== "gone" && stage.phase !== "leaving";
  useEffect(() => {
    if (!ambient || paused || !present || reducedMotion()) return;
    let id: ReturnType<typeof setTimeout>;
    const next = () => {
      id = setTimeout(() => {
        push(ambient);
        next();
      }, ambientDelay(Math.random()));
    };
    next();
    return () => clearTimeout(id);
  }, [ambient, paused, present, push]);

  const reaction = here ? showing(queue, { now: Date.now(), state, reducedMotion: reducedMotion() }) : undefined;
  const poke = useCallback((where: "above" | "below") => push(where === "above" ? "look-up" : "look-down"), [push]);
  return { view: { state: stage.shown, phase: stage.phase, reaction }, poke, react: push };
}

/**
 * The panda over the account card's top edge. A clip box sits on the edge (on the border's outer side, so the
 * panda never draws over the border), so the card hides whatever is below it. Decorative: hidden from assistive tech, never focusable; a mouse click plays the playful panda's tricks.
 */
export function CardPanda({ view }: { view: CardPandaView }) {
  const prank = usePrank();
  const [trick, setTrick] = useState<Trick>();
  const clicks = useRef<PandaClicks>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const leaving = view.phase === "leaving";
  const going = leaving || view.phase === "ducking";
  const base = leaving ? LEAVING_LOOK : view.state === "away" ? undefined : CARD_LOOKS[view.state];
  if (view.phase === "gone" || !base) return null;
  // A trick wins over a reaction while it plays; a panda walking off or ducking plays neither.
  const playing = going ? undefined : trick;
  const reaction = playing ? undefined : view.reaction;
  const look = trickLook(reactionLook(base, reaction), playing);
  const place = cardPlacement(look.pose);

  const click = (event: MouseEvent<HTMLSpanElement>) => {
    if (going) return;
    const played = pandaClick(clicks.current, event, prank, Date.now(), Math.random);
    clicks.current = played.state;
    if (!played.trick) return;
    setTrick(played.trick);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setTrick(undefined), TRICK_MS);
  };

  return (
    <span
      aria-hidden="true"
      data-slot="card-panda"
      className="pointer-events-none absolute inset-x-0 bottom-[calc(100%+1px)] overflow-hidden"
      style={{ height: CARD_SIZE }}
    >
      <span
        data-card-panda={view.state}
        data-reaction={reaction}
        data-rise={view.phase === "rising" ? "" : undefined}
        data-duck={view.phase === "ducking" ? "" : undefined}
        data-leave={leaving ? "" : undefined}
        data-blink={view.phase === "shutting" ? "out" : view.phase === "opening" ? "in" : undefined}
        className="card-panda pointer-events-auto absolute"
        style={{ right: place.right, bottom: place.bottom, width: place.size, height: place.size }}
        onClick={click}
      >
        <PandaRig
          pose={look.pose}
          expression={look.expression}
          props={look.props}
          motion={look.motion}
          trick={look.trick}
          size={place.size}
        />
      </span>
    </span>
  );
}
