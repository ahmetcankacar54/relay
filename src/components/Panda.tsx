import { useId, useMemo } from "react";
import { PANDA_RIG } from "@/mascot/panda-rig";
import { PANDA_SCENES, type PandaMotion, type PandaScene } from "@/mascot/scenes";
import { cn } from "@/lib/utils";
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
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

/** A named in-app scene (src/mascot/scenes.ts). */
export function Panda({ scene, size, className }: { scene: PandaScene; size: number; className?: string }) {
  return <PandaRig {...PANDA_SCENES[scene]} scene={scene} size={size} className={className} />;
}
