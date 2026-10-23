import { useEffect, useState, useSyncExternalStore } from "react";
import {
  LOST_ITEM_KINDS,
  type LostFoundCollection,
  type LostItemKind,
} from "../../shared/lost-found";
import type { RelayAPI } from "../../shared/types";
import type { ShelfItem } from "./lost-found-shelf";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Where the collection lives: kind → the Mondays of the weeks it was found in, newest first. The main
 * process only sees the weeks the 90-day rollups reach, so every week it reports is kept here and a pin
 * stays earned after its weeks fall out of reach.
 */
const STORAGE_KEY = "relay.lostfound.collection.v1";

export type CollectionWeeks = Partial<Record<LostItemKind, string[]>>;

let current: CollectionWeeks | undefined;
const listeners = new Set<() => void>();

function storage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return window.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function load(): CollectionWeeks {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object") return {};
    const weeks: CollectionWeeks = {};
    for (const kind of LOST_ITEM_KINDS) {
      const value = (parsed as Record<string, unknown>)[kind];
      if (!Array.isArray(value)) continue;
      const dates = value.filter(
        (date): date is string => typeof date === "string" && DATE.test(date),
      );
      if (dates.length) weeks[kind] = dates;
    }
    return weeks;
  } catch {
    return {};
  }
}

const snapshot = () => (current ??= load());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Both sets of weeks per kind, newest first, each week once. */
export function mergeWeeks(
  a: CollectionWeeks,
  b: CollectionWeeks,
): CollectionWeeks {
  const merged: CollectionWeeks = {};
  for (const kind of LOST_ITEM_KINDS) {
    const dates = [...new Set([...(a[kind] ?? []), ...(b[kind] ?? [])])].sort(
      (x, y) => y.localeCompare(x),
    );
    if (dates.length) merged[kind] = dates;
  }
  return merged;
}

const sameWeeks = (a: CollectionWeeks, b: CollectionWeeks) =>
  LOST_ITEM_KINDS.every(
    (kind) => (a[kind] ?? []).join() === (b[kind] ?? []).join(),
  );

/** Adds weeks to the collection; nothing is ever taken out of it. */
export function recordFinds(found: CollectionWeeks) {
  const next = mergeWeeks(snapshot(), found);
  if (sameWeeks(next, snapshot())) return;
  current = next;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A full or refused storage keeps the collection for this session only.
  }
  for (const listener of listeners) listener();
}

/** The kept items as collection weeks: keeping one proves it was found. */
export const shelfWeeks = (shelf: readonly ShelfItem[]): CollectionWeeks =>
  mergeWeeks(
    {},
    Object.fromEntries(
      LOST_ITEM_KINDS.map((kind) => [
        kind,
        shelf
          .filter((kept) => kept.item.kind === kind)
          .map((kept) => kept.start),
      ]),
    ),
  );

export interface CollectionState {
  /** Every week each kind was found in, newest first. */
  weeks: CollectionWeeks;
  /** The reach of the main process's answer, once it came. */
  reach?: Pick<LostFoundCollection, "latest" | "oldest">;
  loading: boolean;
}

/** The collection: the stored weeks at once, then those the main process finds within reach. */
export function useCollection(
  api: Pick<RelayAPI, "lostFoundCollection">,
  shelf: readonly ShelfItem[],
): CollectionState {
  const stored = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [reach, setReach] = useState<CollectionState["reach"]>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    // A failed answer leaves the stored weeks to show on their own.
    Promise.resolve(api.lostFoundCollection?.()).then(
      (answer) => {
        if (!live) return;
        if (answer) {
          recordFinds(answer.found);
          setReach({ latest: answer.latest, oldest: answer.oldest });
        }
        setLoading(false);
      },
      () => live && setLoading(false),
    );
    return () => {
      live = false;
    };
  }, [api]);
  useEffect(() => recordFinds(shelfWeeks(shelf)), [shelf]);
  return { weeks: stored, reach, loading };
}

/** Forgets the loaded collection, so the next read loads storage again; for tests. */
export function resetCollectionForTests() {
  current = undefined;
}
