import { useSyncExternalStore } from "react";
import { validLostItem, type LostItem } from "../../shared/lost-found";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Where the kept items live: a JSON array of `ShelfItem`, newest first. */
const STORAGE_KEY = "relay.lostfound.shelf.v1";
/** The shelf keeps this many items; the oldest falls off. */
export const SHELF_SIZE = 40;

/**
 * An item the user kept. It carries the account names of the day it was kept, so it still reads
 * the same after an account is renamed or removed, and after its week leaves the rollups.
 */
export interface ShelfItem {
  /** `<week start>:<kind>`: a week keeps at most one item of each kind. */
  id: string;
  start: string;
  end: string;
  item: LostItem;
  names: Record<string, string>;
}

export const shelfId = (start: string, kind: LostItem["kind"]) =>
  `${start}:${kind}`;

let current: readonly ShelfItem[] | undefined;
const listeners = new Set<() => void>();

/** The window's storage, or undefined when there is none or it will not be handed over. */
function storage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return window.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function load(): readonly ShelfItem[] {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is ShelfItem =>
            typeof entry?.id === "string" &&
            DATE.test(entry?.start) &&
            DATE.test(entry?.end) &&
            validLostItem(entry?.item) &&
            (entry?.names === undefined || typeof entry.names === "object"),
        )
      : [];
  } catch {
    return [];
  }
}

function save(next: readonly ShelfItem[]) {
  current = next;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A full or refused storage keeps the shelf for this session only.
  }
  for (const listener of listeners) listener();
}

const snapshot = () => (current ??= load());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The kept items, newest first. */
export function useShelf(): readonly ShelfItem[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Keeps an item; keeping it again moves it to the front. */
export function keepOnShelf(entry: ShelfItem) {
  save(
    [entry, ...snapshot().filter((kept) => kept.id !== entry.id)].slice(
      0,
      SHELF_SIZE,
    ),
  );
}

export function removeFromShelf(id: string) {
  save(snapshot().filter((kept) => kept.id !== id));
}

/** Forgets the loaded shelf, so the next read loads storage again; for tests. */
export function resetShelfForTests() {
  current = undefined;
}
