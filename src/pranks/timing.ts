import { PANDA_CANVAS } from "../../shared/panda-poses";

/** Inactivity after which the main window's panda dozes off. */
export const DOZE_AFTER_MS = 600_000;
/** How long the panda stays startled after the first activity, before it leaves. */
export const STARTLE_MS = 600;

/** Whether the window has been idle long enough for the doze prank. */
export function dozeDue(lastActivity: number, now: number): boolean {
  return now - lastActivity >= DOZE_AFTER_MS;
}

/** The localStorage key that remembers the confetti already fell. */
export const CONFETTI_KEY = "relay-confetti-done";
export const CONFETTI_MS = 2_000;

/**
 * Confetti falls on an observed 0 → 1 account count, once. A first load (`previous` undefined)
 * never counts, so a returning user who already has accounts gets none.
 */
export function confettiDue(previous: number | undefined, current: number, done: boolean): boolean {
  return !done && previous === 0 && current === 1;
}

export const NIBBLE_MS = 1_500;
/** The pointer moving farther than this from where it clicked ends the nibble. */
export const NIBBLE_ABORT_PX = 80;
/** The real cursor is back by now, whatever happened. */
export const NIBBLE_MAX_MS = 3_000;
/** The nibbling panda's box, in px. */
export const NIBBLE_SIZE = 88;

export type NibblePhase = "peek" | "fly-in" | "chew" | "fly-out" | "withdraw" | "done";

/** Each phase ends where the next begins; `bitten` marks the third nibble of the chew. */
const NIBBLE_PHASES: readonly { phase: Exclude<NibblePhase, "done">; until: number }[] = [
  { phase: "peek", until: 250 },
  { phase: "fly-in", until: 450 },
  { phase: "chew", until: 1_050 },
  { phase: "fly-out", until: 1_300 },
  { phase: "withdraw", until: NIBBLE_MS },
];
const NIBBLE_BITTEN_FROM = 750;

/** The phase `elapsed` ms into the nibble. The bitten cursor stays with the pointer while the panda withdraws. */
export function nibbleFrame(elapsed: number): { phase: NibblePhase; bitten: boolean } {
  const phase = NIBBLE_PHASES.find((p) => elapsed < p.until)?.phase ?? "done";
  return { phase, bitten: elapsed >= NIBBLE_BITTEN_FROM };
}

/**
 * Whether an event ends the nibble at once: the pointer moved more than 80 px from where it
 * started, any pointer or key press, the window blurred, or the document became hidden.
 */
export function nibbleAborts(
  start: { x: number; y: number },
  event: { type: string; clientX?: number; clientY?: number; hidden?: boolean },
): boolean {
  switch (event.type) {
    case "pointermove":
      if (event.clientX === undefined || event.clientY === undefined) return false;
      return Math.hypot(event.clientX - start.x, event.clientY - start.y) > NIBBLE_ABORT_PX;
    case "pointerdown":
    case "keydown":
    case "blur":
      return true;
    case "visibilitychange":
      return event.hidden === true;
    default:
      return false;
  }
}

export type Edge = "top" | "right" | "bottom" | "left";

/** Where the panda's feet point, in screen px: its "down" turned to the edge it peeks from. */
const EDGES: readonly { edge: Edge; rotate: number; down: { x: number; y: number } }[] = [
  { edge: "bottom", rotate: 0, down: { x: 0, y: 1 } },
  { edge: "left", rotate: 90, down: { x: -1, y: 0 } },
  { edge: "top", rotate: 180, down: { x: 0, y: -1 } },
  { edge: "right", rotate: -90, down: { x: 1, y: 0 } },
];

/** The peek pose's ledge line, and the chew pose's `held` pivot, on the 512 canvas. */
const LEDGE_Y = 400;
const HELD_PIVOT = { x: 256, y: 291 };

const clamp = (value: number, max: number): number => Math.min(Math.max(value, 0), Math.max(max, 0));

/**
 * Where the nibbling panda's box goes for a click at `point`: on the nearest window edge, turned
 * so its ledge line lies on that edge and its feet point at it. `left` and `top` are the box's
 * position before the turn (the box is square and turns about its centre), kept inside the
 * viewport along the edge. `held` is where the chew pose's `held` pivot ends up after the turn.
 */
export function nibbleLayout(
  point: { x: number; y: number },
  viewport: { width: number; height: number },
  size: number = NIBBLE_SIZE,
): { edge: Edge; left: number; top: number; rotate: number; held: { x: number; y: number } } {
  const distance: Record<Edge, number> = {
    top: point.y,
    right: viewport.width - point.x,
    bottom: viewport.height - point.y,
    left: point.x,
  };
  const nearest = EDGES.reduce((best, candidate) => (distance[candidate.edge] < distance[best.edge] ? candidate : best));
  const { edge, rotate, down } = nearest;

  const half = size / 2;
  const scale = size / PANDA_CANVAS;
  // The ledge line lies this far past the box centre, along "down".
  const centreToLedge = LEDGE_Y * scale - half;
  // Along the edge the box follows the point; across it the centre sits so the ledge line is on the edge.
  const alongX = clamp(point.x - half, viewport.width - size) + half;
  const alongY = clamp(point.y - half, viewport.height - size) + half;
  const acrossX = (down.x > 0 ? viewport.width : 0) - down.x * centreToLedge;
  const acrossY = (down.y > 0 ? viewport.height : 0) - down.y * centreToLedge;
  const centre = down.x !== 0 ? { x: acrossX, y: alongY } : { x: alongX, y: acrossY };

  // The held pivot's offset from the canvas centre turns with the box: local x runs along
  // (down.y, -down.x), local y along down.
  const offsetX = (HELD_PIVOT.x - PANDA_CANVAS / 2) * scale;
  const offsetY = (HELD_PIVOT.y - PANDA_CANVAS / 2) * scale;
  return {
    edge,
    left: centre.x - half,
    top: centre.y - half,
    rotate,
    held: {
      x: centre.x + offsetX * down.y + offsetY * down.x,
      y: centre.y - offsetX * down.x + offsetY * down.y,
    },
  };
}
