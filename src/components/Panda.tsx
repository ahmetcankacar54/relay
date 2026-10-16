import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";
import { PANDA_RIG } from "@/mascot/panda-rig";
import { PANDA_SCENES, type PandaMotion, type PandaScene } from "@/mascot/scenes";
import { cn } from "@/lib/utils";
import { usePrank, type PrankApi } from "@/pranks/PrankStage";
import { TRICK_MS, nextClick, trickFor, trickLook, type Trick } from "@/pranks/tricks";
import {
  PANDA_CANVAS,
  RIG_ID_TOKEN,
  type PandaExpression,
  type PandaPose,
  type PandaProp,
} from "../../shared/panda-poses";

export interface PandaRigProps {
  pose: PandaPose;
  size: number;
  expression?: PandaExpression;
  props?: readonly PandaProp[];
  motion?: readonly PandaMotion[];
  /** The trick that is playing (src/pranks/tricks.ts), written as data-trick for the styles. */
  trick?: Trick;
  /** Written as data-scene, for styles and tests. */
  scene?: string;
  className?: string;
  /** The generated rig; tests pass their own. */
  rig?: Partial<Record<PandaPose, string>>;
}

/**
 * One puppet pose drawn inline. Decorative: hidden from assistive tech and
 * never focusable. The root's data attributes pick the expression, props and
 * motions (src/styles/panda.css).
 */
export function PandaRig({
  pose,
  size,
  expression = "open",
  props = [],
  motion = [],
  trick,
  scene,
  className,
  rig = PANDA_RIG,
}: PandaRigProps) {
  // Ids must be unique per drawn panda, or a second one would use the first one's clip paths.
  const prefix = `panda${useId().replace(/[^A-Za-z0-9_-]/g, "")}-`;
  const source = rig[pose];
  const markup = useMemo(() => source?.replaceAll(RIG_ID_TOKEN, prefix), [source, prefix]);
  if (markup === undefined)
    return (
      <span
        aria-hidden="true"
        className={cn("inline-block shrink-0", className)}
        style={{ width: size, height: size }}
      />
    );
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${PANDA_CANVAS} ${PANDA_CANVAS}`}
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={cn("panda shrink-0", className)}
      data-scene={scene}
      data-pose={pose}
      data-expression={expression}
      data-props={props.join(" ")}
      data-motion={motion.join(" ")}
      data-trick={trick}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

/** How often a panda has been clicked, and when last; nothing before the first click. */
export type PandaClicks = { count: number; at: number } | undefined;

/**
 * What one click on a playful panda does: it counts the click and picks the trick for its count. A keyboard
 * click (`detail` 0) or one the stage refuses plays nothing and is not counted: `state` comes back as it was.
 */
export function pandaClick(
  state: PandaClicks,
  event: { detail: number },
  api: Pick<PrankApi, "allowsTrick">,
  now: number,
  random: () => number,
): { state: PandaClicks; trick?: Trick } {
  if (event.detail === 0 || !api.allowsTrick(event)) return { state };
  const next = nextClick(state, now);
  return { state: next, trick: trickFor(next.count, random) };
}

/** A scene that does a trick when the mouse clicks it. It is still decorative: no control, no focus, no keys. */
function PlayfulPanda({ scene, size, className }: { scene: PandaScene; size: number; className?: string }) {
  const prank = usePrank();
  const [trick, setTrick] = useState<Trick>();
  // Only the click handler reads these, so they are not state.
  const clicks = useRef<PandaClicks>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const click = (event: MouseEvent<HTMLSpanElement>) => {
    const played = pandaClick(clicks.current, event, prank, Date.now(), Math.random);
    clicks.current = played.state;
    if (!played.trick) return;
    // A click while a trick plays still counts: its trick replaces the playing one and the clock starts again.
    setTrick(played.trick);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setTrick(undefined), TRICK_MS);
  };

  return (
    // The box clips a trick that slides the panda out of it.
    <span
      data-playful
      className="inline-block shrink-0 overflow-hidden"
      style={{ width: size, height: size }}
      onClick={click}
    >
      <PandaRig {...trickLook(PANDA_SCENES[scene], trick)} scene={scene} size={size} className={className} />
    </span>
  );
}

/** A named in-app scene (src/mascot/scenes.ts). A `playful` one does a trick when it is clicked. */
export function Panda({
  scene,
  size,
  className,
  playful,
}: {
  scene: PandaScene;
  size: number;
  className?: string;
  playful?: boolean;
}) {
  if (playful) return <PlayfulPanda scene={scene} size={size} className={className} />;
  return <PandaRig {...PANDA_SCENES[scene]} scene={scene} size={size} className={className} />;
}
