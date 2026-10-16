import type { PrankLevel } from "../../shared/types";

export type PrankKind = "nibble-cursor" | "wheel" | "nibble-bar" | "doze" | "confetti";

/** How often a level may prank: the draw, the gap since the last prank, and the pranks per local day. */
export const PRANK_BUDGET: Record<PrankLevel, { chance: number; gapMs: number; perDay: number }> = {
  sometimes: { chance: 1 / 8, gapMs: 30 * 60_000, perDay: 4 },
  rarely: { chance: 1 / 15, gapMs: 2 * 3_600_000, perDay: 1 },
  off: { chance: 0, gapMs: 0, perDay: 0 },
};

/** The localStorage key the main window and the panel share, so they spend one budget. */
export const PRANK_HISTORY_KEY = "relay-pranks";
export const PRANK_HISTORY_MS = 48 * 3_600_000;

/**
 * Whether a prank may play now. `chance: false` (the doze prank) skips only the random draw;
 * the gap and the daily limit still apply. `off` has a daily limit of 0, so it never passes.
 */
export function prankDecision(input: {
  level: PrankLevel;
  history: readonly number[];
  now: number;
  random: () => number;
  chance: boolean;
}): boolean {
  const { level, history, now, random, chance } = input;
  const budget = PRANK_BUDGET[level];
  if (history.length > 0 && now - Math.max(...history) < budget.gapMs) return false;
  const today = new Date(now).toDateString();
  if (history.filter((t) => new Date(t).toDateString() === today).length >= budget.perDay) return false;
  return !chance || random() < budget.chance;
}

/** Past prank times within the 48 h window. Times in the future are dropped: they would hold the gap shut. */
function recent(times: readonly unknown[], now: number): number[] {
  return times.filter(
    (t): t is number => typeof t === "number" && Number.isFinite(t) && t <= now && now - t <= PRANK_HISTORY_MS,
  );
}

/** The last 48 h of prank times; [] for a missing or malformed record; undefined when storage throws. */
export function readPrankHistory(storage: Pick<Storage, "getItem">, now: number): number[] | undefined {
  let raw: string | null;
  try {
    raw = storage.getItem(PRANK_HISTORY_KEY);
  } catch {
    return undefined;
  }
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? recent(parsed, now) : [];
  } catch {
    return [];
  }
}

/** Stores history + now (pruned to 48 h); false when storage throws. */
export function recordPrank(storage: Pick<Storage, "setItem">, history: readonly number[], now: number): boolean {
  try {
    storage.setItem(PRANK_HISTORY_KEY, JSON.stringify([...recent(history, now), now]));
    return true;
  } catch {
    return false;
  }
}
