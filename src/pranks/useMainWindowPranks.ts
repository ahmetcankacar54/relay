import { useEffect, useRef } from "react";
import { useRelay } from "@/data/relay-context";
import { DOZE_ACTIVITY_EVENTS } from "./layers";
import { usePrank } from "./PrankStage";
import { CONFETTI_KEY, confettiDue, dozeDue } from "./timing";

/** How often the main window checks whether it has been idle long enough to doze. */
export const DOZE_CHECK_MS = 30_000;

/**
 * Offers the doze when the window is visible and has had no activity for 10 minutes. The stage still
 * decides (the budget's gap and daily limit apply); this only keeps the idle clock and asks.
 */
export function useDoze(): void {
  const prank = usePrank();
  useEffect(() => {
    let lastActivity = Date.now();
    const active = () => {
      lastActivity = Date.now();
    };
    for (const type of DOZE_ACTIVITY_EVENTS) window.addEventListener(type, active, { passive: true });
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && dozeDue(lastActivity, Date.now())) prank.offer("doze", null);
    }, DOZE_CHECK_MS);
    return () => {
      clearInterval(timer);
      for (const type of DOZE_ACTIVITY_EVENTS) window.removeEventListener(type, active);
    };
  }, [prank]);
}

/**
 * Whether confetti falls for this account count, given the last one seen: only on an observed
 * 0 → 1, and once ever. The done flag is read now and written when the confetti falls. A storage
 * that cannot be read means it already fell (nothing falls); one that cannot be written lets it fall this once.
 */
export function confettiFalls(
  before: number | undefined,
  count: number,
  storage: () => Pick<Storage, "getItem" | "setItem">,
): boolean {
  if (!confettiDue(before, count, false)) return false;
  try {
    const flags = storage();
    if (flags.getItem(CONFETTI_KEY) !== null) return false;
    try {
      flags.setItem(CONFETTI_KEY, "1");
    } catch {
      // The flag is not kept; the confetti still falls this once.
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Offers the confetti when the account count goes from 0 to 1. The first count the data loads with is
 * only a baseline: a returning user who already has accounts gets none.
 */
export function useConfetti(accountCount: number, loaded: boolean): void {
  const prank = usePrank();
  const before = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!loaded) return;
    const previous = before.current;
    before.current = accountCount;
    if (confettiFalls(previous, accountCount, () => window.localStorage)) prank.offer("confetti", null);
  }, [accountCount, loaded, prank]);
}

/** The main window's own pranks, which need the stage around them. Draws nothing. */
export function MainWindowPranks(): null {
  const relay = useRelay();
  useDoze();
  useConfetti(relay.accounts.length, !!relay.data);
  return null;
}
