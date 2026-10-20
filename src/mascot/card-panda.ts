import { mascotPose, type MascotPose } from "../../shared/mascot";
import type { PandaExpression, PandaPose, PandaProp } from "../../shared/panda-poses";
import type { Account, AccountUsage, DesktopState, PlanningSettings, WindowAttempt } from "../../shared/types";
import { todayLookout } from "../lib/day-timeline";
import { overviewCards } from "../lib/onboarding";
import type { PandaMotion } from "./scenes";

/**
 * The panda over the sidebar's account card (docs/superpowers/specs/2026-10-20-sidebar-panda-design.md).
 * Everything here is plain data and pure functions; src/app/CardPanda.tsx draws it and keeps its clock.
 */

export interface CardLook {
  pose: PandaPose;
  expression: PandaExpression;
  props: readonly PandaProp[];
  motion: readonly PandaMotion[];
}

/** The look for each state; away has none, since the panda is not there. */
export const CARD_LOOKS = {
  idle: { pose: "peek", expression: "open", props: [], motion: ["blink"] },
  hungry: { pose: "peek", expression: "worried", props: [], motion: ["blink"] },
  alert: { pose: "stand", expression: "wide", props: ["bang"], motion: [] },
  sleeping: { pose: "curl", expression: "closed", props: ["z"], motion: [] },
  warming: { pose: "chew", expression: "open", props: ["bamboo"], motion: ["blink"] },
} as const satisfies Record<Exclude<MascotPose, "away">, CardLook>;

/** The panda walking off behind the card when Desktop gets busy. */
export const LEAVING_LOOK: CardLook = { pose: "walk", expression: "open", props: [], motion: [] };

/**
 * The canvas line (0–512) each pose holds on the card's top edge; the card hides what is below it. The stand,
 * walk and chew lines put their heads where the peek's is: stand shows its head and its "!", walk its head
 * and tail, and chew sits a little higher so the bamboo shows. Curl lies on the card.
 */
export const CARD_LEDGE: Partial<Record<PandaPose, number>> = {
  peek: 400,
  stand: 271,
  walk: 320,
  chew: 335,
  curl: 491,
};

/** Every pose is drawn in one box, at the rig's shared scale. */
export const CARD_SIZE = 112;

/** How far the panda's middle sits from the card's right edge, in px. */
export const CARD_CENTER_FROM_RIGHT = 68;

/** Where the panda's box goes in the clip box over the card: its right and its bottom, in px. */
export function cardPlacement(pose: PandaPose): { right: number; bottom: number; size: number } {
  const ledge = CARD_LEDGE[pose] ?? 512;
  return {
    right: CARD_CENTER_FROM_RIGHT - CARD_SIZE / 2,
    bottom: -((512 - ledge) / 512) * CARD_SIZE,
    size: CARD_SIZE,
  };
}

/** How long the walk off the card takes, and the rise back from behind it. */
export const LEAVE_MS = 1_100;
export const RISE_MS = 450;

export type CardReaction = "wave" | "check" | "nod" | "look-up" | "look-down" | "glance" | "chew";

/** Each reaction's length and priority: one of equal or higher priority replaces the one playing. */
export const REACTIONS: Record<CardReaction, { ms: number; priority: number }> = {
  wave: { ms: 1_600, priority: 3 },
  check: { ms: 1_600, priority: 2 },
  nod: { ms: 1_200, priority: 2 },
  "look-up": { ms: 1_200, priority: 1 },
  "look-down": { ms: 1_200, priority: 1 },
  glance: { ms: 1_600, priority: 0 },
  chew: { ms: 1_300, priority: 0 },
};

/** A sleeping panda sleeps, an away one is not there, and an alert one keeps its "!" until the problem is fixed. */
const REACTIVE: ReadonlySet<MascotPose> = new Set(["idle", "hungry", "warming"]);
export const reacts = (state: MascotPose) => REACTIVE.has(state);

/** What the panda does now and then while the window is in view. */
export const AMBIENT: Partial<Record<MascotPose, CardReaction>> = { idle: "glance", warming: "chew" };
export const AMBIENT_MIN_MS = 45_000;
export const AMBIENT_MAX_MS = 90_000;
export const ambientDelay = (random: number) => AMBIENT_MIN_MS + Math.floor(random * (AMBIENT_MAX_MS - AMBIENT_MIN_MS));

/** How long a switch's wave waits for a window in the background to come back. */
export const HOLD_MS = 60_000;

export interface ReactionQueue {
  playing?: { kind: CardReaction; until: number };
  /** The switch wave, kept while the window is in the background. */
  held?: { kind: CardReaction; expires: number };
}

export interface ReactionContext {
  now: number;
  state: MascotPose;
  reducedMotion: boolean;
  paused: boolean;
}

