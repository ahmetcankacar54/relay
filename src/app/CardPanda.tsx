import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { PandaRig, pandaClick, type PandaClicks } from "@/components/Panda";
import { motionPaused, onMotionPaused } from "@/lib/motion";
import {
  AMBIENT,
  CARD_LOOKS,
  LEAVE_MS,
  LEAVING_LOOK,
  ambientDelay,
  cardPlacement,
  react,
  reactionLook,
  resume,
  showing,
  sightReactions,
  type CardReaction,
  type CardSeen,
  type CardSight,
  type ReactionQueue,
} from "@/mascot/card-panda";
import { usePrank } from "@/pranks/context";
import { TRICK_MS, trickLook, type Trick } from "@/pranks/tricks";
import type { MascotPose } from "../../shared/mascot";

/** Read when it matters, as the prank stage does: a change takes effect at the next reaction. */
const reducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** `here`, or `rising` back from behind the card; `leaving` walks off it; `gone` draws nothing. */
export type CardPhase = "here" | "rising" | "leaving" | "gone";

export interface CardPandaView {
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
  // The reaction effects below read the state of this render; this effect runs first.
  const latest = useRef({ state, paused });
  useEffect(() => {
    latest.current = { state, paused };
  });
  const push = useCallback((kind: CardReaction) => {
    const { state, paused } = latest.current;
    setQueue((q) => react(q, kind, { now: Date.now(), state, paused, reducedMotion: reducedMotion() }));
  }, []);

  const seen = useRef<CardSeen>({ refreshing: false });
  useEffect(() => {
    const next = sightReactions(seen.current, { active, busy, settings, refreshing, state });
    seen.current = next.seen;
    for (const kind of next.reactions) push(kind);
  }, [active, busy, settings, refreshing, state, push]);

  useEffect(() => {
    if (!paused)
      setQueue((q) => resume(q, { now: Date.now(), state: latest.current.state, reducedMotion: reducedMotion() }));
  }, [paused]);

  const playing = queue.playing;
  useEffect(() => {
    if (!playing) return;
    const id = setTimeout(
      () => setQueue((q) => (q.playing === playing ? { held: q.held } : q)),
      Math.max(0, playing.until - Date.now()),
    );
    return () => clearTimeout(id);
  }, [playing]);

  // Away walks off the card (not under Reduce motion, and not when nothing showed); stepping aside just goes.
  const hidden = state === "away" || yields;
  const [wasHidden, setWasHidden] = useState(hidden);
  const [phase, setPhase] = useState<CardPhase>(hidden ? "gone" : "here");
  if (hidden !== wasHidden) {
    setWasHidden(hidden);
    setPhase(hidden ? (state === "away" && phase !== "gone" && !reducedMotion() ? "leaving" : "gone") : "rising");
  }
  useEffect(() => {
    if (phase !== "leaving") return;
    const id = setTimeout(() => setPhase("gone"), LEAVE_MS);
    return () => clearTimeout(id);
  }, [phase]);

  // Now and then, only while it is drawn and seen.
  const ambient = AMBIENT[state];
  const present = phase === "here" || phase === "rising";
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

  const reaction = present
    ? showing(queue, { now: Date.now(), state, reducedMotion: reducedMotion() })
    : undefined;
  const poke = useCallback((where: "above" | "below") => push(where === "above" ? "look-up" : "look-down"), [push]);
  return { view: { state, phase, reaction }, poke, react: push };
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
  const base = leaving ? LEAVING_LOOK : view.state === "away" ? undefined : CARD_LOOKS[view.state];
  if (view.phase === "gone" || !base) return null;
  // A trick wins over a reaction while it plays; a panda walking off plays neither.
  const playing = leaving ? undefined : trick;
  const reaction = playing ? undefined : view.reaction;
  const look = trickLook(reactionLook(base, reaction), playing);
  const place = cardPlacement(look.pose);

  const click = (event: MouseEvent<HTMLSpanElement>) => {
    if (leaving) return;
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
      className="pointer-events-none absolute inset-x-0 bottom-[calc(100%+1px)] h-14 overflow-hidden"
    >
      <span
        data-card-panda={view.state}
        data-reaction={reaction}
        data-rise={view.phase === "rising" ? "" : undefined}
        data-leave={leaving ? "" : undefined}
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
