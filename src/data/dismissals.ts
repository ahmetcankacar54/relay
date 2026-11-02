import { useSyncExternalStore } from "react";

/** Where the dismissed warnings are kept: a JSON array of `accountId:issue` keys. */
const STORAGE_KEY = "relay.dismissed.v1";

export const dismissalKey = (accountId: string, issue: string): string =>
  `${accountId}:${issue}`;

/** The account a key belongs to: everything before the first colon. */
export const dismissalAccountId = (key: string): string => {
  const colon = key.indexOf(":");
  return colon < 0 ? key : key.slice(0, colon);
};

/**
 * The dismissed keys, shared by every mounted `Banners` (one per page) so a
 * dismissal holds across pages. Loaded from storage on first use; replaced, never
 * mutated, so `useSyncExternalStore` sees a new snapshot on every change.
 */
let current: ReadonlySet<string> | undefined;
const listeners = new Set<() => void>();

/** The window's storage, or undefined when there is none or it will not be handed over. */
function storage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return window.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function load(): ReadonlySet<string> {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed))
      return new Set(parsed.filter((k): k is string => typeof k === "string"));
  } catch {
    // Unreadable storage or a corrupt value: start empty, in memory.
  }
  return new Set();
}

/** Takes the new set, tells the subscribers, and saves it if storage lets us. */
function replace(next: ReadonlySet<string>): void {
  current = next;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    // Without storage the dismissals last until the window closes.
  }
  for (const listener of [...listeners]) listener();
}

export function getDismissals(): ReadonlySet<string> {
  return (current ??= load());
}

export function subscribeDismissals(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function dismissMany(add: readonly string[]): void {
  const keys = getDismissals();
  if (add.some((key) => !keys.has(key))) replace(new Set([...keys, ...add]));
}

const dismiss = (key: string): void => dismissMany([key]);

/**
 * Forgets dismissals whose issue is no longer current, so an issue that goes
 * away and comes back shows again. `currentKeys` is every issue now present,
 * dismissed or not. Call it only once the data is loaded: before that no issue is
 * known yet and everything would be pruned.
 *
 * `keepAccountIds` are accounts whose usage has not been read yet (right after a
 * launch every account is idle, with no issue): their keys stay until that read
 * settles, so a restart does not wipe their dismissals.
 */
export function pruneDismissals(
  currentKeys: readonly string[],
  keepAccountIds: readonly string[] = [],
): void {
  const present = new Set(currentKeys);
  const unread = new Set(keepAccountIds);
  const keys = getDismissals();
  const kept = [...keys].filter(
    (key) => present.has(key) || unread.has(dismissalAccountId(key)),
  );
  if (kept.length !== keys.size) replace(new Set(kept));
}

export function useDismissals(): {
  dismissed: ReadonlySet<string>;
  dismiss(key: string): void;
  dismissMany(keys: readonly string[]): void;
} {
  const dismissed = useSyncExternalStore(
    subscribeDismissals,
    getDismissals,
    getDismissals,
  );
  return { dismissed, dismiss, dismissMany };
}

/** Forgets what is in memory, so the next read loads from storage again, as a restart does. */
export function resetDismissalsForTests(): void {
  current = undefined;
}