/** The reaction showing at `now`, if any. */
export function showing(queue: ReactionQueue, context: Omit<ReactionContext, "paused">): CardReaction | undefined {
  const playing = queue.playing;
  if (!playing || playing.until <= context.now || context.reducedMotion || !reacts(context.state)) return undefined;
  return playing.kind;
}

/**
 * The queue after `kind` is asked for. Reduce motion and a state that does not react play nothing. In the
 * background only the switch wave is kept, for later. Otherwise one of equal or higher priority replaces the one
 * playing and restarts the clock, and a lower one is dropped: nothing waits behind.
 */
export function react(queue: ReactionQueue, kind: CardReaction, context: ReactionContext): ReactionQueue {
  if (context.reducedMotion || !reacts(context.state)) return queue;
  if (context.paused)
    return kind === "wave" ? { ...queue, held: { kind, expires: context.now + HOLD_MS } } : queue;
  const current = showing(queue, context);
  if (current && REACTIONS[current].priority > REACTIONS[kind].priority) return queue;
  return { playing: { kind, until: context.now + REACTIONS[kind].ms } };
}

/** The window is back in view: a kept wave plays if it is still fresh; either way it is let go. */
export function resume(queue: ReactionQueue, context: Omit<ReactionContext, "paused">): ReactionQueue {
  const held = queue.held;
  if (!held) return queue;
  const rest: ReactionQueue = { playing: queue.playing };
  return held.expires > context.now ? react(rest, held.kind, { ...context, paused: false }) : rest;
}

/** The queue once its reaction has ended at `now`. */
export function settle(queue: ReactionQueue, now: number): ReactionQueue {
  return queue.playing && queue.playing.until <= now ? { held: queue.held } : queue;
}

/** How a state's look changes while a reaction shows: the switch wave smiles; the others only move. */
export function reactionLook(look: CardLook, reaction: CardReaction | undefined): CardLook {
  return reaction === "wave" ? { ...look, expression: "happy" } : look;
}

/** Desktop is busy, or this window has just asked it for a Desktop action (`relay.busy`) before it says so. */
export const desktopWorking = (desktop: DesktopState | undefined, busy: string) =>
  !!desktop?.busy || busy.startsWith("desktop-action:");

/** The state the card panda shows. */
export function cardState(
  data:
    | { accounts: Account[]; usage: Record<string, AccountUsage>; planning?: { attempts?: WindowAttempt[] } }
    | undefined,
  desktop: DesktopState | undefined,
  busy: string,
  now: number,
): MascotPose {
  if (!data) return "idle";
  return mascotPose(
    {
      accounts: data.accounts,
      usage: data.usage,
      desktop: desktop && { ...desktop, busy: desktopWorking(desktop, busy) },
      attempts: data.planning?.attempts,
    },
    now,
  );
}

/** What the window saw last, to tell what changed in the next snapshot. */
export interface CardSeen {
  /** The active account the last time Desktop was not busy. */
  settled?: string;
  settings?: string;
  refreshing: boolean;
  state?: MascotPose;
}

export interface CardSight {
  active?: string;
  busy: boolean;
  /** The settings, as JSON; undefined until the first snapshot. */
  settings?: string;
  refreshing: boolean;
  state: MascotPose;
}

/**
 * The reactions one new sight asks for, in order, and what to remember. A switch is the active account
 * changing between two moments Desktop was not busy, both known; a finished refresh is this window's refreshing
 * going from some accounts to none; a setting is any change after the first snapshot.
 */
export function sightReactions(seen: CardSeen, sight: CardSight): { reactions: CardReaction[]; seen: CardSeen } {
  const reactions: CardReaction[] = [];
  let settled = seen.settled;
  if (!sight.busy && sight.active) {
    if (settled && settled !== sight.active) reactions.push("wave");
    settled = sight.active;
  }
  if (seen.refreshing && !sight.refreshing) reactions.push("check");
  if (seen.settings !== undefined && sight.settings !== undefined && seen.settings !== sight.settings)
    reactions.push("nod");
  if (sight.state === "warming" && seen.state !== undefined && seen.state !== "warming") reactions.push("chew");
  return {
    reactions,
    seen: { settled, settings: sight.settings ?? seen.settings, refreshing: sight.refreshing, state: sight.state },
  };
}

/**
 * Overview draws a panda of its own on the Today card while automatic start is on and nothing is planned
 * (shown once an account is connected); the card panda steps aside meanwhile. With no active account the
 * active account card draws one, but then the sidebar has no card either.
 */
export function cardYields(
  page: string,
  accounts: Account[],
  planning: PlanningSettings,
): boolean {
  return page === "genel" && overviewCards(accounts).today && todayLookout(planning, accounts);
}
