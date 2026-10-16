import { createContext, useContext } from "react";
import type { PrankKind } from "./budget";

/**
 * What a component may ask of the prank stage. It lives apart from the stage so that something drawn by a
 * prank layer (the panda) can read it without importing the stage and its layers back.
 */

/** The part of a click the stage needs: where the pointer was, and `detail` 0 for a keyboard click. */
export interface PrankEvent {
  clientX: number;
  clientY: number;
  detail: number;
}

export interface PrankApi {
  /** Offers a prank; the stage decides. `anchor` and `event` are read now, not when the layer draws. */
  offer(kind: PrankKind, anchor: Element | null, event?: PrankEvent): void;
  /** Whether a click on a playful panda may start a trick. Tricks have no budget. */
  allowsTrick(event: { detail: number }): boolean;
}

/** The class on <html> that hides the real cursor (src/styles/pranks.css); the stage takes it off when a play ends. */
export const CURSOR_HIDDEN_CLASS = "prank-cursor-hidden";

/** Outside a stage nothing pranks. */
export const NO_PRANKS: PrankApi = { offer() {}, allowsTrick: () => false };
export const PrankContext = createContext<PrankApi>(NO_PRANKS);

export function usePrank(): PrankApi {
  return useContext(PrankContext);
}
