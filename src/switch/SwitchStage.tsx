import { ArrowRight } from "lucide-react";
import { PandaRig } from "@/components/Panda";
import { UsageRing } from "@/components/UsageRing";
import { cn } from "@/lib/utils";
import type { PandaExpression, PandaProp } from "../../shared/panda-poses";
import { DISGUISES, type SceneAccount, type SwitchSceneView } from "../../shared/switch-scene";

/** Both rigs share one canvas scale, so the panda stands as tall as the door. */
const RIG_SIZE = 100;
/** With the from → to row the scene gives up room to it. */
const RIG_SIZE_WITH_ACCOUNTS = 80;

/** One side of the switch: a small five-hour ring, the name and its percent. */
function Side({ account, target }: { account: SceneAccount; target?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {account.percent !== undefined && (
        <UsageRing outer={account.percent} size={16} label={`${account.name} %${Math.round(account.percent)}`} />
      )}
      <span className={cn("truncate", target && "font-semibold")}>{account.name}</span>
      {account.percent !== undefined && (
        <span className="shrink-0 text-muted-foreground tabular-nums">%{Math.round(account.percent)}</span>
      )}
    </span>
  );
}

/** How the panda comes back, by outcome. */
function returningPanda(view: SwitchSceneView): { expression: PandaExpression; props: PandaProp[] } {
  if (view.outcome === "failed") return { expression: "wide", props: ["bang"] };
  if (view.outcome === "switched" && view.disguise) return { expression: "open", props: [...DISGUISES[view.disguise]] };
  return { expression: "happy", props: [] };
}

/**
 * The switch window's 240×150 card: the door on the right, the panda and one
 * line; for a switch, a from → to row under it with each account's five-hour
 * ring. With motion off each stage is a still image (src/styles/switch-stage.css).
 */
export function SwitchStage({ view }: { view: SwitchSceneView }) {
  if (!view.visible) return null;
  const back = view.stage === "returning" || view.stage === "closing";
  const pair = view.accounts;
  const rig = pair ? RIG_SIZE_WITH_ACCOUNTS : RIG_SIZE;
  return (
    <div
      key={view.story}
      className={cn(
        "switch-stage grid h-[150px] w-[240px] overflow-hidden rounded-2xl border bg-popover/95 px-3 pt-2 pb-2.5 text-popover-foreground",
        pair ? "grid-rows-[82px_18px_20px]" : "grid-rows-[102px_30px]",
      )}
      data-switch-stage={view.stage}
      data-outcome={back ? view.outcome : undefined}
      data-still={view.motion ? undefined : ""}
    >
      <div className="relative">
        <PandaRig pose="door" size={rig} className="switch-door absolute right-1 bottom-0" />
        {view.stage === "leaving" && view.motion && (
          <PandaRig
            pose="walk"
            size={rig}
            props={["bamboo"]}
            motion={["walk"]}
            className="switch-panda absolute bottom-0 left-0"
          />
        )}
        {back && (
          <PandaRig pose="stand" size={rig} {...returningPanda(view)} className="switch-panda absolute bottom-0 left-6" />
        )}
      </div>
      <div className="grid place-items-center">
        <p
          className={cn(
            "switch-line text-center text-[12px] leading-[15px] font-semibold",
            pair ? "line-clamp-1" : "line-clamp-2",
          )}
          title={view.line}
        >
          {view.line}
        </p>
      </div>
      {pair && (
        <div
          data-slot="switch-accounts"
          className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5 text-[11px]"
        >
          {pair.from ? <Side account={pair.from} /> : <span />}
          <ArrowRight aria-hidden="true" className="size-3 text-muted-foreground" />
          <Side account={pair.to} target />
        </div>
      )}
    </div>
  );
}
