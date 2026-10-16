import type { CarriedConversation } from "./desktop-files";

/** Claude's Local Storage key for the unsent draft of a Code conversation, followed by its alias. */
export const CONVERSATION_DRAFT_PREFIX = "composer-draft:epitaxy-local_";
/** Claude's Local Storage key for the draft of a session that does not exist yet. */
export const NEW_SESSION_DRAFT = "composer-draft:epitaxy-draft";

export interface DraftOps {
  /** Local Storage keys to write, with their new JSON values. */
  set: Record<string, string>;
  /** Local Storage keys to delete. */
  remove: string[];
  /** Conversation drafts written under the target alias. */
  moved: number;
  /** 1 when the new-session draft changed owner. */
  owned: number;
  /** Drafts in scope whose value is not a JSON object with a string `owner`. */
  skipped: number;
}

type Draft = Record<string, unknown> & { owner: string };

function parseDraft(raw: string): Draft | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as { owner?: unknown }).owner === "string"
    )
      return value as Draft;
  } catch {
    // Not JSON: counted as skipped by the caller.
  }
  return null;
}

/**
 * Decides which Local Storage keys to write or remove so that account `from`'s unsent drafts
 * follow its conversations to account `to`. A draft is moved, never copied.
 *
 * Keys outside the carried conversations are never touched, and neither are drafts owned by
 * other accounts, with one exception: A's draft is written to the conversation's target key,
 * which every account holding that alias shares, so it replaces whatever sits there. When that
 * target key holds a malformed value, the whole conversation is left as it is.
 *
 * `drafts` holds every `composer-draft:` key with its raw string value.
 */
export function planDraftMoves(input: {
  drafts: Record<string, string>;
  from: string;
  to: string;
  conversations: CarriedConversation[];
}): DraftOps {
  const { drafts, from, to, conversations } = input;
  const ops: DraftOps = { set: {}, remove: [], moved: 0, owned: 0, skipped: 0 };
  if (from === to) return ops;

  // Account UUIDs compare without case; the owner written is `to` as given.
  const fromKey = from.toLowerCase();
  const isFrom = (draft: Draft) => draft.owner.toLowerCase() === fromKey;
  const seen = new Set<string>();
  /** The parsed draft at `key` when it is in scope and a draft is stored there, else undefined. */
  const read = (key: string): Draft | null | undefined => {
    const raw = drafts[key];
    if (typeof raw !== "string" || seen.has(key)) return undefined;
    seen.add(key);
    const draft = parseDraft(raw);
    if (!draft) ops.skipped++;
    return draft;
  };

  for (const conversation of conversations) {
    const targetKey = CONVERSATION_DRAFT_PREFIX + conversation.targetAlias;
    const keys = [
      ...new Set([
        targetKey,
        ...conversation.members.map(
          (member) => CONVERSATION_DRAFT_PREFIX + member.alias,
        ),
      ]),
    ].sort();
    const mine: { key: string; draft: Draft }[] = [];
    for (const key of keys) {
      const draft = read(key);
      if (draft && isFrom(draft)) mine.push({ key, draft });
    }
    // Overwriting a value Relay cannot read would lose it, so the conversation stays as it is.
    const targetRaw = drafts[targetKey];
    if (typeof targetRaw === "string" && !parseDraft(targetRaw)) continue;
    if (mine.length === 0) continue;
    // The draft already at the target alias wins; otherwise the lexically first (`keys` is sorted).
    const keep = mine.find(({ key }) => key === targetKey) ?? mine[0];
    ops.set[targetKey] = JSON.stringify({ ...keep.draft, owner: to });
    ops.moved++;
    for (const { key } of mine) if (key !== targetKey) ops.remove.push(key);
  }

  const newSession = read(NEW_SESSION_DRAFT);
  if (newSession && isFrom(newSession)) {
    ops.set[NEW_SESSION_DRAFT] = JSON.stringify({ ...newSession, owner: to });
    ops.owned = 1;
  }

  // A key written for one conversation is never also removed for another.
  ops.remove = ops.remove.filter((key) => !(key in ops.set));
  return ops;
}
