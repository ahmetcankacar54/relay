import { useEffect, useState } from "react";
import { PandaRig } from "@/components/Panda";
import type { PrankPlay } from "./PrankStage";
import { CONFETTI_MS, STARTLE_MS } from "./timing";

/** What the stage hands every layer. Layers take no clicks: the stage is click-through. */
export interface LayerProps {
  play: PrankPlay;
  done(): void;
}

/** How long the panda runs in the wheel, and how long it nibbles at the bar. */
export const WHEEL_MS = 2_400;
export const NIBBLE_BAR_MS = 1_000;

const WHEEL_SIZE = 28;
const NIBBLE_BAR_SIZE = 28;
/** The nibbling panda's box rises this far above the bar's top edge. */
const NIBBLE_BAR_RISE = 26;
const DOZE_SIZE = 48;
const DOZE_MARGIN = 12;
/** The gap between a button and the wheel beside it. */
const BESIDE_GAP = 4;
const LEAVES = 14;

/** What counts as activity for the dozing panda, and for the main window's idle clock. */
export const DOZE_ACTIVITY_EVENTS = ["pointermove", "pointerdown", "keydown", "wheel"] as const;

/**
 * Calls `done` after `ms`, and not at all once the layer is gone. With no time (a layer that has
 * nothing to draw) it ends at once, so a play can never hold the stage for good.
 */
function useEndAfter(done: () => void, ms: number | undefined): void {
  useEffect(() => {
    if (ms === undefined) {
      done();
      return;
    }
    const timer = setTimeout(done, ms);
    return () => clearTimeout(timer);
  }, [done, ms]);
}

/**
 * Where a box of `size` goes beside a button: 4 px to its right and vertically centred on it,
 * or 4 px to its left when the right side would cross the viewport (the panel's button sits near its edge).
 */
export function besideRect(
  rect: { left: number; top: number; width: number; height: number },
  size: number,
  viewportWidth: number,
): { left: number; top: number } {
  const right = rect.left + rect.width + BESIDE_GAP;
  return {
    left: right + size > viewportWidth ? rect.left - BESIDE_GAP - size : right,
    top: rect.top + rect.height / 2 - size / 2,
  };
}

/** A panda runs in a wheel beside the refresh button. */
export function WheelLayer({ play, done }: LayerProps) {
  const { rect } = play;
  useEndAfter(done, rect ? WHEEL_MS : undefined);
  if (!rect) return null;
  const at = besideRect(rect, WHEEL_SIZE, typeof window === "undefined" ? Infinity : window.innerWidth);
  return (
    <div className="absolute" style={{ left: at.left, top: at.top }}>
      <PandaRig pose="walk" size={WHEEL_SIZE} props={["wheel"]} motion={["walk"]} />
    </div>
  );
}

/** A panda nibbles at the filled end of a bar, above it. `rect` is the bar's fill. */
export function NibbleBarLayer({ play, done }: LayerProps) {
  const { rect } = play;
  useEndAfter(done, rect ? NIBBLE_BAR_MS : undefined);
  if (!rect) return null;
  return (
    <div
      className="absolute"
      style={{ left: rect.left + rect.width - NIBBLE_BAR_SIZE / 2, top: rect.top - NIBBLE_BAR_RISE }}
    >
      <PandaRig pose="chew" size={NIBBLE_BAR_SIZE} props={["crumbs"]} motion={["chew"]} />
    </div>
  );
}

/**
 * A panda curled up asleep in the bottom left. The first activity startles it for 0.6 s, then it
 * leaves; a window that is hidden has nobody to wake it, so it leaves at once.
 * `startled` is where it starts, for tests and the gallery.
 */
export function DozeLayer({ done, startled: startledAtFirst = false }: LayerProps & { startled?: boolean }) {
  const [startled, setStartled] = useState(startledAtFirst);
  useEffect(() => {
    const leaveIfHidden = () => {
      if (document.visibilityState === "hidden") done();
    };
    leaveIfHidden();
    document.addEventListener("visibilitychange", leaveIfHidden);
    return () => document.removeEventListener("visibilitychange", leaveIfHidden);
  }, [done]);
  useEffect(() => {
    if (startled) {
      const timer = setTimeout(done, STARTLE_MS);
      return () => clearTimeout(timer);
    }
    const wake = () => setStartled(true);
    for (const type of DOZE_ACTIVITY_EVENTS) window.addEventListener(type, wake, { passive: true });
    return () => {
      for (const type of DOZE_ACTIVITY_EVENTS) window.removeEventListener(type, wake);
    };
  }, [startled, done]);
  return (
    <div className="absolute" style={{ left: DOZE_MARGIN, bottom: DOZE_MARGIN }}>
      {startled ? (
        <PandaRig pose="stand" size={DOZE_SIZE} expression="wide" props={["bang"]} />
      ) : (
        <PandaRig pose="curl" size={DOZE_SIZE} props={["z"]} motion={["breathe"]} />
      )}
    </div>
  );
}

/**
 * Bamboo leaves fall over the window. Their places and delays are fixed, so every shower looks the
 * same. The delays reach 0.715 s and a leaf falls for 1.2 s (src/styles/pranks.css), so the last one
 * has landed before CONFETTI_MS ends the layer.
 */
export function ConfettiLayer({ done }: LayerProps) {
  useEndAfter(done, CONFETTI_MS);
  return (
    <>
      {Array.from({ length: LEAVES }, (_, i) => (
        <div
          key={i}
          className="prank-leaf"
          style={{ left: `${(i * 37) % 100}%`, animationDelay: `${(i * 0.055).toFixed(3)}s` }}
        />
      ))}
    </>
  );
}
