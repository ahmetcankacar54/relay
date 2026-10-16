import type { ReactNode } from "react";
import type { PrankKind } from "./budget";
import { ConfettiLayer, DozeLayer, NibbleBarLayer, WheelLayer } from "./layers";
import type { PrankPlay } from "./PrankStage";

/**
 * Draws one prank inside the stage; it calls `done` when it has finished. A layer may hide the
 * real cursor by toggling `prank-cursor-hidden` on <html> in any effect: the stage takes the class
 * off when the play ends and when the stage unmounts, whatever the layer does.
 */
export type PrankLayer = (props: { play: PrankPlay; done(): void }) => ReactNode;

/** The layer that draws each kind of prank. A kind without one ends the moment it starts. */
export const PRANK_LAYERS: Partial<Record<PrankKind, PrankLayer>> = {
  wheel: WheelLayer,
  "nibble-bar": NibbleBarLayer,
  doze: DozeLayer,
  confetti: ConfettiLayer,
};
