import { PandaRig } from "@/components/Panda";
import type { PandaExpression, PandaProp } from "../../shared/panda-poses";
import { DISGUISES, type SwitchSceneView } from "../../shared/switch-scene";

/** Both rigs share one canvas scale, so the panda stands as tall as the door. */
const RIG_SIZE = 100;

/** How the panda comes back, by outcome. */
function returningPanda(view: SwitchSceneView): { expression: PandaExpression; props: PandaProp[] } {
  if (view.outcome === "failed") return { expression: "wide", props: ["bang"] };
  if (view.outcome === "switched" && view.disguise) return { expression: "open", props: [...DISGUISES[view.disguise]] };
  return { expression: "happy", props: [] };
}

/**
 * The switch window's 240×150 card: the door on the right, the panda and one
 * line. With motion off each stage is a still image (src/styles/switch-stage.css).
 */
export function SwitchStage({ view }: { view: SwitchSceneView }) {
  if (!view.visible) return null;
  const back = view.stage === "returning" || view.stage === "closing";
  return (
    <div
      key={view.story}
      className="switch-stage grid h-[150px] w-[240px] grid-rows-[102px_30px] overflow-hidden rounded-2xl border bg-popover/95 px-3 pt-2 pb-2.5 text-popover-foreground"
      data-switch-stage={view.stage}
      data-outcome={back ? view.outcome : undefined}
      data-still={view.motion ? undefined : ""}
    >
      <div className="relative">
        <PandaRig pose="door" size={RIG_SIZE} className="switch-door absolute right-1 bottom-0" />
        {view.stage === "leaving" && view.motion && (
          <PandaRig
            pose="walk"
            size={RIG_SIZE}
            props={["bamboo"]}
            motion={["walk"]}
            className="switch-panda absolute bottom-0 left-0"
          />
        )}
        {back && (
          <PandaRig pose="stand" size={RIG_SIZE} {...returningPanda(view)} className="switch-panda absolute bottom-0 left-6" />
        )}
      </div>
      <div className="grid place-items-center">
        <p className="switch-line line-clamp-2 text-center text-[12px] leading-[15px] font-semibold" title={view.line}>
          {view.line}
        </p>
      </div>
    </div>
  );
}
