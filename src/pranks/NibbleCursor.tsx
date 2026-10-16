import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { PandaRig } from "@/components/Panda";
import type { LayerProps } from "./layers";
import {
  NIBBLE_MAX_MS,
  NIBBLE_SIZE,
  nibbleAborts,
  nibbleFrame,
  nibbleLayout,
  type NibblePhase,
} from "./timing";

type Point = { x: number; y: number };
type NibbleFrame = ReturnType<typeof nibbleFrame>;
type NibbleEvent = Parameters<typeof nibbleAborts>[1];

/** The class on <html> that hides the real cursor (src/styles/pranks.css). */
const CURSOR_HIDDEN = "prank-cursor-hidden";
/** What a finished nibble is: over, with the cursor already bitten. */
const OVER: NibbleFrame = { phase: "done", bitten: true };

export interface NibbleController {
  /** Hides the real cursor and starts the clock and the 3 s cap. A controller that has finished never starts. */
  start(point: Point): void;
  /** The frame now. The tick that finds it over ends the nibble. */
  tick(): NibbleFrame;
  /** Feeds a pointer, key or window event; the ones that abort end the nibble at once. */
  event(event: NibbleEvent): void;
  /** Ends the nibble without waiting. */
  stop(): void;
  /** Whether this controller is hiding the real cursor right now. */
  readonly cursorHidden: boolean;
  /** Where the pointer last was (the click, until it moves); the bitten cursor flies there. */
  readonly pointer: Point;
}

/**
 * The nibble's clock and its promise: the real cursor comes back. However it ends (the timeline,
 * an abort event, `stop`, or the cap when no frame ever runs) the one `finish` takes the class off
 * first, clears the cap, and calls `onDone` once; after that every call does nothing.
 */
export function nibbleController(options: {
  now: () => number;
  classList: Pick<DOMTokenList, "add" | "remove">;
  onDone: () => void;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}): NibbleController {
  const { now, classList, onDone } = options;
  // Called as plain functions: a browser's setTimeout refuses to run with another object as `this`.
  const schedule =
    options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const unschedule =
    options.clearTimeout ??
    ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let startedAt: number | undefined;
  let origin: Point = { x: 0, y: 0 };
  let pointer = origin;
  let hidden = false;
  let finished = false;
  let cap: { handle: unknown } | undefined;

  const finish = () => {
    if (finished) return;
    finished = true;
    // The cursor first: nothing below may keep it hidden.
    if (hidden) {
      hidden = false;
      classList.remove(CURSOR_HIDDEN);
    }
    if (cap) {
      unschedule(cap.handle);
      cap = undefined;
    }
    onDone();
  };

  return {
    start(point) {
      if (finished || startedAt !== undefined) return;
      startedAt = now();
      origin = point;
      pointer = point;
      classList.add(CURSOR_HIDDEN);
      hidden = true;
      cap = { handle: schedule(finish, NIBBLE_MAX_MS) };
    },
    tick() {
      if (finished) return OVER;
      if (startedAt === undefined) return nibbleFrame(0);
      const frame = nibbleFrame(now() - startedAt);
      if (frame.phase === "done") finish();
      return frame;
    },
    event(event) {
      if (finished || startedAt === undefined) return;
      if (
        event.type === "pointermove" &&
        Number.isFinite(event.clientX) &&
        Number.isFinite(event.clientY)
      )
        pointer = { x: event.clientX as number, y: event.clientY as number };
      // Measured from where the click was, not from where the pointer last was.
      if (nibbleAborts(origin, event)) finish();
    },
    stop: finish,
    get cursorHidden() {
      return hidden;
    },
    get pointer() {
      return pointer;
    },
  };
}

/**
 * An arrow like the real cursor, on a 16 x 22 box with its tip at the box's top left corner (the
 * stroke hangs outside the box, `overflow-visible`). The bitten one is the chew pose's `cursor-bitten`
 * prop, redrawn at this size.
 */
const ARROW =
  "M0 0 L0 16.7 L4 13.1 L7.4 19.8 L10.6 18.2 L7.2 11.9 L13.1 11.5 Z";
const ARROW_BITTEN =
  "M0 3.4 Q1.4 4.9 2.7 3.1 Q4.1 4.9 5.6 3.4 L13.1 11.5 L7.2 11.9 L10.6 18.2 L7.4 19.8 L4 13.1 L0 16.7 Z";

/**
 * The drawn cursor, its tip at `at`. A `flight` of "in" moves it from where it was drawn last to
 * `at` by a CSS transition; "out" sets it off from `from` by a CSS animation (src/styles/pranks.css).
 */
