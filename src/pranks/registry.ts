import type { ReactNode } from "react";
import type { PrankKind } from "./budget";
import type { PrankPlay } from "./PrankStage";

/** Draws one prank inside the stage; it calls `done` when it has finished and put everything back. */
export type PrankLayer = (props: { play: PrankPlay; done(): void }) => ReactNode;

/** The layer that draws each kind of prank. A kind without one ends the moment it starts. */
export const PRANK_LAYERS: Partial<Record<PrankKind, PrankLayer>> = {};
