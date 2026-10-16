import type { PrankLevel } from "../../shared/types";
import type { PrankKind } from "./budget";

/** What the app knows when a prank is offered. */
export interface PrankGate {
  reducedMotion: boolean;
  level: PrankLevel;
  desktopBusy: boolean;
  errorShown: boolean;
  windowVisible: boolean;
  /** The click came from the keyboard (`event.detail === 0`). */
  keyboard: boolean;
  /** A Desktop-action dialog is open. */
  dialogOpen: boolean;
}

/** Reduced motion and "off" block every prank; confetti, a one-off celebration, ignores the rest. */
export function prankBlocked(kind: PrankKind | "trick", gate: PrankGate): boolean {
  if (gate.reducedMotion || gate.level === "off") return true;
  if (kind === "confetti") return false;
  return gate.desktopBusy || gate.errorShown || !gate.windowVisible || gate.keyboard || gate.dialogOpen;
}