function DrawnCursor({
  at,
  bitten,
  flight,
  from,
}: {
  at: Point;
  bitten: boolean;
  flight?: "in" | "out";
  from?: Point;
}) {
  const style: CSSProperties & Record<`--${string}`, string> = {
    transform: `translate(${at.x}px, ${at.y}px)`,
  };
  if (from) {
    style["--prank-from-x"] = `${from.x}px`;
    style["--prank-from-y"] = `${from.y}px`;
  }
  return (
    <svg
      viewBox="0 0 16 22"
      width={16}
      height={22}
      aria-hidden="true"
      focusable="false"
      data-prank-cursor={bitten ? "bitten" : "whole"}
      data-flight={flight}
      className="prank-cursor absolute top-0 left-0 overflow-visible fill-neutral-950 stroke-neutral-50"
      style={style}
    >
      <path
        d={bitten ? ARROW_BITTEN : ARROW}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * One frame of the nibble: the panda (88 px) on its edge, turned so its feet point at it, and the
 * drawn cursor. Pure: the layer decides the frame, the layout and the pointer.
 *
 * | phase    | panda                          | drawn cursor                         |
 * | peek     | `peek`, slides in              | whole, at the click                  |
 * | fly-in   | `chew`, no props               | whole, flying to the held point      |
 * | chew     | `chew` holding the cursor      | none (the panda holds it)            |
 * | fly-out  | `chew`, no props               | bitten, flying to the pointer        |
 * | withdraw | `chew`, no props, slides out   | bitten, at the pointer               |
 */
export function NibbleCursorView({
  frame,
  layout,
  start,
  pointer,
}: {
  frame: { phase: NibblePhase; bitten: boolean };
  layout: ReturnType<typeof nibbleLayout>;
  start: Point;
  pointer: Point;
}) {
  const { phase, bitten } = frame;
  if (phase === "done") return null;
  const chewing = phase === "chew";

  let cursor: ReactNode = null;
  if (phase === "peek") cursor = <DrawnCursor at={start} bitten={false} />;
  else if (phase === "fly-in")
    cursor = <DrawnCursor at={layout.held} bitten={false} flight="in" />;
  else if (phase === "fly-out" || phase === "withdraw")
    cursor = (
      <DrawnCursor at={pointer} bitten flight="out" from={layout.held} />
    );

  return (
    <>
      <div
        className="absolute"
        style={{
          left: layout.left,
          top: layout.top,
          width: NIBBLE_SIZE,
          height: NIBBLE_SIZE,
          transform: `rotate(${layout.rotate}deg)`,
        }}
      >
        {/* Turned with the box, so the slide goes toward the edge it peeks from. */}
        <div className="prank-nibble-panda" data-phase={phase}>
          <PandaRig
            pose={phase === "peek" ? "peek" : "chew"}
            size={NIBBLE_SIZE}
            props={chewing ? [bitten ? "cursor-bitten" : "cursor"] : []}
            motion={chewing ? ["chew"] : []}
            className="block"
          />
        </div>
      </div>
      {cursor}
    </>
  );
}

/** What the layer has drawn: the frame, and where the pointer was when it did. */
interface Shown {
  frame: NibbleFrame;
  pointer: Point;
}

/**
 * The panda nibbles the real cursor. The real cursor is hidden before the first paint and always
 * comes back: the controller restores it on every way out, and unmounting stops it.
 */
export function NibbleCursorLayer({ play, done }: LayerProps) {
  const { point } = play;
  // Where the panda goes is fixed when the play starts; resizing the window mid-nibble does not move it.
  const [layout] = useState(() =>
    point
      ? nibbleLayout(point, {
          width: window.innerWidth,
          height: window.innerHeight,
        })
      : undefined,
  );
  const [shown, setShown] = useState<Shown>(() => ({
    frame: nibbleFrame(0),
    pointer: point ?? { x: 0, y: 0 },
  }));
  // The newest `done`, so a new one never restarts the nibble.
  const finish = useRef(done);
  useLayoutEffect(() => {
    finish.current = done;
  });

  useLayoutEffect(() => {
    // Nothing to nibble without a click point (the offer came with no event).
    if (!point) {
      finish.current();
      return;
    }
    // After an unmount the stage has moved on: only the cursor is restored, `done` is not called.
    let live = true;
    let request: number | undefined;
    const controller = nibbleController({
      now: () => performance.now(),
      classList: document.documentElement.classList,
      onDone: () => {
        if (live) finish.current();
      },
    });
    const frames = () => {
      const frame = controller.tick();
      const pointer = controller.pointer;
      setShown((previous) =>
        previous.frame.phase === frame.phase &&
        previous.frame.bitten === frame.bitten &&
        previous.pointer === pointer
          ? previous
          : { frame, pointer },
      );
      request =
        frame.phase === "done" ? undefined : requestAnimationFrame(frames);
    };
    const onEvent = (event: Event) => controller.event(event);
    const onVisibility = () =>
      controller.event({
        type: "visibilitychange",
        hidden: document.visibilityState === "hidden",
      });
    const TYPES = ["pointermove", "pointerdown", "keydown", "blur"] as const;
    for (const type of TYPES)
      window.addEventListener(type, onEvent, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    request = requestAnimationFrame(frames);
    // Last, so nothing above can fail after the cursor is hidden and leave it hidden.
    controller.start(point);
    return () => {
      live = false;
      if (request !== undefined) cancelAnimationFrame(request);
      for (const type of TYPES) window.removeEventListener(type, onEvent);
      document.removeEventListener("visibilitychange", onVisibility);
      controller.stop();
    };
  }, [point]);

  if (!point || !layout) return null;
  return (
    <NibbleCursorView
      frame={shown.frame}
      layout={layout}
      start={point}
      pointer={shown.pointer}
    />
  );
}
