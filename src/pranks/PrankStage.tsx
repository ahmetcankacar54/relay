import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { PrankLevel } from "../../shared/types";
import { prankDecision, readPrankHistory, recordPrank, type PrankKind } from "./budget";
import { CURSOR_HIDDEN_CLASS, PrankContext, type PrankApi, type PrankEvent } from "./context";
import { prankBlocked, type PrankGate } from "./gate";
import { PRANK_LAYERS } from "./registry";

// The context lives in ./context (so a panda can read it without importing the stage); these keep the old import path.
export { usePrank } from "./context";
export type { PrankApi, PrankEvent } from "./context";

/** The prank that is playing, with where its trigger was when it was offered. */
export interface PrankPlay {
  id: number;
  kind: PrankKind;
  rect?: { left: number; top: number; width: number; height: number };
  point?: { x: number; y: number };
}

/** Runs the button's own action first, then offers the prank: a click never waits for it. */
export function offerAfter(prank: PrankApi, kind: PrankKind, event: MouseEvent<Element>, action: () => void): void {
  const anchor = event.currentTarget;
  action();
  prank.offer(kind, anchor, event);
}

type PrankStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * Whether an offered prank plays now. Only one plays at a time. `ignoreLimits` (the gallery) skips
 * the gate and the budget. Confetti has no budget. Anything else is drawn against the history read
 * right now, and recorded before it plays, so the other window sees it. A storage that throws means no prank.
 */
export function decideOffer(input: {
  kind: PrankKind;
  gate: PrankGate;
  level: PrankLevel;
  storage: PrankStorage;
  now: number;
  random: () => number;
  playing: boolean;
  ignoreLimits?: boolean;
}): boolean {
  const { kind, gate, level, storage, now, random, playing, ignoreLimits } = input;
  if (playing) return false;
  if (ignoreLimits) return true;
  if (prankBlocked(kind, gate)) return false;
  if (kind === "confetti") return true;
  const history = readPrankHistory(storage, now);
  if (history === undefined) return false;
  // The doze waits for idleness, not luck: only the gap and the daily limit apply to it.
  if (!prankDecision({ level, history, now, random, chance: kind !== "doze" })) return false;
  return recordPrank(storage, history, now);
}

/** A play, with the anchor's box and the event's point as they are right now. */
export function playFor(id: number, kind: PrankKind, anchor: Element | null, event?: PrankEvent): PrankPlay {
  const play: PrankPlay = { id, kind };
  if (anchor) {
    const { left, top, width, height } = anchor.getBoundingClientRect();
    play.rect = { left, top, width, height };
  }
  if (event) play.point = { x: event.clientX, y: event.clientY };
  return play;
}

/** A layer may hide the real cursor with this class on <html>; the stage takes it off when the play ends. */
function showCursor(): void {
  document.documentElement.classList.remove(CURSOR_HIDDEN_CLASS);
}

/**
 * Holds one play's layer. A layer that throws (while rendering, or in an effect) draws nothing and ends
 * its play through `onError`, so the app around the stage stays up and the real cursor comes back.
 */
class LayerBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const UNAVAILABLE: PrankStorage = {
  getItem() {
    throw new Error("localStorage is unavailable");
  },
  setItem() {
    throw new Error("localStorage is unavailable");
  },
};

/** Read when a prank is offered, never while rendering. A window that will not give its storage pranks nothing. */
export function windowStorage(): PrankStorage {
  try {
    return window.localStorage;
  } catch {
    return UNAVAILABLE;
  }
}

export interface PrankStageProps {
  level: PrankLevel;
  desktopBusy: boolean;
  errorShown: boolean;
  dialogOpen: boolean;
  /** The gallery plays every prank, whatever the gates and the budget say. */
  ignoreLimits?: boolean;
  /** Whether day one keeps pranks quiet, asked when one is offered (the app passes `quietOnDayOne`). */
  dayOneQuiet?: (storage: PrankStorage, now: number) => boolean;
  storage?: PrankStorage;
  now?: () => number;
  random?: () => number;
  children: ReactNode;
}

/** The gate as it is at this moment: the app's state from the props, the window's from the browser. */
function liveGate(props: PrankStageProps, event: { detail: number } | undefined): PrankGate {
  return {
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    level: props.level,
    desktopBusy: props.desktopBusy,
    errorShown: props.errorShown,
    windowVisible: document.visibilityState === "visible",
    keyboard: event?.detail === 0,
    dialogOpen: props.dialogOpen,
    dayOne:
      props.dayOneQuiet?.(
        props.storage ?? windowStorage(),
        (props.now ?? Date.now)(),
      ) ?? false,
  };
}

/**
 * The fixed, click-through overlay at the root of a window. It decides each offered prank and
 * draws the one that is playing; it never blocks a click.
 */
export function PrankStage(props: PrankStageProps) {
  const { children } = props;
  const [play, setPlay] = useState<PrankPlay>();
  // What the handlers read: the props and the playing prank as they are now, not as they were when the handler was made.
  const live = useRef(props);
  useEffect(() => {
    live.current = props;
  });
  const current = useRef<PrankPlay | undefined>(undefined);
  const lastId = useRef(0);

  const end = useCallback((id: number) => {
    // A late `done` from an earlier play must not end, or uncover the cursor of, the one playing now.
    if (current.current?.id !== id) return;
    current.current = undefined;
    showCursor();
    setPlay(undefined);
  }, []);

  const api = useMemo<PrankApi>(
    () => ({
      offer(kind, anchor, event) {
        const stage = live.current;
        const allowed = decideOffer({
          kind,
          gate: liveGate(stage, event),
          level: stage.level,
          storage: stage.storage ?? windowStorage(),
          now: (stage.now ?? Date.now)(),
          random: stage.random ?? Math.random,
          playing: current.current !== undefined,
          ignoreLimits: stage.ignoreLimits,
        });
        if (!allowed) return;
        const next = playFor(++lastId.current, kind, anchor, event);
        current.current = next;
        setPlay(next);
      },
      allowsTrick(event) {
        const stage = live.current;
        return stage.ignoreLimits === true || !prankBlocked("trick", liveGate(stage, event));
      },
    }),
    [],
  );

  const Layer = play ? PRANK_LAYERS[play.kind] : undefined;
  const done = useCallback(() => {
    if (play) end(play.id);
  }, [play, end]);
  // A kind that has no layer yet has nothing to draw, so it ends at once.
  useEffect(() => {
    if (play && !Layer) end(play.id);
  }, [play, Layer, end]);
  // However a play ends (above), or the window goes away, the real cursor comes back.
  useEffect(() => showCursor, []);

  return (
    <PrankContext.Provider value={api}>
      {children}
      <div data-prank-stage className="pointer-events-none fixed inset-0 z-[100] overflow-hidden">
        {play && Layer && (
          <LayerBoundary key={play.id} onError={done}>
            <Layer play={play} done={done} />
          </LayerBoundary>
        )}
      </div>
    </PrankContext.Provider>
  );
}
