import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  addDays,
  LOST_ITEM_KINDS,
  validLostItem,
  type LostFoundCollection,
  type LostItem,
  type LostItemKind,
} from "../../shared/lost-found";
import type { Account, RelayAPI } from "../../shared/types";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Where the collection lives: kind → its finds, newest first. The main process only sees the weeks the 90-day
 * rollups reach, so every find it reports is kept here, with the account names of that day, and a pin stays
 * earned (and its story told) after its week falls out of reach.
 */
const STORAGE_KEY = "relay.lostfound.collection.v2";
/** Earlier versions: the weeks alone, and the shelf of kept items. Read once, while v2 is missing. */
const WEEKS_V1 = "relay.lostfound.collection.v1";
const SHELF_V1 = "relay.lostfound.shelf.v1";

/** A find as the collection keeps it; one carried over from the weeks-only version has no story. */
export interface KeptFind {
  start: string;
  end: string;
  item?: LostItem;
  /** The names of the accounts the story names, as they were when it was kept. */
  names?: Record<string, string>;
}

export type CollectionFinds = Partial<Record<LostItemKind, KeptFind[]>>;

let current: CollectionFinds | undefined;
const listeners = new Set<() => void>();

function storage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return window.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function read(key: string): unknown {
  try {
    const raw = storage()?.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

/** A stored find that can still be read; its item is dropped when another version left it untellable. */
function keptFind(kind: LostItemKind, value: unknown): KeptFind | undefined {
  const entry = value as Record<string, unknown> | null;
  if (!entry || typeof entry.start !== "string" || !DATE.test(entry.start))
    return undefined;
  const end =
    typeof entry.end === "string" && DATE.test(entry.end)
      ? entry.end
      : addDays(entry.start, 6);
  const item =
    validLostItem(entry.item) && entry.item.kind === kind
      ? entry.item
      : undefined;
  const names =
    entry.names && typeof entry.names === "object"
      ? Object.fromEntries(
          Object.entries(entry.names).filter(
            (pair): pair is [string, string] => typeof pair[1] === "string",
          ),
        )
      : undefined;
  return {
    start: entry.start,
    end,
    ...(item ? { item } : {}),
    ...(names ? { names } : {}),
  };
}

/** The weeks-only collection and the shelf, as finds. */
function legacy(): CollectionFinds {
  const weeks = read(WEEKS_V1) as Record<string, unknown> | undefined;
  const finds: CollectionFinds = {};
  for (const kind of LOST_ITEM_KINDS) {
    const dates = weeks?.[kind];
    if (Array.isArray(dates))
      for (const start of dates) {
        const find = keptFind(kind, { start });
        if (find) (finds[kind] ??= []).push(find);
      }
  }
  const shelf = read(SHELF_V1);
  const kept: CollectionFinds = {};
  if (Array.isArray(shelf))
    for (const entry of shelf) {
      const kind = (entry as { item?: { kind?: unknown } } | null)?.item?.kind;
      if (!LOST_ITEM_KINDS.includes(kind as LostItemKind)) continue;
      const find = keptFind(kind as LostItemKind, entry);
      if (find?.item) (kept[kind as LostItemKind] ??= []).push(find);
    }
  return mergeFinds(finds, kept);
}

function load(): CollectionFinds {
  const stored = read(STORAGE_KEY);
  if (!stored || typeof stored !== "object") return legacy();
  const finds: CollectionFinds = {};
  for (const kind of LOST_ITEM_KINDS) {
    const list = (stored as Record<string, unknown>)[kind];
    if (!Array.isArray(list)) continue;
    const kept = list.flatMap((value) => keptFind(kind, value) ?? []);
    if (kept.length) finds[kind] = kept;
  }
  return finds;
}

const snapshot = () => (current ??= load());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Both sets of finds per kind, newest first, one per week. For a week in both, `b`'s find wins when it tells a
 * story, so a fresh answer replaces an older one; a story is never replaced by a find without one.
 */
export function mergeFinds(
  a: CollectionFinds,
  b: CollectionFinds,
): CollectionFinds {
  const merged: CollectionFinds = {};
  for (const kind of LOST_ITEM_KINDS) {
    const byWeek = new Map<string, KeptFind>();
    for (const find of a[kind] ?? []) byWeek.set(find.start, find);
    for (const find of b[kind] ?? []) {
      const kept = byWeek.get(find.start);
      if (!kept || find.item || !kept.item) byWeek.set(find.start, find);
    }
    const finds = [...byWeek.values()].sort((x, y) =>
      y.start.localeCompare(x.start),
    );
    if (finds.length) merged[kind] = finds;
  }
  return merged;
}

/** Adds finds to the collection; nothing is ever taken out of it. */
export function recordFinds(found: CollectionFinds) {
  const before = snapshot();
  const next = mergeFinds(before, found);
  if (JSON.stringify(next) === JSON.stringify(before)) return;
  current = next;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A full or refused storage keeps the collection for this session only.
  }
  for (const listener of listeners) listener();
}

/** The accounts a story names, in its order. */
export function storyAccounts(item: LostItem): string[] {
  if ("accountIds" in item) return item.accountIds;
  return "accountId" in item && item.accountId ? [item.accountId] : [];
}

/** The main process's answer as finds, each with the names its accounts have today. */
export function answerFinds(
  found: LostFoundCollection["found"],
  accounts: Account[],
): CollectionFinds {
  const finds: CollectionFinds = {};
  for (const kind of LOST_ITEM_KINDS)
    for (const find of found[kind] ?? [])
      (finds[kind] ??= []).push({
        ...find,
        names: Object.fromEntries(
          storyAccounts(find.item).flatMap((id) => {
            const account = accounts.find((a) => a.id === id);
            return account ? [[id, account.name]] : [];
          }),
        ),
      });
  return finds;
}

export interface CollectionState {
  /** Every find of each kind, newest first. */
  finds: CollectionFinds;
  /** The reach of the main process's answer, once it came. */
  reach?: Pick<LostFoundCollection, "latest" | "oldest">;
  loading: boolean;
}

/** The collection: the stored finds at once, then those the main process finds within reach. */
export function useCollection(
  api: Pick<RelayAPI, "lostFoundCollection">,
  accounts: Account[],
): CollectionState {
  const stored = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [reach, setReach] = useState<CollectionState["reach"]>();
  const [loading, setLoading] = useState(true);
  // Account names are read when the answer comes; the answer is asked for once.
  const latestAccounts = useRef(accounts);
  useEffect(() => {
    latestAccounts.current = accounts;
  }, [accounts]);
  useEffect(() => {
    let live = true;
    // A failed answer leaves the stored finds to show on their own.
    Promise.resolve(api.lostFoundCollection?.()).then(
      (answer) => {
        if (!live) return;
        if (answer) {
          recordFinds(answerFinds(answer.found, latestAccounts.current));
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
  return { finds: stored, reach, loading };
}

/** Forgets the loaded collection, so the next read loads storage again; for tests. */
export function resetCollectionForTests() {
  current = undefined;
}
